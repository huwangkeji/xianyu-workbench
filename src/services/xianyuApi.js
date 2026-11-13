'use strict';
// 闲鱼 H5 mtop API 客户端（真实账号专用，Cookie 鉴权）
// 报文参照 xianyu-super-butler（XianyuAutoAsync.py: get_item_list_info / refresh_token）
// 说明：mtop 标准流程 —— 请求携带 _m_h5_tk 计算 sign；令牌过期（FAIL_SYS_TOKEN_EXPIRED）
// 时响应 Set-Cookie 会下发新 token，自动合并后重试（最多 3 次）。
const crypto = require('crypto');

const APP_KEY = '34839810';
const IM_APP_KEY = '444e9908a51d1cb236a27862abc769c9'; // 消息令牌接口专用
const H5_HOST = 'https://h5api.m.goofish.com/h5/';
const UPSTREAM_TIMEOUT_MS = 20 * 1000;

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://www.goofish.com/',
  'Origin': 'https://www.goofish.com',
};

function md5(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

function parseCookieString(str) {
  const jar = {};
  String(str || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return jar;
}

function cookieHeaderOf(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 把响应 Set-Cookie 并入 jar，返回是否有变化 */
function mergeSetCookie(jar, res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  let changed = false;
  for (const line of list) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    const semi = value.indexOf(';');
    if (semi >= 0) value = value.slice(0, semi);
    if (jar[name] !== value.trim()) { jar[name] = value.trim(); changed = true; }
  }
  return changed;
}

/** 36 位类 UUID 设备号（参照上游 generate_device_id，尾部附账号标识） */
function genDeviceId(tag) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const out = [];
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out.push('-');
    else if (i === 14) out.push('4');
    else if (i === 19) out.push(chars[((Math.floor(Math.random() * 16)) & 0x3) | 0x8]);
    else out.push(chars[Math.floor(Math.random() * chars.length)]);
  }
  return out.join('') + '-' + String(tag || '0');
}

/**
 * mtop POST 通用调用：自动签名、Set-Cookie 合并、令牌过期自动重试。
 * @param {object} opts { api, dataObj, jar(可变引用), extraQuery }
 * @returns { ok, ret, data, jar }
 */
async function mtopCall({ api, dataObj, jar, extraQuery = {}, retries = 3, v: apiVersion = '1.0' }) {
  let lastRet = '';
  for (let attempt = 1; attempt <= retries; attempt++) {
    const dataVal = JSON.stringify(dataObj);
    const rawTk = jar._m_h5_tk || jar.m_h5_tk || '';
    const token = rawTk.split('_')[0] || '';
    const t = String(Date.now());
    const sign = md5(`${token}&${t}&${APP_KEY}&${dataVal}`);
    const qs = new URLSearchParams({
      jsv: '2.7.2', appKey: APP_KEY, t, sign, v: apiVersion, type: 'originaljson',
      accountSite: 'xianyu', dataType: 'json', timeout: '20000', api, ...extraQuery,
    });
    let res;
    try {
      res = await fetch(`${H5_HOST}${api}/1.0/?${qs}`, {
        method: 'POST',
        headers: { ...BASE_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeaderOf(jar) },
        body: 'data=' + encodeURIComponent(dataVal),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, ret: 'NETWORK_ERROR', data: {}, jar, reason: '网络请求失败: ' + (e && e.message) };
    }
    mergeSetCookie(jar, res);
    const j = await parseMtopJson(res);
    const ret = (j && j.ret && j.ret[0]) || '';
    lastRet = ret;
    if (/^SUCCESS/i.test(ret)) return { ok: true, ret, data: (j && j.data) || {}, jar };
    if (/TOKEN/i.test(ret)) continue; // 令牌过期/为空：新 token 已在 Set-Cookie 合并，重试
    return { ok: false, ret, data: (j && j.data) || {}, jar };
  }
  return { ok: false, ret: lastRet, data: {}, jar };
}

/** mtop 响应解析（大数保真）：订单号等 19 位 ID 超出 JS Number 安全范围，先把长数字字面量转为字符串再 parse */
async function parseMtopJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(String(text).replace(/(:\s*)(\d{15,})(\s*[},\]])/g, '$1"$2"$3'));
  } catch (_) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }
}

/**
 * 真实刷新账号 Cookie（消息令牌接口，同时验证凭证有效性）。
 * 成功返回 { ok:true, cookie(合并后的最新凭证串) }；失败返回 { ok:false, reason, ret }。
 */
async function refreshAccountCookie(account) {
  const jar = parseCookieString(account.cookie);
  if (!Object.keys(jar).length) return { ok: false, reason: '账号无 Cookie 凭证' };
  const dataObj = { appKey: IM_APP_KEY, deviceId: genDeviceId(account.account_id) };
  const r = await mtopCall({ api: 'mtop.taobao.idlemessage.pc.login.token', dataObj, jar, extraQuery: { sessionOption: 'AutoLoginOnly' } });
  const merged = cookieHeaderOf(jar);
  if (r.ok) return { ok: true, cookie: merged, ret: r.ret };
  if (/SESSION|NEED_LOGIN|NOT_LOGIN/i.test(r.ret)) return { ok: false, reason: '登录已失效（Cookie 过期/掉线），请重新扫码', ret: r.ret };
  return { ok: false, reason: '刷新未通过: ' + (r.ret || '响应异常'), ret: r.ret };
}

/**
 * 拉取账号在售商品列表（真实接口，支持翻页）。
 * 成功返回 { ok:true, items:[{item_id,title,price,status,main_image}], hasMore }。
 */
/** 递归提取响应中所有形如商品卡的对象（兼容旧版 cardList 与新版 itemTopicList/topItem 等结构） */
function extractItemCards(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const n of node) extractItemCards(n, out, depth + 1);
    return;
  }
  const cd = node.cardData || node;
  const dp = cd.detailParams || {};
  const itemId = dp.itemId || cd.id;
  if (itemId && cd.title && (cd.priceInfo || dp.price)) {
    out.push(cd);
    return; // 已是商品卡，不再下钻
  }
  for (const k of Object.keys(node)) {
    if (k === 'detailParams' || k === 'trackParams') continue;
    extractItemCards(node[k], out, depth + 1);
  }
}

async function fetchAccountItems(account, page = 1, pageSize = 20) {
  const jar = parseCookieString(account.cookie);
  if (!Object.keys(jar).length) return { ok: false, reason: '账号无 Cookie 凭证' };
  const dataObj = {
    needGroupInfo: false,
    pageNumber: Math.max(1, Number(page) || 1),
    pageSize: Math.min(50, Math.max(1, Number(pageSize) || 20)),
    groupName: '在售',
    groupId: '58877261',
    defaultGroup: true,
    userId: String(account.account_id),
  };
  const r = await mtopCall({ api: 'mtop.idle.web.xyh.item.list', dataObj, jar, extraQuery: { sessionOption: 'AutoLoginOnly' } });
  if (!r.ok) return { ok: false, reason: '商品列表接口失败: ' + (r.ret || ''), jar };
  // 结构自适应解析：递归抓取所有商品卡（兼容新旧响应结构），按 itemId 去重
  const cards = [];
  extractItemCards(r.data || {}, cards);
  const seen = new Set();
  const items = [];
  for (const cd of cards) {
    const dp = cd.detailParams || {};
    const itemId = String(dp.itemId || cd.id || '');
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    const pic = (cd.picInfo && (cd.picInfo.picUrl || (Array.isArray(cd.picInfo.images) && cd.picInfo.images[0] && cd.picInfo.images[0].url))) || (dp.picUrl || '');
    items.push({
      item_id: itemId,
      title: String(cd.title || '').replace(/<[^>]+>/g, '').slice(0, 255),
      price: Math.round((Number((cd.priceInfo && cd.priceInfo.price)) || Number(dp.price) || 0) * 100) / 100,
      status: Number(cd.itemStatus) === 0 ? 'on_sale' : 'off_sale',
      main_image: String(pic).slice(0, 500),
    });
  }
  return {
    ok: true,
    items,
    hasMore: items.length >= dataObj.pageSize && r.data && r.data.nextPage !== false,
    // 接口的 totalCount 偶发为 0/缺失（分页字段与新结构不同步）——以解析结果兜底
    totalCount: (!r.data || r.data.totalCount === undefined || r.data.totalCount === null || Number(r.data.totalCount) === 0)
      ? items.length
      : Number(r.data.totalCount),
    encrypted_hint: !!(r.data && (r.data.needDecryptKeys || r.data.needDecryptKeysV2)) && items.length === 0,
    jar,
  };
}

module.exports = { md5, parseCookieString, cookieHeaderOf, mergeSetCookie, genDeviceId, mtopCall, refreshAccountCookie, fetchAccountItems, fetchItemDetail, fetchAccountOrders, fetchAccountRefunds, fetchItemEditDetail, syncItemEdit, uploadImage, fetchImSessions, fetchSessionMessages, mapOrderStatusText, collectOrderNodes, normalizeOrderNode, APP_KEY, IM_APP_KEY };

// ---------------- 订单历史同步（卖出订单列表） ----------------
// 报文参照 goofish 网页版订单页与 xianyu-sdk-ts 开源实现：
// POST mtop.taobao.idle.trade.merchant.sold.get/1.0，data = { pageNumber, rowsPerPage, orderIds, queryCode, orderSearchParam }
// 退款/售后单经 mtop.taobao.idle.merchant.refund.list/1.0 拉取。

/** 平台订单状态（枚举/文本/数字码）→ 本系统状态（售前 pending_paid/paid/delivered，售后 refunding/closed，终态 completed） */
function mapOrderStatusText(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  // 数字状态码（goofish trade 域：1 待付款 2 待发货 3 已发货 4/11 交易成功 7/9 退款中 8/10/12 关闭）
  const codeMap = { '1': 'pending_paid', '2': 'paid', '3': 'delivered', '4': 'completed', '7': 'refunding', '8': 'closed', '9': 'refunding', '10': 'closed', '11': 'completed', '12': 'closed' };
  if (/^\d+$/.test(s) && codeMap[s]) return codeMap[s];
  if (/wait_buyer|not_pay|待付款/i.test(lower)) return 'pending_paid';
  if (/refund|退款/i.test(lower)) return 'refunding';
  if (/ship|已发货|待收货/i.test(lower) && !/已收货|确认收货/i.test(lower)) return 'delivered';
  if (/success|complete|交易成功|交易完成/i.test(lower)) return 'completed';
  if (/close|cancel|关闭|撤销/i.test(lower)) return 'closed';
  if (/paid|已付款|待发货|seller_send|sell_send/i.test(lower)) return 'paid';
  return mapOrderStatusText(codeMap[s] || '') || '';
}

/** 递归收集响应里所有"订单形"节点（根级或 commonData 内含 orderId/orderIdStr 10 位以上数字） */
function collectOrderNodes(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10 || out.length > 500) return;
  if (Array.isArray(node)) { for (const n of node) collectOrderNodes(n, out, depth + 1); return; }
  const oid = node.orderId || node.orderIdStr || node.bizOrderId || node.id
    || (node.commonData && (node.commonData.orderId || node.commonData.orderIdStr))
    || '';
  const hasShape = node.tradeStatus !== undefined || node.orderStatus !== undefined || node.commonData
    || node.content || node.head || node.seller || node.peerUserId || node.tail;
  if (oid && /^\d{10,}$/.test(String(oid)) && hasShape) {
    out.push(node);
    return; // 订单节点不再下钻（避免把内层 commonData 又当独立订单）
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectOrderNodes(v, out, depth + 1);
  }
}

/** 订单节点 → 归一化字段（自适应新旧响应结构） */
function normalizeOrderNode(node, accountId) {
  const common = (node.commonData && typeof node.commonData === 'object') ? node.commonData : {};
  const buyerVO = (node.buyerInfoVO && typeof node.buyerInfoVO === 'object') ? node.buyerInfoVO : {};
  const itemVO = (node.itemVO && typeof node.itemVO === 'object') ? node.itemVO : {};
  const priceVO = (node.priceVO && typeof node.priceVO === 'object') ? node.priceVO : {};
  const orderId = String(node.orderId || node.orderIdStr || node.bizOrderId || common.orderId || common.orderIdStr || '');
  if (!orderId) return null;
  const pickText = (...vals) => {
    for (const v of vals) {
      if (v === undefined || v === null) continue;
      const s = typeof v === 'object' ? (v.text || v.value || v.amount || '') : v;
      if (s !== '' && s !== undefined && s !== null) return s;
    }
    return '';
  };
  // 状态：tradeStatus/tradeStatusEnum（可带文本）> orderStatus > head.orderStatus > utArgs.orderStatusName
  // 真实 sold.get 结构：commonData.orderStatus（"交易成功"）+ commonData.inRefund（退款标记）
  const statusRaw = node.tradeStatus !== undefined ? node.tradeStatus
    : node.tradeStatusEnum !== undefined ? node.tradeStatusEnum
      : node.orderStatus !== undefined ? node.orderStatus
        : common.orderStatus !== undefined ? common.orderStatus
          : (node.head && node.head.orderStatus) !== undefined ? node.head.orderStatus
            : (node.utArgs && node.utArgs.orderStatusName) || (common.utArgs && common.utArgs.orderStatusName)
              || (node.tail && node.tail.status) || '';
  const statusText = String(typeof statusRaw === 'object' ? (statusRaw.desc || statusRaw.text || '') : statusRaw)
    .replace(/^[A-Z_]+::/, '')
    .replace(/^(\d{4}[/-]\d{2}[/-]\d{2}[^:]*::)?/, '').replace(/^\d{4}[/-]\d{2}[/-]\d{2}$/, '').trim();
  // 商品/买家/金额/图片：先按真实结构字段（itemVO/priceVO/buyerInfoVO），再递归深搜兜底
  const deepStr = (keyRe) => {
    const hit = deepPick(node, keyRe, 0);
    return Array.isArray(hit) ? String(hit[0] || '') : String(hit || '');
  };
  const title = pickText(itemVO.title, node.itemTitle, node.title, common.itemTitle) || deepStr(/^(title|itemTitle)$/) || '';
  const itemId = String(node.itemId || common.itemId || itemVO.itemId || '') || deepStr(/^itemId$/) || '';
  const buyerId = String(buyerVO.buyerId || node.peerUserId || node.buyerUserId || common.peerUserId || (node.buyer && node.buyer.userId) || '') || deepStr(/^(peerUserId|buyerId)$/) || '';
  const buyerNick = String(buyerVO.userNick || node.buyerNick || (node.buyer && (node.buyer.nick || node.buyer.nickname)) || '') || '';
  const price = Number(pickText(priceVO.totalPrice, priceVO.auctionPrice, node.price, node.totalPrice, node.amount, common.price, common.totalPrice))
    || Number(deepStr(/^(totalPrice|auctionPrice|price|amount)$/)) || 0;
  const pic = String(itemVO.itemPicUrl || itemVO.iconUrl || node.picUrl || (node.item && node.item.picUrl) || '') || deepStr(/^(picUrl|itemPicUrl)$/) || '';
  const quantity = Number(priceVO.buyNum || node.buyNum || node.quantity) || 1;
  const timeStr = pickText(common.createTime, node.orderTime, node.createTime, node.gmtCreate, (node.utArgs && node.utArgs.orderCreateTime)) || deepStr(/^createTime$/) || '';
  let placedAt = null;
  if (/^\d{10,13}$/.test(String(timeStr))) {
    const n = Number(timeStr);
    const d = new Date(n > 1e12 ? n : n * 1000);
    if (!Number.isNaN(d.getTime())) placedAt = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  } else if (/\d{4}-\d{2}-\d{2}/.test(String(timeStr))) {
    const m = String(timeStr).match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?)/);
    if (m) placedAt = m[1].length === 16 ? m[1] + ':00' : m[1];
  }
  const mapped = mapOrderStatusText(statusRaw);
  // 退款标记：真实结构 commonData.inRefund（状态文本未体现退款时兜底）
  const inRefund = common.inRefund === true || node.inRefund === true;
  const status = mapped || (inRefund ? 'refunding' : 'paid');
  const finalStatusText = (inRefund && !/退款/.test(statusText)) ? '退款中' : statusText;
  return {
    order_no: orderId,
    item_platform_id: itemId,
    buyer_id: buyerId || 'unknown',
    buyer_nick: buyerNick || (buyerId ? `买家${String(buyerId).slice(-4)}` : '平台买家'),
    quantity: Math.max(1, quantity),
    title: String(title).replace(/<[^>]+>/g, '').slice(0, 255),
    price: Math.round(price * 100) / 100,
    main_image: pic.slice(0, 500),
    status,
    status_text: finalStatusText.slice(0, 100),
    placed_at: placedAt,
    raw_account: String(accountId || ''),
  };
}

/** 深搜对象：返回第一个匹配 keyRe 的值；命中键为对象时取其 text/value/amount */
function deepPick(node, keyRe, depth) {
  if (!node || typeof node !== 'object' || depth > 8) return '';
  if (Array.isArray(node)) {
    for (const n of node) { const r = deepPick(n, keyRe, depth + 1); if (r) return r; }
    return '';
  }
  for (const [k, v] of Object.entries(node)) {
    if (keyRe.test(k) && v !== '' && v !== null && v !== undefined) {
      if (typeof v === 'string' || typeof v === 'number') return v;
      if (typeof v === 'object') {
        const inner = v.text || v.value || v.amount || (typeof v.price === 'object' ? (v.price.text || v.price.value) : v.price) || '';
        if (inner !== '' && inner !== null && inner !== undefined) return inner;
      }
    }
    if (typeof v === 'object' && v) {
      const r = deepPick(v, keyRe, depth + 1);
      if (r) return r;
    }
  }
  return '';
}

/**
 * 拉取账号卖出订单列表（真实接口 mtop.taobao.idle.trade.merchant.sold.get）。
 * 响应结构自适应解析（goofish 前端结构随版本变化）。
 * 成功返回 { ok:true, orders:[...], api_used, totalCount, nextPage }；失败 { ok:false, reason, ret }。
 */
async function fetchAccountOrders(account, { page = 1 } = {}) {
  const jar = parseCookieString(account.cookie);
  if (!Object.keys(jar).length) return { ok: false, reason: '账号无 Cookie 凭证' };
  const dataObj = {
    pageNumber: Math.max(1, Number(page) || 1),
    rowsPerPage: 20,
    orderIds: '',
    queryCode: 'ALL',
    orderSearchParam: '{}',
  };
  const api = 'mtop.taobao.idle.trade.merchant.sold.get';
  const r = await mtopCall({
    api,
    dataObj,
    jar,
    extraQuery: { sessionOption: 'AutoLoginOnly', spm_cnt: 'a21ybx.order-detail.0.0', valueType: 'string' },
  });
  if (!r.ok) {
    return { ok: false, reason: '卖出订单接口失败: ' + (r.ret || ''), ret: r.ret, api_used: api, jar };
  }
  const nodes = [];
  collectOrderNodes(r.data || {}, nodes);
  const seen = new Set();
  const orders = [];
  for (const n of nodes) {
    const o = normalizeOrderNode(n, account.account_id);
    if (!o || seen.has(o.order_no)) continue;
    seen.add(o.order_no);
    orders.push(o);
  }
  const totalCount = (r.data && (r.data.totalCount !== undefined)) ? Number(r.data.totalCount) : null;
  const nextPage = !!(r.data && r.data.nextPage !== undefined && r.data.nextPage !== false && r.data.nextPage !== 'false');
  return {
    ok: true,
    orders,
    api_used: api,
    totalCount: Number.isFinite(totalCount) ? totalCount : null,
    nextPage: nextPage && orders.length > 0,
    jar,
  };
}

/**
 * 拉取退款/售后订单列表（mtop.taobao.idle.merchant.refund.list/1.0，queryType=refund）。
 * 返回 { ok, orders:[归一化订单], api_used }。
 */
async function fetchAccountRefunds(account, { page = 1, rowsPerPage = 20, disputeStatus = '' } = {}) {
  const jar = parseCookieString(account.cookie);
  if (!Object.keys(jar).length) return { ok: false, reason: '账号无 Cookie 凭证' };
  const dataObj = {
    pageNumber: Math.max(1, Number(page) || 1),
    rowsPerPage: Math.min(50, Math.max(1, Number(rowsPerPage) || 20)),
    queryType: 'refund',
    refundSearchParam: { disputeStatus: disputeStatus || '', queryCode: 'ALL' },
  };
  const api = 'mtop.taobao.idle.merchant.refund.list';
  const r = await mtopCall({
    api,
    dataObj,
    jar,
    extraQuery: { sessionOption: 'AutoLoginOnly', spm_cnt: 'a21ybx.order-detail.0.0', valueType: 'string' },
  });
  if (!r.ok) return { ok: false, reason: '退款列表接口失败: ' + (r.ret || ''), ret: r.ret, api_used: api, jar };
  const nodes = [];
  collectOrderNodes(r.data || {}, nodes);
  const orders = [];
  for (const n of nodes) {
    const o = normalizeOrderNode(n, account.account_id);
    if (!o) continue;
    o.status = 'refunding'; // 退款列表中的单据统一视为售后进行中
    o.status_text = o.status_text || '退款中';
    orders.push(o);
  }
  return { ok: true, orders, api_used: api, jar };
}

// ---------------- 商品详情（描述文案） ----------------

/**
 * 拉取单个商品详情（真实接口 mtop.taobao.idle.pc.detail），尽力解析描述文案。
 * 成功返回 { ok:true, desc, main_image, images:[url] }；失败 { ok:false, reason }。
 */
async function fetchItemDetail(account, itemId) {
  const jar = parseCookieString(account.cookie);
  if (!Object.keys(jar).length) return { ok: false, reason: '账号无 Cookie 凭证' };
  const r = await mtopCall({
    api: 'mtop.taobao.idle.pc.detail',
    dataObj: { itemId: String(itemId) },
    jar,
    extraQuery: { sessionOption: 'AutoLoginOnly' },
  });
  if (!r.ok) return { ok: false, reason: '商品详情接口失败: ' + (r.ret || '') };
  // 描述文案自适应提取：itemDO.desc / descProps / main.exContent.desc 等
  const desc = String(deepPick(r.data, /^(desc|description|detailDesc)$/, 0) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // 图片：递归收集 picUrl 类字段去重（前 9 张）
  const imgs = [];
  const collectPics = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8 || imgs.length >= 9) return;
    if (Array.isArray(node)) { for (const n of node) collectPics(n, depth + 1); return; }
    for (const [k, v] of Object.entries(node)) {
      if (/^picUrl$|^imageUrl$|^imgUrl$/i.test(k) && typeof v === 'string' && /^https?:\/\//.test(v) && !imgs.includes(v)) imgs.push(v);
      else if (v && typeof v === 'object') collectPics(v, depth + 1);
    }
  };
  collectPics(r.data);
  return {
    ok: true,
    desc: desc.slice(0, 2000),
    main_image: imgs[0] || '',
    images: imgs,
  };
}

// ---------------- 商品编辑同步到闲鱼（editDetail → edit） ----------------
// 报文参照 goofish PC 编辑页（www.goofish.com/publish?itemId=...）与 pyxianyu 开源实现：
//   1. mtop.idle.pc.idleitem.editDetail/1.0 { itemId } 读取可编辑详情
//   2. 修改 itemTextDTO / itemPriceDTO / imageInfoDOList 后
//   3. mtop.idle.pc.idleitem.edit/1.0 提交（uniqueCode + bizcode/publishScene=pcMainPublish）

const UPLOAD_HOST = 'https://stream-upload.goofish.com/api/upload.api';

/** 拉取商品可编辑详情（真实接口） */
async function fetchItemEditDetail(account, itemId) {
  const jar = parseCookieString(account.cookie);
  if (!Object.keys(jar).length) return { ok: false, reason: '账号无 Cookie 凭证' };
  const r = await mtopCall({
    api: 'mtop.idle.pc.idleitem.editDetail',
    dataObj: { itemId: String(itemId) },
    jar,
    extraQuery: { sessionOption: 'AutoLoginOnly', spm_cnt: 'a21ybx.publish.0.0' },
  });
  if (!r.ok) return { ok: false, reason: '编辑详情接口失败: ' + (r.ret || ''), ret: r.ret, jar };
  const d = r.data || {};
  if (!d.itemTextDTO && !d.itemPriceDTO && !d.imageInfoDOList) {
    return { ok: false, reason: '编辑详情响应缺少可编辑字段（可能类目不支持网页端编辑）', ret: r.ret, jar };
  }
  return { ok: true, detail: d, jar };
}

/**
 * 同步工作台商品信息到闲鱼平台（标题/描述/价格/首图）。
 * 流程：editDetail → 覆盖工作台提供的字段 → edit 提交（其余字段原样保留）。
 * @param {object} account xy_accounts 行（需真实 Cookie）
 * @param {{item_id:string, title?:string, description?:string, price?:number, original_price?:number, main_image?:string}} patch
 * @returns {{ok:true, item_id, ret, data}} 或 { ok:false, reason, ret }
 */
async function syncItemEdit(account, patch) {
  const got = await fetchItemEditDetail(account, patch.item_id);
  if (!got.ok) return got;
  const payload = { ...got.detail };
  // 文案：标题/描述（显式拆分标题与描述）
  const text = { ...(payload.itemTextDTO || {}) };
  if (patch.title !== undefined && patch.title !== '') text.title = String(patch.title).slice(0, 60);
  if (patch.description !== undefined && patch.description !== '') text.desc = String(patch.description).slice(0, 2000);
  if (patch.title !== undefined || patch.description !== undefined) {
    text.titleDescSeparate = true;
    payload.itemTextDTO = text;
  }
  // 价格（单位：分）
  const price = { ...(payload.itemPriceDTO || {}) };
  if (Number(patch.price) > 0) price.priceInCent = String(Math.round(Number(patch.price) * 100));
  if (Number(patch.original_price) > 0) price.origPriceInCent = String(Math.round(Number(patch.original_price) * 100));
  payload.itemPriceDTO = price;
  // 首图：替换/新增 imageInfoDOList 第一张
  if (patch.main_image && /^https?:\/\//.test(String(patch.main_image))) {
    const list = Array.isArray(payload.imageInfoDOList) ? payload.imageInfoDOList.filter(Boolean) : [];
    if (list.length) list[0] = { ...list[0], url: String(patch.main_image), major: true, status: 'done' };
    else list.unshift({
      extraInfo: { isH: 'false', isT: 'false', raw: 'false' },
      isQrCode: false,
      url: String(patch.main_image),
      heightSize: 800,
      widthSize: 800,
      major: true,
      type: 0,
      status: 'done',
    });
    payload.imageInfoDOList = list;
  }
  // 提交（参照 pyxianyu edit_item：uniqueCode 32 位、pcMainPublish 场景）
  payload.itemId = String(patch.item_id);
  payload.uniqueCode = require('crypto').randomBytes(16).toString('hex');
  payload.bizcode = 'pcMainPublish';
  payload.publishScene = 'pcMainPublish';
  payload.sourceId = String(patch.item_id);
  const r = await mtopCall({
    api: 'mtop.idle.pc.idleitem.edit',
    dataObj: payload,
    jar: got.jar,
    extraQuery: { sessionOption: 'AutoLoginOnly', spm_cnt: 'a21ybx.publish.0.0' },
  });
  if (!r.ok) {
    return { ok: false, reason: '平台编辑提交失败: ' + (r.ret || ''), ret: r.ret, item_id: String(patch.item_id) };
  }
  return { ok: true, item_id: String(patch.item_id), ret: r.ret, data: r.data };
}

// ---------------- 图片上传（goofish 媒体上传，非 mtop） ----------------

/**
 * 上传图片到闲鱼 CDN（stream-upload.goofish.com，Cookie 鉴权，multipart/form-data）。
 * @param {object} account xy_accounts 行（需真实 Cookie）
 * @param {Buffer} buffer 图片字节
 * @param {string} filename 文件名（决定 MIME）
 * @returns {{ok:true, url, width?, height?}} 或 { ok:false, reason }
 */
async function uploadImage(account, buffer, filename) {
  const cookie = String(account.cookie || '');
  if (!cookie) return { ok: false, reason: '账号无 Cookie 凭证' };
  const ext = String(filename || 'a.jpg').split('.').pop().toLowerCase();
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/jpeg';
  const safeName = ('img_' + Date.now() + '.' + (ext === 'jpeg' ? 'jpg' : ext)).replace(/["\r\n]/g, '_');
  const boundary = '----wb' + require('crypto').randomBytes(12).toString('hex');
  const head = Buffer.from(
    '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + safeName + '"\r\nContent-Type: ' + mime + '\r\n\r\n',
    'utf8'
  );
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
  const body = Buffer.concat([head, buffer, tail]);
  let res;
  try {
    res = await fetch(UPLOAD_HOST + '?floderId=0&appkey=xy_chat&_input_charset=utf-8', {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Accept': '*/*',
        'Origin': 'https://www.goofish.com',
        'Referer': 'https://www.goofish.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body,
      signal: AbortSignal.timeout(30 * 1000),
    });
  } catch (e) {
    return { ok: false, reason: '上传请求失败: ' + (e && e.message) };
  }
  const j = await res.json().catch(() => null);
  if (!j) return { ok: false, reason: '上传响应解析失败（HTTP ' + res.status + '）' };
  const url = (j.data && j.data.url) || (j.object && j.object.url) || j.url || (j.data && (j.data.fileUrl || j.data.file_url)) || '';
  if (!url) {
    const ret0 = Array.isArray(j.ret) && j.ret[0];
    if (typeof ret0 === 'string' && /SESSION|NEED_LOGIN/i.test(ret0)) return { ok: false, reason: '登录已失效，请重新扫码（' + ret0 + '）' };
    if (/login|mini-login/i.test(JSON.stringify(j).slice(0, 500))) return { ok: false, reason: '上传会话已失效，请重新扫码登录' };
    return { ok: false, reason: '上传响应缺少图片 URL: ' + JSON.stringify(j).slice(0, 200) };
  }
  return {
    ok: true,
    url: String(url).startsWith('//') ? 'https:' + url : String(url),
    width: (j.object && j.object.width) || (j.data && j.data.width) || undefined,
    height: (j.object && j.object.height) || (j.data && j.data.height) || undefined,
  };
}

// ---------------- IM 会话/历史消息同步（session.sync + user.query） ----------------
// 报文参照 goofish web /im 页（pyxianyu docs/mtop_taobao_idlemessage_pc_session_sync.md）。

/** 同步会话摘要列表（真实接口 mtop.taobao.idlemessage.pc.session.sync/3.0） */
async function fetchImSessions(account, { fetchNum = 30 } = {}) {
  const jar = parseCookieString(account.cookie);
  if (!Object.keys(jar).length) return { ok: false, reason: '账号无 Cookie 凭证' };
  const r = await mtopCall({
    api: 'mtop.taobao.idlemessage.pc.session.sync',
    v: '3.0',
    dataObj: { sessionTypes: '[1,19,15,32,3,44,51,52,24]', fetchNum, sortIndex: null, sessionId: null },
    jar,
    extraQuery: { sessionOption: 'AutoLoginOnly', spm_cnt: 'a21ybx.im.0.0' },
  });
  if (!r.ok) return { ok: false, reason: '会话同步接口失败: ' + (r.ret || ''), ret: r.ret, jar };
  const sessions = (r.data && Array.isArray(r.data.sessions)) ? r.data.sessions : [];
  return { ok: true, sessions, hasMore: !!(r.data && r.data.hasMore), jar };
}

/**
 * 拉取单会话历史消息（mtop.taobao.idlemessage.pc.user.query/4.0，type=0）。
 * content.custom.data 为 base64(JSON)（与 WS 推送同编码），这里原样带出由调用方解码。
 */
async function fetchSessionMessages(account, sessionId, { messageCursor, sessionType = 1, isOwner = true } = {}) {
  const jar = parseCookieString(account.cookie);
  if (!Object.keys(jar).length) return { ok: false, reason: '账号无 Cookie 凭证' };
  const dataObj = { type: 0, sessionType, sessionId: String(sessionId), isOwner: !!isOwner };
  if (messageCursor) dataObj.messageId = String(messageCursor);
  const r = await mtopCall({
    api: 'mtop.taobao.idlemessage.pc.user.query',
    v: '4.0',
    dataObj,
    jar,
    extraQuery: { sessionOption: 'AutoLoginOnly', spm_cnt: 'a21ybx.im.0.0' },
  });
  if (!r.ok) return { ok: false, reason: '历史消息接口失败: ' + (r.ret || ''), ret: r.ret, jar };
  const d = r.data || {};
  return {
    ok: true,
    messages: Array.isArray(d.messages) ? d.messages : [],
    userInfo: d.userInfo || {},
    hasMore: !!d.hasMore,
    jar,
  };
}
