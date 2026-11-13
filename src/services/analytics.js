'use strict';
// M14 商品流量分析 + M18 经营利润分析
const { query, queryOne } = require('../db');
const { ApiError, CODE } = require('../http/respond');
const { getSettings } = require('./settings');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const pct = (a, b) => (b > 0 ? round2((a / b) * 100) : 0);

// ---------------- M14 流量分析 ----------------

/** 商品流量总览（近 days 天聚合） */
async function trafficOverview(days) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const rows = await query(
    `SELECT i.id AS item_id, i.title, i.price, i.is_virtual, a.nickname AS account_nickname,
       COALESCE(SUM(s.exposure), 0)  AS exposure,
       COALESCE(SUM(s.views), 0)     AS views,
       COALESCE(SUM(s.favorites), 0) AS favorites,
       COALESCE(SUM(s.inquiries), 0) AS inquiries,
       COALESCE(SUM(s.orders), 0)    AS orders,
       COALESCE(SUM(s.amount), 0)    AS amount
     FROM xy_items i
     LEFT JOIN xy_item_stats_daily s ON s.item_id = i.id AND s.stat_date >= date('now','localtime','-' || ? || ' days')
     LEFT JOIN xy_accounts a ON a.id = i.account_id
     GROUP BY i.id, i.title, i.price, i.is_virtual, a.nickname
     ORDER BY exposure DESC, i.id ASC`,
    [d]
  );
  return rows.map((r) => ({
    ...r,
    exposure: Number(r.exposure),
    views: Number(r.views),
    favorites: Number(r.favorites),
    inquiries: Number(r.inquiries),
    orders: Number(r.orders),
    amount: round2(r.amount),
    ctr: pct(Number(r.views), Number(r.exposure)) / 100,       // 点击率 = 浏览/曝光
    cvr: pct(Number(r.orders), Number(r.views)) / 100,         // 成交转化率 = 成交/浏览
    inquiry_rate: pct(Number(r.inquiries), Number(r.views)) / 100,
  }));
}

/** 单商品近 N 天趋势 */
async function itemTrend(itemId, days) {
  const d = Math.min(90, Math.max(1, Number(days) || 7));
  const item = await queryOne('SELECT id, title FROM xy_items WHERE id = ?', [itemId]);
  if (!item) throw new ApiError(CODE.NOT_FOUND, '商品不存在');
  const rows = await query(
    'SELECT stat_date, exposure, views, favorites, inquiries, orders, amount '
    + "FROM xy_item_stats_daily WHERE item_id = ? AND stat_date >= date('now','localtime','-' || ? || ' days') "
    + 'ORDER BY stat_date ASC',
    [itemId, d]
  );
  return { item, rows };
}

/**
 * 流量诊断：
 * - 高曝光低点击（曝光≥1000 且 点击率<3%）→ 标题/首图问题
 * - 高浏览低成交（浏览≥50 且 转化率<2%）→ 价格/描述/信任问题
 * - 流量下滑（近3天曝光较前3天下降>25%）→ 竞争/权重问题
 */
async function trafficDiagnosis() {
  const rows = await trafficOverview(7);
  const findings = [];
  for (const r of rows) {
    if (r.exposure >= 1000 && r.ctr < 0.03) {
      findings.push({
        type: 'high_exposure_low_ctr', severity: 'high', item_id: r.item_id, item_title: r.title,
        metric: `曝光 ${r.exposure}，点击率 ${(r.ctr * 100).toFixed(1)}%`,
        message: '商品曝光充足但点击率偏低，买家刷到却没有点进来',
        suggestion: '优化首图吸引力（白底实拍/突出卖点），并在标题前部加入差异化的关键词与利益点（如【自动发货】）',
      });
    }
    if (r.views >= 50 && r.cvr < 0.02) {
      findings.push({
        type: 'high_views_low_cvr', severity: 'high', item_id: r.item_id, item_title: r.title,
        metric: `浏览 ${r.views}，成交 ${r.orders} 单，转化率 ${(r.cvr * 100).toFixed(1)}%`,
        message: '买家点进来却不下单，问题集中在价格竞争力、描述可信度或咨询响应',
        suggestion: '对照市场同款价格区间调整定价，补全描述（成色/交易方式/发货时效），并开启自动回复抓住每一次咨询',
      });
    }
  }
  // 流量下滑检测（按日对比）
  const daily = await query(
    'SELECT item_id, stat_date, exposure FROM xy_item_stats_daily '
    + "WHERE stat_date >= date('now','localtime','-7 days') ORDER BY item_id ASC, stat_date ASC"
  );
  const byItem = new Map();
  for (const row of daily) {
    if (!byItem.has(row.item_id)) byItem.set(row.item_id, []);
    byItem.get(row.item_id).push(Number(row.exposure));
  }
  for (const [itemId, arr] of byItem) {
    if (arr.length < 6) continue;
    const prev3 = arr.slice(0, 3).reduce((a, b) => a + b, 0);
    const last3 = arr.slice(-3).reduce((a, b) => a + b, 0);
    if (prev3 >= 300 && last3 / prev3 < 0.75) {
      const r = rows.find((x) => x.item_id === itemId);
      const drop = Math.round((1 - last3 / prev3) * 100);
      findings.push({
        type: 'traffic_decline', severity: 'medium', item_id: itemId, item_title: r ? r.title : `商品#${itemId}`,
        metric: `近3天曝光 ${last3}，较前3天 ${prev3} 下降 ${drop}%`,
        message: '商品流量持续下滑，可能是同类竞品增多或商品权重下降',
        suggestion: '保持定时擦亮提升权重，考虑调整价格或重新编辑商品（更换首图/标题）获取新流量',
      });
    }
  }
  const summary = {
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    total: findings.length,
  };
  return { summary, findings, scanned_at: new Date().toISOString() };
}

/** 商品优化建议（流量漏斗 + 商品体检联动） */
async function trafficSuggestions(itemId) {
  const rows = await trafficOverview(7);
  const r = rows.find((x) => x.item_id === Number(itemId));
  if (!r) throw new ApiError(CODE.NOT_FOUND, '商品不存在或暂无流量数据');
  const suggestions = [];
  if (r.exposure > 0 && r.ctr < 0.03) {
    suggestions.push({ area: '点击率', message: `点击率仅 ${(r.ctr * 100).toFixed(1)}%（行业参考 ≥5%）：重拍首图、标题前置卖点关键词` });
  }
  if (r.views >= 50 && r.cvr < 0.02) {
    suggestions.push({ area: '转化率', message: `浏览 ${r.views} 次仅成交 ${r.orders} 单：核对价格竞争力与描述完整度，及时回复咨询` });
  }
  if (r.inquiries > 0 && r.orders === 0) {
    suggestions.push({ area: '咨询转化', message: `有 ${r.inquiries} 次咨询未成交：检查回复话术，对意向客户在「客户管理」中标记跟进` });
  }
  if (r.exposure === 0) {
    suggestions.push({ area: '曝光', message: '近 7 天无曝光数据：商品可能已下架或权重过低，建议擦亮并重新上架' });
  } else {
    suggestions.push({ area: '曝光', message: `近 7 天曝光 ${r.exposure} 次，收藏 ${r.favorites} 次（收藏率 ${(pct(r.favorites, r.views) / 100).toFixed(1)}%）` });
  }
  return { item: { id: r.item_id, title: r.title }, funnel: r, suggestions };
}

/** 流量统计写入（模拟控制台/采集任务调用），按天 upsert */
async function upsertItemStats({ item_id, date, exposure, views, favorites, inquiries, orders, amount }) {
  const item = await queryOne('SELECT id FROM xy_items WHERE id = ?', [item_id]);
  if (!item) throw new ApiError(CODE.NOT_FOUND, '商品不存在');
  const statDate = date || new Date().toISOString().slice(0, 10);
  await query(
    `INSERT INTO xy_item_stats_daily (item_id, stat_date, exposure, views, favorites, inquiries, orders, amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, stat_date) DO UPDATE SET
       exposure = exposure + excluded.exposure, views = views + excluded.views,
       favorites = favorites + excluded.favorites, inquiries = inquiries + excluded.inquiries,
       orders = orders + excluded.orders, amount = amount + excluded.amount`,
    [item_id, statDate, Math.max(0, Number(exposure) || 0), Math.max(0, Number(views) || 0),
      Math.max(0, Number(favorites) || 0), Math.max(0, Number(inquiries) || 0),
      Math.max(0, Number(orders) || 0), round2(amount)]
  );
  return { item_id: Number(item_id), stat_date: statDate };
}

/** 订单产生时联动累计（由订单服务调用） */
async function recordOrderForStats(itemId, quantity, amount) {
  try {
    await upsertItemStats({
      item_id: itemId, exposure: 0, views: 0, favorites: 0, inquiries: 0,
      orders: quantity, amount,
    });
  } catch (_) { /* 统计失败不影响订单 */ }
}

// ---------------- M18 利润分析 ----------------

async function profitSummary(days) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const settings = await getSettings();
  const feeRate = (Number(settings.platform_fee_rate_pct) || 0) / 100;
  const rows = await query(
    `SELECT o.status, o.quantity, o.amount, i.cost_price, i.shipping_cost
     FROM xy_orders o JOIN xy_items i ON i.id = o.item_id
     WHERE o.status IN ('delivered','completed','refunding','refunded')
       AND o.created_at >= datetime('now','localtime','-' || ? || ' days')`,
    [d]
  );
  let revenue = 0, cost = 0, shipping = 0, fees = 0, refundLoss = 0, orderCount = 0, refundCount = 0;
  for (const r of rows) {
    const amount = Number(r.amount) || 0;
    const qty = Number(r.quantity) || 1;
    // 货物与运费/包装成本：成交单与退款单都已发生
    cost += (Number(r.cost_price) || 0) * qty;
    shipping += (Number(r.shipping_cost) || 0) * qty;
    if (r.status === 'delivered' || r.status === 'completed') {
      revenue += amount;
      fees += amount * feeRate;
      orderCount++;
    } else if (r.status === 'refunding' || r.status === 'refunded') {
      refundLoss += amount;      // 退款损失（货款退还）
      refundCount++;
    }
  }
  const net = revenue - cost - shipping - fees - refundLoss;
  return {
    days: d,
    order_count: orderCount,
    refund_count: refundCount,
    revenue: round2(revenue),
    cost: round2(cost),
    shipping: round2(shipping),
    fees: round2(fees),
    fee_rate_pct: Number(settings.platform_fee_rate_pct) || 0,
    refund_loss: round2(refundLoss),
    net_profit: round2(net),
    margin: revenue > 0 ? round2((net / revenue) * 100) : 0,
  };
}

async function profitByItem(days) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const settings = await getSettings();
  const feeRate = (Number(settings.platform_fee_rate_pct) || 0) / 100;
  const rows = await query(
    `SELECT i.id AS item_id, i.title, i.cost_price, i.shipping_cost,
       COALESCE(SUM(CASE WHEN o.status IN ('delivered','completed') THEN o.quantity ELSE 0 END), 0) AS sold_qty,
       COALESCE(SUM(CASE WHEN o.status IN ('delivered','completed') THEN o.amount ELSE 0 END), 0) AS revenue,
       COALESCE(SUM(CASE WHEN o.status IN ('refunding','refunded') THEN o.amount ELSE 0 END), 0) AS refund_amount,
       COALESCE(SUM(CASE WHEN o.status IN ('refunding','refunded') THEN o.quantity ELSE 0 END), 0) AS refund_qty
     FROM xy_items i
     LEFT JOIN xy_orders o ON o.item_id = i.id AND o.status IN ('delivered','completed','refunding','refunded')
       AND o.created_at >= datetime('now','localtime','-' || ? || ' days')
     GROUP BY i.id, i.title, i.cost_price, i.shipping_cost
     HAVING SUM(CASE WHEN o.status IN ('delivered','completed') THEN o.quantity ELSE 0 END) > 0
         OR SUM(CASE WHEN o.status IN ('refunding','refunded') THEN o.quantity ELSE 0 END) > 0
     ORDER BY revenue DESC`,
    [d]
  );
  return rows.map((r) => {
    const revenue = Number(r.revenue);
    const soldQty = Number(r.sold_qty);
    const refundQty = Number(r.refund_qty);
    const refundAmount = Number(r.refund_amount);
    const cost = (Number(r.cost_price) || 0) * (soldQty + refundQty);
    const shipping = (Number(r.shipping_cost) || 0) * (soldQty + refundQty);
    const fees = revenue * feeRate;
    const net = revenue - cost - shipping - fees - refundAmount;
    return {
      item_id: r.item_id,
      title: r.title,
      sold_qty: soldQty,
      revenue: round2(revenue),
      cost: round2(cost),
      shipping: round2(shipping),
      fees: round2(fees),
      refund_loss: round2(refundAmount),
      net_profit: round2(net),
      margin: revenue > 0 ? round2((net / revenue) * 100) : 0,
    };
  });
}

module.exports = {
  trafficOverview, itemTrend, trafficDiagnosis, trafficSuggestions,
  upsertItemStats, recordOrderForStats,
  profitSummary, profitByItem,
};
