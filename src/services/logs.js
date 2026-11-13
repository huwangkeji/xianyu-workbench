'use strict';
// 日志服务：数据库业务日志写入 + 三类日志查询（回复日志/系统日志/风控日志）
const { query, queryOne } = require('../db');
const { ApiError, CODE, pageOf, paged } = require('../http/respond');

// ---------------- 写入 ----------------

/** 系统运行日志（失败静默，不影响主流程） */
async function sysLog(level, module, message, detail) {
  try {
    await query(
      'INSERT INTO xy_system_logs (level, module, message, detail) VALUES (?, ?, ?, ?)',
      [level, module, String(message || '').slice(0, 1000), detail ? JSON.stringify(detail) : null]
    );
  } catch (_) { /* 日志失败不抛出 */ }
}

/** 风控日志 */
async function riskLog(accountId, eventType, level, detail) {
  try {
    await query(
      'INSERT INTO xy_risk_logs (account_id, event_type, level, detail) VALUES (?, ?, ?, ?)',
      [accountId || null, eventType, level || 'info', String(detail || '').slice(0, 1000)]
    );
  } catch (_) { /* ignore */ }
}

// ---------------- 查询 ----------------

async function listReplyLogs(query_) {
  const pg = pageOf(query_);
  const where = ['1=1'];
  const params = [];
  const accountId = query_.get('account_id');
  const status = query_.get('process_status');
  const strategy = query_.get('reply_strategy');
  if (accountId) { where.push('l.account_id = ?'); params.push(Number(accountId)); }
  if (status) { where.push('l.process_status = ?'); params.push(status); }
  if (strategy) { where.push('l.reply_strategy = ?'); params.push(strategy); }
  const kw = query_.get('keyword');
  if (kw) { where.push('(l.source_message LIKE ? OR l.reply_text LIKE ?)'); params.push(`%${kw}%`, `%${kw}%`); }

  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_reply_logs l WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT l.*, a.nickname AS account_nickname
     FROM xy_reply_logs l LEFT JOIN xy_accounts a ON a.id = l.account_id
     WHERE ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

async function listSystemLogs(query_) {
  const pg = pageOf(query_);
  const where = ['1=1'];
  const params = [];
  const level = query_.get('level');
  const module = query_.get('module');
  if (level) { where.push('level = ?'); params.push(level); }
  if (module) { where.push('module = ?'); params.push(module); }
  const kw = query_.get('keyword');
  if (kw) { where.push('message LIKE ?'); params.push(`%${kw}%`); }

  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_system_logs WHERE ${whereSql}`, params);
  const list = await query(`SELECT * FROM xy_system_logs WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pg.pageSize, pg.offset]);
  return paged(list, totalRow.c, pg);
}

async function listRiskLogs(query_) {
  const pg = pageOf(query_);
  const where = ['1=1'];
  const params = [];
  const level = query_.get('level');
  const eventType = query_.get('event_type');
  const accountId = query_.get('account_id');
  if (level) { where.push('r.level = ?'); params.push(level); }
  if (eventType) { where.push('r.event_type = ?'); params.push(eventType); }
  if (accountId) { where.push('r.account_id = ?'); params.push(Number(accountId)); }

  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_risk_logs r WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT r.*, a.nickname AS account_nickname
     FROM xy_risk_logs r LEFT JOIN xy_accounts a ON a.id = r.account_id
     WHERE ${whereSql} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

module.exports = { sysLog, riskLog, listReplyLogs, listSystemLogs, listRiskLogs };
