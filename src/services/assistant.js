'use strict';
// M25 每日运营助手：经营快照 + 今日待办 + 建议清单（形成决策闭环）；AI 解读可选
const { query, queryOne } = require('../db');
const analytics = require('./analytics');
const crm = require('./crm');
const ai = require('./ai');
const { getSettings } = require('./settings');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

async function dailyBrief() {
  const settings = await getSettings();
  const timeoutHours = Math.max(1, Number(settings.after_sales_timeout_hours) || 48);
  // 昨日经营
  const y = await queryOne(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(amount),0) AS revenue
     FROM xy_orders WHERE status IN ('delivered','completed') AND date(created_at) = date('now','localtime','-1 days')`
  );
  const profit30 = await analytics.profitSummary(1);
  // 今日待办
  const pendingDelivery = await queryOne("SELECT COUNT(*) AS c FROM xy_orders WHERE status = 'paid' AND delivery_status IN ('pending','failed')");
  const dueFollowups = await crm.dueFollowupCount();
  const overdueAftersales = await queryOne(
    "SELECT COUNT(*) AS c FROM xy_orders WHERE status = 'refunding' AND CAST((julianday(datetime('now','localtime')) - julianday(updated_at)) * 24 AS INTEGER) >= "
    + timeoutHours
  );
  const riskHigh = await queryOne("SELECT COUNT(*) AS c FROM xy_accounts WHERE status = 'error' OR (cookie_expires_at IS NOT NULL AND cookie_expires_at < datetime('now','localtime','+48 hours'))");
  // 低卡密库存预警：阈值读系统设置 card_stock_threshold
  const stockThreshold = Math.max(1, Number(settings.card_stock_threshold) || 5);
  const lowStock = await query(
    "SELECT p.name, COUNT(*) AS available FROM xy_card_codes cc JOIN xy_card_products p ON p.id = cc.product_id "
    + "WHERE cc.status = 'available' GROUP BY p.id HAVING COUNT(*) < " + stockThreshold + " ORDER BY available ASC LIMIT 3"
  );
  // 流量异动（近 7 天诊断）
  const diag = await analytics.trafficDiagnosis();
  // 竞品预警（近 24h 价格下降的竞品）
  const priceDrops = await query(
    "SELECT keyword, title, price, prev_price FROM xy_market_items WHERE kind = 'competitor' AND status = 'price_down' AND last_seen_at >= datetime('now','localtime','-24 hours') ORDER BY last_seen_at DESC LIMIT 5"
  );

  const todos = [];
  if (Number(pendingDelivery.c) > 0) todos.push({ type: 'delivery', level: 'high', text: `有 ${pendingDelivery.c} 笔订单待发货/补发` });
  if (dueFollowups > 0) todos.push({ type: 'crm', level: 'high', text: `${dueFollowups} 位未成交客户等待跟进` });
  if (Number(overdueAftersales.c) > 0) todos.push({ type: 'aftersale', level: 'high', text: `${overdueAftersales.c} 笔售后超过 ${timeoutHours} 小时未处理` });
  if (Number(riskHigh.c) > 0) todos.push({ type: 'risk', level: 'medium', text: `${riskHigh.c} 个账号存在异常或 Cookie 即将过期` });
  for (const s of lowStock) todos.push({ type: 'cards', level: 'medium', text: `卡密「${s.name}」库存偏低（仅剩 ${s.available} 张），建议尽快补货` });

  const suggestions = [];
  for (const f of diag.findings.filter((x) => x.severity === 'high').slice(0, 3)) {
    suggestions.push(`【${f.item_title}】${f.suggestion}`);
  }
  for (const d of priceDrops) {
    suggestions.push(`竞品降价提醒：「${d.keyword}」同类竞品降至 ¥${round2(d.price)}（原 ¥${round2(d.prev_price)}），关注价格竞争力`);
  }
  if (!suggestions.length) suggestions.push('今日无高优先级经营风险，保持擦亮与回复时效即可');

  return {
    date: new Date().toISOString().slice(0, 10),
    yesterday: { orders: Number(y.orders), revenue: round2(y.revenue), net_profit: profit30.net_profit },
    todos,
    traffic_findings: diag.findings.slice(0, 5),
    competitor_drops: priceDrops,
    suggestions,
    ai_available: await ai.hasDefaultProvider(),
  };
}

/** AI 解读：大模型基于简报数据输出经营解读与决策建议 */
async function dailyBriefAi() {
  const brief = await dailyBrief();
  const r = await ai.chat({
    system: '你是闲鱼店铺的运营助手。基于数据简报输出：1) 一段 80 字内的经营概览；2) 「今日建议」3-5 条，每条一行，具体可执行。不要客套话。',
    prompt: JSON.stringify(brief),
  });
  return { date: brief.date, provider: r.provider, content: r.content };
}

module.exports = { dailyBrief, dailyBriefAi };
