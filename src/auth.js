'use strict';
// 工作台登录会话：scrypt 密码哈希 + 内存 Token（滑动续期）
// 安全：同用户名登录失败限速（15 分钟内 5 次失败锁定 15 分钟）；支持修改密码（改密后其它会话全部失效）
// 说明：单进程内存会话，重启后需重新登录（见 docs/03-接口约定.md 的约定与限制）
const crypto = require('crypto');
const { queryOne, query } = require('./db');
const { ApiError, CODE } = require('./http/respond');
const { config } = require('./config');
const logger = require('./logger');

/** token -> { userId, username, displayName, role, expiresAt } */
const sessions = new Map();

// 登录失败限速：username -> { count, lockedUntil, firstFailAt }
const loginAttempts = new Map();
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 5;
const LOCK_MS = 15 * 60 * 1000;

function ttlMs() {
  return Math.max(1, config.sessionTtlHours) * 3600 * 1000;
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const calc = crypto.scryptSync(String(password), parts[1], 64);
    return crypto.timingSafeEqual(calc, Buffer.from(parts[2], 'hex'));
  } catch (_) {
    return false;
  }
}

/** 会话有效期优先读系统设置 session_ttl_hours（设置页可改），读取失败回落 .env 配置 */
async function currentTtlMs() {
  try {
    const row = await queryOne('SELECT setting_value FROM xy_settings WHERE setting_key = ?', ['session_ttl_hours']);
    const hours = Number(row && row.setting_value);
    if (Number.isFinite(hours) && hours >= 1 && hours <= 24 * 30) return hours * 3600 * 1000;
  } catch (_) { /* 设置不可用时回落 */ }
  return ttlMs();
}

function assertNotLocked(username) {
  const rec = loginAttempts.get(username);
  if (!rec) return;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    const min = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
    throw new ApiError(CODE.BIZ_FAIL, `登录失败次数过多，账号已临时锁定，请约 ${min} 分钟后重试`);
  }
  if (rec.firstFailAt && Date.now() - rec.firstFailAt > FAIL_WINDOW_MS) loginAttempts.delete(username);
}

function recordLoginFail(username) {
  const now = Date.now();
  const rec = loginAttempts.get(username) || { count: 0, firstFailAt: now, lockedUntil: 0 };
  if (now - rec.firstFailAt > FAIL_WINDOW_MS) { rec.count = 0; rec.firstFailAt = now; }
  rec.count += 1;
  if (rec.count >= FAIL_LIMIT) {
    rec.lockedUntil = now + LOCK_MS;
    logger.warn('auth', `账号 ${username} 连续登录失败 ${rec.count} 次，临时锁定 15 分钟`);
  }
  loginAttempts.set(username, rec);
}

async function login(username, password) {
  assertNotLocked(username);
  const user = await queryOne("SELECT * FROM xy_users WHERE username = ? AND status = 'active'", [username]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFail(username);
    throw new ApiError(CODE.UNAUTHORIZED, '用户名或密码错误');
  }
  loginAttempts.delete(username);
  const ttl = await currentTtlMs();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    expiresAt: Date.now() + ttl,
  });
  logger.info('auth', `用户登录成功: ${user.username}`);
  return {
    token,
    expires_in_hours: Math.round(ttl / 3600000),
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
  };
}

function logout(token) {
  if (token && sessions.delete(token)) logger.info('auth', '用户已退出登录');
}

function getToken(req) {
  const h = String(req.headers['authorization'] || '');
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  if (req.headers['x-auth-token']) return String(req.headers['x-auth-token']).trim();
  return '';
}

function requireAuth(req) {
  const token = getToken(req);
  const s = token ? sessions.get(token) : null;
  if (!s) throw new ApiError(CODE.UNAUTHORIZED, '未登录或令牌无效');
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    throw new ApiError(CODE.UNAUTHORIZED, '登录已过期，请重新登录');
  }
  s.expiresAt = Date.now() + ttlMs(); // 滑动续期（按配置基准）
  s.token = token;
  return s;
}

function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw new ApiError(CODE.FORBIDDEN, '该操作需要管理员权限');
  return user;
}

/** 修改密码：校验旧密码 → 更新哈希 → 使该用户其它会话全部失效 */
async function changePassword(user, oldPassword, newPassword) {
  if (!user) throw new ApiError(CODE.UNAUTHORIZED, '未登录');
  const row = await queryOne('SELECT * FROM xy_users WHERE id = ?', [user.userId]);
  if (!row) throw new ApiError(CODE.UNAUTHORIZED, '用户不存在');
  if (!verifyPassword(oldPassword, row.password_hash)) {
    throw new ApiError(CODE.BIZ_FAIL, '原密码不正确');
  }
  if (String(newPassword || '').length < 6) {
    throw new ApiError(CODE.BAD_REQUEST, '新密码至少 6 位');
  }
  await query('UPDATE xy_users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), user.userId]);
  let removed = 0;
  for (const [tk, s] of sessions) {
    if (s.userId === user.userId && tk !== user.token) { sessions.delete(tk); removed++; }
  }
  logger.info('auth', `用户 ${user.username} 修改密码成功（其它会话失效 ${removed} 个）`);
  return { changed: true, other_sessions_removed: removed };
}

/** 周期清理过期会话（由调度 tick 间接触发或登录时惰性清理兜底） */
function sweepSessions() {
  const now = Date.now();
  for (const [tk, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(tk);
  }
}

module.exports = {
  sessions, hashPassword, verifyPassword, login, logout, getToken,
  requireAuth, requireAdmin, changePassword, sweepSessions,
};
