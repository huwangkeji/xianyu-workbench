'use strict';
// M21 利润计算器 / M23 商品智能估价 / M24 标题图片实验室
const { query, queryOne } = require('../db');
const { ApiError, CODE } = require('../http/respond');
const { getSettings } = require('./settings');
const ai = require('./ai');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ---------------- M21 利润计算器 ----------------

/**
 * 输入：售价/采购成本/运费包装/费率(默认取系统设置)/数量/目标利润率
 * 输出：单件净利、总净利、利润率、保本价、达成目标利润率的建议售价
 */
async function profitCalculator(body) {
  const settings = await getSettings();
  const price = Number(body.price);
  const cost = Number(body.cost) || 0;
  const shipping = Number(body.shipping) || 0;
  const quantity = Math.max(1, Number(body.quantity) || 1);
  const feeRate = body.fee_rate_pct !== undefined && body.fee_rate_pct !== ''
    ? Number(body.fee_rate_pct) / 100
    : (Number(settings.platform_fee_rate_pct) || 0) / 100;
  if (!Number.isFinite(price) || price <= 0) throw new ApiError(CODE.BAD_REQUEST, '售价必须是大于 0 的数字');
  if (feeRate < 0 || feeRate >= 1) throw new ApiError(CODE.BAD_REQUEST, '平台服务费率需在 0-100% 之间');

  const fee = price * feeRate;
  const unitNet = price - cost - shipping - fee;
  const totalNet = unitNet * quantity;
  const margin = price > 0 ? unitNet / price : 0;
  const breakEven = feeRate < 1 ? (cost + shipping) / (1 - feeRate) : null; // 保本价
  let suggest = null;
  const targetMargin = Number(body.target_margin_pct);
  if (Number.isFinite(targetMargin) && targetMargin > 0 && targetMargin < 100 && feeRate < 1) {
    const t = targetMargin / 100;
    suggest = round2((cost + shipping) / (1 - feeRate - t)); // 达成目标净利率的最低售价
  }
  return {
    inputs: { price: round2(price), cost: round2(cost), shipping: round2(shipping), quantity, fee_rate_pct: round2(feeRate * 100) },
    unit_net: round2(unitNet),
    total_net: round2(totalNet),
    margin_pct: round2(margin * 100),
    fee_per_unit: round2(fee),
    break_even_price: breakEven === null ? null : round2(breakEven),
    suggest_price: suggest,
    verdict: unitNet > 0 ? (margin >= 0.2 ? '利润健康' : '利润偏薄') : '亏损定价，请提价或压缩成本',
  };
}

// ---------------- M23 商品智能估价 ----------------

const CONDITION_FACTOR = { '全新': 1.15, '九五新': 1.05, '九成新': 1.0, '八成新': 0.85, '有瑕疵': 0.7 };

/**
 * 启发式估价：市场同款均价 × 成色系数，并保本托底；
 * 配置 AI 后可选生成点评（use_ai=true）
 */
async function estimatePrice(body) {
  const title = String(body.title || '').trim();
  const condition = CONDITION_FACTOR[body.goods_condition] ? body.goods_condition : '九成新';
  const cost = Number(body.cost_price) || 0;
  if (!title) throw new ApiError(CODE.BAD_REQUEST, '请填写商品标题');

  // 定位关键词：优先显式指定，否则取标题命中的监控关键词
  let keyword = String(body.keyword || '').trim();
  if (!keyword) {
    const kws = await query('SELECT keyword, avg_price FROM xy_search_keywords WHERE avg_price IS NOT NULL');
    const hit = kws.find((k) => title.includes(k.keyword));
    keyword = hit ? hit.keyword : '';
  }
  let market = null;
  if (keyword) {
    const rows = await query("SELECT price FROM xy_market_items WHERE keyword = ? AND status <> 'gone'", [keyword]);
    if (rows.length) {
      const prices = rows.map((r) => Number(r.price));
      market = {
        keyword,
        sample: prices.length,
        avg: round2(prices.reduce((a, b) => a + b, 0) / prices.length),
        min: round2(Math.min(...prices)),
        max: round2(Math.max(...prices)),
      };
    }
  }

  const parts = [];
  let suggested;
  if (market) {
    suggested = market.avg * CONDITION_FACTOR[condition];
    parts.push(`「${keyword}」同款市场均价 ¥${market.avg}（样本 ${market.sample}）`);
    parts.push(`成色「${condition}」系数 ${CONDITION_FACTOR[condition]}`);
  } else {
    // 无行情参照：以成本加成为基础（默认毛利 30%）
    suggested = cost > 0 ? cost * 1.3 : 0;
    parts.push('无匹配市场行情，按成本加成 30% 估算');
    parts.push(`成色「${condition}」供参考`);
  }
  // 保本托底：不低于成本 × 1.05（至少覆盖隐性成本）
  if (cost > 0) {
    const floor = cost * 1.05;
    if (suggested < floor) {
      parts.push(`已按保本线（成本×1.05 = ¥${round2(floor)}）托底`);
      suggested = floor;
    }
  }
  suggested = round2(suggested);
  const rangeLow = round2(suggested * 0.95);
  const rangeHigh = round2(suggested * 1.08);
  const confidence = market ? (market.sample >= 5 ? 'high' : market.sample >= 3 ? 'medium' : 'low') : 'low';

  let aiComment = null;
  if (body.use_ai) {
    try {
      const r = await ai.chat({
        system: '你是闲鱼二手商品定价专家，回答简洁、直接给结论，不超过 120 字。',
        prompt: `商品「${title}」成色${condition}，采购成本 ¥${cost}。市场参照：${market ? `关键词「${market.keyword}」均价¥${market.avg}（${market.sample}件，区间¥${market.min}-¥${market.max}）` : '无行情数据'}。启发式估价 ¥${suggested}（区间 ¥${rangeLow}-¥${rangeHigh}）。请点评该定价是否合理，并给出一句调价建议。`,
      });
      aiComment = r.content;
    } catch (_) { aiComment = null; /* AI 不可用时静默降级 */ }
  }

  return {
    title, goods_condition: condition, keyword: keyword || null, market,
    suggested_price: suggested, range: [rangeLow, rangeHigh],
    confidence, rationale: parts,
    ai_comment: aiComment,
  };
}

// ---------------- M24 标题图片实验室 ----------------

/** 标题实验室：体检 + 关键词覆盖 + 结构建议 + 启发式优化变体（AI 生成另走 /ai 接口） */
async function titleLab(body) {
  const title = String(body.title || '').trim();
  if (!title) throw new ApiError(CODE.BAD_REQUEST, '请填写商品标题');
  const settings = await getSettings();
  const violationWords = String(settings.violation_words || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const findings = [];
  const suggestions = [];

  if (title.length < 10) findings.push({ type: 'title', severity: 'medium', message: `标题仅 ${title.length} 字，搜索覆盖不足` });
  if (title.length > 30) findings.push({ type: 'title', severity: 'low', message: `标题 ${title.length} 字会被列表页截断` });
  const violations = violationWords.filter((w) => w && title.includes(w));
  for (const w of violations) findings.push({ type: 'violation', severity: 'high', message: `含违禁/风险词「${w}」` });

  const kws = await query('SELECT keyword, search_count FROM xy_search_keywords ORDER BY search_count DESC LIMIT 20');
  const covered = kws.filter((k) => title.includes(k.keyword));
  const missed = kws.filter((k) => !title.includes(k.keyword) && k.keyword.length >= 2).slice(0, 5);
  if (!covered.length) suggestions.push('标题未覆盖任何监控关键词，建议从「市场雷达」高热度关键词中选取 1-2 个嵌入');
  else suggestions.push(`已覆盖关键词：${covered.map((k) => k.keyword).join('、')}`);

  const hasCondition = /全新|九五新|九成新|八成新|有瑕疵|自用|二手/.test(title);
  if (!hasCondition) suggestions.push('缺少成色词（如 九成新/自用），二手商品补上可提升信任与点击');
  const hasSelling = /包邮|自动发货|秒发|原装|可小刀|急出|实拍/.test(title);
  if (!hasSelling) suggestions.push('缺少卖点词（如 包邮/自动发货/实拍），建议前置 1 个卖点');

  // 启发式变体：前置成色 + 补充未覆盖热词
  const variants = [];
  const condWord = (String(body.goods_condition) || '').match(/全新|九五新|九成新|八成新/) ? body.goods_condition : '';
  const hotMissed = missed[0] ? missed[0].keyword : '';
  if (condWord && !title.includes(condWord)) variants.push(`${condWord}${title}`);
  if (hotMissed) variants.push(`${title}（${hotMissed}同款）`);
  variants.push(title.length <= 26 ? `${title} 包邮可小刀` : title);

  return {
    title,
    findings,
    keyword_coverage: { covered: covered.map((k) => k.keyword), missed_hot: missed.map((k) => ({ keyword: k.keyword, search_count: k.search_count })) },
    suggestions,
    variants: [...new Set(variants)].slice(0, 3),
  };
}

/** AI 生成优化标题（配置 AI 后可用） */
async function titleLabAi(body) {
  const title = String(body.title || '').trim();
  if (!title) throw new ApiError(CODE.BAD_REQUEST, '请填写商品标题');
  const kws = await query('SELECT keyword, search_count FROM xy_search_keywords ORDER BY search_count DESC LIMIT 8');
  const r = await ai.chat({
    system: '你是闲鱼商品标题优化专家。只输出 3 个优化标题，每行一个，不要序号和解释。要求：每个不超过30字、覆盖给定高热度关键词、不使用绝对化违禁词、保留成色信息。',
    prompt: `原标题：${title}\n高热度关键词（按搜索量）：${kws.map((k) => k.keyword + '(' + k.search_count + ')').join('、')}`,
  });
  const titles = r.content.split(/\r?\n/).map((s) => s.replace(/^[-•\d.\s]+/, '').trim()).filter(Boolean).slice(0, 3);
  return { provider: r.provider, model: r.model, titles };
}

/** 图片实验室：首图可用性 + 与标题一致性建议 */
async function imageLab(body) {
  const mainImage = String(body.main_image || '').trim();
  const title = String(body.title || '').trim();
  const findings = [];
  const suggestions = [];
  if (!mainImage) {
    findings.push({ severity: 'high', message: '未配置首图，严重影响点击率与曝光权重' });
    suggestions.push('上传白底实拍首图：商品占画面 70% 以上，无水印无拼接');
  } else {
    if (!/^https?:\/\//i.test(mainImage)) findings.push({ severity: 'medium', message: '首图不是 http(s) 外链，可能无法展示' });
    if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(mainImage)) suggestions.push('首图建议使用 jpg/png/webp 格式');
    if (title) {
      const token = (title.match(/[\u4e00-\u9fa5A-Za-z0-9]+/g) || []).sort((a, b) => b.length - a.length)[0];
      if (token && !mainImage.includes(token) && !/\d{6,}/.test(mainImage)) {
        suggestions.push(`首图文件名未包含商品核心词「${token.slice(0, 6)}」，建议图片命名与商品相关，便于平台识别`);
      }
    }
    suggestions.push('首图三要素：白底实拍 / 商品占比≥70% / 光线充足无遮挡');
  }
  return { main_image: mainImage || null, findings, suggestions };
}

module.exports = { profitCalculator, estimatePrice, titleLab, titleLabAi, imageLab, CONDITION_FACTOR };
