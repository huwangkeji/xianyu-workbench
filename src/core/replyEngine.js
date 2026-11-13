'use strict';
// 自动回复引擎：
// 买家消息 → 会话归档 → 过滤词 → 频率风控 → 规则匹配（商品专属 > 账号专属 > 全局；默认回复兜底）
// → 随机延迟（风控）→ 发送回复 → 回复日志/规则命中计数
// 流程设计参考上游项目 auto_reply_service / message_handler 的职责划分（见 docs/01）
const { query, queryOne } = require('../db');
const { getSettings } = require('../services/settings');
const { ensureConversation, insertMessage } = require('../services/conversations');
const { sysLog, riskLog } = require('../services/logs');
const crm = require('../services/crm');
const ai = require('../services/ai');
const manualMode = require('./manualMode');
const riskControl = require('./riskControl');
const xianyuLive = require('./xianyuLive');

function splitKeywords(kw) {
  return String(kw || '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
}

function testMatch(rule, text) {
  const t = String(text || '').trim();
  if (rule.match_type === 'regex') {
    try {
      return new RegExp(rule.keywords, 'i').test(t);
    } catch (_) {
      return false; // 正则无效不匹配，调用方会记录 warn
    }
  }
  const kws = splitKeywords(rule.keywords);
  if (!kws.length) return false;
  if (rule.match_type === 'exact') return kws.some((k) => t === k);
  return kws.some((k) => t.includes(k)); // contains
}

/** 回复文案变量替换 */
function renderReply(text, ctx) {
  return String(text || '')
    .replace(/\{买家昵称\}/g, ctx.buyerNick || '买家')
    .replace(/\{商品标题\}/g, ctx.itemTitle || '')
    .replace(/\{商品价格\}/g, ctx.itemPrice || '')
    .replace(/\{店铺名\}/g, ctx.shopName || '');
}

function isFiltered(text, filterWords) {
  const words = String(filterWords || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return words.some((w) => text.includes(w));
}

/**
 * 规则匹配。
 * 返回 { rule, matched, strategy } 或 null。
 * 优先级：商品专属关键词 > 账号关键词 > 全局关键词 > 默认回复（商品 > 账号 > 全局）
 */
async function matchRule(accountId, conv, msg) {
  const rules = await query("SELECT * FROM xy_reply_rules WHERE enabled = 1 ORDER BY priority DESC, id ASC");
  const groups = { item: [], account: [], global: [], defaults: [] };
  for (const r of rules) {
    if (r.rule_type === 'default') {
      groups.defaults.push({ rule: r, score: r.item_id ? 3 : (r.account_id ? 2 : 1) });
      continue;
    }
    if (r.item_id) {
      if (conv.item_id && Number(r.item_id) === Number(conv.item_id)) groups.item.push(r);
      continue;
    }
    if (r.account_id && Number(r.account_id) === Number(accountId)) { groups.account.push(r); continue; }
    if (!r.account_id) groups.global.push(r);
  }

  const tryGroup = (list, strategy) => {
    for (const rule of list) {
      if (rule.once_per_session && conv.replied_once) continue;
      if (rule.match_type === 'regex') {
        try { new RegExp(rule.keywords, 'i'); } catch (e) {
          sysLog('warn', 'reply', `规则 #${rule.id} 正则无效: ${e.message}`);
          continue;
        }
      }
      if (rule.rule_type === 'image_keyword') {
        if (msg.msg_type === 'image') {
          return { rule, matched: splitKeywords(rule.keywords)[0] || '', strategy };
        }
        continue;
      }
      if (msg.msg_type !== 'text') continue;
      if (testMatch(rule, msg.content)) {
        let hit = '';
        if (rule.match_type === 'regex') hit = rule.keywords;
        else {
          for (const k of splitKeywords(rule.keywords)) {
            if (rule.match_type === 'exact' ? String(msg.content).trim() === k : String(msg.content).includes(k)) { hit = k; break; }
          }
        }
        return { rule, matched: hit, strategy };
      }
    }
    return null;
  };

  const attempts = [
    [groups.item, 'keyword_item'],
    [groups.account, 'keyword_account'],
    [groups.global, 'keyword_global'],
  ];
  for (const [list, strategy] of attempts) {
    const m = tryGroup(list, strategy);
    if (m) return m;
  }
  groups.defaults.sort((a, b) => b.score - a.score);
  for (const { rule, score } of groups.defaults) {
    if (rule.once_per_session && conv.replied_once) continue;
    const strategy = score === 3 ? 'default_item' : (score === 2 ? 'default_account' : 'default_global');
    return { rule, matched: '', strategy };
  }
  return null;
}

async function writeReplyLog(fields) {
  const r = await query(
    'INSERT INTO xy_reply_logs (account_id, conversation_id, item_id, source_message, msg_type, process_status, '
    + 'decision_reason, reply_strategy, matched_rule_id, matched_keyword, reply_text, error_message) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      fields.account_id, fields.conversation_id || null, fields.item_id || null,
      String(fields.source_message || '').slice(0, 1000), fields.msg_type || 'text',
      fields.process_status, fields.decision_reason || '', fields.reply_strategy || '',
      fields.matched_rule_id || null, fields.matched_keyword || '', fields.reply_text || null,
      fields.error_message || null,
    ]
  );
  return r.insertId;
}

/** 延迟后真正发送回复（异步执行，失败落日志）。真实 WS 在线账号走闲鱼真实通道发送 */
async function sendReply(ctx) {
  try {
    // 真实通道优先：账号 WS 在线 → 先真实发送，成功才落库+计数
    if (xianyuLive.isRunning(ctx.account_id)) {
      const conv = await queryOne('SELECT * FROM xy_conversations WHERE id = ?', [ctx.conversation_id]);
      if (!conv || !conv.session_id) throw new Error('会话缺少闲鱼会话 ID，无法真实发送');
      await xianyuLive.sendText(ctx.account_id, { sessionId: conv.session_id, buyerId: conv.buyer_id, text: ctx.reply_text });
      await sysLog('info', 'reply', `真实自动回复已发送 account=${ctx.account_id} 买家=${conv.buyer_id} 规则#${ctx.rule_id}`);
    }
    await insertMessage({
      conversationId: ctx.conversation_id,
      accountId: ctx.account_id,
      direction: 'out',
      source: 'auto',
      msgType: 'text',
      content: ctx.reply_text,
      imageUrl: ctx.reply_image_url || null,
      itemId: ctx.item_id || null,
    });
    await query('UPDATE xy_reply_rules SET hit_count = hit_count + 1 WHERE id = ?', [ctx.rule_id]);
    await query('UPDATE xy_conversations SET replied_once = 1 WHERE id = ?', [ctx.conversation_id]);
    await writeReplyLog({
      account_id: ctx.account_id, conversation_id: ctx.conversation_id, item_id: ctx.item_id,
      source_message: ctx.source_message, msg_type: ctx.msg_type,
      process_status: 'success', decision_reason: ctx.is_default ? 'default_sent' : 'sent',
      reply_strategy: ctx.strategy, matched_rule_id: ctx.rule_id, matched_keyword: ctx.matched_keyword,
      reply_text: ctx.reply_text,
    });
    await sysLog('info', 'reply', `自动回复已发送 account=${ctx.account_id} 规则#${ctx.rule_id} 延迟=${ctx.delay_ms}ms`);
  } catch (e) {
    await writeReplyLog({
      account_id: ctx.account_id, conversation_id: ctx.conversation_id, item_id: ctx.item_id,
      source_message: ctx.source_message, msg_type: ctx.msg_type,
      process_status: 'failed', decision_reason: 'send_failed', reply_strategy: ctx.strategy,
      matched_rule_id: ctx.rule_id, reply_text: ctx.reply_text, error_message: e.message,
    });
    await sysLog('error', 'reply', `自动回复发送失败: ${e.message}`, { rule_id: ctx.rule_id });
  }
}

/**
 * 处理买家消息（由连接器调用）。
 * @param {object} account xy_accounts 行
 * @param {object} payload { buyer_id, buyer_nick, item_id?, text, msg_type?, image_url? }
 * @returns 立即返回受理结果；回复本身延迟随机毫秒后异步发送
 */
async function handleBuyerMessage(account, payload) {
  const settings = await getSettings();
  const buyerId = String(payload.buyer_id || 'BUYER-' + Date.now()).slice(0, 80);
  const buyerNick = String(payload.buyer_nick || '买家').slice(0, 128);
  const itemId = payload.item_id ? Number(payload.item_id) : null;
  const msgType = ['text', 'image', 'system'].includes(payload.msg_type) ? payload.msg_type : 'text';
  const text = String(payload.text || '').slice(0, 2000);

  const conv = await ensureConversation(account.id, { buyerId, buyerNick, itemId });
  // 会话窗口：距上次互动超过 24 小时视为新会话，重置 once_per_session 标记
  if (conv.replied_once && conv.updated_at) {
    const lastActive = new Date(String(conv.updated_at).replace(' ', 'T')).getTime();
    if (Number.isFinite(lastActive) && Date.now() - lastActive > 24 * 3600 * 1000) {
      await query('UPDATE xy_conversations SET replied_once = 0 WHERE id = ?', [conv.id]);
      conv.replied_once = 0;
    }
  }
  // 消息去重：真实通道按 ext_id（平台消息标识）判重，重复推送直接跳过
  const extId = payload.ext_id ? String(payload.ext_id).slice(0, 250) : null;
  if (extId) {
    const dup = await queryOne('SELECT id FROM xy_messages WHERE ext_id = ?', [extId]);
    if (dup) return { conversation_id: conv.id, message_id: dup.id, decision: 'duplicate', replied: false };
  }
  const msg = await insertMessage({
    conversationId: conv.id,
    accountId: account.id,
    direction: 'in',
    source: 'manual',
    msgType,
    content: msgType === 'image' ? (text || '[图片]') : text,
    imageUrl: payload.image_url || null,
    itemId: conv.item_id,
    extId,
  });

  // M17 CRM 联动：买家档案/咨询分类/意向识别（失败不影响消息主流程）
  await crm.trackBuyerMessage(account, { buyerId, buyerNick, text: msg.content });

  const logBase = {
    account_id: account.id, conversation_id: conv.id, item_id: conv.item_id,
    source_message: msg.content, msg_type: msgType,
  };
  const skip = async (decision, status) => {
    await writeReplyLog({ ...logBase, process_status: status || 'skipped', decision_reason: decision });
    return { conversation_id: conv.id, message_id: msg.id, decision, replied: false };
  };

  if (msgType === 'system') return skip('system_message');

  if (account.status !== 'online') return skip('account_offline');
  if (!account.auto_reply_enabled) return skip('auto_reply_disabled');

  // 人工接管模式：接管窗口内的买家消息跳过自动回复（由客服人工处理）
  const pausedMs = manualMode.remaining(account.id);
  if (pausedMs > 0) {
    return skip('manual_paused');
  }

  if (msgType === 'text' && isFiltered(text, settings.message_filter_words)) {
    return skip('filtered', 'filtered');
  }

  const limit = Math.max(1, Number(settings.reply_rate_limit_per_min) || 20);
  const rate = riskControl.checkAndRecordReply(account.id, limit, account.nickname);
  if (!rate.allowed) return skip('risk_rate_limited'); // 先做频率风控，再消耗 AI 调用

  const m = await matchRule(account.id, conv, msg);
  // M30 AI 兜底回复：无规则命中且开启 ai_auto_reply 时，由大模型生成回复（失败自动降级到默认回复/no_reply）
  let aiReplyText = null;
  if (!m && Number(settings.ai_auto_reply) === 1) {
    try {
      const recent = await query(
        'SELECT direction, content FROM xy_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 6',
        [conv.id]
      );
      const history = recent.reverse().map((x) => (x.direction === 'in' ? '买家：' : '客服：') + x.content).join('\n');
      let itemLine = '';
      if (conv.item_id) {
        const it = await queryOne('SELECT title, price FROM xy_items WHERE id = ?', [conv.item_id]);
        if (it) itemLine = `\n买家咨询的商品：${it.title}（¥${it.price}）`;
      }
      const r = await ai.chat({
        system: '你是闲鱼二手店铺的资深客服。语气亲切自然，回复不超过 60 字；不承诺平台外交易，不使用绝对化用语；无法确定的信息引导买家查看商品描述。',
        prompt: `店铺名：${account.nickname}${itemLine}\n最近对话：\n${history}\n买家最新消息：${msg.content}\n请直接输出给买家的回复。`,
      });
      aiReplyText = r.content.trim().slice(0, 500);
      await sysLog('info', 'reply', `AI 兜底回复命中 account=${account.id}（${r.provider}/${r.model}）`);
    } catch (e) {
      await sysLog('warn', 'reply', `AI 兜底回复失败，降级默认处理: ${e.message}`);
    }
  }
  if (!m && aiReplyText === null) return skip('no_reply');

  const accMin = Number(account.reply_delay_min_ms) > 0 ? Number(account.reply_delay_min_ms) : Number(settings.reply_delay_min_ms);
  const accMax = Number(account.reply_delay_max_ms) > 0 ? Number(account.reply_delay_max_ms) : Number(settings.reply_delay_max_ms);
  const lo = Math.max(0, Math.min(accMin, accMax));
  const hi = Math.max(lo, Math.max(accMin, accMax));
  const delayMs = hi === lo ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));

  let replyText;
  let ctx;
  if (m) {
    let itemRow = null;
    if (conv.item_id) itemRow = await queryOne('SELECT * FROM xy_items WHERE id = ?', [conv.item_id]);
    replyText = renderReply(m.rule.reply_text, {
      buyerNick,
      itemTitle: itemRow ? itemRow.title : '',
      itemPrice: itemRow ? itemRow.price : '',
      shopName: account.nickname,
    });
    ctx = {
      conversation_id: conv.id,
      account_id: account.id,
      item_id: conv.item_id,
      source_message: msg.content,
      msg_type: msgType,
      rule_id: m.rule.id,
      matched_keyword: m.matched,
      strategy: m.strategy,
      is_default: m.rule.rule_type === 'default',
      reply_text: replyText,
      reply_image_url: m.rule.reply_image_url || null,
      delay_ms: delayMs,
    };
  } else {
    ctx = {
      conversation_id: conv.id,
      account_id: account.id,
      item_id: conv.item_id,
      source_message: msg.content,
      msg_type: msgType,
      rule_id: null,
      matched_keyword: '',
      strategy: 'ai',
      is_default: false,
      reply_text: aiReplyText,
      reply_image_url: null,
      delay_ms: delayMs,
    };
  }
  setTimeout(() => { sendReply(ctx); }, delayMs);

  await sysLog('info', 'reply', `受理买家消息 account=${account.id} 规则=${m ? '#' + m.rule.id : 'AI兜底'} 延迟=${delayMs}ms`);
  return {
    conversation_id: conv.id,
    message_id: msg.id,
    decision: 'delayed',
    replied: true,
    rule_id: ctx.rule_id,
    rule_name: m ? m.rule.name : null,
    strategy: ctx.strategy,
    matched_keyword: ctx.matched_keyword,
    reply_text: replyText,
    delay_ms: delayMs,
  };
}

module.exports = { handleBuyerMessage, matchRule, testMatch, renderReply, splitKeywords };
