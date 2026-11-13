'use strict';
// M16 智能商品优化：体检（标题/描述/首图/价格竞争力/违禁词）+ 发布前检查 + 素材库
const { query, queryOne } = require('../db');
const { ApiError, CODE, pageOf, paged, str, enumOf } = require('../http/respond');
const { getSettings } = require('../services/settings');
const { sysLog } = require('./logs');

const SEVERITY_WEIGHT = { high: 25, medium: 12, low: 4 };

function findViolationWords(text, words) {
  return words.filter((w) => w && String(text).includes(w));
}

/** 对单件商品执行体检，返回 findings 数组（不落库，实时计算） */
async function checkItem(itemId) {
  const item = await queryOne('SELECT * FROM xy_items WHERE id = ?', [itemId]);
  if (!item) throw new ApiError(CODE.NOT_FOUND, '商品不存在');
  const settings = await getSettings();
  const violationWords = String(settings.violation_words || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const findings = [];

  // 1) 标题检查
  const title = String(item.title || '');
  if (title.length < 10) findings.push({ type: 'title', severity: 'medium', message: '标题过短（不足10字），难以覆盖搜索关键词', suggestion: '补充品牌/型号/成色/卖点等关键词' });
  if (title.length > 30) findings.push({ type: 'title', severity: 'low', message: `标题过长（${title.length} 字），列表页会被截断`, suggestion: '控制在 30 字以内，前置核心卖点' });
  for (const w of findViolationWords(title, violationWords)) {
    findings.push({ type: 'violation', severity: 'high', message: `标题含违禁/风险词「${w}」，有下架或处罚风险`, suggestion: `删除标题中的「${w}」，改用客观描述` });
  }

  // 2) 描述完整度
  const desc = String(item.description || '');
  if (desc.length < 30) {
    findings.push({ type: 'description', severity: 'medium', message: `描述过短（${desc.length} 字），买家难以建立信任`, suggestion: '补充成色说明、购买渠道、价格理由、交易方式' });
  } else {
    if (!/包邮|自提|快递|邮寄/.test(desc)) findings.push({ type: 'description', severity: 'low', message: '描述未说明交易方式（包邮/自提）', suggestion: '注明是否包邮或支持自提，减少咨询摩擦' });
    if (!/全新|九成新|九五新|八成新|二手|自用/.test(desc)) findings.push({ type: 'description', severity: 'low', message: '描述未说明成色/新旧程度', suggestion: '明确成色等级，降低售后纠纷' });
  }
  for (const w of findViolationWords(desc, violationWords)) {
    findings.push({ type: 'violation', severity: 'high', message: `描述含违禁/风险词「${w}」`, suggestion: `删除描述中的「${w}」` });
  }

  // 3) 首图检查
  const img = String(item.main_image || '');
  if (!img) {
    findings.push({ type: 'image', severity: 'high', message: '未配置首图，严重点击率与曝光权重', suggestion: '上传白底实拍首图，商品占画面 70% 以上' });
  } else if (!/^https?:\/\//i.test(img)) {
    findings.push({ type: 'image', severity: 'low', message: '首图不是标准外链地址，可能无法展示', suggestion: '使用 http(s) 图片地址' });
  }

  // 4) 价格竞争力（对照市场行情）
  const kws = await query('SELECT keyword, avg_price FROM xy_search_keywords WHERE avg_price IS NOT NULL');
  const matched = kws.filter((k) => title.includes(k.keyword));
  let priceChecked = false;
  for (const k of matched) {
    const market = await query(
      "SELECT price FROM xy_market_items WHERE keyword = ? AND status <> 'gone'",
      [k.keyword]
    );
    if (market.length < 2) continue;
    const avg = market.reduce((a, b) => a + Number(b.price), 0) / market.length;
    const diffPct = Math.round(((Number(item.price) - avg) / avg) * 100);
    priceChecked = true;
    if (diffPct > 20) {
      findings.push({ type: 'price', severity: 'medium', message: `价格高于「${k.keyword}」同款市场均价 ${diffPct}%（市场均价 ¥${avg.toFixed(2)}）`, suggestion: '降价或突出成色/附件等差异化价值' });
    } else if (diffPct < -30) {
      findings.push({ type: 'price', severity: 'low', message: `价格低于「${k.keyword}」市场均价 ${Math.abs(diffPct)}%，注意利润空间`, suggestion: '确认成本后可小幅回调价格' });
    }
  }

  // 5) 虚拟商品发货能力联动
  if (item.is_virtual) {
    const product = await queryOne('SELECT id FROM xy_card_products WHERE item_id = ? LIMIT 1', [item.id]);
    if (!product) {
      findings.push({ type: 'delivery', severity: 'medium', message: '虚拟商品未配置卡券产品，无法自动发货', suggestion: '在「卡券库存」为该商品配置卡券产品并导入卡密' });
    }
  }

  const penalty = findings.reduce((a, f) => a + (SEVERITY_WEIGHT[f.severity] || 0), 0);
  const score = Math.max(0, 100 - penalty);
  const grade = score >= 85 ? '优秀' : score >= 70 ? '良好' : score >= 50 ? '待优化' : '高风险';
  await sysLog('info', 'app', `商品「${title}」体检完成：得分 ${score}，问题 ${findings.length} 项`);
  return { item_id: item.id, title: item.title, score, grade, finding_count: findings.length, findings };
}

/** 发布前风险检查（不依赖商品记录） */
async function precheck({ title, description }) {
  const settings = await getSettings();
  const violationWords = String(settings.violation_words || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const findings = [];
  const t = String(title || '');
  const d = String(description || '');
  if (t.length < 10) findings.push({ type: 'title', severity: 'medium', message: '标题过短（不足10字）', suggestion: '补充关键词，提升搜索命中率' });
  if (t.length > 30) findings.push({ type: 'title', severity: 'low', message: `标题过长（${t.length} 字）会被截断`, suggestion: '精简到 30 字以内' });
  if (d && d.length < 30) findings.push({ type: 'description', severity: 'low', message: '描述偏短，建议补充成色与交易方式', suggestion: '参考素材库模板补全' });
  for (const w of findViolationWords(t, violationWords)) {
    findings.push({ type: 'violation', severity: 'high', message: `标题含违禁/风险词「${w}」`, suggestion: `删除「${w}」` });
  }
  for (const w of findViolationWords(d, violationWords)) {
    findings.push({ type: 'violation', severity: 'high', message: `描述含违禁/风险词「${w}」`, suggestion: `删除「${w}」` });
  }
  return { passed: !findings.some((f) => f.severity === 'high'), finding_count: findings.length, findings };
}

// ---------------- 素材库 ----------------

async function listMaterials(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const category = q.get('category');
  if (category && ['title', 'description', 'image'].includes(category)) { where.push('category = ?'); params.push(category); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_materials WHERE ${whereSql}`, params);
  const list = await query(`SELECT * FROM xy_materials WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pg.pageSize, pg.offset]);
  return paged(list, totalRow.c, pg);
}

async function createMaterial(body) {
  const r = await query(
    'INSERT INTO xy_materials (name, category, content, tags) VALUES (?, ?, ?, ?)',
    [
      str(body.name, 'name', { required: true, max: 128 }),
      enumOf(body.category, 'category', ['title', 'description', 'image'], { default: 'title' }),
      str(body.content, 'content', { required: true, max: 5000 }),
      str(body.tags, 'tags', { max: 255 }),
    ]
  );
  return queryOne('SELECT * FROM xy_materials WHERE id = ?', [r.insertId]);
}

async function updateMaterial(id, body) {
  const m = await queryOne('SELECT * FROM xy_materials WHERE id = ?', [id]);
  if (!m) throw new ApiError(CODE.NOT_FOUND, '素材不存在');
  const name = body.name !== undefined ? str(body.name, 'name', { required: true, max: 128 }) : m.name;
  const category = body.category !== undefined ? enumOf(body.category, 'category', ['title', 'description', 'image']) : m.category;
  const content = body.content !== undefined ? str(body.content, 'content', { required: true, max: 5000 }) : m.content;
  const tags = body.tags !== undefined ? str(body.tags, 'tags', { max: 255 }) : m.tags;
  await query('UPDATE xy_materials SET name = ?, category = ?, content = ?, tags = ? WHERE id = ?', [name, category, content, tags, id]);
  return queryOne('SELECT * FROM xy_materials WHERE id = ?', [id]);
}

async function deleteMaterial(id) {
  const m = await queryOne('SELECT * FROM xy_materials WHERE id = ?', [id]);
  if (!m) throw new ApiError(CODE.NOT_FOUND, '素材不存在');
  await query('DELETE FROM xy_materials WHERE id = ?', [id]);
  return { id: Number(id) };
}

async function useMaterial(id) {
  const m = await queryOne('SELECT * FROM xy_materials WHERE id = ?', [id]);
  if (!m) throw new ApiError(CODE.NOT_FOUND, '素材不存在');
  await query('UPDATE xy_materials SET use_count = use_count + 1 WHERE id = ?', [id]);
  return { id: Number(id), use_count: Number(m.use_count) + 1, content: m.content };
}

module.exports = { checkItem, precheck, listMaterials, createMaterial, updateMaterial, deleteMaterial, useMaterial };
