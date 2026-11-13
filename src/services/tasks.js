'use strict';
// 定时任务管理（查询/创建/更新/删除/历史），执行动作由 core/scheduler 提供
// 任务类型固定 8 种（与 schema CHECK 一致）：可新建同类型任务（如按账号单独配置擦亮）并删除
const { query, queryOne, withTransaction } = require('../db');
const { ApiError, CODE, pageOf, paged, str, int, bool, enumOf } = require('../http/respond');

const TASK_TYPES = ['item_polish', 'order_sync', 'delivery_retry', 'auto_rate', 'cookie_check', 'crm_followup', 'market_scan', 'daily_brief'];

async function listTasks(q) {
  const accountId = q && q.get ? q.get('account_id') : null;
  // 全局账号切换器：显示绑定该账号的任务 + 作用于全部账号的全局任务（account_id 为空）
  const rows = accountId
    ? await query(
      'SELECT t.*, a.nickname AS account_nickname FROM xy_tasks t LEFT JOIN xy_accounts a ON a.id = t.account_id '
      + 'WHERE t.account_id = ? OR t.account_id IS NULL ORDER BY t.id ASC',
      [Number(accountId)]
    )
    : await query(
      'SELECT t.*, a.nickname AS account_nickname FROM xy_tasks t LEFT JOIN xy_accounts a ON a.id = t.account_id ORDER BY t.id ASC'
    );
  return rows;
}

async function getTask(id) {
  const row = await queryOne('SELECT * FROM xy_tasks WHERE id = ?', [id]);
  if (!row) throw new ApiError(CODE.NOT_FOUND, '任务不存在');
  return row;
}

async function createTask(body, user) {
  const taskType = enumOf(body.task_type, 'task_type', TASK_TYPES, { required: true });
  const accountId = body.account_id !== undefined && body.account_id !== null && body.account_id !== '' ? int(body.account_id, 'account_id', { min: 1 }) : null;
  if (accountId) {
    const acc = await queryOne('SELECT id FROM xy_accounts WHERE id = ?', [accountId]);
    if (!acc) throw new ApiError(CODE.NOT_FOUND, '绑定的账号不存在');
  }
  const intervalSeconds = int(body.interval_seconds, 'interval_seconds', { default: 300, min: 10, max: 86400 * 7 });
  const name = str(body.name, 'name', { required: true, max: 128 });
  const dup = await queryOne('SELECT id FROM xy_tasks WHERE task_type = ? AND account_id IS ?', [taskType, accountId]);
  if (dup) throw new ApiError(CODE.CONFLICT, '同类型同账号的任务已存在，可直接编辑它');
  const r = await query(
    'INSERT INTO xy_tasks (name, task_type, account_id, interval_seconds, enabled, next_run_at) '
    + "VALUES (?, ?, ?, ?, ?, datetime('now','localtime','+' || ? || ' seconds'))",
    [name, taskType, accountId, intervalSeconds, bool(body.enabled, 'enabled', true) ? 1 : 0, intervalSeconds]
  );
  await query('INSERT INTO xy_system_logs (level, module, message) VALUES (\'info\', \'task\', ?)', [`新建任务「${name}」（${taskType}，操作员 ${user.username}）`]);
  return getTask(r.insertId);
}

async function updateTask(id, body, user) {
  const task = await getTask(id);
  const name = body.name !== undefined ? str(body.name, 'name', { required: true, max: 128 }) : task.name;
  const enabled = body.enabled !== undefined ? (bool(body.enabled, 'enabled') ? 1 : 0) : task.enabled;
  let intervalSeconds = task.interval_seconds;
  if (body.interval_seconds !== undefined) {
    intervalSeconds = int(body.interval_seconds, 'interval_seconds', { required: true, min: 10, max: 86400 * 7 });
  }
  // 间隔变化或重新启用时，重排下次执行时间
  const reschedule = intervalSeconds !== task.interval_seconds || (enabled === 1 && task.enabled === 0);
  await query("UPDATE xy_tasks SET name = ?, enabled = ?, interval_seconds = ?, updated_at = datetime('now','localtime') WHERE id = ?", [name, enabled, intervalSeconds, id]);
  if (reschedule) {
    await query("UPDATE xy_tasks SET next_run_at = datetime('now','localtime','+' || ? || ' seconds') WHERE id = ?", [intervalSeconds, id]);
  }
  await query('INSERT INTO xy_system_logs (level, module, message) VALUES (\'info\', \'task\', ?)', [`任务「${name}」配置更新（操作员 ${user.username}）`]);
  return getTask(id);
}

async function deleteTask(id, user) {
  const task = await getTask(id);
  await withTransaction(async (conn) => {
    await conn.query('DELETE FROM xy_task_runs WHERE task_id = ?', [id]);
    await conn.query('DELETE FROM xy_tasks WHERE id = ?', [id]);
  });
  await query('INSERT INTO xy_system_logs (level, module, message) VALUES (\'warn\', \'task\', ?)', [`删除任务「${task.name}」（操作员 ${user.username}）`]);
  return { id: Number(id) };
}

async function listTaskRuns(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const taskId = q.get('task_id');
  if (taskId) { where.push('r.task_id = ?'); params.push(Number(taskId)); }
  const status = q.get('status');
  if (status) { where.push('r.status = ?'); params.push(status); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_task_runs r WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT r.*, t.name AS task_name FROM xy_task_runs r LEFT JOIN xy_tasks t ON t.id = r.task_id
     WHERE ${whereSql} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

module.exports = { listTasks, getTask, createTask, updateTask, deleteTask, listTaskRuns, TASK_TYPES };
