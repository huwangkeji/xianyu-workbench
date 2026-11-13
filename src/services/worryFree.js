'use strict';
// 闲鱼无忧卖（轻运营销售模式）状态跟踪：报名 → 审核 → 售卖/失败 → 结束/退出
// 状态对齐官方 7 态：pending_signup(待报名) reviewing(审核中) selling(售卖中)
// signup_failed(报名失败) ended(已结束) exited(已退出) unsupported(不支持)
const { query, queryOne } = require('../db');
const { ApiError, CODE, pageOf, paged, str, int, enumOf } = require('../http/respond');
const { sysLog } = require('./logs');
const { getAccount } = require('./accounts');

const STATUSES = ['pending_signup', 'reviewing', 'selling', 'signup_failed', 'ended', 'exited', 'unsupported'];
const STATUS_LABELS = {
  pending_signup: '待报名', reviewing: '审核中', selling: '售卖中', signup_failed: '报名失败',
  ended: '已结束', exited: '已退出', unsupported: '不支持',
};

/** 状态流转时间戳：进入某状态时记录对应时间 */
const STATUS_TIME_COL = { reviewing: 'review_at', selling: 'selling_at', signup_failed: 'ended_at', ended: 'ended_at', exited: 'ended_at', unsupported: 'ended_at' };

async function list(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const status = q.get('status');
  const accountId = q.get('account_id');
  const keyword = q.get('keyword');
  if (status) { where.push('w.status = ?'); params.push(status); }
  if (accountId) { where.push('w.account_id = ?'); params.push(Number(accountId)); }
  if (keyword) { where.push('(w.item_title LIKE ? OR i.item_id LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_worry_free w LEFT JOIN xy_items i ON i.id = w.item_id WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT w.*, i.item_id AS platform_item_id, i.price AS item_price, i.status AS item_status, a.nickname AS account_nickname
     FROM xy_worry_free w
     LEFT JOIN xy_items i ON i.id = w.item_id
     LEFT JOIN xy_accounts a ON a.id = w.account_id
     WHERE ${whereSql} ORDER BY w.updated_at DESC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  const stats = {};
  for (const s of STATUSES) stats[s] = 0;
  for (const r of await query(`SELECT status, COUNT(*) AS c FROM xy_worry_free GROUP BY status`)) stats[r.status] = Number(r.c);
  return paged(list, totalRow.c, pg, stats);
}

/** 报名：把在架商品加入无忧卖（同一账号同一商品仅一条有效记录，已结束/退出/失败的可重新报名） */
async function enroll(body, user) {
  const accountId = int(body.account_id, 'account_id', { required: true, min: 1 });
  const itemIds = Array.isArray(body.item_ids) ? body.item_ids.map((x) => int(x, 'item_ids', { min: 1 })) : [];
  if (!itemIds.length) throw new ApiError(CODE.BAD_REQUEST, '请选择要报名的商品');
  const account = await getAccount(accountId);
  const results = { enrolled: 0, skipped: [] };
  for (const itemId of itemIds) {
    const item = await queryOne('SELECT id, title, status FROM xy_items WHERE id = ? AND account_id = ?', [itemId, accountId]);
    if (!item) { results.skipped.push(`商品#${itemId} 不存在`); continue; }
    if (item.status !== 'on_sale') { results.skipped.push(`「${item.title.slice(0, 20)}」不在架`); continue; }
    const active = await queryOne(
      "SELECT id, status FROM xy_worry_free WHERE account_id = ? AND item_id = ? AND status IN ('pending_signup','reviewing','selling')",
      [accountId, itemId]
    );
    if (active) { results.skipped.push(`「${item.title.slice(0, 20)}」已在无忧卖流程中（${STATUS_LABELS[active.status]}）`); continue; }
    await query(
      `INSERT INTO xy_worry_free (account_id, item_id, item_title, status, enrolled_at) VALUES (?, ?, ?, 'pending_signup', datetime('now','localtime'))`,
      [accountId, itemId, item.title.slice(0, 255)]
    );
    results.enrolled++;
  }
  await sysLog('info', 'connector', `无忧卖报名：账号 ${account.account_id} 报名 ${results.enrolled} 件商品（操作员 ${user.username}）`);
  results.message = `报名完成：新增 ${results.enrolled} 件${results.skipped.length ? `，跳过 ${results.skipped.length} 件` : ''}`;
  return results;
}

/** 状态流转（记录各阶段时间戳） */
async function updateStatus(id, body, user) {
  const row = await queryOne('SELECT * FROM xy_worry_free WHERE id = ?', [id]);
  if (!row) throw new ApiError(CODE.NOT_FOUND, '无忧卖记录不存在');
  const status = enumOf(body.status, 'status', STATUSES, { required: true });
  const remark = body.remark !== undefined ? str(body.remark, 'remark', { max: 500 }) : row.remark;
  const timeCol = STATUS_TIME_COL[status];
  await query(
    `UPDATE xy_worry_free SET status = ?, remark = ?${timeCol ? `, ${timeCol} = COALESCE(${timeCol}, datetime('now','localtime'))` : ''} WHERE id = ?`,
    [status, remark, id]
  );
  await sysLog('info', 'connector', `无忧卖「${row.item_title}」状态：${STATUS_LABELS[row.status] || row.status} → ${STATUS_LABELS[status]}（操作员 ${user.username}）`);
  return queryOne('SELECT * FROM xy_worry_free WHERE id = ?', [id]);
}

async function remove(id, user) {
  const row = await queryOne('SELECT * FROM xy_worry_free WHERE id = ?', [id]);
  if (!row) throw new ApiError(CODE.NOT_FOUND, '无忧卖记录不存在');
  await query('DELETE FROM xy_worry_free WHERE id = ?', [id]);
  await sysLog('info', 'connector', `删除无忧卖记录「${row.item_title}」（操作员 ${user.username}）`);
  return { id: Number(id) };
}

async function stats() {
  const rows = await query('SELECT status, COUNT(*) AS c FROM xy_worry_free GROUP BY status');
  const stats = {};
  for (const s of STATUSES) stats[s] = 0;
  for (const r of rows) stats[r.status] = Number(r.c);
  return stats;
}

module.exports = { list, enroll, updateStatus, remove, stats, STATUSES, STATUS_LABELS };
