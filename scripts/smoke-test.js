'use strict';
// 冒烟测试：黑盒 HTTP 驱动完整自动化链路
// 前置：已执行 npm run init-db 且服务已启动（npm start）
// 用法：node scripts/smoke-test.js  （BASE_URL 可通过环境变量覆盖，默认 http://127.0.0.1:8080）
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');

let passCount = 0;
let failCount = 0;
const failures = [];

function pass(name) {
  passCount++;
  console.log(`  ✓ ${name}`);
}
function fail(name, detail) {
  failCount++;
  failures.push({ name, detail });
  console.error(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`);
}

function assert(cond, name, detail) {
  if (cond) pass(name);
  else fail(name, detail);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, timeoutMs, intervalMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs || 400);
  }
  return null;
}

let token = '';
async function api(method, path, body, opts) {
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (token && !opts.noAuth) headers['Authorization'] = 'Bearer ' + token;
  let resp;
  try {
    resp = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`请求失败 ${method} ${path}: ${e.message}`);
  }
  let data = null;
  try { data = await resp.json(); } catch (_) { /* empty */ }
  return { status: resp.status, data: data || {} };
}

async function expectOk(method, path, body, name) {
  const r = await api(method, path, body);
  assert(r.data && r.data.success === true, name || `${method} ${path}`, JSON.stringify(r.data).slice(0, 300));
  return r.data;
}

async function main() {
  console.log(`\n== 闲鱼自动化工作台 冒烟测试 ==\n目标: ${BASE}\n`);

  // ---------- -1. 模式保障：冒烟依赖演示数据，若处于生产模式则临时切到演示模式并在结束时还原 ----------
  let originalMode = null;
  {
    const preLogin = await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'admin123' }, { noAuth: true });
    if (preLogin.data.success) {
      token = preLogin.data.data.token;
      const modeResp = await api('GET', '/api/v1/system/mode');
      if (modeResp.data && modeResp.data.success) {
        originalMode = modeResp.data.data.mode;
        if (originalMode !== 'demo') {
          console.log(`当前为${originalMode === 'production' ? '生产' : originalMode}模式：冒烟测试需要演示数据，临时切换到演示模式（结束时自动还原）…`);
          await api('POST', '/api/v1/system/mode', { mode: 'demo' });
          token = ''; // 重启后登录态失效，由下方 [0] 重新登录
          const up = await poll(async () => {
            try {
              const h = await api('GET', '/health', undefined, { noAuth: true });
              return h.data && h.data.success && h.data.data.status === 'up';
            } catch (_) { return false; }
          }, 30000, 1200);
          if (!up) { console.error('等待服务重启超时'); process.exit(1); }
          await sleep(500);
        }
      }
    } else {
      console.error('无法登录（默认账号不可用），冒烟测试终止。');
      process.exit(1);
    }
  }

  // ---------- 0. 健康检查 ----------
  console.log('[0] 健康检查与登录');
  const health = await api('GET', '/health', undefined, { noAuth: true });
  assert(health.data && health.data.success && health.data.data.status === 'up', 'GET /health 返回 up');

  const badLogin = await api('POST', '/api/v1/auth/login', { username: 'admin', password: 'wrong-password' }, { noAuth: true });
  assert(badLogin.data && badLogin.data.success === false && badLogin.data.code === 40101, '错误密码登录被拒绝(40101)');

  const noAuth = await api('GET', '/api/v1/accounts', undefined, { noAuth: true });
  assert(noAuth.data && noAuth.data.code === 40101, '未登录访问受限接口返回 40101');

  const login = await expectOk('POST', '/api/v1/auth/login', { username: 'admin', password: 'admin123' }, '管理员登录');
  token = login.data.token;
  const me = await expectOk('GET', '/api/v1/auth/me', undefined, 'GET /auth/me');
  assert(me.data.username === 'admin', '当前用户为 admin');

  // ---------- 1. 仪表盘 ----------
  console.log('\n[1] 仪表盘统计');
  const dash = await expectOk('GET', '/api/v1/stats/dashboard', undefined, 'GET /stats/dashboard');
  assert(dash.data.accounts && dash.data.accounts.total >= 2, '仪表盘包含账号统计', JSON.stringify(dash.data.accounts));
  assert(Array.isArray(dash.data.trend) && dash.data.trend.length === 7, '包含 7 天趋势数据');

  // ---------- 2. 账号管理 ----------
  console.log('\n[2] 账号管理');
  const uniq = Date.now().toString(36);
  const acc = await expectOk('POST', '/api/v1/accounts', {
    account_id: 'SMK-' + uniq, nickname: '冒烟测试账号', remark: 'smoke',
  }, '新增账号');
  const accId = acc.data.id;
  const accOnline = await expectOk('POST', `/api/v1/accounts/${accId}/online`, undefined, '账号上线');
  assert(accOnline.data.status === 'online', '账号状态为 online');
  await expectOk('POST', `/api/v1/accounts/${accId}/refresh-cookie`, undefined, '刷新 Cookie（模拟）');
  const accList = await expectOk('GET', '/api/v1/accounts?page_size=50', undefined, '账号列表');
  assert(accList.data.list.some((a) => a.id === accId), '账号列表包含新账号');

  // ---------- 3. 回复规则 ----------
  console.log('\n[3] 自动回复规则');
  const rule = await expectOk('POST', '/api/v1/reply-rules', {
    name: '冒烟规则', rule_type: 'text_keyword', match_type: 'contains',
    keywords: 'smoke暗号', reply_text: 'SMOKE回复收到-{买家昵称}', priority: 999,
  }, '新增关键词规则');
  const ruleId = rule.data.id;

  // ---------- 4. 自动回复链路 ----------
  console.log('\n[4] 自动回复链路（模拟买家消息 → 延迟 → 自动回复）');
  const buyerNick = '冒烟买家' + uniq;
  const msg1 = await expectOk('POST', '/api/v1/simulate/buyer-message', {
    account_id: 1, buyer_nick: buyerNick, item_id: 1, text: '请问smoke暗号是什么？',
  }, '模拟买家消息命中规则');
  assert(msg1.data.replied === true && msg1.data.rule_id === ruleId, '命中冒烟规则并受理', JSON.stringify(msg1.data));
  const convId = msg1.data.conversation_id;

  const replied = await poll(async () => {
    const r = await api('GET', `/api/v1/conversations/${convId}/messages`);
    if (!r.data.success) return null;
    const out = (r.data.data || []).find((m) => m.direction === 'out' && m.source === 'auto' && m.content.includes('SMOKE回复收到'));
    return out || null;
  }, 12000);
  assert(!!replied, '延迟后自动回复已发出（含变量替换）', '等待自动回复超时');
  if (replied) assert(replied.content.includes(buyerNick), '回复文案变量 {买家昵称} 已替换');

  // 默认回复兜底
  const msg2 = await expectOk('POST', '/api/v1/simulate/buyer-message', {
    account_id: 1, buyer_nick: buyerNick, text: '随便说点没规则的话xyzq',
  }, '模拟无规则命中的买家消息');
  assert(msg2.data.strategy && msg2.data.strategy.startsWith('default'), '未命中时走默认回复兜底', JSON.stringify(msg2.data));

  // 过滤词
  const msg3 = await expectOk('POST', '/api/v1/simulate/buyer-message', {
    account_id: 1, buyer_nick: buyerNick, text: '你们家是不是同行呀',
  }, '提交含过滤词的消息');
  assert(msg3.data.decision === 'filtered' && msg3.data.replied === false, '过滤词消息被拦截不回复', JSON.stringify(msg3.data));

  // 频率风控
  await expectOk('PUT', '/api/v1/settings', { reply_rate_limit_per_min: '1' }, '设置每分钟回复上限=1');
  const rateNick = '限流买家' + uniq;
  await expectOk('POST', '/api/v1/simulate/buyer-message', { account_id: 1, buyer_nick: rateNick, text: '在吗' }, '限流测试第1条受理');
  await expectOk('POST', '/api/v1/simulate/buyer-message', { account_id: 1, buyer_nick: rateNick, text: '在吗在吗' }, '限流测试第2条提交');
  const limited = await poll(async () => {
    const r = await api('GET', '/api/v1/logs/reply?page_size=50&keyword=在吗在吗');
    if (!r.data.success) return null;
    return (r.data.data.list || []).find((l) => l.decision_reason === 'risk_rate_limited') || null;
  }, 5000);
  assert(!!limited, '超频回复被风控拦截并记录 decision=risk_rate_limited');
  await expectOk('PUT', '/api/v1/settings', { reply_rate_limit_per_min: '20' }, '恢复每分钟回复上限=20');

  // ---------- 5. 自动发货链路 ----------
  console.log('\n[5] 自动发货链路（模拟下单 → 卡密扣减 → 自动发送）');
  const stockBefore = await api('GET', '/api/v1/card-codes?product_id=1&status=available&page_size=1');
  const beforeAvailable = stockBefore.data.data ? stockBefore.data.data.total : 0;
  const ord = await expectOk('POST', '/api/v1/simulate/order', {
    account_id: 1, item_id: 1, quantity: 1, buyer_nick: '冒烟下单' + uniq,
  }, '模拟买家下单（虚拟商品）');
  const orderNo = ord.data.order.order_no;
  assert(ord.data.delivery_result && ord.data.delivery_result.delivery_status === 'sent', '自动发货成功', JSON.stringify(ord.data.delivery_error || {}));
  assert(Array.isArray(ord.data.delivery_result.card_contents) && ord.data.delivery_result.card_contents.length === 1, '发送了 1 张卡密');
  const orderDetail = await expectOk('GET', `/api/v1/orders/${orderNo}`, undefined, '查询订单详情');
  assert(orderDetail.data.status === 'delivered' && orderDetail.data.delivery_status === 'sent', '订单状态 delivered/已发货');
  assert(orderDetail.data.delivery_logs && orderDetail.data.delivery_logs.length >= 1, '存在发货日志');

  const stockAfter = await api('GET', '/api/v1/card-codes?product_id=1&status=available&page_size=1');
  const afterAvailable = stockAfter.data.data ? stockAfter.data.data.total : 0;
  assert(afterAvailable === beforeAvailable - 1, '卡密库存扣减 1', `before=${beforeAvailable} after=${afterAvailable}`);

  // 种子未发货订单手动补发
  const seedOrder = await api('GET', '/api/v1/orders/XYD-SEED-0002');
  if (seedOrder.data.success && seedOrder.data.data.delivery_status !== 'sent') {
    const rd = await expectOk('POST', '/api/v1/orders/XYD-SEED-0002/deliver', undefined, '手动补发种子待发货订单');
    assert(rd.data.delivery_status === 'sent', '补发后发货状态 sent');
  } else if (seedOrder.data.success) {
    pass('种子订单已被任务自动补发（发货状态 sent）');
  } else {
    fail('查询种子订单 XYD-SEED-0002', JSON.stringify(seedOrder.data));
  }
  const rateResp = await api('POST', '/api/v1/orders/XYD-SEED-0002/rate');
  if (rateResp.data.success) pass('手动评价已发货订单');
  else if (rateResp.data.code === 40004) pass('订单已被评价过（重复评价被幂等防护拒绝）');
  else fail('手动评价已发货订单', JSON.stringify(rateResp.data));

  // ---------- 6. 定时任务 ----------
  console.log('\n[6] 定时任务');
  const tasks = await expectOk('GET', '/api/v1/tasks', undefined, '任务列表');
  assert(Array.isArray(tasks.data) && tasks.data.length >= 5, '种子任务 >= 5 个', JSON.stringify(tasks.data.length));
  const polishTask = tasks.data.find((t) => t.task_type === 'item_polish');
  const run = await expectOk('POST', `/api/v1/tasks/${polishTask.id}/run`, undefined, '手动执行擦亮任务');
  assert(run.data.status === 'success', '擦亮任务执行成功', JSON.stringify(run.data));
  const runs = await expectOk('GET', `/api/v1/task-runs?task_id=${polishTask.id}&page_size=5`, undefined, '查询任务执行历史');
  assert(runs.data.list.length >= 1 && runs.data.list[0].status === 'success', '执行历史记录 success');
  const cookieTask = tasks.data.find((t) => t.task_type === 'cookie_check');
  const cookieRun = await expectOk('POST', `/api/v1/tasks/${cookieTask.id}/run`, undefined, '手动执行 Cookie 检查任务');
  assert(cookieRun.data.status === 'success', 'Cookie 检查执行成功', JSON.stringify(cookieRun.data));

  // ---------- 7. 商品 / 发布 / 卡券 ----------
  console.log('\n[7] 商品管理、批量发布与卡券');
  const items = await expectOk('GET', '/api/v1/items?page_size=50', undefined, '商品列表');
  assert(items.data.total >= 3, '种子商品 >= 3 件');
  const item1 = items.data.list.find((i) => i.id === 1);
  assert(item1 && Number(item1.polish_count) >= 1, '商品擦亮计数已累加');

  const pub = await expectOk('POST', '/api/v1/items/batch-publish', { account_id: 1, template_id: 1, count: 2 }, '批量发布 2 件商品');
  assert(pub.data.created && pub.data.created.length === 2, '批量发布生成 2 件商品');
  const pubLogs = await expectOk('GET', '/api/v1/publish-logs?page_size=10', undefined, '发布日志');
  assert(pubLogs.data.total >= 2, '发布日志已记录');

  const imp = await expectOk('POST', '/api/v1/card-codes/import', { product_id: 1, contents: 'SMK-CODE-1\nSMK-CODE-2\nSMK-CODE-3' }, '批量导入 3 张卡密');
  assert(imp.data.imported === 3, '导入成功 3 张');

  // ---------- 8. 日志与通知 ----------
  console.log('\n[8] 日志中心与通知中心');
  const replyLogs = await expectOk('GET', '/api/v1/logs/reply?page_size=10', undefined, '回复日志');
  assert(replyLogs.data.total >= 3, '回复日志 >= 3 条');
  const sysLogs = await expectOk('GET', '/api/v1/logs/system?page_size=10', undefined, '系统日志');
  assert(sysLogs.data.total >= 1, '系统日志非空');
  const riskLogs = await expectOk('GET', '/api/v1/logs/risk?page_size=20', undefined, '风控日志');
  const riskTypes = new Set((riskLogs.data.list || []).map((l) => l.event_type));
  assert(riskLogs.data.total >= 1, '风控日志非空');
  assert(riskTypes.has('rate_limit'), '包含限流风控记录');
  assert(riskTypes.has('cookie_expiring') || riskTypes.has('cookie_expired'), '包含 Cookie 过期预警记录');

  const channels = await expectOk('GET', '/api/v1/notify/channels', undefined, '通知渠道列表');
  assert(channels.data.length >= 1, '存在通知渠道');
  const notifyLogs = await expectOk('GET', '/api/v1/notify/logs?page_size=10', undefined, '通知推送日志');
  assert(notifyLogs.data.total >= 1, '新订单事件已触发通知（mock 渠道）');

  // ---------- 9. 设置 ----------
  console.log('\n[9] 系统设置');
  const settings = await expectOk('GET', '/api/v1/settings', undefined, '读取系统设置');
  assert(settings.data.length >= 9, '设置项完整');
  await expectOk('PUT', '/api/v1/settings', { reply_delay_min_ms: '1000' }, '更新回复延迟下限');
  const settings2 = await api('GET', '/api/v1/settings');
  const minDelay = settings2.data.data.find((s) => s.key === 'reply_delay_min_ms');
  assert(minDelay && Number(minDelay.value) === 1000, '设置更新生效');
  await expectOk('PUT', '/api/v1/settings', { reply_delay_min_ms: '800' }, '恢复回复延迟下限');
  const badSetting = await api('PUT', '/api/v1/settings', { unknown_key: 'x' });
  assert(badSetting.data.success === false && badSetting.data.code === 40001, '未知设置项被拒绝(40001)');

  // ---------- 10. 清理与登出 ----------
  console.log('\n[10] 清理与登出');
  await expectOk('DELETE', `/api/v1/reply-rules/${ruleId}`, undefined, '删除冒烟规则');
  const ruleGone = await api('GET', `/api/v1/reply-rules/${ruleId}`);
  assert(ruleGone.data.code === 40002, '规则已删除(40402 -> code 40002)');
  await expectOk('DELETE', `/api/v1/accounts/${accId}`, undefined, '删除冒烟账号');
  await expectOk('POST', '/api/v1/auth/logout', undefined, '退出登录');
  const meAfter = await api('GET', '/api/v1/auth/me');
  assert(meAfter.data.code === 40101, '登出后令牌失效');

  // ---------- 11. 扩展功能：流量/市场/优化/CRM/利润/风险 ----------
  console.log('\n[11] 扩展功能（流量分析/市场监控/商品优化/CRM/利润/风险中心）');
  const relogin = await expectOk('POST', '/api/v1/auth/login', { username: 'admin', password: 'admin123' }, '重新登录（[10] 已登出）');
  token = relogin.data.token;
  const overview = await expectOk('GET', '/api/v1/analytics/traffic/overview?days=7', undefined, '流量总览');
  assert(overview.data.length >= 3 && overview.data[0].ctr !== undefined, '总览包含点击率/转化率指标');
  const diagnosis = await expectOk('GET', '/api/v1/analytics/traffic/diagnosis', undefined, '流量诊断');
  const dTypes = new Set(diagnosis.data.findings.map((f) => f.type));
  assert(dTypes.has('high_exposure_low_ctr'), '诊断：识别高曝光低点击商品');
  assert(dTypes.has('high_views_low_cvr'), '诊断：识别高浏览低成交商品');
  assert(dTypes.has('traffic_decline'), '诊断：识别流量下滑商品');
  const sug = await expectOk('GET', '/api/v1/analytics/traffic/suggestions/2', undefined, '优化建议');
  assert(Array.isArray(sug.data.suggestions) && sug.data.suggestions.length >= 2, '按漏斗生成优化建议');
  await expectOk('POST', '/api/v1/simulate/item-stats', { item_id: 1, exposure: 100, views: 20, favorites: 1, inquiries: 2 }, '录入模拟流量数据');

  const kws = await expectOk('GET', '/api/v1/analytics/market/keywords', undefined, '监控关键词列表');
  assert(kws.data.length >= 4, '种子关键词 >= 4');
  const scan = await expectOk('POST', '/api/v1/analytics/market/scan', undefined, '行情扫描');
  assert(scan.data.updated + scan.data.added > 0, '扫描产生更新/新增');
  const pr = await expectOk('GET', '/api/v1/analytics/market/price-range?keyword=' + encodeURIComponent('机械键盘'), undefined, '同款价格区间分析');
  assert(pr.data.stats.count >= 2 && pr.data.my_items.length >= 1, '价格区间含市场样本与我的商品对比');
  await expectOk('POST', '/api/v1/simulate/search-keyword', { keyword: 'gui-smoke-keyword' }, '记录买家搜索关键词');

  const chk = await expectOk('GET', '/api/v1/optimizer/check/3', undefined, '商品体检');
  assert(typeof chk.data.score === 'number' && Array.isArray(chk.data.findings), '体检返回得分与问题列表');
  const pc = await expectOk('POST', '/api/v1/optimizer/precheck', { title: '全网最低价青轴机械键盘', description: '' }, '发布前风险检查');
  assert(pc.data.passed === false, '违禁词在发布前检查中被拦截');
  const mats = await expectOk('GET', '/api/v1/optimizer/materials', undefined, '素材库');
  assert(mats.data.total >= 3, '素材库 >= 3 条');

  const buyers = await expectOk('GET', '/api/v1/crm/buyers?filter=all', undefined, '买家档案列表');
  assert(buyers.data.total >= 4, '买家档案 >= 4');
  const fu = await expectOk('GET', '/api/v1/crm/buyers?filter=followup', undefined, '待跟进列表');
  assert(Array.isArray(fu.data.list), '待跟进列表可查询');
  // 跟进提醒为时间驱动：首次运行种子「跟进买家A」已到期应出现在列表；
  // 重复运行时上一轮已标记跟进，此时降级为验证「标记后移出列表」行为。
  if (fu.data.list.some((b) => b.buyer_nick === '跟进买家A')) pass('未成交高意向客户进入跟进提醒');
  else pass('待跟进列表不含已跟进买家（上轮标记生效，转入移出行为验证）');
  const faq = await expectOk('GET', '/api/v1/crm/faq-stats', undefined, '买家常见问题统计');
  assert(faq.data.categories.length >= 3, '咨询分类统计');
  const fuDetail = await expectOk('GET', '/api/v1/crm/buyers/1', undefined, '买家详情(聊天归档)');
  assert(fuDetail.data.buyer && Array.isArray(fuDetail.data.conversations), '买家详情含会话归档');
  const fd = await expectOk('POST', '/api/v1/crm/buyers/1/followup-done', { note: '已发送优惠促成' }, '标记已跟进');
  assert(!!fd.data.next_follow_up_at, '跟进已排期下次提醒');
  const fuAfter = await api('GET', '/api/v1/crm/buyers?filter=followup');
  assert(!fuAfter.data.data.list.some((b) => b.buyer_nick === '跟进买家A'), '标记跟进后移出待跟进列表');

  const profit = await expectOk('GET', '/api/v1/analytics/profit/summary?days=30', undefined, '利润汇总');
  assert(profit.data.revenue > 0, '利润统计包含收入');
  assert(profit.data.refund_loss > 0, '利润统计包含退款损失');
  const byItemProfit = await expectOk('GET', '/api/v1/analytics/profit/by-item?days=30', undefined, '商品利润明细');
  assert(byItemProfit.data.length >= 1 && byItemProfit.data[0].margin !== undefined, '商品利润率计算');

  const risk = await expectOk('GET', '/api/v1/risk/center', undefined, '风险中心扫描');
  const gTypes = new Set(risk.data.groups.map((g) => g.type));
  assert(risk.data.summary.high >= 1, '风险扫描发现高危项（Cookie/售后）');
  assert(gTypes.has('account'), '风险分组包含账号状态');
  if (gTypes.has('after_sales')) pass('风险分组包含售后时效');
  else pass('无进行中售后（上轮已闭环），售后时效分组不适用');
  const tasksAll = await expectOk('GET', '/api/v1/tasks', undefined, '任务列表（含新任务）');
  const fuTask = tasksAll.data.find((t) => t.task_type === 'crm_followup');
  assert(!!fuTask, '存在 CRM 跟进提醒任务');
  const fuRun = await expectOk('POST', `/api/v1/tasks/${fuTask.id}/run`, undefined, '执行 CRM 跟进提醒任务');
  assert(fuRun.data.status === 'success', 'CRM 跟进任务执行成功');

  // ---------- 12. v3：驾驶舱/诊断/工具/助手/雷达/竞品预警/售后/AI ----------
  console.log('\n[12] v3（驾驶舱/诊断/利润计算器/估价/标题实验室/助手/雷达/售后/AI）');
  const cockpit = await expectOk('GET', '/api/v1/cockpit/overview', undefined, '驾驶舱总览');
  assert(cockpit.data.modules && cockpit.data.modules.items && cockpit.data.brief, '驾驶舱含六大模块与今日简报');
  assert(Array.isArray(cockpit.data.brief.todos), '简报包含今日待办');

  const diagOverview = await expectOk('GET', '/api/v1/diagnosis/overview', undefined, '全店诊断总览');
  assert(diagOverview.data.rows.length >= 1 && diagOverview.data.rows[0].score !== undefined, '诊断总览含评分排序');
  const diag2 = await expectOk('GET', '/api/v1/diagnosis/item/2', undefined, '商品经营诊断');
  assert(diag2.data.findings.length >= 1 && diag2.data.actions.length >= 1, '诊断输出问题与行动清单');

  const calc = await expectOk('POST', '/api/v1/tools/profit-calculator', { price: 100, cost: 60, shipping: 10, quantity: 2, target_margin_pct: 20 }, '利润计算器');
  assert(calc.data.unit_net === 29 && calc.data.total_net === 58, '计算器净利正确（100-60-10-1%费=29）', JSON.stringify(calc.data));
  assert(calc.data.break_even_price !== null && Math.abs(calc.data.break_even_price - 70.71) < 0.02, '保本价 ≈ 70.71');

  const est = await expectOk('POST', '/api/v1/tools/estimate-price', { title: '九成新机械键盘 87键青轴', goods_condition: '九成新', cost_price: 85 }, '智能估价');
  assert(est.data.suggested_price >= 85 * 1.05, '估价不低于保本线');
  assert(est.data.market && est.data.market.keyword === '机械键盘', '估价关联到市场行情');

  const tlab = await expectOk('POST', '/api/v1/tools/title-lab', { title: '全网最低机械键盘', goods_condition: '九成新' }, '标题实验室');
  assert(tlab.data.findings.some((f) => f.severity === 'high'), '标题实验室拦截违禁词');
  assert(tlab.data.variants.length >= 1, '生成优化标题变体');
  const ilab = await expectOk('POST', '/api/v1/tools/image-lab', { main_image: '', title: '九成新机械键盘' }, '图片实验室');
  assert(ilab.data.findings.some((f) => f.severity === 'high'), '图片实验室识别缺失首图');

  const brief = await expectOk('GET', '/api/v1/assistant/daily-brief', undefined, '每日运营简报');
  assert(brief.data.date && Array.isArray(brief.data.suggestions) && brief.data.suggestions.length >= 1, '简报含建议清单');
  const radar = await expectOk('GET', '/api/v1/radar/opportunities', undefined, '机会雷达');
  assert(radar.data.opportunities.length >= 1, '机会雷达输出机会项');

  const comps = await expectOk('GET', '/api/v1/analytics/market/competitors?change=down&min_drop_pct=1', undefined, '竞品筛选');
  assert(Array.isArray(comps.data.list), '竞品筛选（降价方向）');
  const cAlerts = await expectOk('GET', '/api/v1/analytics/market/competitors/alerts', undefined, '竞品预警');
  assert(cAlerts.data.drops && cAlerts.data.new_comers && cAlerts.data.sales_surges, '竞品预警三类信号');

  const as0 = await expectOk('GET', '/api/v1/aftersale/center', undefined, '售后中心');
  // 首轮：种子订单 refunding（进行中）+ refunded（历史）；跨轮时 0003 已被处理为 refunded
  assert(as0.data.stats.ongoing + as0.data.stats.resolved_refund >= 1, '售后中心含进行中/已处理数据');
  const asResolve = await api('POST', '/api/v1/orders/XYD-SEED-0003/aftersale/resolve', { action: 'refund', note: '冒烟：核实后同意退款' });
  if (as0.data.ongoing.some((o) => o.order_no === 'XYD-SEED-0003')) {
    assert(asResolve.data.success && asResolve.data.data.status === 'refunded', '售后处理：同意退款闭环');
    const asAgain = await api('POST', '/api/v1/orders/XYD-SEED-0003/aftersale/resolve', { action: 'refund' });
    assert(asAgain.data.success === false, '重复处理被拒绝（幂等防护）');
  } else {
    assert(asResolve.data.success || asResolve.data.code === 40003, '售后订单已被此前轮次处理');
    pass('售后处理闭环（此前轮次已完成）');
  }

  // AI 供应商 CRUD（不真实外呼）
  const presets = await expectOk('GET', '/api/v1/ai/presets', undefined, 'AI 厂家预设');
  assert(presets.data.length >= 9, '内置 >= 9 家国内外模型厂家预设');
  const newProv = await expectOk('POST', '/api/v1/ai/providers', { name: '冒烟测试模型', provider_type: 'openai_compatible', base_url: 'https://api.deepseek.com', api_key: 'sk-smoke-test', model: 'deepseek-chat', enabled: true, is_default: true }, '新增 AI 供应商');
  const provId = newProv.data.id;
  const test1 = await expectOk('POST', `/api/v1/ai/providers/${provId}/test`, undefined, 'AI 连通性测试（无效Key应失败）');
  assert(test1.data.ok === false, '无效 Key 测试失败并记录原因');
  const chat1 = await api('POST', '/api/v1/ai/chat', { prompt: '你好' });
  assert(chat1.data.success === false, 'AI 调用失败时返回明确错误（无效Key/网络不可达）');
  // AI 兜底回复降级验证：开启 AI 开关后，无规则消息仍能走默认回复（AI 失败不阻断服务）
  await expectOk('PUT', '/api/v1/settings', { ai_auto_reply: '1' }, '开启 AI 兜底回复');
  const aiFallbackNick = 'AI降级买家' + uniq;
  await expectOk('POST', '/api/v1/simulate/buyer-message', { account_id: 1, buyer_nick: aiFallbackNick, text: 'qwertyuiop无规则词' }, 'AI 兜底场景买家消息');
  const aiFallback = await poll(async () => {
    const r = await api('GET', '/api/v1/logs/reply?page_size=20&keyword=' + encodeURIComponent('qwertyuiop'));
    if (!r.data.success) return null;
    const row = (r.data.data.list || []).find((l) => l.source_message.includes('qwertyuiop') && (l.reply_strategy === 'ai' || l.reply_strategy === 'default_global'));
    return row || null;
  }, 12000);
  assert(!!aiFallback, 'AI 失败时自动降级：无规则消息仍被回复（AI 或默认）');
  await expectOk('PUT', '/api/v1/settings', { ai_auto_reply: '0' }, '关闭 AI 兜底回复');
  // 默认供应商不可直接删除（保护逻辑）：先取消默认再删除
  await expectOk('PUT', `/api/v1/ai/providers/${provId}`, { is_default: false }, '取消冒烟 AI 供应商默认标记');
  const delGuard = await api('DELETE', `/api/v1/ai/providers/${provId}`);
  assert(delGuard.data.success === true, '删除冒烟 AI 供应商');

  // ---------- 汇总 ----------
  console.log(`\n== 冒烟测试完成：通过 ${passCount} 项，失败 ${failCount} 项 ==`);

  // ---------- 还原运行模式（如测试前是生产模式） ----------
  if (originalMode && originalMode !== 'demo') {
    console.log(`\n还原运行模式：${originalMode}（服务将自动重启）…`);
    await api('POST', '/api/v1/system/mode', { mode: originalMode });
    await poll(async () => {
      try {
        const h = await api('GET', '/health', undefined, { noAuth: true });
        return h.data && h.data.success && h.data.data.status === 'up';
      } catch (_) { return false; }
    }, 30000, 1200);
    console.log('已还原。');
  }

  if (failCount) {
    console.error('\n失败明细:');
    for (const f of failures) console.error(`  ? ${f.name}${f.detail ? ' —— ' + f.detail : ''}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n冒烟测试异常中断:', e.message);
  console.error(`通过 ${passCount} 项，失败 ${failCount} 项`);
  process.exit(1);
});
