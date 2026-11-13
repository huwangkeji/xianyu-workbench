'use strict';
// M28 商品机会雷达：聚合市场/流量/CRM 信号，输出可执行的经营机会
const { query } = require('../db');
const crm = require('./crm');
const ai = require('./ai');

/**
 * 机会类型：
 * - demand_uncovered  上升关键词但我店无在架商品（建议上架）
 * - new_demand        近 7 天发现的新需求
 * - price_adjust      我的商品价格显著偏离市场（调价机会）
 * - hot_keyword       热度上升关键词（蹭流量）
 * - buyer_followup    高意向未成交买家（催单机会）
 */
async function opportunities() {
  const list = [];
  const kws = await query(
    `SELECT k.*,
       (SELECT COUNT(*) FROM xy_items i WHERE i.status = 'on_sale' AND i.title LIKE ('%' || k.keyword || '%')) AS my_item_count
     FROM xy_search_keywords k ORDER BY k.search_count DESC LIMIT 20`
  );
  for (const k of kws) {
    if (Number(k.my_item_count) === 0 && Number(k.search_count) >= 300) {
      list.push({
        type: 'demand_uncovered', score: Math.min(95, 50 + Math.round(Number(k.search_count) / 100)),
        title: `关键词「${k.keyword}」有需求无供给`,
        detail: `搜索热度 ${k.search_count}、趋势${k.trend === 'up' ? '上升' : '平稳'}，但我的在架商品未覆盖该关键词`,
        action: k.avg_price ? `参考市场均价 ¥${Number(k.avg_price).toFixed(2)} 上架相关商品` : '上架相关商品抢占搜索流量',
      });
    }
    if (k.trend === 'up' && Number(k.my_item_count) > 0) {
      list.push({
        type: 'hot_keyword', score: 60,
        title: `「${k.keyword}」热度上升`,
        detail: `当前搜索热度 ${k.search_count}`,
        action: '在相关商品标题/描述中强化该关键词，并增加擦亮频率',
      });
    }
  }

  const demands = await query("SELECT keyword, title, monthly_sales FROM xy_market_items WHERE kind = 'demand' AND last_seen_at >= datetime('now','localtime','-7 days') ORDER BY monthly_sales DESC LIMIT 5");
  for (const d of demands) {
    list.push({
      type: 'new_demand', score: 70,
      title: `新需求信号：${d.title}`,
      detail: `关键词「${d.keyword}」，热度 ${d.monthly_sales}`,
      action: '评估是否跟进该需求上架商品',
    });
  }

  // 我的在架商品 vs 市场均价（显著偏离 → 调价机会）
  const items = await query("SELECT id, title, price FROM xy_items WHERE status = 'on_sale'");
  const avgKws = await query('SELECT keyword, avg_price FROM xy_search_keywords WHERE avg_price IS NOT NULL');
  for (const it of items) {
    const hit = avgKws.find((k) => it.title.includes(k.keyword));
    if (!hit) continue;
    const rows = await query("SELECT price FROM xy_market_items WHERE keyword = ? AND status <> 'gone'", [hit.keyword]);
    if (rows.length < 2) continue;
    const avg = rows.reduce((a, b) => a + Number(b.price), 0) / rows.length;
    const diff = Math.round(((Number(it.price) - avg) / avg) * 100);
    if (diff > 20) {
      list.push({
        type: 'price_adjust', score: Math.min(90, 55 + diff),
        title: `「${it.title}」定价高于市场 ${diff}%`,
        detail: `我的价格 ¥${Number(it.price).toFixed(2)} vs 市场均价 ¥${avg.toFixed(2)}`,
        action: '降价或突出成色/附件差异化，提升转化',
      });
    } else if (diff < -30) {
      list.push({
        type: 'price_adjust', score: 55,
        title: `「${it.title}」定价低于市场 ${Math.abs(diff)}%`,
        detail: `可能存在利润空间损失`,
        action: '确认成本后可小幅上调价格',
      });
    }
  }

  const dueBuyers = await query(
    "SELECT id, buyer_nick, intention_score, category FROM xy_buyers WHERE converted = 0 AND status = 'active' AND intention_level = 'high' LIMIT 5"
  );
  for (const b of dueBuyers) {
    list.push({
      type: 'buyer_followup', score: 80,
      title: `高意向买家「${b.buyer_nick}」未成交`,
      detail: `意向 ${b.intention_score} 分，最近咨询分类：${b.category || '—'}`,
      action: '发送限时优惠或答疑，促成转化',
    });
  }

  list.sort((a, b) => b.score - a.score);
  return { total: list.length, opportunities: list.slice(0, 20), ai_available: await ai.hasDefaultProvider() };
}

module.exports = { opportunities };
