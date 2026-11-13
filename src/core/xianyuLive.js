'use strict';
// 闲鱼 WS 监听核心（真实账号专用）：连接 goofish 推送通道，监听买家对话与订单事件并入库
// 协议参照 xianyu-super-butler（XianyuAutoAsync）：
//   /reg 注册（DingTalk UA）→ 1s 后 /r/SyncStatus/ackDiff（关键：不发此帧服务端不下发推送）
//   → 心跳 /! → syncPushPackage 推送（base64+msgpack）→ 逐帧回 ACK → 解析入库
// 消息结构（与参考实现 handle_message 一致）：
//   聊天消息 decoded['1'] 为对象 { '2': cid@goofish, '5': 时间戳ms, '10': {senderUserId, senderNick,
//   reminderContent, reminderUrl(含 itemId=), sessionType} }；decoded['3'].redReminder 为订单状态提醒
//   系统通知 decoded['1'] 为字符串发送者ID@goofish
const WebSocket = require('ws');
const { decodeMsgpack } = require('./msgpack');
const xianyuApi = require('../services/xianyuApi');
const { query, queryOne } = require('../db');
const { sysLog } = require('../services/logs');
const logger = require('../logger');

const WS_URL = 'wss://wss-goofish.dingtalk.com/';
const APP_KEY = '34839810';
const IM_APP_KEY = '444e9908a51d1cb236a27862abc769c9';
// /reg 注册用的 UA 必须为 DingTalk 形态（与参考实现一致，否则注册不生效）
const REG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 DingTalk(2.1.5) OS(Windows/10) Browser(Chrome/133.0.0.0) DingWeb/2.1.5 IMPaaS DingWeb/2.1.5';
const HEARTBEAT_MS = 15 * 1000;
const TOKEN_REFRESH_MS = 60 * 60 * 1000; // 1 小时刷新令牌

/** accountId -> 实例 { ws, timers, stopping } */
const instances = new Map();

/** 与参考实现对齐的 mid/uuid 生成（mid 含尾部 " 0"） */
function genMid() { return Math.floor(Math.random() * 1000) + String(Date.now()) + ' 0'; }
function genUuid() { return '-' + Date.now() + '1'; }

function cookieStateOf(acc) {
  if (!acc.cookie_expires_at) return acc.cookie ? 'unknown' : 'none';
  const exp = new Date(String(acc.cookie_expires_at).replace(' ', 'T')).getTime();
  if (!Number.isFinite(exp)) return 'unknown';
  return (exp - Date.now()) / 3600000 <= 0 ? 'expired' : 'ok';
}

function isRealOnlineCandidate(acc) {
  return /^\d+$/.test(String(acc.account_id)) && !!acc.cookie && !/(demo=1|demo-cookie-)/.test(String(acc.cookie));
}

// ---------------- 通用解析工具 ----------------

/** 从解码后的推送里递归收集 updateKey / bizOrderId（订单事件标志） */
function collectKeys(node, out) {
  if (!node || typeof node !== 'object' || out.depth > 10) return;
  if (Array.isArray(node)) { for (const n of node) collectKeys(n, out); return; }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      // updateKey 形如 "<cid>:<bizOrderId>:<状态>_<角色>"
      const m = v.match(/(\d{10,}):(\d{10,}):([a-z_]+)/);
      if (m) { out.orderKeys.add(m[0]); out.orderInfo.set(m[0], v); }
      const oid = v.match(/bizOrderId=(\d{10,})/);
      if (oid) out.orderIds.add(oid[1]);
      const od = v.match(/orderId=(\d{10,})/);
      if (od) out.orderIds.add(od[1]);
    } else if (v && typeof v === 'object') {
      out.depth++;
      collectKeys(v, out);
      out.depth--;
    }
  }
}

/** 订单状态关键词 → 本系统状态（覆盖闲鱼全部订单状态；参考实现 order_status_handler 同口径） */
function mapOrderStatus(text) {
  const t = String(text || '');
  if (/not_pay|待付款|已拍下|等待买家付款/.test(t)) return 'pending_paid';
  if (/refund|退款/.test(t)) return 'refunding';
  if (/已发货|待收货|shipped|delivered/.test(t)) return 'delivered';
  if (/成功|完成|success/.test(t)) return 'completed';
  if (/closed|关闭|cancel|撤销/.test(t)) return 'closed';
  if (/paid|付款|已付款|待发货|等待卖家发货|买家已付款/.test(t)) return 'paid';
  return 'paid';
}

/** 平台商品ID → 本系统商品ID */
async function localItemIdOf(platformItemId) {
  if (!platformItemId) return null;
  const row = await queryOne('SELECT id FROM xy_items WHERE item_id = ?', [String(platformItemId)]);
  return row ? row.id : null;
}

/** 递归寻找对象里第一个匹配 key 的字符串值（用于 itemId 提取兜底） */
function deepFind(node, keyRe, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return '';
  if (Array.isArray(node)) {
    for (const n of node) { const r = deepFind(n, keyRe, depth + 1); if (r) return r; }
    return '';
  }
  for (const [k, v] of Object.entries(node)) {
    if (keyRe.test(k) && typeof v === 'string' && v) return v;
    const r = deepFind(v, keyRe, depth + 1);
    if (r) return r;
  }
  return '';
}

/** 消息去重键（ext_id）：账号+会话+发送者+时间+内容摘要 */
function msgExtKey(account, { cid, senderId, ts, content }) {
  const c = String(content || '').slice(0, 120);
  return `${account.account_id}|${cid || ''}|${senderId || ''}|${ts || ''}|${c}`;
}

async function isDupMessage(extId) {
  if (!extId) return false;
  const dup = await queryOne('SELECT id FROM xy_messages WHERE ext_id = ?', [extId.slice(0, 250)]);
  return !!dup;
}

/** 更新会话的闲鱼会话 ID（真实发送消息要用作 cid） */
async function bindSessionId(account, buyerId, cid) {
  if (!cid) return;
  await query(
    "UPDATE xy_conversations SET session_id = ? WHERE account_id = ? AND buyer_id = ? AND (session_id IS NULL OR session_id = '' OR session_id <> ?)",
    [cid, account.id, buyerId, cid]
  );
}

// ---------------- 推送处理 ----------------

/**
 * 聊天推送（decoded['1'] 为对象，含 10 键消息详情）→ 复用回复引擎入库与自动回复（售前链路）。
 * 自己发出的消息（senderUserId == myid）落为 out 记录，不触发自动回复。
 */
async function handleChatMessage(account, st, decoded) {
  const m1 = decoded['1'];
  if (!m1 || typeof m1 !== 'object') return false;
  const m10 = (typeof m1['10'] === 'object' && m1['10']) ? m1['10'] : null;
  if (!m10 || typeof m10.reminderContent === 'undefined') return false;

  const cid = String(m1['2'] || '').split('@')[0];
  const ts = Number(m1['5']) || Date.now();
  const senderId = String(m10.senderUserId || '').split('@')[0] || 'unknown';
  const senderNick = String(m10.senderNick || m10.reminderTitle || '').slice(0, 100) || `买家${senderId.slice(-4)}`;
  const content = String(m10.reminderContent || '').slice(0, 2000);
  const sessionType = String(m10.sessionType || '1');
  const extId = msgExtKey(account, { cid, senderId, ts, content });
  if (await isDupMessage(extId)) return true;

  // 平台商品ID：reminderUrl 里的 itemId= 优先，找不到则深搜兜底
  let platformItemId = '';
  const url = String(m10.reminderUrl || '');
  if (url.includes('itemId=')) platformItemId = (url.split('itemId=')[1] || '').split('&')[0];
  if (!platformItemId) platformItemId = deepFind(decoded, /^(itemId|item_id)$/);
  const localItemId = await localItemIdOf(platformItemId);

  const isSelf = senderId === String(st.myid);
  logger.debug('sync', `消息推送 account=${account.account_id} from=${senderId} cid=${cid} self=${isSelf} content=${content.slice(0, 40)}`);

  if (isSelf) {
    // 自己在闲鱼 App 里发的消息：按 cid 找会话补录一条 out（找不到则跳过）
    const conv = cid
      ? await queryOne('SELECT * FROM xy_conversations WHERE account_id = ? AND session_id = ?', [account.id, cid])
      : null;
    if (conv) {
      await query(
        "INSERT INTO xy_messages (conversation_id, account_id, direction, source, msg_type, content, ext_id, item_id) VALUES (?, ?, 'out', 'manual', 'text', ?, ?, ?)",
        [conv.id, account.id, content, extId.slice(0, 250), conv.item_id]
      );
      await query("UPDATE xy_conversations SET last_message = ?, updated_at = datetime('now','localtime') WHERE id = ?", [content.slice(0, 500), conv.id]);
    }
    return true;
  }

  if (sessionType === '30') {
    logger.debug('sync', `跳过群组消息 account=${account.account_id} cid=${cid}`);
    return true;
  }

  // 买家消息 → 回复引擎（会话创建/入库/CRM/自动回复全链路）
  const replyEngine = require('./replyEngine'); // 惰性引入避免循环依赖
  await replyEngine.handleBuyerMessage(account, {
    buyer_id: senderId,
    buyer_nick: senderNick,
    item_id: localItemId,
    text: content,
    msg_type: 'text',
    ext_id: extId.slice(0, 250),
  });
  await bindSessionId(account, senderId, cid);
  return true;
}

/** 订单推送 → 订单表 upsert（状态映射覆盖全部订单状态） */
async function handleOrderPush(account, bizOrderId, statusText) {
  if (!/^\d{10,}$/.test(String(bizOrderId || ''))) return;
  const status = mapOrderStatus(statusText);
  const exists = await queryOne('SELECT id, status FROM xy_orders WHERE order_no = ?', [String(bizOrderId)]);
  if (exists) {
    if (exists.status !== status) {
      await query("UPDATE xy_orders SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?", [status, exists.id]);
      sysLog('info', 'sync', `订单 ${bizOrderId} 状态同步：${exists.status} → ${status}`);
    }
    return;
  }
  // 新订单：买家信息未知（详情由订单同步任务/详情接口补全），金额待详情接口
  await query(
    `INSERT INTO xy_orders (order_no, account_id, item_id, buyer_id, buyer_nick, quantity, amount, status, is_virtual, delivery_status, source, placed_at)
     VALUES (?, ?, 0, ?, '平台买家', 1, 0, ?, 0, 'none', 'sync', datetime('now','localtime'))`,
    [String(bizOrderId), account.id, 'sync_' + (account.account_id || ''), status]
  );
  sysLog('info', 'sync', `订单 ${bizOrderId} 实时新增（状态 ${status}）`);
}

/** 订单状态系统消息（decoded['3'].redReminder）→ 同步订单状态 */
async function handleRedReminder(account, decoded) {
  const m3 = (typeof decoded['3'] === 'object' && decoded['3']) ? decoded['3'] : null;
  const red = m3 ? String(m3.redReminder || '') : '';
  if (!red) return;
  const keys = { orderKeys: new Set(), orderIds: new Set(), orderInfo: new Map(), depth: 0 };
  collectKeys(decoded, keys);
  const status = mapOrderStatus(red);
  for (const key of keys.orderKeys) await handleOrderPush(account, key.split(':')[1], status);
  for (const oid of keys.orderIds) await handleOrderPush(account, oid, status);
}

/** 单条解码后的推送分发 */
async function dispatchDecoded(account, st, decoded) {
  if (!decoded || typeof decoded !== 'object') return;
  await handleChatMessage(account, st, decoded);
  await handleRedReminder(account, decoded);
  // 订单事件（updateKey / orderId / bizOrderId 出现在任意层）
  const keys = { orderKeys: new Set(), orderIds: new Set(), orderInfo: new Map(), depth: 0 };
  collectKeys(decoded, keys);
  for (const key of keys.orderKeys) {
    const statusText = key.split(':')[2] || '';
    await handleOrderPush(account, key.split(':')[1], statusText);
  }
  for (const oid of keys.orderIds) await handleOrderPush(account, oid, '');
}

// ---------------- WS 实例管理 ----------------

async function startInstance(account) {
  if (instances.has(account.id)) return;
  const st = { ws: null, timers: [], stopping: false, retries: 0, account, myid: String(account.account_id), pending: new Map() };
  instances.set(account.id, st);
  connect(st, account);
}

async function stopInstance(accountId) {
  const st = instances.get(accountId);
  if (!st) return;
  st.stopping = true;
  for (const t of st.timers) clearTimeout(t);
  try { if (st.ws) st.ws.close(); } catch (_) { /* ignore */ }
  instances.delete(accountId);
}

function scheduleReconnect(st, account) {
  if (st.stopping) return;
  st.retries = Math.min((st.retries || 0) + 1, 6);
  const delay = Math.min(60 * 1000, 5 * 1000 * st.retries);
  logger.warn('sync', `账号 ${account.account_id} WS 将在 ${Math.round(delay / 1000)}s 后重连（第 ${st.retries} 次）`);
  setTimeout(() => { if (!st.stopping && instances.has(account.id)) connect(st, account); }, delay);
}

/** 对收到的每一帧回 ACK（参考实现 handle_message 首段：服务端依赖确认继续推送） */
function ackFrame(ws, msg) {
  try {
    const headers = (msg && msg.headers) || {};
    const ack = {
      code: 200,
      headers: {
        mid: headers.mid || genMid(),
        sid: headers.sid || '',
      },
    };
    if ('app-key' in headers) ack.headers['app-key'] = headers['app-key'];
    if ('ua' in headers) ack.headers.ua = headers.ua;
    if ('dt' in headers) ack.headers.dt = headers.dt;
    ws.send(JSON.stringify(ack));
  } catch (_) { /* 忽略 ACK 发送失败 */ }
}

async function connect(st, account) {
  try {
    // 1) 刷新令牌（真实接口）
    const r = await xianyuApi.refreshAccountCookie(account);
    if (!r.ok) {
      logger.warn('sync', `账号 ${account.account_id} 凭证无效：${r.reason}，停止监听`);
      await query("UPDATE xy_accounts SET status = 'error' WHERE id = ?", [account.id]);
      stopInstance(account.id);
      return;
    }
    if (r.cookie && r.cookie !== account.cookie) {
      await query('UPDATE xy_accounts SET cookie = ? WHERE id = ?', [r.cookie, account.id]);
      account.cookie = r.cookie;
    }
    // 2) 取 accessToken（消息通道注册用）
    const tok = await xianyuApi.mtopCall({
      api: 'mtop.taobao.idlemessage.pc.login.token',
      dataObj: { appKey: IM_APP_KEY, deviceId: xianyuApi.genDeviceId(account.account_id) },
      jar: xianyuApi.parseCookieString(account.cookie),
      extraQuery: { sessionOption: 'AutoLoginOnly' },
    });
    const accessToken = (tok.data && tok.data.accessToken) || '';
    if (!accessToken) {
      logger.warn('sync', `账号 ${account.account_id} 未获取到 accessToken（${tok.ret}），稍后重连`);
      scheduleReconnect(st, account);
      return;
    }
    st.myid = String((tok.data && tok.data.userId) || account.account_id); // 平台侧自身 IM 用户 ID（发送回执用）
    // 3) 建立 WS 连接（Cookie 头用于鉴权）
    const ws = new WebSocket(WS_URL, { headers: { Cookie: account.cookie } });
    st.ws = ws;
    ws.on('open', async () => {
      st.retries = 0;
      // /reg 注册（UA 必须为 DingTalk 形态）
      ws.send(JSON.stringify({
        lwp: '/reg',
        headers: {
          'cache-header': 'app-key token ua wv',
          'app-key': IM_APP_KEY,
          token: accessToken,
          ua: REG_UA,
          dt: 'j',
          wv: 'im:3,au:3,sy:6',
          sync: '0,0;0;0;',
          did: xianyuApi.genDeviceId(account.account_id),
          mid: genMid(),
        },
      }));
      // 关键：注册 1s 后发送 ackDiff，服务端才会开始下发同步推送（参考实现 init）
      st.timers.push(setTimeout(() => {
        try {
          const nowMs = Date.now();
          ws.send(JSON.stringify({
            lwp: '/r/SyncStatus/ackDiff',
            headers: { mid: genMid() },
            body: [{
              pipeline: 'sync',
              tooLong2Tag: 'PNM,1',
              channel: 'sync',
              topic: 'sync',
              highPts: 0,
              pts: nowMs * 1000,
              seq: 0,
              timestamp: nowMs,
            }],
          }));
          logger.info('sync', `账号 ${account.account_id} 已发送 ackDiff（开始接收推送）`);
        } catch (_) { /* ignore */ }
      }, 1000));
      // 心跳
      st.timers.push(setInterval(() => {
        try { ws.send(JSON.stringify({ lwp: '/!', headers: { mid: genMid() } })); } catch (_) { /* ignore */ }
      }, HEARTBEAT_MS));
      // 令牌定期刷新（刷新后重连以启用新 token）
      st.timers.push(setTimeout(async () => {
        try {
          const fresh = await xianyuApi.refreshAccountCookie(account);
          if (fresh.ok && fresh.cookie) await query('UPDATE xy_accounts SET cookie = ? WHERE id = ?', [fresh.cookie, account.id]);
        } catch (_) { /* ignore */ }
        try { ws.close(); } catch (_) { /* ignore */ } // 触发重连流程
      }, TOKEN_REFRESH_MS));
      logger.info('sync', `账号 ${account.account_id} 消息监听已连接`);
      sysLog('info', 'sync', `账号 ${account.account_id} 消息监听已连接（真实通道）`);
    });
    ws.on('message', async (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      try {
        // 先回 ACK（心跳/注册回执除外）
        if (!(msg.code !== undefined && msg.headers)) ackFrame(ws, msg);
        // lwp 调用回执（/reg、消息发送等）：mid 匹配则唤醒等待方
        if (msg.code !== undefined && msg.headers && msg.headers.mid && st.pending && st.pending.has(msg.headers.mid)) {
          const p = st.pending.get(msg.headers.mid);
          st.pending.delete(msg.headers.mid);
          clearTimeout(p.timer);
          if (msg.code === 200) p.resolve(msg);
          else p.reject(new Error(`平台回执 code=${msg.code}${msg.message ? ' ' + msg.message : ''}`));
          return;
        }
        if (msg.code && msg.headers) { /* 其它 ack 响应，忽略 */ return; }
        const push = msg.body && msg.body.syncPushPackage;
        if (!push || !Array.isArray(push.data)) return;
        let handled = 0;
        for (const item of push.data) {
          if (!item || !item.data) continue;
          let decoded = null;
          try {
            decoded = decodeMsgpack(Buffer.from(item.data, 'base64'));
          } catch (e) {
            logger.warn('sync', `msgpack 解码失败（账号 ${account.account_id}）: ${e.message}`);
            continue;
          }
          await dispatchDecoded(account, st, decoded);
          handled++;
        }
        if (handled > 0) logger.debug('sync', `账号 ${account.account_id} 处理推送 ${handled} 帧`);
      } catch (e) {
        logger.warn('sync', `推送处理异常（账号 ${account.account_id}）: ${e.message}`);
      }
    });
    ws.on('error', (e) => logger.warn('sync', `账号 ${account.account_id} WS 错误: ${e.message}`));
    ws.on('close', () => {
      for (const t of st.timers) clearTimeout(t);
      st.timers = [];
      if (!st.stopping) scheduleReconnect(st, account);
    });
  } catch (e) {
    logger.error('sync', `账号 ${account.account_id} 监听启动失败: ${e.message}`);
    scheduleReconnect(st, account);
  }
}

// ---------------- 对外接口 ----------------

/** 启动账号消息监听（真实账号且凭证有效） */
async function startFor(account) {
  if (!/^\d+$/.test(String(account.account_id)) || !account.cookie) return false;
  await startInstance(account);
  return true;
}

/** 停止账号消息监听 */
async function stopFor(accountId) {
  await stopInstance(accountId);
}

function isRunning(accountId) { return instances.has(Number(accountId)); }
function runningAccounts() { return [...instances.keys()]; }

/**
 * 通过真实 WS 通道发送 IM 消息（协议与参考实现一致：/r/MessageSend/sendByReceiverScope）。
 * @param {number|string} accountId 本系统账号 ID
 * @param {{sessionId: string, buyerId: string, text: string}} payload
 * @returns {Promise<{mid: string}>} 平台确认后返回
 */
async function sendText(accountId, payload) {
  const st = instances.get(Number(accountId));
  if (!st || !st.ws || st.ws.readyState !== WebSocket.OPEN) {
    throw new Error('该账号消息监听未在线（需上线且凭证有效），无法真实发送');
  }
  const sessionId = String(payload.sessionId || '').trim();
  const buyerId = String(payload.buyerId || '').trim();
  const text = String(payload.text || '');
  if (!sessionId || !buyerId || !text) throw new Error('发送参数不完整（会话ID/买家ID/内容）');
  const content = { contentType: 1, text: { text } };
  const b64 = Buffer.from(JSON.stringify(content), 'utf8').toString('base64');
  const mid = genMid();
  const frame = {
    lwp: '/r/MessageSend/sendByReceiverScope',
    headers: { mid },
    body: [
      {
        uuid: genUuid(),
        cid: `${sessionId}@goofish`,
        conversationType: 1,
        content: { contentType: 101, custom: { type: 1, data: b64 } },
        redPointPolicy: 0,
        extension: { extJson: '{}' },
        ctx: { appVersion: '1.0', platform: 'web' },
        mtags: {},
        msgReadStatusSetting: 1,
      },
      { actualReceivers: [`${buyerId}@goofish`, `${st.myid}@goofish`] },
    ],
  };
  return sendFrame(st, mid, frame);
}

/**
 * 通过真实 WS 通道发送图片消息（imageUrl 需为闲鱼 CDN 或公网可访问链接）。
 * @param {number|string} accountId
 * @param {{sessionId: string, buyerId: string, imageUrl: string, width?: number, height?: number}} payload
 */
async function sendImage(accountId, payload) {
  const st = instances.get(Number(accountId));
  if (!st || !st.ws || st.ws.readyState !== WebSocket.OPEN) {
    throw new Error('该账号消息监听未在线（需上线且凭证有效），无法真实发送');
  }
  const sessionId = String(payload.sessionId || '').trim();
  const buyerId = String(payload.buyerId || '').trim();
  const url = String(payload.imageUrl || '');
  if (!sessionId || !buyerId || !url) throw new Error('发送参数不完整（会话ID/买家ID/图片URL）');
  const content = {
    contentType: 2,
    image: { pics: [{ height: Number(payload.height) || 600, type: 0, url, width: Number(payload.width) || 800 }] },
  };
  const b64 = Buffer.from(JSON.stringify(content), 'utf8').toString('base64');
  const mid = genMid();
  const frame = {
    lwp: '/r/MessageSend/sendByReceiverScope',
    headers: { mid },
    body: [
      {
        uuid: genUuid(),
        cid: `${sessionId}@goofish`,
        conversationType: 1,
        content: { contentType: 101, custom: { type: 1, data: b64 } },
        redPointPolicy: 0,
        extension: { extJson: '{}' },
        ctx: { appVersion: '1.0', platform: 'web' },
        mtags: {},
        msgReadStatusSetting: 1,
      },
      { actualReceivers: [`${buyerId}@goofish`, `${st.myid}@goofish`] },
    ],
  };
  return sendFrame(st, mid, frame);
}

/** 发送 lwp 帧并等待平台回执（6 秒超时） */
function sendFrame(st, mid, frame) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      st.pending.delete(mid);
      reject(new Error('发送超时（6 秒内未收到平台确认）'));
    }, 6000);
    st.pending.set(mid, { resolve, reject, timer });
    try {
      st.ws.send(JSON.stringify(frame));
    } catch (e) {
      clearTimeout(timer);
      st.pending.delete(mid);
      reject(new Error('WS 发送失败: ' + e.message));
    }
  });
}

/**
 * 通过账号的在线 WS 通道调用 lwp 路由（如 /r/Conversation/listNewestPagination、
 * /r/MessageManager/listUserMessages），返回平台回执整包。
 */
async function wsCall(accountId, lwp, body, timeoutMs = 6000) {
  const st = instances.get(Number(accountId));
  if (!st || !st.ws || st.ws.readyState !== WebSocket.OPEN) {
    throw new Error('该账号消息监听未在线（需上线且凭证有效）');
  }
  const mid = genMid();
  const frame = { lwp, headers: { mid } };
  if (body !== undefined) frame.body = body;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      st.pending.delete(mid);
      reject(new Error('WS 调用超时（' + Math.round(timeoutMs / 1000) + 's 内未收到回执）'));
    }, timeoutMs);
    st.pending.set(mid, { resolve, reject, timer });
    try {
      st.ws.send(JSON.stringify(frame));
    } catch (e) {
      clearTimeout(timer);
      st.pending.delete(mid);
      reject(new Error('WS 发送失败: ' + e.message));
    }
  });
}

module.exports = { startFor, stopFor, isRunning, runningAccounts, sendText, sendImage, wsCall, mapOrderStatus };
