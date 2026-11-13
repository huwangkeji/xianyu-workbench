'use strict';
// 通知中心：渠道 / 规则 / 通知日志 / 渠道测试发送
const { query, queryOne } = require('../db');
const { ApiError, CODE, pageOf, paged, str, int, bool, enumOf } = require('../http/respond');
const notifier = require('../core/notifier');

const CHANNEL_TYPES = ['wecom', 'dingtalk', 'feishu', 'bark', 'webhook'];
// 与 schema CHECK 及实际 emit 点对齐（auto_reply 不做事件通知，已从可订阅项移除）
const EVENT_TYPES = ['new_order', 'delivery_failed', 'risk_intercept', 'followup_due', 'task_failed', 'risk_alert', 'competitor_alert'];

/** 剥离 secret 明文（保留是否已配置的提示） */
function maskChannel(ch) {
  if (!ch) return ch;
  return { ...ch, secret: ch.secret ? '******' : '', secret_set: !!ch.secret };
}

async function listChannels() {
  const rows = await query(
    `SELECT c.*, (SELECT COUNT(*) FROM xy_notify_rules r WHERE r.channel_id = c.id) AS rule_count
     FROM xy_notify_channels c ORDER BY c.id ASC`
  );
  return rows.map(maskChannel);
}

async function createChannel(body) {
  const r = await query(
    'INSERT INTO xy_notify_channels (name, channel_type, webhook_url, secret, enabled) VALUES (?, ?, ?, ?, ?)',
    [
      str(body.name, 'name', { required: true, max: 128 }),
      enumOf(body.channel_type, 'channel_type', CHANNEL_TYPES, { default: 'webhook' }),
      str(body.webhook_url, 'webhook_url', { max: 500 }),
      str(body.secret, 'secret', { max: 255 }),
      bool(body.enabled, 'enabled', true) ? 1 : 0,
    ]
  );
  return maskChannel(await queryOne('SELECT * FROM xy_notify_channels WHERE id = ?', [r.insertId]));
}

async function updateChannel(id, body) {
  const ch = await queryOne('SELECT * FROM xy_notify_channels WHERE id = ?', [id]);
  if (!ch) throw new ApiError(CODE.NOT_FOUND, '通知渠道不存在');
  const name = body.name !== undefined ? str(body.name, 'name', { required: true, max: 128 }) : ch.name;
  const webhookUrl = body.webhook_url !== undefined ? str(body.webhook_url, 'webhook_url', { max: 500 }) : ch.webhook_url;
  // secret 不回显：留空/缺省 = 保留原值
  const secret = body.secret !== undefined && String(body.secret) !== '' ? str(body.secret, 'secret', { max: 255 }) : ch.secret;
  const enabled = body.enabled !== undefined ? (bool(body.enabled, 'enabled') ? 1 : 0) : ch.enabled;
  await query("UPDATE xy_notify_channels SET name = ?, webhook_url = ?, secret = ?, enabled = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [name, webhookUrl, secret, enabled, id]);
  return maskChannel(await queryOne('SELECT * FROM xy_notify_channels WHERE id = ?', [id]));
}

async function deleteChannel(id) {
  const ch = await queryOne('SELECT * FROM xy_notify_channels WHERE id = ?', [id]);
  if (!ch) throw new ApiError(CODE.NOT_FOUND, '通知渠道不存在');
  const rules = await queryOne('SELECT COUNT(*) AS c FROM xy_notify_rules WHERE channel_id = ?', [id]);
  await query('DELETE FROM xy_notify_rules WHERE channel_id = ?', [id]);
  await query('DELETE FROM xy_notify_channels WHERE id = ?', [id]);
  return { id: Number(id), rules_deleted: rules.c };
}

async function testChannel(id) {
  const r = await notifier.sendTestToChannel(int(id, 'id', { required: true, min: 1 }));
  if (!r) throw new ApiError(CODE.NOT_FOUND, '通知渠道不存在');
  return { ...r, message: r.status === 'success' ? '测试消息已发送成功' : r.status === 'mock' ? 'mock 渠道：已记录通知日志（未真实发送）' : `发送失败（${r.status}），请检查地址/网络` };
}

async function listRules() {
  return query(
    'SELECT r.*, c.name AS channel_name FROM xy_notify_rules r LEFT JOIN xy_notify_channels c ON c.id = r.channel_id ORDER BY r.id ASC'
  );
}

async function createRule(body) {
  const channelId = int(body.channel_id, 'channel_id', { required: true, min: 1 });
  const ch = await queryOne('SELECT * FROM xy_notify_channels WHERE id = ?', [channelId]);
  if (!ch) throw new ApiError(CODE.NOT_FOUND, '通知渠道不存在');
  const eventType = enumOf(body.event_type, 'event_type', EVENT_TYPES, { required: true });
  const dup = await queryOne('SELECT id FROM xy_notify_rules WHERE channel_id = ? AND event_type = ?', [channelId, eventType]);
  if (dup) throw new ApiError(CODE.CONFLICT, '该渠道已订阅此事件');
  const r = await query('INSERT INTO xy_notify_rules (channel_id, event_type, enabled) VALUES (?, ?, ?)',
    [channelId, eventType, bool(body.enabled, 'enabled', true) ? 1 : 0]);
  return queryOne('SELECT * FROM xy_notify_rules WHERE id = ?', [r.insertId]);
}

async function updateRule(id, body) {
  const r = await queryOne('SELECT * FROM xy_notify_rules WHERE id = ?', [id]);
  if (!r) throw new ApiError(CODE.NOT_FOUND, '通知规则不存在');
  const enabled = body.enabled !== undefined ? (bool(body.enabled, 'enabled') ? 1 : 0) : r.enabled;
  const eventType = body.event_type !== undefined ? enumOf(body.event_type, 'event_type', EVENT_TYPES, { required: true }) : r.event_type;
  const channelId = body.channel_id !== undefined ? int(body.channel_id, 'channel_id', { required: true, min: 1 }) : r.channel_id;
  const ch = await queryOne('SELECT id FROM xy_notify_channels WHERE id = ?', [channelId]);
  if (!ch) throw new ApiError(CODE.NOT_FOUND, '通知渠道不存在');
  await query('UPDATE xy_notify_rules SET channel_id = ?, event_type = ?, enabled = ? WHERE id = ?', [channelId, eventType, enabled, id]);
  return queryOne('SELECT * FROM xy_notify_rules WHERE id = ?', [id]);
}

async function deleteRule(id) {
  const r = await queryOne('SELECT * FROM xy_notify_rules WHERE id = ?', [id]);
  if (!r) throw new ApiError(CODE.NOT_FOUND, '通知规则不存在');
  await query('DELETE FROM xy_notify_rules WHERE id = ?', [id]);
  return { id: Number(id) };
}

async function listLogs(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const eventType = q.get('event_type');
  const status = q.get('status');
  const channelId = q.get('channel_id');
  if (eventType) { where.push('event_type = ?'); params.push(eventType); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (channelId) { where.push('channel_id = ?'); params.push(Number(channelId)); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_notify_logs WHERE ${whereSql}`, params);
  const list = await query(`SELECT * FROM xy_notify_logs WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]);
  return paged(list, totalRow.c, pg);
}

module.exports = {
  listChannels, createChannel, updateChannel, deleteChannel, testChannel,
  listRules, createRule, updateRule, deleteRule, listLogs,
  CHANNEL_TYPES, EVENT_TYPES,
};
