'use strict';
// 账号与凭证管理
// 安全：对外响应剥离 cookie 明文（cookie_set 表示是否已配置）；删除带预检计数与级联选项
const { query, queryOne, withTransaction, localDateTimeString } = require('../db');
const { ApiError, CODE, pageOf, paged, str, bool, enumOf, int } = require('../http/respond');
const { sysLog } = require('./logs');
const { getConnector } = require('../core/connector');
const manualMode = require('../core/manualMode');
const xianyuApi = require('./xianyuApi');
const { getMode } = require('./mode');
const { getSettings, updateSettings } = require('./settings');
const xianyuLive = require('../core/xianyuLive');

async function getAccount(id) {
  const row = await queryOne('SELECT * FROM xy_accounts WHERE id = ?', [id]);
  if (!row) throw new ApiError(CODE.NOT_FOUND, '账号不存在');
  return row;
}

/** Cookie 状态判定（供列表徽标）：unknown=未知(真实扫码账号), ok/expiring(≤48h)/expired */
function cookieState(row) {
  if (!row.cookie_expires_at) return { cookie_state: row.cookie ? 'unknown' : 'none', cookie_hours: null };
  const exp = new Date(String(row.cookie_expires_at).replace(' ', 'T')).getTime();
  if (!Number.isFinite(exp)) return { cookie_state: 'unknown', cookie_hours: null };
  const hours = Math.round((exp - Date.now()) / 3600000);
  if (hours <= 0) return { cookie_state: 'expired', cookie_hours: hours };
  if (hours < 48) return { cookie_state: 'expiring', cookie_hours: hours };
  return { cookie_state: 'ok', cookie_hours: hours };
}

/** 对外脱敏：剥离 cookie 明文，附加人工接管剩余信息 */
function sanitizeAccount(row) {
  if (!row) return row;
  const { cookie, ...rest } = row;
  const remainMs = manualMode.remaining(row.id);
  return {
    ...rest,
    cookie_set: !!cookie,
    paused: remainMs > 0,
    paused_minutes: remainMs > 0 ? Math.ceil(remainMs / 60000) : 0,
    ...cookieState(row),
  };
}

/** 内部含 cookie 的完整行 → 对外安全视图（qrlogin 等复用） */
function toPublicAccount(row) {
  return sanitizeAccount(row);
}

async function listAccounts(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const status = q.get('status');
  if (status) { where.push('status = ?'); params.push(status); }
  const kw = q.get('keyword');
  if (kw) { where.push('(nickname LIKE ? OR account_id LIKE ?)'); params.push(`%${kw}%`, `%${kw}%`); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_accounts WHERE ${whereSql}`, params);
  const settings = await getSettings();
  const defaultId = Number(settings.default_account_id) || 0;
  const list = await query(
    `SELECT a.*,
       (SELECT COUNT(*) FROM xy_items i WHERE i.account_id = a.id) AS item_count,
       (SELECT COUNT(*) FROM xy_conversations c WHERE c.account_id = a.id) AS conversation_count
     FROM xy_accounts a WHERE ${whereSql}
     ORDER BY a.id ASC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list.map((row) => ({ ...sanitizeAccount(row), is_default: Number(row.id) === defaultId })), totalRow.c, pg);
}

async function createAccount(body, user) {
  const accountId = str(body.account_id, 'account_id', { required: true, max: 80 });
  const exists = await queryOne('SELECT id FROM xy_accounts WHERE account_id = ?', [accountId]);
  if (exists) throw new ApiError(CODE.CONFLICT, '平台账号标识已存在');
  const r = await query(
    'INSERT INTO xy_accounts (account_id, nickname, cookie, cookie_expires_at, status, auto_reply_enabled, '
    + 'auto_delivery_enabled, auto_rate_enabled, reply_delay_min_ms, reply_delay_max_ms, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      accountId,
      str(body.nickname, 'nickname', { required: true, max: 128 }),
      str(body.cookie, 'cookie', { max: 16384 }) || 'demo-cookie-' + Date.now(),
      body.cookie_expires_at || null,
      'offline',
      bool(body.auto_reply_enabled, 'auto_reply_enabled', true) ? 1 : 0,
      bool(body.auto_delivery_enabled, 'auto_delivery_enabled', true) ? 1 : 0,
      bool(body.auto_rate_enabled, 'auto_rate_enabled', false) ? 1 : 0,
      int(body.reply_delay_min_ms, 'reply_delay_min_ms', { default: 0, min: 0, max: 60000 }),
      int(body.reply_delay_max_ms, 'reply_delay_max_ms', { default: 0, min: 0, max: 60000 }),
      str(body.remark, 'remark', { max: 255 }),
    ]
  );
  await sysLog('info', 'app', `新增账号 ${accountId}（操作员 ${user.username}）`);
  return sanitizeAccount(await getAccount(r.insertId));
}

async function updateAccount(id, body, user) {
  const acc = await getAccount(id);
  const nickname = body.nickname !== undefined ? str(body.nickname, 'nickname', { required: true, max: 128 }) : acc.nickname;
  // cookie 不回显：留空/缺省 = 保留原凭证
  const cookie = body.cookie !== undefined && String(body.cookie) !== '' ? str(body.cookie, 'cookie', { max: 16384 }) : acc.cookie;
  const remark = body.remark !== undefined ? str(body.remark, 'remark', { max: 255 }) : acc.remark;
  const autoReply = body.auto_reply_enabled !== undefined ? (bool(body.auto_reply_enabled, 'auto_reply_enabled') ? 1 : 0) : acc.auto_reply_enabled;
  const autoDelivery = body.auto_delivery_enabled !== undefined ? (bool(body.auto_delivery_enabled, 'auto_delivery_enabled') ? 1 : 0) : acc.auto_delivery_enabled;
  const autoRate = body.auto_rate_enabled !== undefined ? (bool(body.auto_rate_enabled, 'auto_rate_enabled') ? 1 : 0) : acc.auto_rate_enabled;
  // 账号级回复随机延迟覆盖（0 = 用全局设置）
  const delayMin = body.reply_delay_min_ms !== undefined ? int(body.reply_delay_min_ms, 'reply_delay_min_ms', { min: 0, max: 60000 }) : acc.reply_delay_min_ms;
  const delayMax = body.reply_delay_max_ms !== undefined ? int(body.reply_delay_max_ms, 'reply_delay_max_ms', { min: 0, max: 60000 }) : acc.reply_delay_max_ms;
  if (delayMin > delayMax) throw new ApiError(CODE.BAD_REQUEST, '回复延迟下限不能大于上限');
  await query(
    'UPDATE xy_accounts SET nickname = ?, cookie = ?, remark = ?, auto_reply_enabled = ?, '
    + "auto_delivery_enabled = ?, auto_rate_enabled = ?, reply_delay_min_ms = ?, reply_delay_max_ms = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [nickname, cookie, remark, autoReply, autoDelivery, autoRate, delayMin, delayMax, id]
  );
  await sysLog('info', 'app', `更新账号 #${id}（操作员 ${user.username}）`);
  return sanitizeAccount(await getAccount(id));
}

/** 删除预检：返回将被孤立/级联的业务数据计数 */
async function deletePrecheck(id) {
  const acc = await getAccount(id);
  const c = async (sql) => Number((await queryOne(sql, [id])).c);
  return {
    account: { id: acc.id, account_id: acc.account_id, nickname: acc.nickname },
    items: await c('SELECT COUNT(*) AS c FROM xy_items WHERE account_id = ?'),
    orders: await c('SELECT COUNT(*) AS c FROM xy_orders WHERE account_id = ?'),
    orders_active: await c("SELECT COUNT(*) AS c FROM xy_orders WHERE account_id = ? AND status IN ('pending_paid','paid','refunding')"),
    conversations: await c('SELECT COUNT(*) AS c FROM xy_conversations WHERE account_id = ?'),
    buyers: await c('SELECT COUNT(*) AS c FROM xy_buyers WHERE account_id = ?'),
    rules: await c('SELECT COUNT(*) AS c FROM xy_reply_rules WHERE account_id = ?'),
    card_products: await c('SELECT COUNT(*) AS c FROM xy_card_products WHERE item_id IN (SELECT id FROM xy_items WHERE account_id = ?)'),
  };
}

/**
 * 删除账号。
 * - 有进行中订单（待付款/待发货/售后中）→ 直接拒绝
 * - 有关联业务数据且未显式 cascade=true → 返回 40003 + 计数（前端弹后果确认）
 * - cascade=true → 按依赖顺序删除全部业务数据（回复/风控等历史日志保留）
 */
async function deleteAccount(id, user, options) {
  const pre = await deletePrecheck(id);
  if (pre.orders_active > 0) {
    throw new ApiError(CODE.CONFLICT, `该账号有 ${pre.orders_active} 个进行中订单（待付款/待发货/售后中），请先处理完再删除`);
  }
  const hasRelated = pre.items + pre.orders + pre.conversations + pre.buyers + pre.rules + pre.card_products > 0;
  const cascade = !!(options && options.cascade);
  if (hasRelated && !cascade) {
    throw new ApiError(CODE.CONFLICT, '该账号存在关联业务数据，请确认后选择级联删除', pre);
  }
  if (cascade) {
    await withTransaction(async (conn) => {
      await conn.query('DELETE FROM xy_card_codes WHERE product_id IN (SELECT id FROM xy_card_products WHERE item_id IN (SELECT id FROM xy_items WHERE account_id = ?))', [id]);
      await conn.query('DELETE FROM xy_card_products WHERE item_id IN (SELECT id FROM xy_items WHERE account_id = ?)', [id]);
      await conn.query('DELETE FROM xy_reply_rules WHERE account_id = ?', [id]);
      await conn.query('DELETE FROM xy_buyers WHERE account_id = ?', [id]);
      await conn.query('DELETE FROM xy_delivery_logs WHERE account_id = ?', [id]);
      await conn.query('DELETE FROM xy_orders WHERE account_id = ?', [id]);
      await conn.query('DELETE FROM xy_messages WHERE account_id = ?', [id]);
      await conn.query('DELETE FROM xy_conversations WHERE account_id = ?', [id]);
      await conn.query('DELETE FROM xy_item_stats_daily WHERE item_id IN (SELECT id FROM xy_items WHERE account_id = ?)', [id]);
      await conn.query('DELETE FROM xy_publish_logs WHERE account_id = ?', [id]);
      await conn.query('DELETE FROM xy_worry_free WHERE account_id = ?', [id]);
      await conn.query('DELETE FROM xy_items WHERE account_id = ?', [id]);
      await conn.query('DELETE FROM xy_accounts WHERE id = ?', [id]);
    });
  } else {
    await query('DELETE FROM xy_accounts WHERE id = ?', [id]);
  }
  // 被删账号若是默认账号，重置默认为全部账号
  const s = await getSettings();
  if (Number(s.default_account_id) === Number(id)) {
    await updateSettings({ default_account_id: '0' });
  }
  await sysLog('warn', 'app', `删除账号 ${pre.account.account_id}（${pre.account.nickname}，${cascade ? '含级联业务数据' : '无关联数据'}，操作员 ${user.username}）`);
  return { id: Number(id), cascade, counts: pre };
}

/** 上线/下线：上线前对真实账号强制校验凭证（掉线拒绝上线），并启停真实消息监听 */
async function toggleOnline(id, target, user) {
  const acc = await getAccount(id);
  if (acc.status === 'disabled') throw new ApiError(CODE.BIZ_FAIL, '账号已禁用，请先启用');
  if (target === 'online') {
    const check = await assertCanGoOnline(acc);
    await xianyuLive.startFor(acc); // 真实账号启动 WS 消息监听
    await sysLog('info', 'connector', `账号 ${acc.account_id} 已上线${check ? '（凭证真实校验通过）' : ''}，消息监听${xianyuLive.isRunning(acc.id) ? '已启动' : '未启动（非真实账号）'}（操作员 ${user.username}）`);
  } else {
    await xianyuLive.stopFor(acc.id);
    await sysLog('info', 'connector', `账号 ${acc.account_id} 已下线，消息监听停止（操作员 ${user.username}）`);
  }
  const status = target === 'online' ? 'online' : 'offline';
  await query(
    "UPDATE xy_accounts SET status = ?, last_active_at = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [status, status === 'online' ? localDateTimeString() : acc.last_active_at, id]
  );
  await sysLog('info', 'connector', `账号 ${acc.nickname} ${status === 'online' ? '上线' : '下线'}（模拟连接器，操作员 ${user.username}）`);
  return sanitizeAccount(await getAccount(id));
}

/** 刷新 Cookie：真实账号走闲鱼令牌接口真实刷新；演示账号仅演示模式允许模拟顺延 */
async function refreshCookie(id, user) {
  const acc = await getAccount(id);
  const hasRealCookie = !!acc.cookie && !/(demo=1|demo-cookie-)/.test(String(acc.cookie));
  if (hasRealCookie) {
    const r = await xianyuApi.refreshAccountCookie(acc);
    if (!r.ok) {
      await sysLog('warn', 'connector', `真实刷新 Cookie 失败：${acc.account_id}（${r.reason}，操作员 ${user.username}）`);
      throw new ApiError(CODE.BIZ_FAIL, `真实刷新失败：${r.reason}`);
    }
    await query('UPDATE xy_accounts SET cookie = ? WHERE id = ?', [r.cookie, acc.id]);
    await sysLog('info', 'connector', `真实刷新 Cookie 成功：${acc.account_id}（操作员 ${user.username}）`);
    return { account: sanitizeAccount(await getAccount(id)), message: 'Cookie 已真实刷新（凭证校验通过）' };
  }
  if (getMode() !== 'demo') {
    throw new ApiError(CODE.BIZ_FAIL, '该账号无真实 Cookie，生产模式不支持模拟刷新；请使用扫码登录或编辑真实 Cookie');
  }
  const connector = await getConnector();
  const r = await connector.refreshCookie(acc);
  await sysLog('info', 'connector', `模拟刷新 Cookie：账号 ${acc.nickname} 顺延 7 天（操作员 ${user.username}）`);
  return { account: sanitizeAccount(await getAccount(id)), message: 'Cookie 已刷新（演示模式，模拟顺延7天）' };
}

/** 上线前真实凭证校验（有真实 Cookie 的账号强制校验，失败拒绝上线） */
async function assertCanGoOnline(acc) {
  const hasRealCookie = !!acc.cookie && !/(demo=1|demo-cookie-)/.test(String(acc.cookie));
  if (!hasRealCookie) return null; // 演示/手填占位账号跳过
  const r = await xianyuApi.refreshAccountCookie(acc);
  if (!r.ok) throw new ApiError(CODE.BIZ_FAIL, `上线失败：${r.reason}`);
  if (r.cookie && r.cookie !== String(acc.cookie || '')) {
    await query('UPDATE xy_accounts SET cookie = ? WHERE id = ?', [r.cookie, acc.id]);
  }
  return r;
}

/** 人工接管：暂停该账号自动回复 N 分钟（0 = 立即恢复人工接管） */
async function pauseAccount(id, minutes, user) {
  const acc = await getAccount(id);
  const m = int(minutes, 'minutes', { required: true, min: 0, max: 24 * 60 });
  const r = manualMode.pause(id, m);
  if (r.paused) {
    await sysLog('warn', 'connector', `账号 ${acc.account_id}（${acc.nickname}）进入人工接管 ${m} 分钟，期间自动回复暂停（操作员 ${user.username}）`);
  } else {
    await sysLog('info', 'connector', `账号 ${acc.account_id}（${acc.nickname}）已恢复自动回复（操作员 ${user.username}）`);
  }
  return sanitizeAccount(await getAccount(id));
}

module.exports = { getAccount, toPublicAccount, listAccounts, createAccount, updateAccount, deletePrecheck, deleteAccount, toggleOnline, refreshCookie, pauseAccount };
