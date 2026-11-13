'use strict';
// M20 商品经营诊断（核心差异化）：流量漏斗 + 商品体检 + 价格 + 咨询转化 + 利润 的综合诊断
const { query, queryOne } = require('../db');
const { ApiError, CODE } = require('../http/respond');
const analytics = require('./analytics');
const optimizer = require('./optimizer');
const ai = require('./ai');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * 单商品综合诊断：
 * 聚合体检得分、流量漏斗（点击率/转化率/下滑）、价格竞争力、咨询转化、利润率，
 * 输出问题列表 + 按优先级排序的行动清单
 */
async function diagnoseItem(itemId) {
  const item = await queryOne('SELECT * FROM xy_items WHERE id = ?', [itemId]);
  if (!item) throw new ApiError(CODE.NOT_FOUND, '商品不存在');

  const findings = [];
  const actions = [];

  // 1) 商品体检（标题/描述/首图/违禁词/发货能力）
  const check = await optimizer.checkItem(itemId);
  for (const f of check.findings) findings.push({ area: '商品质量', severity: f.severity, message: f.message });

  // 2) 流量漏斗（近 7 天）
  const tRows = await analytics.trafficOverview(7);
  const t = tRows.find((x) => x.item_id === Number(itemId));
  let funnel = null;
  if (t) {
    funnel = t;
    if (t.exposure > 0 && t.ctr < 0.03) {
      findings.push({ area: '流量', severity: 'high', message: `点击率仅 ${(t.ctr * 100).toFixed(1)}%（曝光 ${t.exposure}）` });
      actions.push({ priority: 1, area: '流量', action: '重做首图并前置卖点关键词，提升点击率' });
    }
    if (t.views >= 50 && t.cvr < 0.02) {
      findings.push({ area: '转化', severity: 'high', message: `浏览 ${t.views} 次成交 ${t.orders} 单，转化率 ${(t.cvr * 100).toFixed(1)}%` });
      actions.push({ priority: 1, area: '转化', action: '核对价格竞争力与描述可信度，开启自动回复承接咨询' });
    }
  } else {
    findings.push({ area: '流量', severity: 'medium', message: '近 7 天无流量数据（商品可能下架或无曝光）' });
  }

  // 3) 价格竞争力（对照市场）
  try {
    const kws = await query('SELECT keyword FROM xy_search_keywords WHERE avg_price IS NOT NULL');
    const hitKw = kws.find((k) => item.title.includes(k.keyword));
    if (hitKw) {
      const rows = await query("SELECT price FROM xy_market_items WHERE keyword = ? AND status <> 'gone'", [hitKw.keyword]);
      if (rows.length >= 2) {
        const avg = rows.reduce((a, b) => a + Number(b.price), 0) / rows.length;
        const diff = Math.round(((Number(item.price) - avg) / avg) * 100);
        if (diff > 20) {
          findings.push({ area: '价格', severity: 'medium', message: `价格高于「${hitKw.keyword}」市场均价 ${diff}%` });
          actions.push({ priority: 2, area: '价格', action: `参考市场均价 ¥${round2(avg)} 调价，或突出成色/附件差异化` });
        }
      }
    }
  } catch (_) { /* 行情缺失不阻断诊断 */ }

  // 4) 咨询转化（有咨询无成交）
  if (t && t.inquiries > 0 && t.orders === 0) {
    findings.push({ area: '咨询', severity: 'medium', message: `${t.inquiries} 次咨询未产生成交` });
    actions.push({ priority: 2, area: '咨询', action: '在「客户中心」对意向买家标记跟进，发送限时优惠促成' });
  }

  // 5) 利润（近 30 天）
  try {
    const byItem = await analytics.profitByItem(30);
    const p = byItem.find((x) => x.item_id === Number(itemId));
    if (p && p.sold_qty > 0) {
      if (p.margin < 0) {
        findings.push({ area: '利润', severity: 'high', message: `当前定价下净利润为负（¥${p.net_profit}，利润率 ${p.margin}%）` });
        actions.push({ priority: 1, area: '利润', action: '用「利润计算器」重算保本价，提价或压缩成本' });
      } else if (p.margin < 10) {
        findings.push({ area: '利润', severity: 'low', message: `利润率仅 ${p.margin}%，抗风险能力弱` });
      }
    }
  } catch (_) { /* ignore */ }

  // 汇总
  const sevWeight = { high: 22, medium: 10, low: 3 };
  const score = Math.max(0, check.score - findings.reduce((a, f) => a + (sevWeight[f.severity] || 0), 0) + (check.finding_count === 0 ? 0 : 0));
  const grade = score >= 85 ? '优秀' : score >= 70 ? '良好' : score >= 50 ? '待优化' : '高风险';
  // 行动清单：体检建议 + 专项 action，按优先级
  for (const f of check.findings.slice(0, 3)) {
    actions.push({ priority: f.severity === 'high' ? 1 : f.severity === 'medium' ? 2 : 3, area: '商品质量', action: f.suggestion });
  }
  actions.sort((a, b) => a.priority - b.priority);

  return {
    item: { id: item.id, title: item.title, price: item.price, goods_condition: item.goods_condition, status: item.status },
    score, grade,
    finding_count: findings.length,
    findings,
    actions: actions.slice(0, 6),
    funnel,
    check_score: check.score,
    ai_available: await ai.hasDefaultProvider(),
  };
}

/** AI 诊断处方：基于诊断结果让大模型生成经营处方 */
async function diagnoseItemAi(itemId) {
  const d = await diagnoseItem(itemId);
  const r = await ai.chat({
    system: '你是闲鱼店铺经营顾问。基于给出的诊断 JSON，输出一份「经营处方」：不超过 5 条，每条一行，格式「[领域] 动作（预期效果）」。直接输出，不要开场白。',
    prompt: JSON.stringify({ 商品: d.item, 得分: d.score, 问题: d.findings, 现有建议: d.actions, 近7天流量: d.funnel ? { 曝光: d.funnel.exposure, 浏览: d.funnel.views, 成交: d.funnel.orders } : null }),
  });
  const prescriptions = r.content.split(/\r?\n/).map((s) => s.replace(/^[-•\d.\s]+/, '').trim()).filter(Boolean).slice(0, 5);
  return { item: d.item, provider: r.provider, prescriptions };
}

/** 全店诊断总览：在架商品按综合得分升序（最需要处理的在前） */
async function diagnosisOverview() {
  const items = await query("SELECT id, title, price FROM xy_items WHERE status = 'on_sale' ORDER BY id ASC");
  const rows = [];
  for (const it of items) {
    try {
      const d = await diagnoseItem(it.id);
      rows.push({
        item_id: d.item.id, title: d.item.title, price: d.item.price,
        score: d.score, grade: d.grade, finding_count: d.finding_count,
        top_finding: d.findings[0] ? `${d.findings[0].area}：${d.findings[0].message}` : '—',
        top_action: d.actions[0] ? d.actions[0].action : '—',
      });
    } catch (_) { /* 单品失败不阻断总览 */ }
  }
  rows.sort((a, b) => a.score - b.score);
  const summary = {
    total: rows.length,
    high_risk: rows.filter((r) => r.grade === '高风险').length,
    need_optimize: rows.filter((r) => r.grade === '待优化').length,
    good: rows.filter((r) => r.grade === '良好' || r.grade === '优秀').length,
  };
  return { summary, rows };
}

module.exports = { diagnoseItem, diagnoseItemAi, diagnosisOverview };
