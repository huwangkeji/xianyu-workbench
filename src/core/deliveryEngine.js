'use strict';
// 自动发货引擎：已支付虚拟商品订单 → 锁定卡密（事务）→ 发送内容 → 更新订单/发货日志/通知
// 发货规则设计参考上游 auto_delivery_handler 与 aoofish「自动确认订单+卡密自动发放」（见 docs/01）
const { query, queryOne, withTransaction } = require('../db');
const { ApiError, CODE } = require('../http/respond');
const { ensureConversation, insertMessage } = require('../services/conversations');
const { sysLog } = require('../services/logs');
const { notifyEvent } = require('./notifier');

class InsufficientStockError extends Error {
  constructor(need, got) {
    super(`卡密库存不足：需要 ${need}，可用 ${got}`);
    this.shortOf = need - got;
  }
}

async function markFailed(order, reason) {
  await query(
    "UPDATE xy_orders SET delivery_status = 'failed', delivery_fail_reason = ? WHERE id = ?",
    [String(reason).slice(0, 500), order.id]
  );
  await query(
    "INSERT INTO xy_delivery_logs (order_no, account_id, item_id, status, retry_count, error_message) VALUES (?, ?, ?, 'failed', ?, ?)",
    [order.order_no, order.account_id, order.item_id, order.delivery_attempts || 0, String(reason).slice(0, 500)]
  );
}

/**
 * 处理订单发货（幂等防护：已发货订单直接拒绝）。
 * @param {string} orderNo 订单号
 * @returns {object} 发货结果
 */
async function processOrder(orderNo) {
  const order = await queryOne('SELECT * FROM xy_orders WHERE order_no = ?', [orderNo]);
  if (!order) throw new ApiError(CODE.NOT_FOUND, '订单不存在');
  if (order.status !== 'paid') {
    throw new ApiError(CODE.BIZ_FAIL, `订单状态为 ${order.status}，仅已支付(paid)订单可发货`);
  }
  if (!order.is_virtual) throw new ApiError(CODE.BIZ_FAIL, '非虚拟商品无需系统自动发货');
  if (order.delivery_status === 'sent') throw new ApiError(CODE.CONFLICT, '该订单已发货，请勿重复发货');

  const item = await queryOne('SELECT * FROM xy_items WHERE id = ?', [order.item_id]);
  if (!item) throw new ApiError(CODE.NOT_FOUND, '订单关联商品不存在');
  const account = await queryOne('SELECT * FROM xy_accounts WHERE id = ?', [order.account_id]);
  if (!account) throw new ApiError(CODE.NOT_FOUND, '订单关联账号不存在');

  await query('UPDATE xy_orders SET delivery_attempts = delivery_attempts + 1 WHERE id = ?', [order.id]);
  const attempts = Number(order.delivery_attempts || 0) + 1;

  if (!account.auto_delivery_enabled) {
    await markFailed(order, '账号未开启自动发货（自动发货需同时开启自动确认发货）');
    throw new ApiError(CODE.BIZ_FAIL, '账号未开启自动发货（自动发货需同时开启自动确认发货）');
  }

  const product = await queryOne('SELECT * FROM xy_card_products WHERE item_id = ? ORDER BY id ASC LIMIT 1', [item.id]);
  if (!product) {
    await markFailed(order, '该商品未配置卡券产品');
    throw new ApiError(CODE.BIZ_FAIL, '该商品未配置卡券产品');
  }

  const need = Math.max(1, Number(order.quantity) || 1);
  let codes;
  try {
    codes = await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        // SQLite 单写者模型：BEGIN IMMEDIATE 事务本身即互斥，无需 FOR UPDATE 锁提示
        "SELECT * FROM xy_card_codes WHERE product_id = ? AND status = 'available' ORDER BY id ASC LIMIT ?",
        [product.id, need]
      );
      if (rows.length < need) throw new InsufficientStockError(need, rows.length);
      for (const c of rows) {
        await conn.query(
          "UPDATE xy_card_codes SET status = 'sold', order_no = ?, buyer_nick = ?, sold_at = datetime('now','localtime') WHERE id = ?",
          [order.order_no, order.buyer_nick || '', c.id]
        );
      }
      return rows;
    });
  } catch (e) {
    if (e instanceof InsufficientStockError) {
      await markFailed(order, e.message);
      await notifyEvent('delivery_failed', `订单 ${order.order_no} 自动发货失败`, `${item.title}: ${e.message}`);
      throw new ApiError(CODE.BIZ_FAIL, e.message);
    }
    throw e;
  }

  const content = codes.map((c) => `${product.name}：${c.content}`).join('\n');
  await query(
    "UPDATE xy_orders SET delivery_status = 'sent', delivery_content = ?, delivery_fail_reason = NULL, "
    + "status = 'delivered', delivered_at = datetime('now','localtime') WHERE id = ?",
    [content, order.id]
  );
  const conv = await ensureConversation(account.id, {
    buyerId: order.buyer_id || 'BUYER-' + order.order_no,
    buyerNick: order.buyer_nick || '买家',
    itemId: order.item_id,
  });
  await insertMessage({
    conversationId: conv.id,
    accountId: account.id,
    direction: 'out',
    source: 'auto',
    msgType: 'text',
    content,
    itemId: order.item_id,
  });
  await query(
    "INSERT INTO xy_delivery_logs (order_no, account_id, item_id, card_code_id, content_sent, status, retry_count) "
    + "VALUES (?, ?, ?, ?, ?, 'success', ?)",
    [order.order_no, order.account_id, order.item_id, codes[0].id, content, attempts - 1]
  );
  await sysLog('info', 'delivery', `订单 ${order.order_no} 自动发货成功（卡密 ${codes.length} 张）`);
  return {
    order_no: order.order_no,
    delivery_status: 'sent',
    card_count: codes.length,
    card_contents: codes.map((c) => c.content),
    conversation_id: conv.id,
  };
}

module.exports = { processOrder, InsufficientStockError };
