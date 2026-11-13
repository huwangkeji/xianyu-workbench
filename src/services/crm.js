'use strict';
// M17 买家客户管理 CRM：咨询自动分类 / 意向识别 / 跟进提醒 / 常见问题统计
const { query, queryOne } = require('../db');
const { ApiError, CODE, pageOf, paged } = require('../http/respond');
const { getSettings } = require('../services/settings');
const { sysLog } = require('./logs');

const CLASSIFY_RULES = [
  { category: '售后',     words: ['退款', '退货', '坏了', '不能用', '投诉', '假货', '货不对版'], delta: 25 },
  { category: '议价',     words: ['便宜', '少点', '优惠', '价格', '刀', '折扣', '包圆'],        delta: 30 },
  { category: '发货咨询', words: ['发货', '快递', '物流', '到货', '几天到', '卡密', '兑换码'],  delta: 20 },
  { category: '售前咨询', words: ['在吗', '有货', '还能买', '尺寸', '成色', '怎么卖', '还在'],  delta: 10 },
];

/** 按消息内容分类，返回 { category, delta, keyword } */
function classifyMessage(text) {
  const t = String(text || '');
  for (const rule of CLASSIFY_RULES) {
    const hit = rule.words.find((w) => t.includes(w));
    if (hit) return { category: rule.category, delta: rule.delta, keyword: hit };
  }
  return { category: '闲聊', delta: 5, keyword: '' };
}

function levelOf(score) {
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  if (score > 0) return 'low';
  return 'unknown';
}

/**
 * 买家消息联动（由回复引擎在收到买家消息时调用）：
 * 更新/创建买家档案、累计意向分、刷新跟进提醒时间
 */
async function trackBuyerMessage(account, { buyerId, buyerNick, text }) {
  try {
    const settings = await getSettings();
    const followHours = Math.max(1, Number(settings.follow_up_hours) || 24);
    const { category, delta } = classifyMessage(text);
    const existing = await queryOne('SELECT * FROM xy_buyers WHERE account_id = ? AND buyer_id = ?', [account.id, buyerId]);
    if (!existing) {
      const score = Math.min(100, delta);
      await query(
        `INSERT INTO xy_buyers (account_id, buyer_id, buyer_nick, first_contact_at, last_contact_at,
           message_count_in, intention_score, intention_level, category, follow_up_at)
         VALUES (?, ?, ?, datetime('now','localtime'), datetime('now','localtime'), 1, ?, ?, ?,
           CASE WHEN ? > 0 THEN datetime('now','localtime','+' || ? || ' hours') ELSE NULL END)`,
        [account.id, buyerId, buyerNick, score, levelOf(score), category, 1, followHours]
      );
    } else {
      const score = Math.min(100, Number(existing.intention_score) + delta);
      await query(
        `UPDATE xy_buyers SET last_contact_at = datetime('now','localtime'), message_count_in = message_count_in + 1,
           intention_score = ?, intention_level = ?, category = ?,
           follow_up_at = CASE WHEN converted = 1 THEN follow_up_at ELSE datetime('now','localtime','+' || ? || ' hours') END
         WHERE id = ?`,
        [score, levelOf(score), category, followHours, existing.id]
      );
    }
  } catch (_) { /* CRM 联动失败不影响消息主流程 */ }
}

/** 客服发出消息联动（由会话服务调用） */
async function trackSellerMessage(accountId, buyerId) {
  try {
    await query(
      "UPDATE xy_buyers SET message_count_out = message_count_out + 1, last_contact_at = datetime('now','localtime') WHERE account_id = ? AND buyer_id = ?",
      [accountId, buyerId]
    );
  } catch (_) { /* ignore */ }
}

/** 订单成交联动（由订单服务调用）：成交加分并按新分数重新定级 */
async function markConverted(accountId, buyerId, orderNo) {
  try {
    const buyer = await queryOne('SELECT * FROM xy_buyers WHERE account_id = ? AND buyer_id = ?', [accountId, buyerId]);
    if (!buyer) return;
    const newScore = Math.min(100, Number(buyer.intention_score) + 20);
    await query(
      'UPDATE xy_buyers SET converted = 1, converted_order_no = ?, follow_up_at = NULL, '
      + 'intention_score = ?, intention_level = ? WHERE id = ?',
      [orderNo, newScore, levelOf(newScore), buyer.id]
    );
  } catch (_) { /* ignore */ }
}

/** 买家列表：filter=all|followup|converted|high */
async function listBuyers(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const filter = q.get('filter') || 'all';
  if (filter === 'followup') {
    where.push("b.converted = 0 AND b.status = 'active' AND b.follow_up_at IS NOT NULL AND b.follow_up_at <= datetime('now','localtime') AND b.followup_done_at IS NULL");
  } else if (filter === 'converted') {
    where.push('b.converted = 1');
  } else if (filter === 'high') {
    where.push("b.intention_level = 'high'");
  }
  const accountId = q.get('account_id');
  if (accountId) { where.push('b.account_id = ?'); params.push(Number(accountId)); }
  const kw = q.get('keyword');
  if (kw) { where.push('(b.buyer_nick LIKE ? OR b.buyer_id LIKE ?)'); params.push(`%${kw}%`, `%${kw}%`); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_buyers b WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT b.*, a.nickname AS account_nickname,
       (SELECT COUNT(*) FROM xy_conversations c WHERE c.account_id = b.account_id AND c.buyer_id = b.buyer_id) AS conversation_count
     FROM xy_buyers b LEFT JOIN xy_accounts a ON a.id = b.account_id
     WHERE ${whereSql}
     ORDER BY b.intention_score DESC, b.last_contact_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

/** 买家详情：档案 + 关联会话与最近消息（聊天记录归档视图） */
async function buyerDetail(id) {
  const buyer = await queryOne(
    'SELECT b.*, a.nickname AS account_nickname FROM xy_buyers b LEFT JOIN xy_accounts a ON a.id = b.account_id WHERE b.id = ?',
    [id]
  );
  if (!buyer) throw new ApiError(CODE.NOT_FOUND, '买家不存在');
  const conversations = await query(
    'SELECT c.*, i.title AS item_title FROM xy_conversations c LEFT JOIN xy_items i ON i.id = c.item_id '
    + 'WHERE c.account_id = ? AND c.buyer_id = ? ORDER BY c.updated_at DESC',
    [buyer.account_id, buyer.buyer_id]
  );
  const convIds = conversations.map((c) => c.id);
  let messages = [];
  if (convIds.length) {
    messages = await query(
      `SELECT m.* FROM xy_messages m WHERE m.conversation_id IN (${convIds.map(() => '?').join(',')}) ORDER BY m.id DESC LIMIT 100`,
      convIds
    );
  }
  return { buyer, conversations, messages: messages.reverse() };
}

/** 标记已跟进：立即结清本轮提醒，并按间隔排下一次 */
async function markFollowupDone(id, note, user) {
  const buyer = await queryOne('SELECT * FROM xy_buyers WHERE id = ?', [id]);
  if (!buyer) throw new ApiError(CODE.NOT_FOUND, '买家不存在');
  const settings = await getSettings();
  const followHours = Math.max(1, Number(settings.follow_up_hours) || 24);
  await query(
    "UPDATE xy_buyers SET followup_done_at = datetime('now','localtime'), follow_up_at = datetime('now','localtime','+' || ? || ' hours'), follow_up_note = ? WHERE id = ?",
    [followHours, String(note || buyer.follow_up_note || '').slice(0, 500), id]
  );
  await sysLog('info', 'app', `买家「${buyer.buyer_nick}」已标记跟进（操作员 ${user.username}）`);
  return { id: Number(id), next_follow_up_at: new Date(Date.now() + followHours * 3600 * 1000).toISOString() };
}

/** 买家常见问题统计 */
async function faqStats() {
  const categories = await query(
    "SELECT category, COUNT(*) AS buyer_count, SUM(converted = 1) AS converted_count FROM xy_buyers WHERE category <> '' GROUP BY category ORDER BY buyer_count DESC"
  );
  const topKeywords = await query(
    "SELECT matched_keyword AS keyword, COUNT(*) AS hit_count FROM xy_reply_logs WHERE matched_keyword <> '' GROUP BY matched_keyword ORDER BY hit_count DESC LIMIT 10"
  );
  const intention = await query(
    "SELECT intention_level, COUNT(*) AS buyer_count FROM xy_buyers GROUP BY intention_level"
  );
  return {
    categories,
    top_keywords: topKeywords,
    intention_levels: intention,
  };
}

/** 待跟进买家数（任务用） */
async function dueFollowupCount() {
  const row = await queryOne(
    "SELECT COUNT(*) AS c FROM xy_buyers WHERE converted = 0 AND status = 'active' AND follow_up_at IS NOT NULL AND follow_up_at <= datetime('now','localtime') AND followup_done_at IS NULL"
  );
  return Number(row.c);
}

module.exports = { classifyMessage, trackBuyerMessage, trackSellerMessage, markConverted, listBuyers, buyerDetail, markFollowupDone, faqStats, dueFollowupCount, CLASSIFY_RULES };
