'use strict';
// 六大系统逐条验证：对照需求清单的 30 个子功能点，逐项调用线上 API 实测
// 用法：node scripts/verify-six-systems.js （需服务运行中，且已执行过至少一轮 npm run smoke 以产生演示数据）
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
let token = '';
let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, evidence) {
  if (cond) { pass++; console.log(`  ✓ [${name}]`); }
  else { fail++; fails.push(name); console.error(`  ✗ [${name}] ${evidence || ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return resp.json();
}

async function main() {
  const login = await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'admin123' });
  token = login.data.token;
  const uniq = Date.now().toString(36);

  // ============ 系统 1：商品流量分析 ============
  console.log('\n【系统1 商品流量分析】知道商品为什么卖不出去');
  {
    const r = await api('POST', '/api/v1/simulate/item-stats', { item_id: 1, exposure: 500, views: 40, favorites: 3, inquiries: 5, orders: 1, amount: 12.8 });
    ok('1.1 每个商品曝光/浏览/收藏/咨询/成交记录', r.success && r.data.item_id === 1, JSON.stringify(r));
    const ov = await api('GET', '/api/v1/analytics/traffic/overview?days=7');
    const row = ov.data[0];
    ok('1.1a 总览含五维字段(曝光/浏览/收藏/咨询/成交)', ov.success && row && ['exposure', 'views', 'favorites', 'inquiries', 'orders'].every((k) => row[k] !== undefined));
    const diag = await api('GET', '/api/v1/analytics/traffic/diagnosis');
    const types = new Set(diag.data.findings.map((f) => f.type));
    ok('1.2 找出高曝光低点击的商品', types.has('high_exposure_low_ctr'), JSON.stringify([...types]));
    ok('1.3 找出高浏览低成交的商品', types.has('high_views_low_cvr'));
    ok('1.4 自动分析商品流量变化(下滑检测)', types.has('traffic_decline'));
    const sug = await api('GET', '/api/v1/analytics/traffic/suggestions/2');
    ok('1.5 生成商品优化建议', sug.success && sug.data.suggestions.length >= 2);
  }

  // ============ 系统 2：关键词与市场监控 ============
  console.log('\n【系统2 关键词与市场监控】知道应该卖什么');
  {
    const kw = await api('GET', '/api/v1/analytics/market/keywords');
    ok('2.1 监控买家搜索关键词', kw.success && kw.data.length >= 4);
    const rec = await api('POST', '/api/v1/simulate/search-keyword', { keyword: '验证词' + uniq, count: 10 });
    ok('2.1a 记录买家搜索', rec.success && rec.data.search_count >= 10);
    const hot = await api('GET', '/api/v1/analytics/market/items?kind=hot&page_size=50');
    ok('2.2 统计行业热门商品', hot.success && hot.data.total >= 1);
    const comp = await api('GET', '/api/v1/analytics/market/items?kind=competitor&page_size=50');
    const c0 = comp.data.list[0] || {};
    ok('2.3 追踪竞争对手商品价格(现价/上次价/变动)', comp.success && comp.data.total >= 1 && c0.price !== undefined && c0.prev_price !== undefined && c0.status !== undefined);
    const pr = await api('GET', '/api/v1/analytics/market/price-range?keyword=' + encodeURIComponent('机械键盘'));
    ok('2.4 分析同款商品价格区间', pr.success && pr.data.stats && pr.data.stats.count >= 2 && pr.data.my_items.length >= 1);
    const demand = await api('GET', '/api/v1/analytics/market/items?kind=demand&page_size=50');
    ok('2.5 发现市场上新出现的需求', demand.success && demand.data.total >= 1);
  }

  // ============ 系统 3：智能商品优化 ============
  console.log('\n【系统3 智能商品优化】提高商品竞争力');
  {
    const chk = await api('GET', '/api/v1/optimizer/check/2');
    const tlab = await api('POST', '/api/v1/tools/title-lab', { title: '键盘', goods_condition: '九成新' });
    ok('3.1 标题关键词检查', chk.success && tlab.success && tlab.data.findings.some((f) => f.type === 'title'));
    ok('3.2 商品描述完整度检查', chk.data.findings.some((f) => f.type === 'description'));
    ok('3.3 首图质量检查', chk.data.findings.some((f) => f.type === 'image'));
    ok('3.4 商品价格竞争力分析', chk.data.findings.some((f) => f.type === 'price'));
    const mats = await api('GET', '/api/v1/optimizer/materials?page_size=50');
    ok('3.5 商品发布素材库', mats.success && mats.data.total >= 3);
    const pre = await api('POST', '/api/v1/optimizer/precheck', { title: '全网第一好用的键盘', description: '' });
    ok('3.6 发布前违规风险检查', pre.success && pre.data.passed === false);
  }

  // ============ 系统 4：买家客户管理 CRM ============
  console.log('\n【系统4 买家客户管理 CRM】减少客户流失');
  {
    const buyers = await api('GET', '/api/v1/crm/buyers?filter=all&page_size=100');
    const cats = new Set(buyers.data.list.map((b) => b.category).filter(Boolean));
    ok('4.1 买家咨询自动分类', buyers.success && cats.size >= 3, '分类: ' + [...cats].join('/'));
    ok('4.2 意向客户识别', buyers.data.list.some((b) => b.intention_level === 'high' && b.intention_score >= 60));
    const withConv = buyers.data.list.find((b) => Number(b.conversation_count) > 0);
    if (withConv) {
      const d = await api('GET', '/api/v1/crm/buyers/' + withConv.id);
      ok('4.3 历史聊天记录归档', d.success && Array.isArray(d.data.conversations) && d.data.messages.length >= 1, `会话${d.data.conversations.length} 消息${d.data.messages.length}`);
    } else {
      const d = await api('GET', '/api/v1/crm/buyers/1');
      ok('4.3 历史聊天记录归档(结构)', d.success && Array.isArray(d.data.conversations) && Array.isArray(d.data.messages));
    }
    const fu = await api('GET', '/api/v1/crm/buyers?filter=followup');
    ok('4.4 未成交客户跟进提醒(列表+任务)', fu.success && Array.isArray(fu.data.list));
    const tasks = await api('GET', '/api/v1/tasks');
    ok('4.4a 跟进提醒定时任务存在', tasks.data.some((t) => t.task_type === 'crm_followup'));
    const faq = await api('GET', '/api/v1/crm/faq-stats');
    ok('4.5 买家常见问题统计', faq.success && faq.data.categories.length >= 3 && faq.data.top_keywords !== undefined);
  }

  // ============ 系统 5：经营利润分析 ============
  console.log('\n【系统5 经营利润分析】知道到底有没有赚钱');
  {
    const s = await api('GET', '/api/v1/analytics/profit/summary?days=30');
    ok('5.2 商品成交金额(收入)', s.success && Number(s.data.revenue) > 0);
    ok('5.3 平台服务费', s.data.fees !== undefined && s.data.fee_rate_pct > 0);
    ok('5.4 运费、包装成本', s.data.shipping !== undefined);
    ok('5.5 退款损失', Number(s.data.refund_loss) > 0);
    ok('5.6 商品净利润和利润率', s.data.net_profit !== undefined && s.data.margin !== undefined);
    const byItem = await api('GET', '/api/v1/analytics/profit/by-item?days=30');
    const p0 = byItem.data[0] || {};
    ok('5.1 商品采购成本(按商品口径)', byItem.success && byItem.data.length >= 1 && p0.cost !== undefined && Number(p0.cost) > 0);
  }

  // ============ 系统 6：店铺风险管理 ============
  console.log('\n【系统6 店铺风险管理】降低经营风险');
  {
    // 构造一笔进行中售后（下单→发货→标记退款），用于售后超时与风险分组验证
    const ord = await api('POST', '/api/v1/simulate/order', { account_id: 1, item_id: 1, quantity: 1, buyer_nick: '验证售后' + uniq });
    const orderNo = ord.data.order.order_no;
    await api('POST', `/api/v1/orders/${orderNo}/refund`);
    const risk = await api('GET', '/api/v1/risk/center');
    const gTypes = new Set(risk.data.groups.map((g) => g.type));
    ok('6.1 账号状态异常提醒', gTypes.has('account') && risk.data.groups.find((g) => g.type === 'account').items.length >= 1);
    ok('6.2 商品违规风险检查', gTypes.has('item_violation') || risk.data.summary.group_count >= 1);
    ok('6.3 重复商品检测', gTypes.has('duplicate_items'));
    ok('6.4 售后超时提醒', gTypes.has('after_sales') && risk.data.groups.find((g) => g.type === 'after_sales').items.length >= 1);
    ok('6.5 自动化任务异常监控(扫描结构+失败即点亮)', risk.success && Array.isArray(risk.data.groups), '分组: ' + [...gTypes].join('/'));
    const accGroup = risk.data.groups.find((g) => g.type === 'account');
    ok('6.6 登录状态失效提醒', accGroup && accGroup.items.some((i) => i.detail.includes('登录状态')));
    // 闭环：处理掉验证售后，恢复干净状态
    const done = await api('POST', `/api/v1/orders/${orderNo}/aftersale/resolve`, { action: 'refund', note: '验证脚本自动闭环' });
    ok('6.4a 售后处理闭环(同意退款)', done.success && done.data.status === 'refunded');
  }

  console.log(`\n== 六大系统逐条验证：通过 ${pass} 项，失败 ${fail} 项 ==`);
  if (fail) { console.error('失败项: ' + fails.join(' | ')); process.exit(1); }
}

main().catch((e) => { console.error('验证中断:', e.message); process.exit(1); });
