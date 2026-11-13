'use strict';
// 用户管理（管理员）：列表 / 创建 / 更新（角色·状态·显示名）/ 重置密码 / 删除
// 安全：不返回 password_hash；操作全部落系统日志；不能删除自己或最后一个管理员
const { query, queryOne } = require('../db');
const { ApiError, CODE, str, bool, enumOf } = require('../http/respond');
const auth = require('../auth');
const { sysLog } = require('./logs');

function sanitize(u) {
  const { password_hash, ...rest } = u;
  return rest;
}

async function adminCount() {
  const r = await queryOne("SELECT COUNT(*) AS c FROM xy_users WHERE role = 'admin' AND status = 'active'");
  return Number(r.c);
}

async function listUsers() {
  const rows = await query('SELECT id, username, display_name, role, status, created_at, updated_at FROM xy_users ORDER BY id ASC');
  return rows.map((u) => ({ ...u, online: [...auth.sessions.values()].some((s) => s.userId === u.id) }));
}

async function createUser(body, user) {
  const username = str(body.username, 'username', { required: true, max: 64 });
  const password = str(body.password, 'password', { required: true, max: 128 });
  if (password.length < 6) throw new ApiError(CODE.BAD_REQUEST, '初始密码至少 6 位');
  const exists = await queryOne('SELECT id FROM xy_users WHERE username = ?', [username]);
  if (exists) throw new ApiError(CODE.CONFLICT, '用户名已存在');
  const role = enumOf(body.role, 'role', ['admin', 'operator'], { default: 'operator' });
  const r = await query(
    'INSERT INTO xy_users (username, password_hash, display_name, role, status) VALUES (?, ?, ?, ?, ?)',
    [username, auth.hashPassword(password), str(body.display_name, 'display_name', { max: 64 }) || username, role,
      bool(body.status, 'status', true) ? 'active' : 'disabled']
  );
  await sysLog('warn', 'auth', `创建用户 ${username}（${role}，操作员 ${user.username}）`);
  return sanitize(await queryOne('SELECT id, username, display_name, role, status, created_at FROM xy_users WHERE id = ?', [r.insertId]));
}

async function updateUser(id, body, user) {
  const target = await queryOne('SELECT * FROM xy_users WHERE id = ?', [id]);
  if (!target) throw new ApiError(CODE.NOT_FOUND, '用户不存在');
  const role = body.role !== undefined ? enumOf(body.role, 'role', ['admin', 'operator']) : target.role;
  const status = body.status !== undefined ? enumOf(body.status, 'status', ['active', 'disabled']) : target.status;
  const displayName = body.display_name !== undefined ? str(body.display_name, 'display_name', { max: 64 }) : target.display_name;
  if ((target.role === 'admin') && (role !== 'admin' || status !== 'active') && target.id !== user.userId) {
    // 降级/禁用其他管理员前确认还剩其他管理员
    const admins = await adminCount();
    if (admins <= 1) throw new ApiError(CODE.BIZ_FAIL, '系统至少需要保留一个启用中的管理员');
  }
  await query('UPDATE xy_users SET role = ?, status = ?, display_name = ? WHERE id = ?', [role, status, displayName, id]);
  // 禁用/降级后使该用户全部会话失效
  if (status !== 'active' || (target.role === 'admin' && role !== 'admin')) {
    for (const [tk, s] of auth.sessions) {
      if (s.userId === Number(id)) auth.sessions.delete(tk);
    }
  }
  await sysLog('warn', 'auth', `更新用户 ${target.username}（role=${role}, status=${status}，操作员 ${user.username}）`);
  return sanitize(await queryOne('SELECT id, username, display_name, role, status, created_at FROM xy_users WHERE id = ?', [id]));
}

async function resetPassword(id, newPassword, user) {
  const target = await queryOne('SELECT * FROM xy_users WHERE id = ?', [id]);
  if (!target) throw new ApiError(CODE.NOT_FOUND, '用户不存在');
  if (String(newPassword || '').length < 6) throw new ApiError(CODE.BAD_REQUEST, '新密码至少 6 位');
  await query('UPDATE xy_users SET password_hash = ? WHERE id = ?', [auth.hashPassword(newPassword), id]);
  for (const [tk, s] of auth.sessions) {
    if (s.userId === Number(id)) auth.sessions.delete(tk);
  }
  await sysLog('warn', 'auth', `重置用户 ${target.username} 的密码（操作员 ${user.username}）`);
  return { id: Number(id), password_reset: true };
}

async function deleteUser(id, user) {
  const target = await queryOne('SELECT * FROM xy_users WHERE id = ?', [id]);
  if (!target) throw new ApiError(CODE.NOT_FOUND, '用户不存在');
  if (Number(id) === user.userId) throw new ApiError(CODE.BIZ_FAIL, '不能删除当前登录的账号');
  if (target.role === 'admin') {
    const admins = await adminCount();
    if (admins <= 1) throw new ApiError(CODE.BIZ_FAIL, '系统至少需要保留一个管理员');
  }
  await query('DELETE FROM xy_users WHERE id = ?', [id]);
  for (const [tk, s] of auth.sessions) {
    if (s.userId === Number(id)) auth.sessions.delete(tk);
  }
  await sysLog('warn', 'auth', `删除用户 ${target.username}（操作员 ${user.username}）`);
  return { id: Number(id) };
}

module.exports = { listUsers, createUser, updateUser, resetPassword, deleteUser };
