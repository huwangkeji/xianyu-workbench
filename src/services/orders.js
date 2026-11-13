'use strict';
// 订单服务：查询 / 创建已支付订单（模拟）/ 手动发货 / 手动评价
const { query, queryOne } = require('../db');
const { ApiError, CODE, pageOf, paged, int } = require('../http/respond');
const { sysLog } = require('./logs');
const { notifyEvent } = require('../core/notifier');
const deliveryEngine = require('../core/deliveryEngine');
const crm = require('./crm');
const analytics = require('./analytics');
const { getSettings } = require('./settings');
const xianyuApi = require('./xianyuApi');

const ORDER_STATUSES = ['pending_paid', 'paid', 'delivered', 'completed', 'closed', 'refunding'];
const DELIVERY_STATUSES = ['none', 'pending', 'sent', 'failed'];

function genOrderNo() {
  return 'XYD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function listOrders(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const status = q.get('status');
  const delivery = q.get('delivery_status');
  const accountId = q.get('account_id');
  const itemId = q.get('item_id');
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (delivery) { where.push('o.delivery_status = ?'); params.push(delivery); }
  if (accountId) { where.push('o.account_id = ?'); params.push(Number(accountId)); }
  if (itemId) { where.push('o.item_id = ?'); params.push(Number(itemId)); }
  const kw = q.get('keyword');
  if (kw) { where.push('(o.order_no LIKE ? OR o.buyer_nick LIKE ?)'); params.push(`%${kw}%`, `%${kw}%`); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_orders o WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT o.*, i.title AS item_title, a.nickname AS account_nickname
     FROM xy_orders o
     LEFT JOIN xy_items i ON i.id = o.item_id
     LEFT JOIN xy_accounts a ON a.id = o.account_id
     WHERE ${whereSql}
     ORDER BY o.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

async function getOrder(orderNo) {
  const order = await queryOne(
    'SELECT o.*, i.title AS item_title, a.nickname AS account_nickname '
    + 'FROM xy_orders o LEFT JOIN xy_items i ON i.id = o.item_id LEFT JOIN xy_accounts a ON a.id = o.account_id '
    + 'WHERE o.order_no = ?',
    [orderNo]
  );
  if (!order) throw new ApiError(CODE.NOT_FOUND, '订单不存在');
  const deliveryLogs = await query('SELECT * FROM xy_delivery_logs WHERE order_no = ? ORDER BY id DESC', [orderNo]);
  return { ...order, delivery_logs: deliveryLogs };
}

/**
 * 创建已支付订单（模拟买家下单付款），虚拟商品立即触发自动发货流程。
 * 真实环境该事件应来自连接器（闲鱼 WebSocket 订单推送），见 docs/01 不确定项。
 */
async function createPaidOrder(account, item, payload) {
  const quantity = Math.min(99, Math.max(1, int(payload.quantity, 'quantity', { default: 1, min: 1 })));
  const buyerNick = String(payload.buyer_nick || '模拟买家').slice(0, 128);
  const buyerId = String(payload.buyer_id || 'BUYER-' + Date.now().toString(36)).slice(0, 80);
  const specValue = String(payload.spec_value || '默认规格').slice(0, 128);
  const isBargain = !!payload.is_bargain;
  const amount = (Number(item.price) * quantity).toFixed(2);
  const orderNo = genOrderNo();

  await query(
    `INSERT INTO xy_orders (order_no, account_id, item_id, buyer_id, buyer_nick, spec_name, spec_value,
      quantity, amount, status, is_virtual, is_bargain, delivery_status, source, placed_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, 'simulated', datetime('now','localtime'), datetime('now','localtime'))`,
    [orderNo, account.id, item.id, buyerId, buyerNick, '规格', specValue, quantity, amount,
      item.is_virtual ? 1 : 0, isBargain, item.is_virtual ? 'pending' : 'none']
  );
  await sysLog('info', 'app', `模拟订单已创建 ${orderNo}（${item.title} x${quantity}）`);
  await notifyEvent('new_order', `新订单 ${orderNo}`, `${item.title} x${quantity}，金额 ¥${amount}，买家 ${buyerNick}`);
  // M17 CRM / M14 流量统计联动
  await crm.markConverted(account.id, buyerId, orderNo);
  await analytics.recordOrderForStats(item.id, quantity, Number(amount));

  let deliveryResult = null;
  let deliveryError = null;
  if (item.is_virtual) {
    try {
      deliveryResult = await deliveryEngine.processOrder(orderNo);
    } catch (e) {
      deliveryError = e.message; // 发货失败不影响订单创建结果
    }
  }
  const order = await getOrder(orderNo);
  return { order, delivery_result: deliveryResult, delivery_error: deliveryError };
}

/** 手动发货（重试失败订单/补发） */
async function deliverManual(orderNo, user) {
  const result = await deliveryEngine.processOrder(orderNo);
  await sysLog('info', 'app', `人工触发发货 ${orderNo}（操作员 ${user ? user.username : '-'}）`);
  return result;
}

/** 手动评价 */
async function rateManual(orderNo, user) {
  const order = await queryOne('SELECT * FROM xy_orders WHERE order_no = ?', [orderNo]);
  if (!order) throw new ApiError(CODE.NOT_FOUND, '订单不存在');
  if (order.is_rated) throw new ApiError(CODE.CONFLICT, '该订单已评价');
  if (order.status !== 'delivered' && order.status !== 'completed') {
    throw new ApiError(CODE.BIZ_FAIL, `订单状态为 ${order.status}，仅已发货订单可评价`);
  }
  await query("UPDATE xy_orders SET is_rated = 1, rated_at = datetime('now','localtime') WHERE id = ?", [order.id]);
  await sysLog('info', 'app', `人工评价订单 ${orderNo}（操作员 ${user ? user.username : '-'}）`);
  return { order_no: orderNo, is_rated: true };
}

/** 标记退款/售后开单（利润分析记为退款损失；风险中心跟踪处理时效） */
async function markRefund(orderNo, user) {
  const order = await queryOne('SELECT * FROM xy_orders WHERE order_no = ?', [orderNo]);
  if (!order) throw new ApiError(CODE.NOT_FOUND, '订单不存在');
  if (!['delivered', 'completed', 'paid'].includes(order.status)) {
    throw new ApiError(CODE.BIZ_FAIL, `订单状态为 ${order.status}，不能标记退款`);
  }
  await query("UPDATE xy_orders SET status = 'refunding', updated_at = datetime('now','localtime') WHERE id = ?", [order.id]);
  await sysLog('warn', 'app', `订单 ${orderNo} 标记退款/售后开单（操作员 ${user ? user.username : '-'}）`);
  return { order_no: orderNo, status: 'refunding' };
}

/**
 * M27 售后纠纷处理：
 * - action=refund 同意退款 → status='refunded'（计入退款损失，闭环）
 * - action=reject 拒绝/协商完成 → status='completed'（记录协商备注）
 */
async function resolveAftersale(orderNo, body, user) {
  const order = await queryOne('SELECT * FROM xy_orders WHERE order_no = ?', [orderNo]);
  if (!order) throw new ApiError(CODE.NOT_FOUND, '订单不存在');
  if (order.status !== 'refunding') throw new ApiError(CODE.BIZ_FAIL, `订单状态为 ${order.status}，无进行中的售后`);
  const action = body.action;
  const note = String(body.note || '').slice(0, 500);
  if (action === 'refund') {
    await query(
      "UPDATE xy_orders SET status = 'refunded', aftersale_note = ?, aftersale_closed_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?",
      [note || '同意退款', order.id]
    );
    await sysLog('info', 'app', `售后处理：订单 ${orderNo} 同意退款（操作员 ${user.username}）`);
    return { order_no: orderNo, status: 'refunded', action };
  }
  if (action === 'reject') {
    await query(
      "UPDATE xy_orders SET status = 'completed', aftersale_note = ?, aftersale_closed_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?",
      [note || '协商完成，拒绝退款', order.id]
    );
    await sysLog('info', 'app', `售后处理：订单 ${orderNo} 拒绝退款/协商完成（操作员 ${user.username}）`);
    return { order_no: orderNo, status: 'completed', action };
  }
  throw new ApiError(CODE.BAD_REQUEST, 'action 必须是 refund/reject');
}

/** 售后纠纷中心数据：进行中（超时阈值读系统设置，支持 keyword 搜索订单号/买家）+ 已处理历史 */
async function aftersaleCenter(q) {
  const settings = await getSettings();
  const timeoutHours = Math.max(1, Number(settings.after_sales_timeout_hours) || 48);
  const kw = q && q.get ? q.get('keyword') : '';
  const kwWhere = kw ? ' AND (o.order_no LIKE ? OR o.buyer_nick LIKE ?)' : '';
  const kwParams = kw ? [`%${kw}%`, `%${kw}%`] : [];
  const ongoing = await query(
    `SELECT o.*, i.title AS item_title, a.nickname AS account_nickname,
       CAST((julianday(datetime('now','localtime')) - julianday(o.updated_at)) * 24 AS INTEGER) AS hours_open
     FROM xy_orders o LEFT JOIN xy_items i ON i.id = o.item_id LEFT JOIN xy_accounts a ON a.id = o.account_id
     WHERE o.status = 'refunding'${kwWhere} ORDER BY o.updated_at ASC`,
    kwParams
  );
  const resolved = await query(
    `SELECT o.*, i.title AS item_title, a.nickname AS account_nickname
     FROM xy_orders o LEFT JOIN xy_items i ON i.id = o.item_id LEFT JOIN xy_accounts a ON a.id = o.account_id
     WHERE o.status IN ('refunded','closed') OR (o.status = 'completed' AND o.aftersale_closed_at IS NOT NULL)
     ORDER BY o.aftersale_closed_at DESC LIMIT 50`
  );
  const stats = {
    timeout_hours: timeoutHours,
    ongoing: ongoing.length,
    overdue: ongoing.filter((o) => Number(o.hours_open) >= timeoutHours).length,
    resolved_refund: resolved.filter((o) => o.status === 'refunded').length,
    resolved_reject: resolved.filter((o) => o.status === 'completed').length,
  };
  return { stats, ongoing, resolved };
}

/** 订单导出（CSV，按当前筛选条件，最多 5000 行） */
async function exportOrders(q) {
  const where = ['1=1'];
  const params = [];
  const status = q.get('status');
  const deliveryStatus = q.get('delivery_status');
  const accountId = q.get('account_id');
  const kw = q.get('keyword');
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (deliveryStatus) { where.push('o.delivery_status = ?'); params.push(deliveryStatus); }
  if (accountId) { where.push('o.account_id = ?'); params.push(Number(accountId)); }
  if (kw) { where.push('(o.order_no LIKE ? OR o.buyer_nick LIKE ?)'); params.push(`%${kw}%`, `%${kw}%`); }
  const rows = await query(
    `SELECT o.order_no, o.status, o.delivery_status, o.quantity, o.amount, o.buyer_nick, o.buyer_id,
       o.is_virtual, o.is_rated, o.placed_at, o.paid_at, o.delivered_at, o.created_at,
       i.title AS item_title, a.nickname AS account_nickname
     FROM xy_orders o LEFT JOIN xy_items i ON i.id = o.item_id LEFT JOIN xy_accounts a ON a.id = o.account_id
     WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT 5000`,
    params
  );
  return rows;
}

/**
 * 同步账号平台订单（历史订单 + 实时状态，含售前/售后）：
 * 从闲鱼「卖出订单」接口分页拉取，按平台订单号 upsert 入库；平台商品 ID 关联本地商品。
 * 仅支持有真实 Cookie 的账号。返回 { api_used, total, added, updated }。
 */
async function syncAccountOrders(accountId, user, opts = {}) {
  const accounts = await getAccountsForSync(accountId);
  if (!accounts.length) {
    throw new ApiError(CODE.BIZ_FAIL, '没有可同步的账号（需要已扫码登录且有真实 Cookie 的账号）');
  }
  const result = { api_used: '', total: 0, added: 0, updated: 0, accounts: [] };
  for (const account of accounts) {
    const r = await syncOneAccountOrders(account, user, opts.maxPages || 10);
    if (!r.ok) {
      result.accounts.push({ account_id: account.account_id, ok: false, reason: r.reason });
      continue;
    }
    if (!result.api_used) result.api_used = r.api_used;
    result.total += r.total;
    result.added += r.added;
    result.updated += r.updated;
    result.accounts.push({ account_id: account.account_id, ok: true, total: r.total, added: r.added, updated: r.updated });
  }
  if (result.total === 0 && result.accounts.every((a) => !a.ok)) {
    const firstFail = result.accounts[0];
    throw new ApiError(CODE.BIZ_FAIL, `同步失败：${firstFail ? firstFail.reason : '所有账号均同步失败'}`);
  }
  await sysLog('info', 'connector', `同步平台订单：共 ${result.total} 单（新增 ${result.added}，更新 ${result.updated}，接口 ${result.api_used || '-'}，操作员 ${user ? user.username : '-'}）`);
  return result;
}

/** 同步目标账号：指定 ID 取单个（校验真实 Cookie），否则取所有真实账号 */
async function getAccountsForSync(accountId) {
  const { getAccount } = require('./accounts');
  if (accountId) {
    const acc = await getAccount(Number(accountId));
    const hasRealCookie = !!acc.cookie && !/(demo=1|demo-cookie-)/.test(String(acc.cookie));
    if (!hasRealCookie) throw new ApiError(CODE.BIZ_FAIL, '该账号无真实 Cookie 凭证，无法同步平台订单（请使用扫码登录添加账号）');
    return [acc];
  }
  const rows = await query('SELECT * FROM xy_accounts WHERE status <> \'deleted\'');
  return rows.filter((a) => !!a.cookie && !/(demo=1|demo-cookie-)/.test(String(a.cookie)));
}

/** 单账号订单同步：卖出订单分页拉取 + 退款/售后列表 + upsert */
async function syncOneAccountOrders(account, user, maxPages) {
  const seen = new Map(); // order_no -> { added, updated }
  let added = 0;
  let updated = 0;
  let total = 0;
  let apiUsed = '';
  for (let page = 1; page <= maxPages; page++) {
    const r = await xianyuApi.fetchAccountOrders(account, { page });
    if (!r.ok) return { ok: false, reason: `账号 ${account.account_id}：${r.reason}`, api_used: r.api_used || apiUsed };
    apiUsed = r.api_used || apiUsed;
    for (const o of r.orders) {
      const res = await upsertSyncedOrder(account, o);
      if (res === 'added') added++;
      else if (res === 'updated') updated++;
      seen.set(o.order_no, res);
    }
    total += r.orders.length;
    if (!r.nextPage) break;
  }
  // 售后/退款单：统一按 refunding 状态 upsert（覆盖交易成功后发起的售后）
  const rf = await xianyuApi.fetchAccountRefunds(account, { page: 1, rowsPerPage: 20 });
  if (rf.ok) {
    apiUsed = apiUsed || rf.api_used;
    for (const o of rf.orders) {
      const res = await upsertSyncedOrder(account, o);
      if (res === 'added') added++;
      else if (res === 'updated') updated++;
      total += 1;
    }
  } else {
    await sysLog('warn', 'connector', `账号 ${account.account_id} 退款列表拉取失败（不影响卖出订单同步）: ${rf.reason}`);
  }
  return { ok: true, total, added, updated, api_used: apiUsed };
}

/** 订单 upsert（source=sync）：新单插入并通知；老单状态/金额变化更新 */
async function upsertSyncedOrder(account, o) {
  const exists = await queryOne('SELECT id, status, amount FROM xy_orders WHERE order_no = ?', [o.order_no]);
  if (exists) {
    const amount = o.price > 0 ? o.price : exists.amount;
    if (exists.status !== o.status || Number(amount) !== Number(exists.amount)) {
      await query(
        "UPDATE xy_orders SET status = ?, amount = ?, buyer_id = CASE WHEN ? <> '' THEN ? ELSE buyer_id END, "
        + "buyer_nick = CASE WHEN ? <> '' THEN ? ELSE buyer_nick END, status_text = ?, "
        + "updated_at = datetime('now','localtime') WHERE id = ?",
        [o.status, amount, o.buyer_id, o.buyer_id, o.buyer_nick, o.buyer_nick, o.status_text, exists.id]
      );
      await sysLog('info', 'connector', `订单 ${o.order_no} 同步更新：${exists.status} → ${o.status}${o.status_text ? `（${o.status_text}）` : ''}`);
      return 'updated';
    }
    return 'kept';
  }
  // 关联本地商品（平台商品 ID 匹配），金额缺省时记 0（详情接口后续补全）
  let localItemId = 0;
  let isVirtual = 0;
  if (o.item_platform_id) {
    const it = await queryOne('SELECT id, is_virtual FROM xy_items WHERE item_id = ?', [o.item_platform_id]);
    if (it) { localItemId = it.id; isVirtual = it.is_virtual; }
  }
  await query(
    `INSERT INTO xy_orders (order_no, account_id, item_id, buyer_id, buyer_nick, quantity, amount, status, is_virtual, delivery_status, source, status_text, placed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 'sync', ?, ?)`,
    [o.order_no, account.id, localItemId, o.buyer_id, o.buyer_nick, o.quantity || 1, o.price, o.status, isVirtual, o.status_text, o.placed_at]
  );
  await notifyEvent('new_order', `同步新增订单 ${o.order_no}`, `${o.title || '平台商品'}，金额 ¥${o.price}，买家 ${o.buyer_nick}（${o.status_text || o.status}）`);
  return 'added';
}

/** 订单售前/售后统计（订单页概览卡） */
async function orderStats(q) {
  const accountId = q && q.get ? q.get('account_id') : '';
  const where = accountId ? 'WHERE o.account_id = ?' : '';
  const params = accountId ? [Number(accountId)] : [];
  const rows = await query(`SELECT o.status, COUNT(*) AS c FROM xy_orders o ${where} GROUP BY o.status`, params);
  const by = {};
  for (const r of rows) by[r.status] = Number(r.c);
  return {
    presale: {
      pending_paid: by.pending_paid || 0,
      paid: by.paid || 0,
      delivered: by.delivered || 0,
    },
    aftersale: {
      refunding: by.refunding || 0,
      refunded: by.refunded || 0,
      closed: by.closed || 0,
    },
    completed: by.completed || 0,
    total: rows.reduce((s, r) => s + Number(r.c), 0),
  };
}

module.exports = { listOrders, getOrder, createPaidOrder, deliverManual, rateManual, markRefund, resolveAftersale, aftersaleCenter, exportOrders, syncAccountOrders, orderStats, genOrderNo, ORDER_STATUSES, DELIVERY_STATUSES };
