'use strict';
// REST API 路由总表（/api/v1 前缀，统一响应格式见 docs/03-接口约定.md）
const { ApiError, CODE, int, str, enumOf, bool } = require('../http/respond');
const auth = require('../auth');
const { closePool } = require('../db');

const accountsService = require('../services/accounts');
const qrloginService = require('../services/qrlogin');
const modeService = require('../services/mode');
const itemsService = require('../services/items');
const cardsService = require('../services/cards');
const rulesService = require('../services/rules');
const conversationsService = require('../services/conversations');
const ordersService = require('../services/orders');
const tasksService = require('../services/tasks');
const logsService = require('../services/logs');
const notifyService = require('../services/notify');
const settingsService = require('../services/settings');
const statsService = require('../services/stats');
const scheduler = require('../core/scheduler');
const analyticsService = require('../services/analytics');
const marketService = require('../services/market');
const optimizerService = require('../services/optimizer');
const crmService = require('../services/crm');
const riskcenterService = require('../services/riskcenter');
const aiService = require('../services/ai');
const toolsService = require('../services/tools');
const diagnosisService = require('../services/diagnosis');
const cockpitService = require('../services/cockpit');
const assistantService = require('../services/assistant');
const radarService = require('../services/radar');
const usersService = require('../services/users');
const worryFreeService = require('../services/worryFree');
const xianyuApiService = require('../services/xianyuApi');
const { sysLog } = require('../services/logs');
const replyEngine = require('../core/replyEngine');

/** 管理员守卫 */
const admin = (ctx) => auth.requireAdmin(ctx.user);

module.exports = function registerApiRoutes(router) {
  // ---------- 鉴权 ----------
  router.post('/api/v1/auth/login', async (ctx) => {
    const username = str(ctx.body.username, 'username', { required: true, max: 64 });
    const password = str(ctx.body.password, 'password', { required: true, max: 128 });
    return auth.login(username, password);
  }, { public: true });

  router.post('/api/v1/auth/logout', async (ctx) => {
    auth.logout(ctx.user.token);
    return { logged_out: true };
  });

  router.get('/api/v1/auth/me', async (ctx) => ({
    id: ctx.user.userId, username: ctx.user.username, display_name: ctx.user.displayName, role: ctx.user.role,
  }));

  // 修改密码（校验旧密码；成功后该用户其它会话全部失效）
  router.post('/api/v1/auth/password', async (ctx) => {
    const oldPassword = str(ctx.body.old_password, 'old_password', { required: true, max: 128 });
    const newPassword = str(ctx.body.new_password, 'new_password', { required: true, max: 128 });
    return auth.changePassword(ctx.user, oldPassword, newPassword);
  });

  // ---------- 仪表盘 ----------
  router.get('/api/v1/stats/dashboard', async () => statsService.dashboard());

  // ---------- 运行模式（生产/演示，切换触发自重启并要求重新登录） ----------
  router.get('/api/v1/system/mode/public', async () => ({ mode: modeService.getMode() }), { public: true });
  router.get('/api/v1/system/mode', async () => ({
    mode: modeService.getMode(),
    db_file: modeService.currentDbFile(),
  }));
  router.post('/api/v1/system/mode', async (ctx) => {
    admin(ctx);
    const mode = enumOf(ctx.body.mode, 'mode', ['production', 'demo']);
    return modeService.requestSwitch(mode);
  });
  // 重置演示库（仅演示模式）：删除演示库文件 → 自重启 → 自动重建内置演示数据
  router.post('/api/v1/system/demo-reset', async (ctx) => {
    admin(ctx);
    if (modeService.getMode() !== 'demo') throw new ApiError(CODE.BIZ_FAIL, '仅演示模式下可重置演示数据');
    await closePool();
    modeService.resetDemoData();
    modeService.triggerRestart();
    return { resetting: true };
  });

  // ---------- 账号管理 ----------
  router.get('/api/v1/accounts', async (ctx) => accountsService.listAccounts(ctx.query));
  router.post('/api/v1/accounts', async (ctx) => accountsService.createAccount(ctx.body, ctx.user));
  router.get('/api/v1/accounts/:id', async (ctx) => accountsService.toPublicAccount(await accountsService.getAccount(int(ctx.params.id, 'id', { required: true, min: 1 }))));
  router.put('/api/v1/accounts/:id', async (ctx) => accountsService.updateAccount(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body, ctx.user));
  // 删除：有关联数据且未带 cascade=true 时返回 40003 + 计数（前端弹后果确认）；级联删除仅管理员
  router.delete('/api/v1/accounts/:id', async (ctx) => {
    admin(ctx);
    return accountsService.deleteAccount(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user, { cascade: bool(ctx.body.cascade, 'cascade', false) });
  });
  router.post('/api/v1/accounts/:id/online', async (ctx) => accountsService.toggleOnline(int(ctx.params.id, 'id', { required: true, min: 1 }), 'online', ctx.user));
  router.post('/api/v1/accounts/:id/offline', async (ctx) => accountsService.toggleOnline(int(ctx.params.id, 'id', { required: true, min: 1 }), 'offline', ctx.user));
  router.post('/api/v1/accounts/:id/refresh-cookie', async (ctx) => accountsService.refreshCookie(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user));
  router.post('/api/v1/accounts/check-all', async (ctx) => qrloginService.checkAllAccounts(ctx.user));
  router.post('/api/v1/accounts/:id/check', async (ctx) => qrloginService.checkAccountById(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user));
  router.get('/api/v1/accounts/delete-precheck/:id', async (ctx) => accountsService.deletePrecheck(int(ctx.params.id, 'id', { required: true, min: 1 })));
  // 人工接管：暂停自动回复 N 分钟（0=立即恢复）
  router.post('/api/v1/accounts/:id/pause', async (ctx) => {
    const minutes = int(ctx.body.minutes, 'minutes', { required: true, min: 0, max: 1440 });
    return accountsService.pauseAccount(int(ctx.params.id, 'id', { required: true, min: 1 }), minutes, ctx.user);
  });
  // 同步账号平台商品（真实拉取闲鱼在架商品入库）
  router.post('/api/v1/accounts/:id/sync-items', async (ctx) => itemsService.syncAccountItems(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user));
  router.post('/api/v1/accounts/:id/sync-orders', async (ctx) => ordersService.syncAccountOrders(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user));
  // 商品编辑同步到闲鱼平台（editDetail → edit，标题/描述/价格/首图）
  router.post('/api/v1/items/:id/sync-platform', async (ctx) => itemsService.syncItemToPlatform(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body || {}, ctx.user));

  // ---------- 扫码登录添加账号（调用闲鱼 passport 真实端点，见 services/qrlogin.js） ----------
  router.post('/api/v1/accounts/qr-login/start', async (ctx) => qrloginService.startLogin(ctx.user));
  router.get('/api/v1/accounts/qr-login/:sessionId', async (ctx) => qrloginService.pollStatus(ctx.params.sessionId));

  // ---------- 自动回复规则 ----------
  router.get('/api/v1/reply-rules', async (ctx) => rulesService.listRules(ctx.query));
  router.post('/api/v1/reply-rules', async (ctx) => rulesService.createRule(ctx.body, ctx.user));
  // 规则测试器：输入一条买家消息，看会命中哪条规则（不真实发送）
  router.post('/api/v1/reply-rules/test', async (ctx) => {
    const accountId = ctx.body.account_id !== undefined && ctx.body.account_id !== null && ctx.body.account_id !== '' ? int(ctx.body.account_id, 'account_id', { min: 1 }) : null;
    const itemId = ctx.body.item_id !== undefined && ctx.body.item_id !== null && ctx.body.item_id !== '' ? int(ctx.body.item_id, 'item_id', { min: 1 }) : null;
    const message = str(ctx.body.message, 'message', { required: true, max: 1000 });
    const msgType = enumOf(ctx.body.msg_type, 'msg_type', ['text', 'image'], { default: 'text' });
    const hit = await replyEngine.matchRule(accountId, { item_id: itemId }, { msg_type: msgType, content: message });
    const rule = hit && hit.rule;
    return {
      matched: !!rule,
      rule: rule ? { id: rule.id, name: rule.name, rule_type: rule.rule_type, match_type: rule.match_type, keywords: rule.keywords, reply_text: rule.reply_text, reply_image_url: rule.reply_image_url, priority: rule.priority } : null,
      matched_keyword: hit ? hit.matched : '',
      reply_strategy: hit ? hit.strategy : '',
      message,
    };
  });
  router.get('/api/v1/reply-rules/:id', async (ctx) => rulesService.getRule(int(ctx.params.id, 'id', { required: true, min: 1 })));
  router.put('/api/v1/reply-rules/:id', async (ctx) => rulesService.updateRule(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body, ctx.user));
  router.delete('/api/v1/reply-rules/:id', async (ctx) => {
    admin(ctx);
    return rulesService.deleteRule(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user);
  });
  router.post('/api/v1/reply-rules/:id/toggle', async (ctx) => rulesService.toggleRule(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body, ctx.user));

  // ---------- 商品 / 模板 / 发布 ----------
  router.get('/api/v1/items', async (ctx) => itemsService.listItems(ctx.query));
  router.post('/api/v1/items', async (ctx) => itemsService.createItem(ctx.body, ctx.user));
  router.get('/api/v1/items/:id', async (ctx) => itemsService.getItem(int(ctx.params.id, 'id', { required: true, min: 1 })));
  router.put('/api/v1/items/:id', async (ctx) => itemsService.updateItem(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body, ctx.user));
  router.delete('/api/v1/items/:id', async (ctx) => {
    admin(ctx);
    return itemsService.deleteItem(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user, { cascade: bool(ctx.body.cascade, 'cascade', false) });
  });
  router.post('/api/v1/items/:id/polish', async (ctx) => itemsService.polishItem(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user));

  router.get('/api/v1/item-templates', async () => itemsService.listTemplates());
  router.post('/api/v1/item-templates', async (ctx) => itemsService.createTemplate(ctx.body));
  router.put('/api/v1/item-templates/:id', async (ctx) => itemsService.updateTemplate(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body));
  router.delete('/api/v1/item-templates/:id', async (ctx) => {
    admin(ctx);
    return itemsService.deleteTemplate(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user);
  });
  router.post('/api/v1/items/batch-publish', async (ctx) => {
    admin(ctx);
    return itemsService.batchPublish(ctx.body, ctx.user);
  });
  router.get('/api/v1/publish-logs', async (ctx) => itemsService.listPublishLogs(ctx.query));

  // ---------- 卡券库存 ----------
  router.get('/api/v1/card-products', async (ctx) => cardsService.listProducts(ctx.query));
  router.post('/api/v1/card-products', async (ctx) => cardsService.createProduct(ctx.body));
  router.delete('/api/v1/card-products/:id', async (ctx) => {
    admin(ctx);
    return cardsService.deleteProduct(int(ctx.params.id, 'id', { required: true, min: 1 }));
  });
  router.post('/api/v1/card-codes/import', async (ctx) => cardsService.importCodes(ctx.body, ctx.user));
  router.get('/api/v1/card-codes', async (ctx) => cardsService.listCodes(ctx.query));
  // 卡密导出（CSV，同筛选条件，≤5000 行）
  router.get('/api/v1/card-codes/export', async (ctx) => {
    const rows = await cardsService.exportCodes(ctx.query);
    const esc = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
    const lines = [['ID', '产品', '卡密内容', '状态', '售出订单', '买家', '售出时间'].map(esc).join(',')];
    for (const c of rows) lines.push([c.id, c.product_name, c.content, c.status, c.order_no, c.buyer_nick, c.sold_at].map(esc).join(','));
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="card-codes-${Date.now()}.csv"`,
      'Cache-Control': 'no-store',
    });
    ctx.res.end('\ufeff' + lines.join('\r\n'));
  });
  router.post('/api/v1/card-codes/:id/disable', async (ctx) => cardsService.disableCode(int(ctx.params.id, 'id', { required: true, min: 1 })));

  // ---------- 会话与消息 ----------
  router.get('/api/v1/conversations', async (ctx) => conversationsService.listConversations(ctx.query));
  router.get('/api/v1/conversations/unread-summary', async () => conversationsService.unreadSummary());
  // 同步平台历史会话与消息（session.sync + user.query，真实接口）
  router.post('/api/v1/conversations/sync', async (ctx) => conversationsService.syncPlatformConversations(ctx.body && ctx.body.account_id, ctx.user));
  // 消息通道状态（账号在线/凭证/WS 监听，用于页面提示）
  router.get('/api/v1/conversations/channel-status', async () => conversationsService.channelStatus());
  router.post('/api/v1/conversations/read-all', async () => conversationsService.markAllRead());
  router.get('/api/v1/conversations/:id', async (ctx) => conversationsService.getConversation(int(ctx.params.id, 'id', { required: true, min: 1 })));
  router.get('/api/v1/conversations/:id/messages', async (ctx) => conversationsService.listMessages(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.query));
  router.post('/api/v1/conversations/:id/send', async (ctx) => {
    const content = str(ctx.body.content, 'content', { required: true, max: 2000 });
    const imageUrl = ctx.body.image_url !== undefined && ctx.body.image_url !== '' ? str(ctx.body.image_url, 'image_url', { max: 500 }) : null;
    return conversationsService.sendManual(int(ctx.params.id, 'id', { required: true, min: 1 }), content, ctx.user, imageUrl);
  });
  router.post('/api/v1/conversations/:id/read', async (ctx) => conversationsService.markRead(int(ctx.params.id, 'id', { required: true, min: 1 })));
  router.post('/api/v1/conversations/:id/status', async (ctx) => {
    const status = enumOf(ctx.body.status, 'status', ['open', 'closed']);
    return conversationsService.setConvStatus(int(ctx.params.id, 'id', { required: true, min: 1 }), status, ctx.user);
  });

  // ---------- 订单 ----------
  // ---------- 图片上传（multipart，转发闲鱼媒体上传） ----------
  router.post('/api/v1/upload/image', async (ctx) => {
    const accountId = Number(ctx.query.get('account_id')) || 0;
    if (!ctx.rawBody || !ctx.rawBody.length) throw new ApiError(CODE.BAD_REQUEST, '请选择要上传的图片');
    const ct = String(ctx.contentType || '');
    const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!bm) throw new ApiError(CODE.BAD_REQUEST, '请求不是 multipart 表单');
    const boundary = '--' + (bm[1] || bm[2]).trim();
    const parts = parseMultipart(ctx.rawBody, boundary);
    const filePart = parts.find((p) => p.name === 'file' && p.filename);
    if (!filePart) throw new ApiError(CODE.BAD_REQUEST, '未找到图片文件（表单字段名须为 file）');
    if (filePart.data.length > 8 * 1024 * 1024) throw new ApiError(CODE.BAD_REQUEST, '图片超过 8MB，请压缩后再上传');
    if (!/^image\/(jpeg|png|webp|gif)/.test(filePart.mime || '')) throw new ApiError(CODE.BAD_REQUEST, '仅支持 jpg/png/webp/gif 图片');
    const r = await xianyuApiService.uploadImage(await accountsService.getAccount(accountId), filePart.data, filePart.filename);
    if (!r.ok) throw new ApiError(CODE.BIZ_FAIL, '图片上传失败：' + r.reason);
    await sysLog('info', 'connector', `图片已上传闲鱼 CDN（账号 ${accountId}，${Math.round(filePart.data.length / 1024)}KB，操作员 ${ctx.user.username}）`);
    return { url: r.url, width: r.width || null, height: r.height || null };
  });

  router.get('/api/v1/orders', async (ctx) => ordersService.listOrders(ctx.query));
  // 售前/售后概览统计（订单页概览卡）
  router.get('/api/v1/orders/stats', async (ctx) => ordersService.orderStats(ctx.query));
  // 同步平台订单（历史订单+实时状态；body.account_id 可选）
  router.post('/api/v1/orders/sync', async (ctx) => ordersService.syncAccountOrders(ctx.body && ctx.body.account_id, ctx.user, ctx.body || {}));
  // 订单导出（CSV，按当前筛选，最多 5000 行）
  router.get('/api/v1/orders/export', async (ctx) => {
    const rows = await ordersService.exportOrders(ctx.query);
    const esc = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
    const header = ['订单号', '状态', '发货状态', '数量', '金额', '买家昵称', '买家ID', '商品', '账号', '虚拟', '已评价', '下单时间', '支付时间', '发货时间'];
    const lines = [header.map(esc).join(',')];
    for (const r of rows) {
      lines.push([r.order_no, r.status, r.delivery_status, r.quantity, r.amount, r.buyer_nick, r.buyer_id,
        r.item_title, r.account_nickname, r.is_virtual ? '是' : '否', r.is_rated ? '是' : '否',
        r.placed_at, r.paid_at, r.delivered_at].map(esc).join(','));
    }
    const body = '\ufeff' + lines.join('\r\n'); // BOM 保证 Excel 正确识别 UTF-8
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="orders-${Date.now()}.csv"`,
      'Cache-Control': 'no-store',
    });
    ctx.res.end(body);
  });
  router.get('/api/v1/orders/:orderNo', async (ctx) => ordersService.getOrder(String(ctx.params.orderNo)));
  router.post('/api/v1/orders/:orderNo/deliver', async (ctx) => ordersService.deliverManual(String(ctx.params.orderNo), ctx.user));
  router.post('/api/v1/orders/:orderNo/rate', async (ctx) => ordersService.rateManual(String(ctx.params.orderNo), ctx.user));
  router.post('/api/v1/orders/:orderNo/refund', async (ctx) => ordersService.markRefund(String(ctx.params.orderNo), ctx.user));

  // ---------- 定时任务 ----------
  router.get('/api/v1/tasks', async (ctx) => tasksService.listTasks(ctx.query));
  router.post('/api/v1/tasks', async (ctx) => {
    admin(ctx);
    return tasksService.createTask(ctx.body, ctx.user);
  });
  router.put('/api/v1/tasks/:id', async (ctx) => tasksService.updateTask(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body, ctx.user));
  router.delete('/api/v1/tasks/:id', async (ctx) => {
    admin(ctx);
    return tasksService.deleteTask(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user);
  });
  router.post('/api/v1/tasks/:id/run', async (ctx) => {
    const id = int(ctx.params.id, 'id', { required: true, min: 1 });
    const result = await scheduler.runTaskById(id);
    return result;
  });
  router.get('/api/v1/task-runs', async (ctx) => tasksService.listTaskRuns(ctx.query));

  // ---------- 日志中心 ----------
  router.get('/api/v1/logs/reply', async (ctx) => logsService.listReplyLogs(ctx.query));
  router.get('/api/v1/logs/system', async (ctx) => logsService.listSystemLogs(ctx.query));
  router.get('/api/v1/logs/risk', async (ctx) => logsService.listRiskLogs(ctx.query));

  // ---------- 通知中心 ----------
  router.get('/api/v1/notify/channels', async () => notifyService.listChannels());
  router.post('/api/v1/notify/channels', async (ctx) => notifyService.createChannel(ctx.body));
  router.put('/api/v1/notify/channels/:id', async (ctx) => notifyService.updateChannel(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body));
  router.post('/api/v1/notify/channels/:id/test', async (ctx) => notifyService.testChannel(int(ctx.params.id, 'id', { required: true, min: 1 })));
  router.delete('/api/v1/notify/channels/:id', async (ctx) => {
    admin(ctx);
    return notifyService.deleteChannel(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user);
  });
  router.get('/api/v1/notify/rules', async () => notifyService.listRules());
  router.post('/api/v1/notify/rules', async (ctx) => notifyService.createRule(ctx.body));
  router.put('/api/v1/notify/rules/:id', async (ctx) => notifyService.updateRule(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body));
  router.delete('/api/v1/notify/rules/:id', async (ctx) => notifyService.deleteRule(int(ctx.params.id, 'id', { required: true, min: 1 })));
  router.get('/api/v1/notify/logs', async (ctx) => notifyService.listLogs(ctx.query));

  // ---------- M14 商品流量分析 ----------
  router.get('/api/v1/analytics/traffic/overview', async (ctx) => analyticsService.trafficOverview(ctx.query.get('days')));
  router.get('/api/v1/analytics/traffic/diagnosis', async () => analyticsService.trafficDiagnosis());
  router.get('/api/v1/analytics/traffic/item/:id', async (ctx) => analyticsService.itemTrend(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.query.get('days')));
  router.get('/api/v1/analytics/traffic/suggestions/:id', async (ctx) => analyticsService.trafficSuggestions(int(ctx.params.id, 'id', { required: true, min: 1 })));

  // ---------- M15 关键词与市场监控 ----------
  router.get('/api/v1/analytics/market/keywords', async () => marketService.listKeywords());
  router.post('/api/v1/analytics/market/keywords', async (ctx) => marketService.addKeyword(ctx.body));
  router.get('/api/v1/analytics/market/keywords/export', async () => marketService.exportKeywords());
  router.post('/api/v1/analytics/market/keywords/import', async (ctx) => {
    admin(ctx);
    return marketService.importKeywords(ctx.body || {});
  });
  router.delete('/api/v1/analytics/market/keywords/:id', async (ctx) => {
    admin(ctx);
    return marketService.deleteKeyword(int(ctx.params.id, 'id', { required: true, min: 1 }));
  });
  router.get('/api/v1/analytics/market/items', async (ctx) => marketService.listMarketItems(ctx.query));
  router.get('/api/v1/analytics/market/price-range', async (ctx) => marketService.priceRange(ctx.query.get('keyword')));
  router.post('/api/v1/analytics/market/scan', async () => marketService.runMarketScan());

  // ---------- M16 智能商品优化 ----------
  router.get('/api/v1/optimizer/check/:itemId', async (ctx) => optimizerService.checkItem(int(ctx.params.itemId, 'itemId', { required: true, min: 1 })));
  router.post('/api/v1/optimizer/precheck', async (ctx) => optimizerService.precheck(ctx.body || {}));
  router.get('/api/v1/optimizer/materials', async (ctx) => optimizerService.listMaterials(ctx.query));
  router.post('/api/v1/optimizer/materials', async (ctx) => optimizerService.createMaterial(ctx.body));
  router.put('/api/v1/optimizer/materials/:id', async (ctx) => optimizerService.updateMaterial(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body));
  router.delete('/api/v1/optimizer/materials/:id', async (ctx) => optimizerService.deleteMaterial(int(ctx.params.id, 'id', { required: true, min: 1 })));
  router.post('/api/v1/optimizer/materials/:id/use', async (ctx) => optimizerService.useMaterial(int(ctx.params.id, 'id', { required: true, min: 1 })));

  // ---------- M17 买家 CRM ----------
  router.get('/api/v1/crm/buyers', async (ctx) => crmService.listBuyers(ctx.query));
  router.get('/api/v1/crm/buyers/:id', async (ctx) => crmService.buyerDetail(int(ctx.params.id, 'id', { required: true, min: 1 })));
  router.post('/api/v1/crm/buyers/:id/followup-done', async (ctx) => crmService.markFollowupDone(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body ? ctx.body.note : '', ctx.user));
  router.get('/api/v1/crm/faq-stats', async () => crmService.faqStats());

  // ---------- M18 经营利润分析 ----------
  router.get('/api/v1/analytics/profit/summary', async (ctx) => analyticsService.profitSummary(ctx.query.get('days')));
  router.get('/api/v1/analytics/profit/by-item', async (ctx) => analyticsService.profitByItem(ctx.query.get('days')));

  // ---------- M19 店铺风险管理 ----------
  router.get('/api/v1/risk/center', async () => riskcenterService.scanRiskCenter());

  // ---------- 经营驾驶舱 / 每日运营助手 ----------
  router.get('/api/v1/cockpit/overview', async () => cockpitService.overview());
  router.get('/api/v1/assistant/daily-brief', async () => assistantService.dailyBrief());
  router.post('/api/v1/assistant/daily-brief/ai', async () => assistantService.dailyBriefAi());

  // ---------- M20 商品经营诊断 ----------
  router.get('/api/v1/diagnosis/overview', async () => diagnosisService.diagnosisOverview());
  router.get('/api/v1/diagnosis/item/:id', async (ctx) => diagnosisService.diagnoseItem(int(ctx.params.id, 'id', { required: true, min: 1 })));
  router.post('/api/v1/diagnosis/item/:id/ai', async (ctx) => diagnosisService.diagnoseItemAi(int(ctx.params.id, 'id', { required: true, min: 1 })));

  // ---------- M21/M23/M24 经营工具 ----------
  router.post('/api/v1/tools/profit-calculator', async (ctx) => toolsService.profitCalculator(ctx.body || {}));
  router.post('/api/v1/tools/estimate-price', async (ctx) => toolsService.estimatePrice(ctx.body || {}));
  router.post('/api/v1/tools/title-lab', async (ctx) => toolsService.titleLab(ctx.body || {}));
  router.post('/api/v1/tools/title-lab/ai', async (ctx) => toolsService.titleLabAi(ctx.body || {}));
  router.post('/api/v1/tools/image-lab', async (ctx) => toolsService.imageLab(ctx.body || {}));

  // ---------- M28 商品机会雷达 ----------
  router.get('/api/v1/radar/opportunities', async () => radarService.opportunities());

  // ---------- 闲鱼无忧卖（轻运营销售模式跟踪） ----------
  router.get('/api/v1/worry-free', async (ctx) => worryFreeService.list(ctx.query));
  router.post('/api/v1/worry-free/enroll', async (ctx) => {
    admin(ctx);
    return worryFreeService.enroll(ctx.body, ctx.user);
  });
  router.put('/api/v1/worry-free/:id/status', async (ctx) => worryFreeService.updateStatus(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body, ctx.user));
  router.delete('/api/v1/worry-free/:id', async (ctx) => {
    admin(ctx);
    return worryFreeService.remove(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user);
  });

  // ---------- M22 竞品筛选与预警 ----------
  router.get('/api/v1/analytics/market/competitors', async (ctx) => marketService.filterCompetitors(ctx.query));
  router.get('/api/v1/analytics/market/competitors/alerts', async () => marketService.competitorAlerts());

  // ---------- M27 售后纠纷中心 ----------
  router.get('/api/v1/aftersale/center', async (ctx) => ordersService.aftersaleCenter(ctx.query));
  router.post('/api/v1/orders/:orderNo/aftersale/resolve', async (ctx) => {
    const action = str(ctx.body.action, 'action', { required: true, max: 16 });
    return ordersService.resolveAftersale(String(ctx.params.orderNo), { action, note: str(ctx.body.note, 'note', { max: 500 }) }, ctx.user);
  });

  // ---------- M30 大模型 AI ----------
  router.get('/api/v1/ai/presets', async () => aiService.listPresets());
  router.get('/api/v1/ai/chat-presets', async () => aiService.getChatPresets());
  router.put('/api/v1/ai/chat-prompts', async (ctx) => {
    admin(ctx);
    return aiService.saveChatPrompts(ctx.body && ctx.body.custom, ctx.user);
  });
  router.get('/api/v1/ai/providers', async () => aiService.listProviders());
  router.post('/api/v1/ai/providers', async (ctx) => {
    admin(ctx);
    return aiService.createProvider(ctx.body);
  });
  router.post('/api/v1/ai/providers/batch', async (ctx) => {
    admin(ctx);
    return aiService.createProvidersBatch(ctx.body, ctx.user);
  });
  router.put('/api/v1/ai/providers/:id', async (ctx) => {
    admin(ctx);
    return aiService.updateProvider(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body);
  });
  router.delete('/api/v1/ai/providers/:id', async (ctx) => {
    admin(ctx);
    return aiService.deleteProvider(int(ctx.params.id, 'id', { required: true, min: 1 }));
  });
  router.post('/api/v1/ai/providers/:id/test', async (ctx) => aiService.testProvider(int(ctx.params.id, 'id', { required: true, min: 1 })));
  router.post('/api/v1/ai/chat', async (ctx) => {
    const prompt = str(ctx.body.prompt, 'prompt', { required: true, max: 4000 });
    const system = str(ctx.body.system, 'system', { max: 2000 });
    return aiService.chat({ system: system || '', prompt });
  });

  // ---------- 系统设置 ----------
  router.get('/api/v1/settings', async () => settingsService.listSettings());
  router.put('/api/v1/settings', async (ctx) => {
    admin(ctx);
    const settings = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : null;
    if (!settings) {
      throw new ApiError(CODE.BAD_REQUEST, '请求体应为 { "key": "value", ... } 形式的设置对象');
    }
    return settingsService.updateSettings(settings);
  });

  // ---------- 快捷回复短语（消息会话页管理，存于系统设置 quick_phrases） ----------
  router.get('/api/v1/reply-phrases', async () => {
    const s = await settingsService.getSettings();
    let arr = [];
    try { arr = JSON.parse(s.quick_phrases || '[]'); } catch (_) { /* ignore */ }
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.text === 'string') : [];
  });
  router.put('/api/v1/reply-phrases', async (ctx) => {
    const arr = Array.isArray(ctx.body.phrases) ? ctx.body.phrases : null;
    if (!arr) throw new ApiError(CODE.BAD_REQUEST, 'phrases 必须是数组');
    const clean = arr.map((p) => ({ text: String(p && p.text || '').slice(0, 200) })).filter((p) => p.text).slice(0, 100);
    await settingsService.updateSettings({ quick_phrases: JSON.stringify(clean) });
    return clean;
  });

  // ---------- 用户管理（管理员） ----------
  router.get('/api/v1/users', async (ctx) => {
    admin(ctx);
    return usersService.listUsers();
  });
  router.post('/api/v1/users', async (ctx) => {
    admin(ctx);
    return usersService.createUser(ctx.body, ctx.user);
  });
  router.put('/api/v1/users/:id', async (ctx) => {
    admin(ctx);
    return usersService.updateUser(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.body, ctx.user);
  });
  router.post('/api/v1/users/:id/reset-password', async (ctx) => {
    admin(ctx);
    const newPassword = str(ctx.body.new_password, 'new_password', { required: true, max: 128 });
    return usersService.resetPassword(int(ctx.params.id, 'id', { required: true, min: 1 }), newPassword, ctx.user);
  });
  router.delete('/api/v1/users/:id', async (ctx) => {
    admin(ctx);
    return usersService.deleteUser(int(ctx.params.id, 'id', { required: true, min: 1 }), ctx.user);
  });

  // ---------- 数据备份（管理员）：备份/列表/下载/恢复 ----------
  const fsMod = require('fs');
  const pathMod = require('path');
  router.post('/api/v1/system/backup', async (ctx) => {
    admin(ctx);
    await closePool();
    const { config } = require('../config');
    const { currentDbFile } = require('../services/mode');
    const file = currentDbFile();
    if (!fsMod.existsSync(file)) throw new ApiError(CODE.NOT_FOUND, '数据库文件不存在');
    const backupDir = pathMod.join(config.root, 'data', 'backups');
    fsMod.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const name = `manual-${stamp}.db`;
    fsMod.copyFileSync(file, pathMod.join(backupDir, name));
    await sysLog('warn', 'app', `手动备份数据库：${name}（操作员 ${ctx.user.username}）`);
    return { file: name };
  });
  router.get('/api/v1/system/backups', async (ctx) => {
    admin(ctx);
    const { config } = require('../config');
    const backupDir = pathMod.join(config.root, 'data', 'backups');
    if (!fsMod.existsSync(backupDir)) return [];
    return fsMod.readdirSync(backupDir).filter((f) => f.endsWith('.db')).map((f) => ({
      file: f,
      size_kb: Math.round(fsMod.statSync(pathMod.join(backupDir, f)).size / 1024),
      created_at: fsMod.statSync(pathMod.join(backupDir, f)).mtime.toISOString(),
    })).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  });
  router.get('/api/v1/system/backups/download', async (ctx) => {
    admin(ctx);
    const name = str(ctx.query.get('file'), 'file', { required: true, max: 120 });
    if (!/^[\w.-]+\.db$/.test(name) || name.includes('..')) throw new ApiError(CODE.BAD_REQUEST, '非法文件名');
    const p = pathMod.join(require('../config').root, 'data', 'backups', name);
    if (!fsMod.existsSync(p)) throw new ApiError(CODE.NOT_FOUND, '备份文件不存在');
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    ctx.res.end(fsMod.readFileSync(p));
  });
  router.post('/api/v1/system/backups/restore', async (ctx) => {
    admin(ctx);
    const name = str(ctx.body.file, 'file', { required: true, max: 120 });
    if (!/^[\w.-]+\.db$/.test(name) || name.includes('..')) throw new ApiError(CODE.BAD_REQUEST, '非法文件名');
    const { config } = require('../config');
    const { currentDbFile } = require('../services/mode');
    const src = pathMod.join(config.root, 'data', 'backups', name);
    if (!fsMod.existsSync(src)) throw new ApiError(CODE.NOT_FOUND, '备份文件不存在');
    await closePool();
    const target = currentDbFile();
    for (const suffix of ['-wal', '-shm']) {
      if (fsMod.existsSync(target + suffix)) fsMod.unlinkSync(target + suffix);
    }
    fsMod.copyFileSync(src, target);
    await sysLog('warn', 'app', `从备份恢复数据库：${name}（操作员 ${ctx.user.username}），服务将自动重启`);
    modeService.triggerRestart();
    return { restoring: true, file: name };
  });
};


/** 解析 multipart/form-data 请求体（文本字段 + 文件字段） */
function parseMultipart(buf, boundary) {
  const parts = [];
  const bBoundary = Buffer.from(boundary, 'utf8');
  let pos = buf.indexOf(bBoundary);
  while (pos !== -1) {
    const next = buf.indexOf(bBoundary, pos + bBoundary.length);
    if (next === -1) break;
    // 段内：头部（\r\n\r\n 分隔）+ 数据
    const seg = buf.slice(pos + bBoundary.length + 2, next - 2); // 去掉开头 CRLF 与结尾 CRLF
    const headerEnd = seg.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const head = seg.slice(0, headerEnd).toString('utf8');
      const data = seg.slice(headerEnd + 4);
      const nameM = head.match(/name="([^"]*)"/i);
      const fileM = head.match(/filename="([^"]*)"/i);
      const mimeM = head.match(/Content-Type:\s*([^\r\n]+)/i);
      parts.push({
        name: nameM ? nameM[1] : '',
        filename: fileM ? fileM[1] : '',
        mime: mimeM ? mimeM[1].trim() : '',
        data,
      });
    }
    pos = next;
  }
  return parts;
}
