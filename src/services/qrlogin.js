'use strict';
// 扫码登录闲鱼账号：参照 xianyu-super-butler 的 utils/qr_login.py 移植（Node 原生 fetch，零新依赖）
// 流程：h5 取 m_h5_tk 种子 → mini_login.htm 取表单参数 → generate.do 生成二维码 → query.do 轮询扫码状态
// 会话保存在内存（与登录会话同约定：重启即失效；二维码本身 5 分钟过期）
// 边界说明：本服务只负责「登录凭证获取」；业务连接器（WebSocket/自动回复真实链路）仍维持 connector.js 的 simulated/50101 边界
const crypto = require('crypto');
const { ApiError, CODE, isApiError } = require('../http/respond');
const { query, queryOne, localDateTimeString } = require('../db');
const { getAccount, toPublicAccount } = require('./accounts');
const { sysLog } = require('./logs');
const logger = require('../logger');

const PASSPORT_HOST = 'https://passport.goofish.com';
const API_MINI_LOGIN = `${PASSPORT_HOST}/mini_login.htm`;
const API_GENERATE_QR = `${PASSPORT_HOST}/newlogin/qrcode/generate.do`;
const API_SCAN_STATUS = `${PASSPORT_HOST}/newlogin/qrcode/query.do`;
const API_H5_TK = 'https://h5api.m.goofish.com/h5/mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get/1.0/';
const H5_API_NAME = 'mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get';
const APP_KEY = '34839810';
const SESSION_TTL_MS = 5 * 60 * 1000;
const POLL_THROTTLE_MS = 800;
const UPSTREAM_TIMEOUT_MS = 10 * 1000;

// 请求头照抄 qr_login.py generate_headers()（Node fetch 自动处理压缩，不手工设 Accept-Encoding）
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://passport.goofish.com/',
  'Origin': 'https://passport.goofish.com',
};

/** sessionId -> 会话（waiting/scanned/success/expired/cancelled/verification_required/failed） */
const sessions = new Map();

// ---------------- 工具 ----------------

function md5(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

/** 把响应的 Set-Cookie 并入会话 cookie 表 */
function mergeSetCookie(session, res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    const semi = value.indexOf(';');
    if (semi >= 0) value = value.slice(0, semi);
    session.cookies[name] = value.trim();
  }
}

function cookieHeader(session) {
  return Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function cookieString(session) {
  return cookieHeader(session);
}

async function upstreamFetch(url, { method = 'GET', extraHeaders = {}, body = null, session = null, withCookies = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers = { ...BASE_HEADERS, ...extraHeaders };
    if (withCookies && session && Object.keys(session.cookies).length) {
      headers.Cookie = cookieHeader(session);
    }
    return await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

function sweepExpired() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.status !== 'success' && now - s.createdAt > SESSION_TTL_MS) {
      s.status = 'expired';
    }
    if (s.status !== 'waiting' && s.status !== 'scanned' && now - s.createdAt > 30 * 60 * 1000) {
      sessions.delete(id); // 终态会话保留 30 分钟供查询，之后清理
    }
  }
}

function isTerminal(status) {
  return status === 'success' || status === 'expired' || status === 'cancelled'
    || status === 'verification_required' || status === 'failed';
}

// ---------------- 上游四步 ----------------

/** 步骤 1：h5 首页接口拿 m_h5_tk 种子并正式调用一次（确保 token 有效） */
async function fetchSeedToken(session) {
  const dataStr = '{"bizScene":"home"}';
  const res = await upstreamFetch(API_H5_TK, { session, withCookies: true });
  mergeSetCookie(session, res);
  await res.arrayBuffer().catch(() => {});

  const rawTk = session.cookies._m_h5_tk || session.cookies.m_h5_tk || '';
  const token = rawTk.split('_')[0] || '';
  const t = String(Date.now());
  const sign = md5(`${token}&${t}&${APP_KEY}&${dataStr}`);
  const qs = new URLSearchParams({
    jsv: '2.7.2', appKey: APP_KEY, t, sign, v: '1.0', type: 'originaljson',
    dataType: 'json', timeout: '20000', api: H5_API_NAME, data: dataStr,
  });
  const res2 = await upstreamFetch(`${API_H5_TK}?${qs}`, { method: 'POST', session, withCookies: true });
  mergeSetCookie(session, res2);
  await res2.arrayBuffer().catch(() => {});
}

/** 步骤 2：mini_login.htm 页面里提取 loginFormData 表单参数 */
async function fetchLoginParams(session) {
  const qs = new URLSearchParams({
    lang: 'zh_cn', appName: 'xianyu', appEntrance: 'web', styleType: 'vertical',
    bizParams: '', notLoadSsoView: 'False', notKeepLogin: 'False', isMobile: 'False',
    qrCodeFirst: 'False', stie: '77', rnd: String(Math.random()),
  });
  const res = await upstreamFetch(`${API_MINI_LOGIN}?${qs}`, { session, withCookies: true });
  mergeSetCookie(session, res);
  const html = await res.text();
  const m = html.match(/window\.viewData\s*=\s*(\{.*?\});/);
  if (!m) throw new ApiError(CODE.BIZ_FAIL, '获取闲鱼登录参数失败（登录页结构可能已变化）');
  let viewData;
  try {
    viewData = JSON.parse(m[1]);
  } catch (_) {
    throw new ApiError(CODE.BIZ_FAIL, '解析闲鱼登录参数失败');
  }
  const formData = viewData && viewData.loginFormData;
  if (!formData || typeof formData !== 'object') {
    throw new ApiError(CODE.BIZ_FAIL, '闲鱼登录参数缺失（loginFormData）');
  }
  formData.umidTag = 'SERVER';
  return formData;
}

/** 步骤 3：generate.do 生成二维码（codeContent 即二维码内容） */
async function generateQr(session) {
  const qs = new URLSearchParams(session.loginForm);
  const res = await upstreamFetch(`${API_GENERATE_QR}?${qs}`);
  const j = await res.json().catch(() => null);
  const content = j && j.content;
  const data = content && content.data;
  if (!content || content.success !== true || !data || !data.codeContent) {
    logger.warn('login', `二维码生成接口异常响应: ${JSON.stringify(j).slice(0, 300)}`);
    throw new ApiError(CODE.BIZ_FAIL, '获取闲鱼登录二维码失败');
  }
  session.params.t = data.t;
  session.params.ck = data.ck;
  session.qrContent = data.codeContent;
  mergeSetCookie(session, res);
}

/** 步骤 4：query.do 轮询一次扫码状态，返回 { data, res } */
async function pollUpstream(session) {
  const form = new URLSearchParams({ ...session.loginForm, t: session.params.t, ck: session.params.ck });
  const res = await upstreamFetch(API_SCAN_STATUS, {
    method: 'POST',
    session,
    withCookies: true,
    extraHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const j = await res.json().catch(() => null);
  const data = j && j.content && j.content.data ? j.content.data : null;
  return { data, res };
}

// ---------------- 账号落库 ----------------

/** 尽力从确认响应里挖昵称，挖不到用「闲鱼账号+unb后4位」占位（后续可编辑） */
function extractNickname(data, unb) {
  const cands = [data && (data.nick || data.nickname || data.nickName || data.userName || data.displayName)];
  const info = data && data.userInfo;
  if (info && typeof info === 'object') {
    cands.push(info.nick, info.nickname, info.nickName, info.userName, info.displayName);
  }
  const nick = cands.find((v) => typeof v === 'string' && v.trim());
  return nick ? nick.trim().slice(0, 128) : `闲鱼账号${String(unb).slice(-4)}`;
}

/** 按 unb 去重落库：已存在则更新 cookie 并恢复在线（重新扫码即修复异常/掉线状态），不存在则新建 */
async function saveAccount(session, data) {
  const cookieStr = cookieString(session);
  const unb = String(session.unb);
  const xianyuLive = require('../core/xianyuLive'); // 惰性引入避免循环依赖
  const exists = await queryOne('SELECT id, status FROM xy_accounts WHERE account_id = ?', [unb]);
  let account;
  if (exists) {
    // 重新扫码 = 凭证已换新：清掉异常/离线状态与旧的过期时间估计，恢复在线并重启消息监听
    await query(
      "UPDATE xy_accounts SET cookie = ?, status = 'online', cookie_expires_at = NULL, last_active_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?",
      [cookieStr, exists.id]
    );
    account = await getAccount(exists.id);
    const started = await xianyuLive.startFor(account).catch(() => false);
    await sysLog('info', 'login', `扫码登录：账号 ${unb} 已存在，凭证已更新并恢复在线（消息监听${xianyuLive.isRunning(account.id) ? '已启动' : '未启动'}，操作员 ${session.operator}）`);
  } else {
    const nickname = extractNickname(data, unb);
    const r = await query(
      'INSERT INTO xy_accounts (account_id, nickname, cookie, status, last_active_at) VALUES (?, ?, ?, ?, datetime(\'now\',\'localtime\'))',
      [unb, nickname, cookieStr, 'online']
    );
    account = await getAccount(r.insertId);
    await xianyuLive.startFor(account).catch(() => { });
    await sysLog('info', 'login', `扫码登录：新增账号 ${unb}（${account.nickname}，在线，操作员 ${session.operator}）`);
  }

  // 尽力校验+补全：带新 cookie 调一次 h5 接口，把响应里刷新的 cookie（如 _m_h5_tk）并回去
  try {
    const dataStr = '{"bizScene":"home"}';
    const rawTk = session.cookies._m_h5_tk || session.cookies.m_h5_tk || '';
    const token = rawTk.split('_')[0] || '';
    const t = String(Date.now());
    const sign = md5(`${token}&${t}&${APP_KEY}&${dataStr}`);
    const qs = new URLSearchParams({
      jsv: '2.7.2', appKey: APP_KEY, t, sign, v: '1.0', type: 'originaljson',
      dataType: 'json', timeout: '20000', api: H5_API_NAME, data: dataStr,
    });
    const res = await upstreamFetch(`${API_H5_TK}?${qs}`, { method: 'POST', session, withCookies: true });
    const before = cookieString(session);
    mergeSetCookie(session, res);
    await res.arrayBuffer().catch(() => {});
    const after = cookieString(session);
    if (after !== before) {
      await query('UPDATE xy_accounts SET cookie = ? WHERE id = ?', [after, account.id]);
    }
    logger.info('login', `扫码 cookie 校验调用完成（账号 ${unb}）`);
  } catch (e) {
    logger.warn('login', `扫码 cookie 校验调用失败（忽略）: ${e && e.message}`);
  }
  return account;
}

// ---------------- 对外 API ----------------

function buildStatus(session) {
  const out = {
    status: session.status,
    session_id: session.id,
    remain_seconds: Math.max(0, Math.round((session.createdAt + SESSION_TTL_MS - Date.now()) / 1000)),
  };
  if (session.status === 'verification_required' && session.verificationUrl) {
    out.verification_url = session.verificationUrl;
  }
  if (session.status === 'success') {
    out.unb = session.unb;
    out.account = session.account ? toPublicAccount(session.account) : null; // 脱敏：不回传 cookie 明文
  }
  return out;
}

/** 发起扫码登录：走完上游 1-3 步，返回二维码内容（前端本地渲染成二维码图片） */
async function startLogin(user) {
  sweepExpired();
  const session = {
    id: crypto.randomUUID(),
    status: 'waiting',
    cookies: {},
    loginForm: null,
    params: {},
    unb: null,
    qrContent: null,
    account: null,
    verificationUrl: null,
    operator: user ? user.username : '-',
    createdAt: Date.now(),
    lastPollAt: 0,
  };
  try {
    await fetchSeedToken(session);
    session.loginForm = await fetchLoginParams(session);
    await generateQr(session);
  } catch (e) {
    const msg = e && e.name === 'AbortError'
      ? '连接闲鱼超时，请检查本机网络后重试'
      : (e && e.message) || '生成二维码失败';
    if (!isApiError(e)) {
      logger.error('login', `扫码登录二维码生成失败: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    }
    throw isApiError(e) ? e : new ApiError(CODE.BIZ_FAIL, msg);
  }
  sessions.set(session.id, session);
  sysLog('info', 'login', `发起扫码登录会话 ${session.id.slice(0, 8)}…（操作员 ${session.operator}）`);
  return {
    session_id: session.id,
    qr_content: session.qrContent,
    expires_in: Math.round(SESSION_TTL_MS / 1000),
  };
}

/** 查询扫码状态（惰性轮询：每次查询最多向上游 query.do 发一次请求，800ms 节流） */
async function pollStatus(sessionId) {
  sweepExpired();
  const session = sessions.get(String(sessionId || ''));
  if (!session) {
    throw new ApiError(CODE.NOT_FOUND, '扫码会话不存在或已清理，请重新生成二维码');
  }
  if (isTerminal(session.status)) return buildStatus(session);
  if (session.status === 'expired') return buildStatus(session);

  const now = Date.now();
  if (now - session.createdAt > SESSION_TTL_MS) {
    session.status = 'expired';
    return buildStatus(session);
  }
  if (now - session.lastPollAt < POLL_THROTTLE_MS) return buildStatus(session);
  session.lastPollAt = now;

  let result;
  try {
    result = await pollUpstream(session);
  } catch (e) {
    // 瞬时网络异常不打断会话，保持当前状态等下一次轮询
    logger.warn('login', `扫码状态轮询上游失败（保持状态 ${session.status}）: ${e && e.message}`);
    return buildStatus(session);
  }

  const { data, res } = result;
  const st = data && data.qrCodeStatus;
  if (st === 'SCANED') {
    session.status = 'scanned';
  } else if (st === 'EXPIRED') {
    session.status = 'expired';
  } else if (st === 'CONFIRMED') {
    if (data.iframeRedirect === true) {
      session.status = 'verification_required';
      session.verificationUrl = data.iframeRedirectUrl || null;
      sysLog('warn', 'login', `扫码登录触发风控验证（会话 ${session.id.slice(0, 8)}…）`);
    } else {
      mergeSetCookie(session, res);
      session.unb = session.cookies.unb || null;
      if (!session.unb) {
        session.status = 'failed';
        sysLog('error', 'login', `扫码登录确认成功但未捕获 unb cookie（会话 ${session.id.slice(0, 8)}…）`);
      } else {
        session.status = 'success';
        try {
          session.account = await saveAccount(session, data);
        } catch (e) {
          logger.error('login', `扫码登录账号入库失败: ${e && e.message}`);
          session.status = 'failed';
        }
      }
    }
  } else if (st && st !== 'NEW') {
    // 其余状态视为用户取消
    session.status = 'cancelled';
  }
  return buildStatus(session);
}

// ---------------- 账号可用性检查 ----------------

const xianyuApi = require('./xianyuApi');

/** 是否真实扫码账号（account_id 为纯数字 unb）；演示/手填账号为 false */
function isRealAccount(account) {
  return /^\d+$/.test(String(account.account_id || ''));
}

/** 是否携带非演示占位的真实 Cookie */
function hasRealCookie(account) {
  return !!account.cookie && !/(demo=1|demo-cookie-)/.test(String(account.cookie));
}

/**
 * 单账号可用性检查（不抛异常，结果里给原因）：
 * - 演示/手填账号（cookie 为占位串）：按 status 与 cookie_expires_at 模拟判定
 * - 真实账号（有真实 Cookie）：调用消息令牌接口验证凭证有效性，成功则合并刷新的 Set-Cookie
 */
async function checkAccountAvailability(account) {
  const checkedAt = localDateTimeString();
  if (!hasRealCookie(account)) {
    let available = account.status === 'online';
    let reason = `演示/模拟账号（无真实凭证），按当前状态判定：${account.status === 'online' ? '在线' : account.status === 'error' ? '异常' : '离线'}`;
    if (account.cookie_expires_at) {
      const expired = new Date(String(account.cookie_expires_at).replace(' ', 'T')).getTime() < Date.now();
      if (expired) {
        available = false;
        reason = '演示账号 Cookie 已过期（模拟判定为掉线）';
      }
    }
    return { available, simulated: true, reason, checked_at: checkedAt };
  }

  const r = await xianyuApi.refreshAccountCookie(account);
  if (r.ok && r.cookie && r.cookie !== String(account.cookie || '')) {
    await query('UPDATE xy_accounts SET cookie = ? WHERE id = ?', [r.cookie, account.id]);
  }
  return {
    available: !!r.ok,
    simulated: false,
    reason: r.ok ? '凭证有效（token 接口调用成功）' : r.reason,
    ret: r.ret,
    checked_at: checkedAt,
  };
}

/** 按账号 id 检查并落日志；可用时刷新 last_active_at，异常账号自动恢复在线并重启监听 */
async function checkAccountById(id, user) {
  const account = await getAccount(id);
  const r = await checkAccountAvailability(account);
  if (r.available) {
    await query("UPDATE xy_accounts SET last_active_at = datetime('now','localtime') WHERE id = ?", [account.id]);
    // 检查通过但账号仍处于异常态（此前误判掉线或已恢复）→ 自动恢复在线并重启消息监听
    if (account.status === 'error') {
      const xianyuLive = require('../core/xianyuLive');
      await query("UPDATE xy_accounts SET status = 'online', updated_at = datetime('now','localtime') WHERE id = ?", [account.id]);
      await xianyuLive.startFor(await getAccount(account.id)).catch(() => { });
      await sysLog('info', 'connector', `账号 ${account.account_id} 凭证恢复有效，已自动由异常恢复在线（消息监听${xianyuLive.isRunning(account.id) ? '已启动' : '未启动'}，操作员 ${user ? user.username : '-'}）`);
      r.recovered = true;
    }
  }
  sysLog(r.available ? 'info' : 'warn', 'connector',
    `可用性检查：账号 ${account.account_id}（${account.nickname}）${r.available ? '可用' : '不可用'} — ${r.reason}（操作员 ${user ? user.username : '-'}）`);
  return {
    account_id: account.id,
    account_identifier: account.account_id,
    nickname: account.nickname,
    status: r.available ? 'online' : account.status,
    cookie_state: cookieStateOf(account),
    ...r,
  };
}

/** 简版 cookie 状态（检查结果用） */
function cookieStateOf(account) {
  if (!account.cookie_expires_at) return account.cookie ? 'unknown' : 'none';
  const exp = new Date(String(account.cookie_expires_at).replace(' ', 'T')).getTime();
  if (!Number.isFinite(exp)) return 'unknown';
  const hours = (exp - Date.now()) / 3600000;
  if (hours <= 0) return 'expired';
  if (hours < 48) return 'expiring';
  return 'ok';
}

/** 批量检查全部账号 */
async function checkAllAccounts(user) {
  const list = await query('SELECT * FROM xy_accounts ORDER BY id ASC');
  const results = [];
  for (const acc of list) {
    const r = await checkAccountById(acc.id, user);
    results.push(r);
  }
  return {
    results,
    summary: {
      total: results.length,
      available: results.filter((r) => r.available).length,
      unavailable: results.filter((r) => !r.available).length,
    },
  };
}

module.exports = { startLogin, pollStatus, sessions, checkAccountById, checkAllAccounts, isRealAccount, hasRealCookie };
