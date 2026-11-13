'use strict';
// 经营驾驶舱：店铺经营总览 + 六大模块实时指标 + 今日简报/待办
const { queryOne, query } = require('../db');
const analytics = require('./analytics');
const crm = require('./crm');
const assistant = require('./assistant');
const riskcenter = require('./riskcenter');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

async function overview() {
  const [profit, traffic, risk, accounts, items, buyers, marketStats, messagesToday, pendingDelivery, cardStock] = await Promise.all([
    analytics.profitSummary(30),
    analytics.trafficOverview(7),
    riskcenter.scanRiskCenter(),
    queryOne("SELECT COUNT(*) AS total, SUM(status='online') AS online FROM xy_accounts"),
    queryOne("SELECT COUNT(*) AS total, SUM(is_virtual=1) AS virtual_cnt, SUM(status='on_sale') AS on_sale FROM xy_items"),
    queryOne("SELECT COUNT(*) AS total, SUM(intention_level='high') AS high, SUM(converted=1) AS converted FROM xy_buyers"),
    queryOne("SELECT (SELECT COUNT(*) FROM xy_search_keywords) AS keywords, (SELECT COUNT(*) FROM xy_market_items WHERE kind='competitor') AS competitors, (SELECT COUNT(*) FROM xy_market_items WHERE kind='demand') AS demands, (SELECT COUNT(*) FROM xy_market_items WHERE kind='competitor' AND status='price_down' AND last_seen_at >= datetime('now','localtime','-24 hours')) AS recent_price_drops"),
    queryOne("SELECT COUNT(*) AS c FROM xy_messages WHERE created_at >= date('now','localtime')"),
    queryOne("SELECT COUNT(*) AS c FROM xy_orders WHERE status='paid' AND delivery_status IN ('pending','failed')"),
    queryOne("SELECT COUNT(*) AS c FROM xy_card_codes WHERE status='available'"),
  ]);
  const dueFollowups = await crm.dueFollowupCount();

  const totals = traffic.reduce((a, t) => ({
    exposure: a.exposure + Number(t.exposure),
    views: a.views + Number(t.views),
    inquiries: a.inquiries + Number(t.inquiries),
    orders: a.orders + Number(t.orders),
    amount: a.amount + Number(t.amount),
  }), { exposure: 0, views: 0, inquiries: 0, orders: 0, amount: 0 });

  const modules = {
    items: {
      label: '商品中心', href: '#/items',
      stats: { 在架商品: Number(items.on_sale), 虚拟商品: Number(items.virtual_cnt), 在线账号: `${Number(accounts.online)}/${Number(accounts.total)}`, 可用卡密: Number(cardStock.c) },
    },
    traffic: {
      label: '流量中心', href: '#/traffic',
      stats: { 近7天曝光: totals.exposure, 浏览: totals.views, 成交: totals.orders, 成交额: '¥' + round2(totals.amount) },
    },
    market: {
      label: '市场雷达', href: '#/market',
      stats: { 监控关键词: Number(marketStats.keywords), 竞品: Number(marketStats.competitors), '24h降价': Number(marketStats.recent_price_drops), 新需求: Number(marketStats.demands) },
    },
    crm: {
      label: '客户中心', href: '#/crm',
      stats: { 买家档案: Number(buyers.total), 高意向: Number(buyers.high), 已成交: Number(buyers.converted), 待跟进: dueFollowups },
    },
    profit: {
      label: '利润中心', href: '#/profit',
      stats: { 近30天收入: '¥' + round2(profit.revenue), 净利润: '¥' + round2(profit.net_profit), 利润率: profit.margin + '%', 退款损失: '¥' + round2(profit.refund_loss) },
    },
    risk: {
      label: '风险中心', href: '#/riskcenter',
      stats: { 高危: risk.summary.high, 中危: risk.summary.medium, 类别: risk.summary.group_count },
    },
  };

  const brief = await assistant.dailyBrief();

  return {
    top: {
      accounts: { total: Number(accounts.total), online: Number(accounts.online) },
      profit_30d: { revenue: profit.revenue, net: profit.net_profit, margin: profit.margin },
      messages_today: Number(messagesToday.c),
      pending_delivery: Number(pendingDelivery.c),
      risk: risk.summary,
      traffic_7d: { ...totals, ctr: totals.exposure > 0 ? round2(totals.views / totals.exposure * 100) : 0, cvr: totals.views > 0 ? round2(totals.orders / totals.views * 100) : 0 },
    },
    modules,
    brief,
  };
}

module.exports = { overview };
