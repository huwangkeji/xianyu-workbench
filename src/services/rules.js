'use strict';
// 自动回复规则 CRUD
const { query, queryOne } = require('../db');
const { ApiError, CODE, pageOf, paged, str, int, bool, enumOf } = require('../http/respond');
const { sysLog } = require('./logs');

const RULE_TYPES = ['text_keyword', 'image_keyword', 'default'];
const MATCH_TYPES = ['contains', 'exact', 'regex'];

async function getRule(id) {
  const row = await queryOne('SELECT * FROM xy_reply_rules WHERE id = ?', [id]);
  if (!row) throw new ApiError(CODE.NOT_FOUND, '规则不存在');
  return row;
}

async function listRules(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const scope = q.get('scope'); // global | account:<id> | item:<id>
  if (scope === 'global') { where.push('r.account_id IS NULL AND r.item_id IS NULL'); }
  else if (scope && scope.startsWith('account:')) { where.push('r.account_id = ? AND r.item_id IS NULL'); params.push(Number(scope.slice(8))); }
  else if (scope && scope.startsWith('item:')) { where.push('r.item_id = ?'); params.push(Number(scope.slice(5))); }
  const accountId = q.get('account_id'); // 全局账号切换器：作用于该账号的规则 = 全局 + 账号专属 + 该账号商品的专属
  if (accountId) {
    where.push('(r.account_id IS NULL AND r.item_id IS NULL OR r.account_id = ? OR r.item_id IN (SELECT id FROM xy_items WHERE account_id = ?))');
    params.push(Number(accountId), Number(accountId));
  }
  const ruleType = q.get('rule_type');
  if (ruleType) { where.push('r.rule_type = ?'); params.push(ruleType); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(
    `SELECT COUNT(*) AS c FROM xy_reply_rules r
     LEFT JOIN xy_accounts a ON a.id = r.account_id
     LEFT JOIN xy_items i ON i.id = r.item_id
     WHERE ${whereSql}`, params
  );
  const list = await query(
    `SELECT r.*, a.nickname AS account_nickname, i.title AS item_title
     FROM xy_reply_rules r
     LEFT JOIN xy_accounts a ON a.id = r.account_id
     LEFT JOIN xy_items i ON i.id = r.item_id
     WHERE ${whereSql} ORDER BY r.priority DESC, r.id ASC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

function validateBody(body, partial, existing) {
  const out = {};
  out.name = body.name !== undefined || !partial ? str(body.name, 'name', { max: 128 }) : (existing ? existing.name : '');
  out.rule_type = body.rule_type !== undefined || !partial
    ? enumOf(body.rule_type, 'rule_type', RULE_TYPES, { default: 'text_keyword' })
    : (existing ? existing.rule_type : 'text_keyword');
  out.match_type = body.match_type !== undefined || !partial
    ? enumOf(body.match_type, 'match_type', MATCH_TYPES, { default: 'contains' })
    : (existing ? existing.match_type : 'contains');
  out.keywords = body.keywords !== undefined || !partial ? str(body.keywords, 'keywords', { max: 500 }) : (existing ? existing.keywords : '');
  out.reply_text = body.reply_text !== undefined || !partial
    ? str(body.reply_text, 'reply_text', { required: true, max: 2000 })
    : (existing ? existing.reply_text : '');
  out.reply_image_url = body.reply_image_url !== undefined || !partial
    ? str(body.reply_image_url, 'reply_image_url', { max: 500 })
    : (existing ? existing.reply_image_url : '');
  out.priority = body.priority !== undefined || !partial
    ? int(body.priority, 'priority', { default: 100, min: 0, max: 100000 })
    : (existing ? existing.priority : 100);
  out.once_per_session = body.once_per_session !== undefined || !partial
    ? (bool(body.once_per_session, 'once_per_session', false) ? 1 : 0)
    : (existing ? existing.once_per_session : 0);
  out.enabled = body.enabled !== undefined || !partial
    ? (bool(body.enabled, 'enabled', true) ? 1 : 0)
    : (existing ? existing.enabled : 1);
  out.account_id = body.account_id !== undefined || !partial
    ? (body.account_id ? int(body.account_id, 'account_id', { min: 1 }) : null)
    : (existing ? existing.account_id : null);
  out.item_id = body.item_id !== undefined || !partial
    ? (body.item_id ? int(body.item_id, 'item_id', { min: 1 }) : null)
    : (existing ? existing.item_id : null);
  if (out.rule_type === 'default' && out.match_type === 'regex') {
    throw new ApiError(CODE.BAD_REQUEST, '默认回复规则不支持正则匹配类型');
  }
  if (out.rule_type !== 'default' && !out.keywords) {
    throw new ApiError(CODE.BAD_REQUEST, '关键词规则必须填写关键词');
  }
  return out;
}

async function createRule(body, user) {
  const v = validateBody(body, false, null);
  if (v.account_id) {
    const acc = await queryOne('SELECT id FROM xy_accounts WHERE id = ?', [v.account_id]);
    if (!acc) throw new ApiError(CODE.NOT_FOUND, '关联账号不存在');
  }
  if (v.item_id) {
    const item = await queryOne('SELECT id FROM xy_items WHERE id = ?', [v.item_id]);
    if (!item) throw new ApiError(CODE.NOT_FOUND, '关联商品不存在');
  }
  const r = await query(
    'INSERT INTO xy_reply_rules (account_id, item_id, name, rule_type, match_type, keywords, reply_text, reply_image_url, priority, once_per_session, enabled) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [v.account_id, v.item_id, v.name, v.rule_type, v.match_type, v.keywords, v.reply_text, v.reply_image_url, v.priority, v.once_per_session, v.enabled]
  );
  await sysLog('info', 'app', `新增回复规则「${v.name || r.insertId}」（操作员 ${user.username}）`);
  return getRule(r.insertId);
}

async function updateRule(id, body, user) {
  const existing = await getRule(id);
  const v = validateBody(body, true, existing);
  await query(
    'UPDATE xy_reply_rules SET account_id = ?, item_id = ?, name = ?, rule_type = ?, match_type = ?, keywords = ?, '
    + "reply_text = ?, reply_image_url = ?, priority = ?, once_per_session = ?, enabled = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [v.account_id, v.item_id, v.name, v.rule_type, v.match_type, v.keywords, v.reply_text, v.reply_image_url, v.priority, v.once_per_session, v.enabled, id]
  );
  await sysLog('info', 'app', `更新回复规则 #${id}（操作员 ${user.username}）`);
  return getRule(id);
}

async function deleteRule(id, user) {
  await getRule(id);
  await query('DELETE FROM xy_reply_rules WHERE id = ?', [id]);
  await sysLog('info', 'app', `删除回复规则 #${id}（操作员 ${user.username}）`);
  return { id: Number(id) };
}

async function toggleRule(id, body, user) {
  const existing = await getRule(id);
  const enabled = body.enabled !== undefined ? bool(body.enabled, 'enabled') : !existing.enabled;
  await query("UPDATE xy_reply_rules SET enabled = ?, updated_at = datetime('now','localtime') WHERE id = ?", [enabled ? 1 : 0, id]);
  await sysLog('info', 'app', `${enabled ? '启用' : '停用'}回复规则 #${id}（操作员 ${user.username}）`);
  return getRule(id);
}

module.exports = { getRule, listRules, createRule, updateRule, deleteRule, toggleRule, RULE_TYPES, MATCH_TYPES };
