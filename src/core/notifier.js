'use strict';
// 通知中心：按事件类型匹配启用中的渠道并推送
// webhook_url 以 mock:// 开头时仅记录日志不真实发送（演示/冒烟用）
// 内建事件级冷却：高频事件（风控/行情/跟进提醒等）在冷却窗口内不重复推送，避免通知轰炸
const { query, queryOne } = require('../db');
const { sysLog } = require('../services/logs');

const COOLDOWN_MS = 10 * 60 * 1000; // 高频事件默认冷却 10 分钟
const COOLED_EVENTS = new Set(['risk_alert', 'competitor_alert', 'risk_intercept', 'followup_due']);
const lastSentAt = new Map(); // eventType -> ts

async function pushToChannel(row, eventType, title, content) {
  let status = 'success';
  let errMessage = null;
  if (!row.webhook_url || row.webhook_url.startsWith('mock://')) {
    status = 'mock'; // 模拟推送，仅落通知日志
  } else {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3000);
      const resp = await fetch(row.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType, title, content, timestamp: new Date().toISOString() }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        status = 'failed';
        errMessage = 'HTTP ' + resp.status;
      }
    } catch (e) {
      status = 'failed';
      errMessage = e.message;
    }
  }
  await query(
    'INSERT INTO xy_notify_logs (channel_id, channel_name, event_type, title, content, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [row.channel_id, row.channel_name, eventType, String(title || '').slice(0, 255), content || null, status, errMessage]
  );
  if (status === 'failed') await sysLog('warn', 'notify', `通知推送失败 [${row.channel_name}]: ${errMessage}`);
  return status;
}

/**
 * 触发事件通知。返回推送的渠道数量。
 * 高频事件（COOLED_EVENTS）在冷却窗口内只推送一次。
 * @param {'new_order'|'delivery_failed'|'risk_intercept'|'followup_due'|'task_failed'|'risk_alert'|'competitor_alert'} eventType
 */
async function notifyEvent(eventType, title, content) {
  if (COOLED_EVENTS.has(eventType)) {
    const last = lastSentAt.get(eventType) || 0;
    if (Date.now() - last < COOLDOWN_MS) return 0;
    lastSentAt.set(eventType, Date.now());
  }
  const rows = await query(
    'SELECT r.id AS rule_id, c.id AS channel_id, c.name AS channel_name, c.webhook_url '
    + 'FROM xy_notify_rules r JOIN xy_notify_channels c ON c.id = r.channel_id '
    + "WHERE r.event_type = ? AND r.enabled = 1 AND c.enabled = 1",
    [eventType]
  );
  for (const row of rows) {
    try {
      await pushToChannel(row, eventType, title, content);
    } catch (e) {
      await sysLog('warn', 'notify', `通知处理异常 [${row.channel_name}]: ${e.message}`);
    }
  }
  return rows.length;
}

/** 指定渠道发送一条测试消息（不经过事件规则，直接推送并落日志） */
async function sendTestToChannel(channelId) {
  const row = await queryOne(
    'SELECT id AS channel_id, name AS channel_name, webhook_url FROM xy_notify_channels WHERE id = ?',
    [channelId]
  );
  if (!row) return null;
  const status = await pushToChannel(row, 'test', `这是一条测试消息（渠道「${row.channel_name}」，${new Date().toLocaleString('zh-CN')}）。收到说明渠道配置可用。`);
  return { channel_id: row.channel_id, channel_name: row.channel_name, status };
}

/** 推送到所有启用渠道（不经事件规则）——每日简报等全局广播用 */
async function pushToAllChannels(eventType, title, content) {
  const rows = await query('SELECT id AS channel_id, name AS channel_name, webhook_url FROM xy_notify_channels WHERE enabled = 1');
  let sent = 0;
  for (const row of rows) {
    try {
      await pushToChannel(row, eventType, title, content);
      sent++;
    } catch (e) {
      await sysLog('warn', 'notify', `广播推送异常 [${row.channel_name}]: ${e.message}`);
    }
  }
  return sent;
}

module.exports = { notifyEvent, sendTestToChannel, pushToAllChannels };
