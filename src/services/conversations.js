'use strict';
// 会话与消息
const { query, queryOne, localDateTimeString } = require('../db');
const { ApiError, CODE, pageOf, paged } = require('../http/respond');
const { sysLog } = require('./logs');
const crm = require('./crm');
const xianyuLive = require('../core/xianyuLive');
const { getMode } = require('./mode');

async function getConversation(id) {
  const row = await queryOne(
    'SELECT c.*, a.nickname AS account_nickname, i.title AS item_title '
    + 'FROM xy_conversations c '
    + 'LEFT JOIN xy_accounts a ON a.id = c.account_id '
    + 'LEFT JOIN xy_items i ON i.id = c.item_id '
    + 'WHERE c.id = ?',
    [id]
  );
  // 真实通道判定：账号 WS 在线且已有闲鱼会话 ID（手动回复可真实送达）
  if (row) row.real_channel = !!(xianyuLive.isRunning(row.account_id) && row.session_id);
  return row;
}

/** 按账号+买家定位会话，不存在则创建 */
async function ensureConversation(accountId, { buyerId, buyerNick, itemId }) {
  let conv = await queryOne(
    'SELECT * FROM xy_conversations WHERE account_id = ? AND buyer_id = ? ORDER BY id DESC LIMIT 1',
    [accountId, buyerId]
  );
  if (!conv) {
    const r = await query(
      'INSERT INTO xy_conversations (account_id, buyer_id, buyer_nick, item_id, last_message) VALUES (?, ?, ?, ?, ?)',
      [accountId, buyerId, buyerNick, itemId || null, '']
    );
    conv = await queryOne('SELECT * FROM xy_conversations WHERE id = ?', [r.insertId]);
  } else if (itemId && !conv.item_id) {
    await query('UPDATE xy_conversations SET item_id = ? WHERE id = ?', [itemId, conv.id]);
    conv.item_id = itemId;
  }
  return conv;
}

async function insertMessage({ conversationId, accountId, direction, source, msgType, content, imageUrl, itemId, extId }) {
  const r = await query(
    'INSERT INTO xy_messages (conversation_id, account_id, direction, source, msg_type, content, image_url, item_id, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [conversationId, accountId, direction, source || 'manual', msgType || 'text', content, imageUrl || null, itemId || null, extId || null]
  );
  if (direction === 'in') {
    await query(
      "UPDATE xy_conversations SET last_message = ?, unread_count = unread_count + 1, updated_at = datetime('now','localtime') WHERE id = ?",
      [String(content || '').slice(0, 500), conversationId]
    );
  } else {
    await query(
      "UPDATE xy_conversations SET last_message = ?, updated_at = datetime('now','localtime') WHERE id = ?",
      [String(content || '').slice(0, 500), conversationId]
    );
  }
  return { id: r.insertId, conversation_id: conversationId, direction, msg_type: msgType || 'text', content };
}

async function listConversations(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const accountId = q.get('account_id');
  const status = q.get('status');
  if (accountId) { where.push('c.account_id = ?'); params.push(Number(accountId)); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  const kw = q.get('keyword');
  if (kw) { where.push('(c.buyer_nick LIKE ? OR c.last_message LIKE ?)'); params.push(`%${kw}%`, `%${kw}%`); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_conversations c WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT c.*, a.nickname AS account_nickname, a.status AS account_status, i.title AS item_title
     FROM xy_conversations c
     LEFT JOIN xy_accounts a ON a.id = c.account_id
     LEFT JOIN xy_items i ON i.id = c.item_id
     WHERE ${whereSql}
     ORDER BY c.updated_at DESC, c.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

/** 消息列表：afterId 存在时增量拉取，否则返回最近一页（升序） */
async function listMessages(conversationId, q) {
  const afterId = Number(q.get('after_id') || 0);
  const limit = Math.min(200, Math.max(1, Number(q.get('limit') || 100)));
  if (afterId > 0) {
    return query('SELECT * FROM xy_messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?', [conversationId, afterId, limit]);
  }
  const rows = await query(
    'SELECT * FROM (SELECT * FROM xy_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) t ORDER BY id ASC',
    [conversationId, limit]
  );
  return rows;
}

async function markRead(conversationId) {
  await query('UPDATE xy_conversations SET unread_count = 0 WHERE id = ?', [conversationId]);
  return { conversation_id: Number(conversationId), unread_count: 0 };
}

/** 关闭/重开会话（closed 会话不再出现在默认列表顶部排序影响外，仅状态标记） */
async function setConvStatus(conversationId, status, user) {
  const conv = await queryOne('SELECT * FROM xy_conversations WHERE id = ?', [conversationId]);
  if (!conv) throw new ApiError(CODE.NOT_FOUND, '会话不存在');
  await query('UPDATE xy_conversations SET status = ? WHERE id = ?', [status, conversationId]);
  await sysLog('info', 'app', `会话 #${conversationId}（${conv.buyer_nick}）已${status === 'closed' ? '关闭' : '重新打开'}（操作员 ${user ? user.username : '-'}）`);
  return { conversation_id: Number(conversationId), status };
}

/** 未读汇总（侧边栏角标用） */
async function unreadSummary() {
  const row = await queryOne('SELECT COALESCE(SUM(unread_count),0) AS total, COUNT(*) AS convos FROM xy_conversations WHERE unread_count > 0');
  return { total_unread: Number(row.total), conversations: Number(row.convos) };
}

/** 全部标记已读 */
async function markAllRead() {
  const r = await query('UPDATE xy_conversations SET unread_count = 0, updated_at = updated_at WHERE unread_count > 0');
  return { conversations_cleared: r.affectedRows };
}

/** 客服手动发送消息（支持附带图片 URL）。真实账号走 WS 真实通道发送，演示账号走模拟入库 */
async function sendManual(conversationId, content, user, imageUrl) {
  const conv = await queryOne('SELECT * FROM xy_conversations WHERE id = ?', [conversationId]);
  if (!conv) throw new ApiError(CODE.NOT_FOUND, '会话不存在');
  // 真实通道：账号 WS 在线时必须真实发送成功后才入库
  if (xianyuLive.isRunning(conv.account_id)) {
    if (!conv.session_id) {
      throw new ApiError(CODE.BIZ_FAIL, '该会话缺少闲鱼会话 ID（尚无真实消息推送），无法真实发送');
    }
    try {
      const payload = { sessionId: conv.session_id, buyerId: conv.buyer_id, text: content, imageUrl: imageUrl || undefined };
      if (imageUrl) await xianyuLive.sendImage(conv.account_id, payload);
      else await xianyuLive.sendText(conv.account_id, payload);
      await sysLog('info', 'reply', `真实消息已发送：会话 #${conv.id}（买家 ${conv.buyer_id}，操作员 ${user ? user.username : '-'}）`);
    } catch (e) {
      await writeSendFailureLog(conv, content, imageUrl, e);
      throw new ApiError(CODE.BIZ_FAIL, '真实发送失败：' + e.message);
    }
  } else if (getMode() !== 'demo') {
    throw new ApiError(CODE.BIZ_FAIL, '该账号未连接真实消息通道（请先上线账号，且凭证有效），生产模式不支持模拟发送');
  }
  const msg = await insertMessage({
    conversationId: conv.id,
    accountId: conv.account_id,
    direction: 'out',
    source: 'manual',
    msgType: imageUrl ? 'image' : 'text',
    content,
    imageUrl: imageUrl || null,
    itemId: conv.item_id,
  });
  if (!xianyuLive.isRunning(conv.account_id)) {
    await sysLog('info', 'app', `客服手动回复会话 #${conv.id}（模拟，操作员 ${user ? user.username : '-'}）`);
  }
  await crm.trackSellerMessage(conv.account_id, conv.buyer_id);
  return msg;
}

/** 真实发送失败时同步落一条失败消息，便于消息页追溯 */
async function writeSendFailureLog(conv, content, imageUrl, err) {
  try {
    await query(
      'INSERT INTO xy_messages (conversation_id, account_id, direction, source, msg_type, content, image_url, item_id) '
      + "VALUES (?, ?, 'out', 'manual', 'system', ?, ?, ?)",
      [conv.id, conv.account_id, '【发送失败】' + String(content).slice(0, 1800) + ' — ' + err.message, imageUrl || null, conv.item_id]
    );
  } catch (_) { /* 日志失败不阻塞主流程 */ }
}

// ---------------- 平台历史会话同步（session.sync + user.query） ----------------

/** 解码 IM 消息 content（custom.data 为 base64(JSON)，与 WS 推送同编码） */
function decodeImContent(msg) {
  try {
    const c = msg && msg.content;
    if (c && c.custom && typeof c.custom.data === 'string') {
      const json = JSON.parse(Buffer.from(c.custom.data, 'base64').toString('utf8'));
      if (json && json.text && json.text.text) return { type: 'text', text: String(json.text.text) };
      if (json && json.image && Array.isArray(json.image.pics) && json.image.pics[0]) {
        return { type: 'image', text: '[图片]', url: json.image.pics[0].url || '' };
      }
      // 卡片/系统等复杂消息：落 JSON 摘要
      const title = (json.dxCards && json.dxCards.item && json.dxCards.item.main && json.dxCards.item.main.exContent && json.dxCards.item.main.exContent.title) || '';
      return { type: 'system', text: title || '[卡片消息]' };
    }
    const reminder = msg && msg.extension && msg.extension.reminderTitle;
    if (reminder) return { type: 'system', text: String(reminder) };
    return null;
  } catch (_) { return null; }
}

/** 从任意结构里递归收集"会话形"节点（含 cid 的对象） */
function collectConversationNodes(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10 || out.length > 100) return;
  if (Array.isArray(node)) { for (const n of node) collectConversationNodes(n, out, depth + 1); return; }
  if (typeof node.cid === 'string' && node.cid) { out.push(node); return; }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectConversationNodes(v, out, depth + 1);
  }
}

/** 会话节点 → 归一化 { cid, unread, summary } */
function normalizeConversationNode(node) {
  const cid = String(node.cid || '').split('@')[0];
  if (!cid) return null;
  const unread = Number(node.unreadCount ?? node.unread_count ?? node.unread ?? 0) || 0;
  let summary = '';
  const lm = node.lastMessage || node.lastMsg || node.recentMessage;
  if (lm) {
    summary = String(lm.summary || lm.content || (typeof lm === 'string' ? lm : '')) || '';
    if (!summary && lm.message) summary = String(lm.message.summary || '');
  }
  return { cid, unread, summary: summary.slice(0, 200) };
}

/** 从历史消息对象里提取 {senderId, nick, type, text, url, ts}（自适应 WS/HTTP 两种结构） */
function normalizeHistoryMessage(m) {
  const msg = (m && m.message) ? m.message : (m || {});
  const senderId = String(msg.senderUserId ?? msg['1'] ?? '').split('@')[0] || '';
  const nick = String((msg.extension && msg.extension.reminderTitle) || msg.reminderTitle || '').slice(0, 100);
  const ts = Number(msg.createTime ?? msg['5'] ?? 0) || 0;
  const dec = decodeImContent(msg);
  if (!dec || !dec.text) return null;
  return { senderId, nick, ts, ...dec };
}

/**
 * 同步平台历史会话与消息入库（真实通道，售前售后聊天记录补全）。
 * 通道选择：账号 WS 在线 → WS 路由（listNewestPagination + listUserMessages，与网页版一致）；
 * 否则退回 HTTP mtop（session.sync + user.query，部分网关未注册时明确报错）。
 * 按 ext_id（账号|会话|消息标识）幂等去重。
 */
async function syncPlatformConversations(accountId, user) {
  const accountsService = require('./accounts');
  const xianyuApi = require('./xianyuApi');
  const xianyuLive = require('../core/xianyuLive');
  let account;
  if (accountId) {
    account = await accountsService.getAccount(Number(accountId));
  } else {
    const rows = await query('SELECT * FROM xy_accounts WHERE status <> \'deleted\' ORDER BY id LIMIT 1');
    account = rows[0];
  }
  const hasRealCookie = account && !!account.cookie && !/(demo=1|demo-cookie-)/.test(String(account.cookie));
  if (!hasRealCookie) {
    throw new ApiError(CODE.BIZ_FAIL, '没有可同步的账号（需要已扫码登录且有真实 Cookie 的账号）');
  }

  const myid = String(account.account_id);
  let convos = 0;
  let msgs = 0;
  const details = [];

  const upsertConversation = async ({ sessionId, buyerId, buyerNick, unread, summary }) => {
    let conv = await queryOne('SELECT * FROM xy_conversations WHERE account_id = ? AND session_id = ?', [account.id, sessionId]);
    if (!conv) conv = await queryOne('SELECT * FROM xy_conversations WHERE account_id = ? AND buyer_id = ? AND (session_id IS NULL OR session_id = ?)', [account.id, buyerId, sessionId]);
    if (!conv) {
      const r = await query(
        'INSERT INTO xy_conversations (account_id, buyer_id, buyer_nick, session_id, last_message, unread_count) VALUES (?, ?, ?, ?, ?, ?)',
        [account.id, buyerId, String(buyerNick).slice(0, 100), sessionId, summary, unread]
      );
      conv = await queryOne('SELECT * FROM xy_conversations WHERE id = ?', [r.insertId]);
      convos++;
    } else {
      await query(
        "UPDATE xy_conversations SET buyer_nick = CASE WHEN ? <> '' THEN ? ELSE buyer_nick END, session_id = ?, "
        + "unread_count = CASE WHEN unread_count < ? THEN ? ELSE unread_count END, last_message = CASE WHEN ? <> '' THEN ? ELSE last_message END, "
        + "updated_at = datetime('now','localtime') WHERE id = ?",
        [buyerNick, buyerNick, sessionId, unread, unread, summary, summary, conv.id]
      );
    }
    return conv;
  };

  const insertHistoryMessages = async (conv, sessionId, messages) => {
    let inserted = 0;
    for (const hm of messages) {
      const extId = `${account.account_id}|${sessionId}|${hm.ts || ''}|${String(hm.text).slice(0, 80)}`.slice(0, 250);
      const dup = await queryOne('SELECT id FROM xy_messages WHERE ext_id = ?', [extId]);
      if (dup) continue;
      const isSelf = hm.senderId === myid;
      await query(
        'INSERT INTO xy_messages (conversation_id, account_id, direction, source, msg_type, content, image_url, ext_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          conv.id, account.id, isSelf ? 'out' : 'in', isSelf ? 'manual' : 'auto',
          hm.type === 'image' ? 'image' : hm.type === 'system' ? 'system' : 'text',
          String(hm.text).slice(0, 2000), hm.url || null, extId,
          hm.ts ? localDateTimeString(new Date(hm.ts)) : null,
        ]
      );
      inserted++;
      msgs++;
    }
    return inserted;
  };

  // ---------- 通道 1：WS 在线（与网页版同路由） ----------
  if (xianyuLive.isRunning(account.id)) {
    let convNodes = [];
    try {
      const resp = await xianyuLive.wsCall(account.id, '/r/Conversation/listNewestPagination', [0, 30], 8000);
      const body = Array.isArray(resp.body) ? resp.body[0] : resp.body;
      collectConversationNodes(body || {}, convNodes);
    } catch (e) {
      details.push({ channel: 'ws', ok: false, reason: e.message });
    }
    for (const node of convNodes) {
      const cn = normalizeConversationNode(node);
      if (!cn) continue;
      let buyerId = '';
      let buyerNick = '';
      let messages = [];
      try {
        const mResp = await xianyuLive.wsCall(account.id, '/r/MessageManager/listUserMessages',
          [`${cn.cid}@goofish`, false, 9007199254740991, 20, false], 8000);
        const mBody = Array.isArray(mResp.body) ? mResp.body[0] : (mResp.body || {});
        const models = Array.isArray(mBody.userMessageModels) ? mBody.userMessageModels : [];
        messages = models.map(normalizeHistoryMessage).filter(Boolean);
        for (const hm of messages) {
          if (hm.senderId && hm.senderId !== myid) { buyerId = hm.senderId; buyerNick = buyerNick || hm.nick; }
        }
      } catch (e) {
        details.push({ cid: cn.cid, ok: false, reason: e.message });
      }
      const conv = await upsertConversation({
        sessionId: cn.cid,
        buyerId: buyerId || 'sid_' + cn.cid.slice(-8),
        buyerNick: buyerNick || `买家${(buyerId || cn.cid).slice(-4)}`,
        unread: cn.unread,
        summary: cn.summary,
      });
      const inserted = await insertHistoryMessages(conv, cn.cid, messages);
      details.push({ cid: cn.cid, buyer: conv.buyer_nick, inserted });
    }
    await sysLog('info', 'connector', `同步平台会话（WS）：账号 ${account.account_id} 会话 ${convNodes.length} 个（新增 ${convos}），消息入库 ${msgs} 条（操作员 ${user ? user.username : '-'}）`);
    return { channel: 'ws', total_sessions: convNodes.length, new_conversations: convos, synced_messages: msgs, details };
  }

  // ---------- 通道 2：HTTP mtop（账号 WS 未在线时的兜底） ----------
  const sess = await xianyuApi.fetchImSessions(account, { fetchNum: 30 });
  if (!sess.ok) {
    throw new ApiError(CODE.BIZ_FAIL,
      `会话同步需要账号在线：请先在「账号管理」让账号上线（消息监听连接后走网页版同款通道）；HTTP 会话接口也不可用（${sess.reason}）`);
  }
  for (const item of sess.sessions.slice(0, 30)) {
    const s = (item && item.session) || {};
    const sessionId = String(s.sessionId || '');
    if (!sessionId) continue;
    const unread = Number(item.unreadCount) || 0;
    const summary = String((item.lastMsg && item.lastMsg.summary) || '').slice(0, 200);
    const hist = await xianyuApi.fetchSessionMessages(account, sessionId, { isOwner: true });
    if (!hist.ok) {
      details.push({ session_id: sessionId, ok: false, reason: hist.reason });
      continue;
    }
    let buyerId = '';
    let buyerNick = '';
    const messages = hist.messages.map(normalizeHistoryMessage).filter(Boolean);
    for (const hm of messages) {
      if (hm.senderId && hm.senderId !== myid) { buyerId = hm.senderId; buyerNick = buyerNick || hm.nick; }
    }
    if (!buyerId && hist.userInfo && typeof hist.userInfo === 'object') {
      for (const [uid, info] of Object.entries(hist.userInfo)) {
        if (uid !== myid) { buyerId = uid; buyerNick = (info && (info.nick || info.nickname)) || ''; }
      }
    }
    const conv = await upsertConversation({
      sessionId,
      buyerId: buyerId || 'sid_' + sessionId.slice(-8),
      buyerNick: buyerNick || `买家${(buyerId || sessionId).slice(-4)}`,
      unread,
      summary,
    });
    const inserted = await insertHistoryMessages(conv, sessionId, messages);
    details.push({ session_id: sessionId, buyer: conv.buyer_nick, inserted });
  }
  await sysLog('info', 'connector', `同步平台会话（HTTP）：账号 ${account.account_id} 会话 ${sess.sessions.length} 个（新增 ${convos}），消息入库 ${msgs} 条（操作员 ${user ? user.username : '-'}）`);
  return { channel: 'http', total_sessions: sess.sessions.length, new_conversations: convos, synced_messages: msgs, details };
}

/** 消息通道状态（消息页横幅：为什么收不到消息） */
async function channelStatus() {
  const xianyuLive = require('../core/xianyuLive');
  const rows = await query('SELECT id, account_id, nickname, status, cookie, cookie_expires_at FROM xy_accounts WHERE status <> \'deleted\'');
  const accounts = rows.map((a) => {
    const real = /^\d+$/.test(String(a.account_id)) && !!a.cookie && !/(demo=1|demo-cookie-)/.test(String(a.cookie));
    let cookieState = 'unknown';
    if (real) {
      const exp = a.cookie_expires_at ? new Date(String(a.cookie_expires_at).replace(' ', 'T')).getTime() : NaN;
      cookieState = Number.isFinite(exp) ? ((exp - Date.now()) / 3600000 <= 0 ? 'expired' : 'ok') : 'unknown';
    }
    return {
      id: a.id,
      account_id: a.account_id,
      nickname: a.nickname,
      status: a.status,
      is_real: real,
      ws_running: xianyuLive.isRunning(a.id),
      cookie_state: cookieState,
    };
  });
  return { accounts };
}

module.exports = { getConversation, ensureConversation, insertMessage, listConversations, listMessages, markRead, markAllRead, unreadSummary, setConvStatus, sendManual, syncPlatformConversations, channelStatus };
