'use strict';
// 定时任务调度器：每 5s 扫描到期任务，逐个执行并记录运行历史
// 任务类型与上游 scheduler 服务对齐：擦亮/订单同步/发货补发/自动评价/Cookie 检查（见 docs/01）
const { query, queryOne } = require('../db');
const { ApiError, CODE } = require('../http/respond');
const logger = require('../logger');
const pathJoin = require('path').join;
const { sysLog } = require('../services/logs');
const { notifyEvent, pushToAllChannels } = require('./notifier');
const { getConnector } = require('./connector');
const { getSettings } = require('../services/settings');
const { getMode } = require('../services/mode');
const riskControl = require('./riskControl');
const deliveryEngine = require('./deliveryEngine');
const crm = require('../services/crm');
const market = require('../services/market');
const assistant = require('../services/assistant');
const xianyuLive = require('./xianyuLive');

// ---------------- 任务处理器 ----------------

/** 商品定时擦亮：仅演示模式执行模拟擦亮；生产模式真实擦亮需平台接口（跳过） */
async function hItemPolish(task) {
  if (getMode() !== 'demo') {
    return { affected: 0, message: '生产模式下真实擦亮需平台接口支持（暂未对接），已跳过' };
  }
  const params = [];
  let sql = 'SELECT i.*, a.status AS account_status, a.nickname AS account_nickname '
    + 'FROM xy_items i JOIN xy_accounts a ON a.id = i.account_id '
    + "WHERE i.polish_enabled = 1 AND i.status = 'on_sale'";
  if (task.account_id) { sql += ' AND i.account_id = ?'; params.push(task.account_id); }
  const items = await query(sql, params);
  const settings = await getSettings();
  const minMinutes = Math.max(1, Number(settings.polish_min_interval_minutes) || 30);
  let polished = 0;
  let skippedOffline = 0;
  let skippedTooSoon = 0;
  for (const it of items) {
    if (it.account_status !== 'online') { skippedOffline++; continue; }
    if (riskControl.isPolishTooSoon(it.last_polish_at, minMinutes)) { skippedTooSoon++; continue; }
    await query("UPDATE xy_items SET last_polish_at = datetime('now','localtime'), polish_count = polish_count + 1 WHERE id = ?", [it.id]);
    polished++;
  }
  if (skippedTooSoon > 0) {
    await sysLog('info', 'task', `擦亮任务：${skippedTooSoon} 件商品因最小间隔被跳过（风控）`);
  }
  return { affected: polished, message: `擦亮 ${polished} 件，跳过(离线) ${skippedOffline} 件、(间隔过短) ${skippedTooSoon} 件` };
}

/** 订单拉取同步：生产模式走真实「卖出订单」接口拉取历史/状态（含售前售后）；演示模式走模拟连接器 */
async function hOrderSync(task) {
  if (getMode() !== 'demo') {
    const ordersService = require('../services/orders');
    try {
      const r = await ordersService.syncAccountOrders(task.account_id || '', null, { maxPages: 3 });
      const fails = r.accounts.filter((a) => !a.ok);
      const msg = `平台订单同步：共 ${r.total} 单（新增 ${r.added}，更新 ${r.updated}）`
        + (fails.length ? `；${fails.length} 个账号同步失败（${fails[0].reason || ''}）` : '');
      return { affected: r.added + r.updated, message: msg };
    } catch (e) {
      const listening = xianyuLive.runningAccounts().length;
      // 拉取失败时保留 WS 实时通道兜底说明（实时推送不受影响）
      return { affected: 0, message: `订单列表拉取失败（${e.message}）；WS 实时通道监听中 ${listening} 个账号` };
    }
  }
  const connector = await getConnector();
  const params = [];
  let sql = "SELECT * FROM xy_accounts WHERE status = 'online'";
  if (task.account_id) { sql += ' AND id = ?'; params.push(task.account_id); }
  const accounts = await query(sql, params);
  let total = 0;
  for (const acc of accounts) {
    const r = await connector.fetchNewOrders(acc);
    total += Number(r.new_orders) || 0;
  }
  return { affected: total, message: `同步检查完成（${accounts.length} 个在线账号），新增订单 ${total}` };
}

/** 未发货订单补发 */
async function hDeliveryRetry(task) {
  const settings = await getSettings();
  const minMinutes = Math.max(1, Number(settings.delivery_retry_interval_minutes) || 10);
  const params = [minMinutes];
  let sql = "SELECT * FROM xy_orders WHERE status = 'paid' AND is_virtual = 1 "
    + "AND delivery_status IN ('pending','failed') AND updated_at < datetime('now','localtime','-' || ? || ' minutes')";
  if (task.account_id) { sql += ' AND account_id = ?'; params.push(task.account_id); }
  sql += ' ORDER BY id ASC LIMIT 50';
  const orders = await query(sql, params);
  let okCount = 0;
  let failCount = 0;
  for (const o of orders) {
    try {
      await deliveryEngine.processOrder(o.order_no);
      okCount++;
    } catch (e) {
      failCount++; // processOrder 内部已记录失败原因与日志
    }
  }
  return { affected: okCount, message: `补发处理 ${orders.length} 单：成功 ${okCount}，失败 ${failCount}` };
}

/** 自动评价：已发货且超过延迟分钟数的订单 */
async function hAutoRate(task) {
  const settings = await getSettings();
  const delayMinutes = Math.max(0, Number(settings.auto_rate_delay_minutes) || 0);
  const params = [delayMinutes];
  let sql = 'SELECT o.*, a.auto_rate_enabled FROM xy_orders o JOIN xy_accounts a ON a.id = o.account_id '
    + "WHERE o.status IN ('delivered','completed') AND o.is_rated = 0 "
    + "AND o.delivered_at IS NOT NULL AND o.delivered_at < datetime('now','localtime','-' || ? || ' minutes')";
  if (task.account_id) { sql += ' AND o.account_id = ?'; params.push(task.account_id); }
  sql += ' ORDER BY o.id ASC LIMIT 100';
  const orders = await query(sql, params);
  let rated = 0;
  for (const o of orders) {
    if (!o.auto_rate_enabled) continue;
    await query("UPDATE xy_orders SET is_rated = 1, rated_at = datetime('now','localtime') WHERE id = ?", [o.id]);
    rated++;
  }
  return { affected: rated, message: `自动评价 ${rated} 单（候选 ${orders.length} 单）` };
}

/** Cookie 有效性检查：演示账号按过期时间判定；真实扫码账号走闲鱼凭证真实校验（每账号每天最多一次） */
const lastRealCheck = new Map(); // accountId -> date string
async function hCookieCheck(task) {
  const qrlogin = require('../services/qrlogin');
  const connector = await getConnector();
  const params = [];
  let sql = 'SELECT * FROM xy_accounts';
  if (task.account_id) { sql += ' WHERE id = ?'; params.push(task.account_id); }
  const accounts = await query(sql, params);
  const states = { ok: 0, expiring: 0, expired: 0, unknown: 0, real_checked: 0, real_offline: 0 };
  const today = new Date().toISOString().slice(0, 10);
  for (const acc of accounts) {
    try {
      // 真实扫码账号（纯数字 unb）：每天最多真实校验一次，掉线自动置为异常并通知
      if (qrlogin.isRealAccount(acc) && acc.cookie) {
        if (lastRealCheck.get(acc.id) === today) {
          const r = await connector.checkCookie(acc); // 当天已校验过，退化为本地过期时间判定
          states[r.state] = (states[r.state] || 0) + 1;
          continue;
        }
        lastRealCheck.set(acc.id, today);
        const r = await qrlogin.checkAccountById(acc.id, null);
        states.real_checked++;
        if (r.available) { states.ok++; continue; }
        states.expired++;
        // 仅把此前在线的账号标记为异常（真实掉线）；人工下线的账号保持离线态
        if (acc.status === 'online') {
          states.real_offline++;
          await query("UPDATE xy_accounts SET status = 'error' WHERE id = ?", [acc.id]);
          notifyEvent('risk_alert', `账号掉线：${acc.nickname}`,
            `真实账号 ${acc.account_id} 凭证校验失败（${r.reason}），已置为异常状态，请重新扫码登录`).catch(() => { });
        }
        continue;
      }
      const r = await connector.checkCookie(acc);
      states[r.state] = (states[r.state] || 0) + 1;
    } catch (e) {
      logger.warn('task', `Cookie 检查账号 ${acc.id} 失败（跳过）: ${e.message}`);
      states.unknown++;
    }
  }
  const warn = states.expiring + states.expired;
  return {
    affected: warn,
    message: `检查 ${accounts.length} 个账号：正常 ${states.ok}，即将过期 ${states.expiring}，已过期 ${states.expired}`
      + (states.real_checked ? `；真实校验 ${states.real_checked} 个（掉线 ${states.real_offline}）` : ''),
  };
}

const HANDLERS = {
  item_polish: hItemPolish,
  order_sync: hOrderSync,
  delivery_retry: hDeliveryRetry,
  auto_rate: hAutoRate,
  cookie_check: hCookieCheck,
  crm_followup: hCrmFollowup,
  market_scan: hMarketScan,
  daily_brief: hDailyBrief,
};

/** M25 每日运营简报：生成快照落系统日志，并推送到所有启用渠道（AI 解读由驾驶舱按需触发） */
async function hDailyBrief(task) {
  const b = await assistant.dailyBrief();
  const line = `每日简报 ${b.date}：昨日成交 ${b.yesterday.orders} 单/¥${b.yesterday.revenue}；待办 ${b.todos.length} 项（${b.todos.map((t) => t.text).join('；') || '无'}）`;
  await sysLog('info', 'assistant', line);
  let pushed = 0;
  try {
    pushed = await pushToAllChannels('daily_brief', `每日运营简报 ${b.date}`, line);
  } catch (_) { /* 通知失败不影响任务 */ }
  return { affected: b.todos.length, message: `简报已生成：待办 ${b.todos.length} 项${pushed ? `，已推送 ${pushed} 个渠道` : ''}` };
}

/** M17 未成交客户跟进提醒 */
async function hCrmFollowup(task) {
  const due = await crm.dueFollowupCount();
  if (due > 0) {
    await sysLog('warn', 'task', `CRM 跟进提醒：${due} 位未成交客户等待跟进，请到「客户管理」处理`);
    notifyEvent('followup_due', '客户跟进提醒', `${due} 位未成交客户等待跟进，请到「客户中心」处理`).catch(() => { /* 通知失败不影响任务 */ });
  }
  return { affected: due, message: due > 0 ? `发现 ${due} 位待跟进客户，已记录提醒` : '暂无待跟进客户' };
}

/** M15 市场行情扫描 */
async function hMarketScan(task) {
  const r = await market.runMarketScan();
  return { affected: r.updated + r.added, message: `扫描 ${r.keywords} 个关键词：更新 ${r.updated}，新增 ${r.added}，价格变动 ${r.price_changes}` };
}

// ---------------- 调度核心 ----------------

let timer = null;
let ticking = false;
let lastCleanupDay = ''; // 日结清理：每天最多执行一次
let lastVacuumMonth = ''; // VACUUM：每月最多执行一次

/** 自动备份数据库（WAL 检查点后复制到 data/backups，保留最近 7 份） */
async function autoBackup() {
  const { config } = require('../config');
  const { currentDbFile } = require('../services/mode');
  const fs = require('fs');
  const file = currentDbFile();
  if (!fs.existsSync(file)) return;
  const backupDir = pathJoin(config.root, 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  try { query("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (_) { /* ignore */ }
  const name = `auto-${new Date().toISOString().slice(0, 10)}.db`;
  fs.copyFileSync(file, pathJoin(backupDir, name));
  // 只保留最近 7 份自动备份
  const olds = fs.readdirSync(backupDir).filter((f) => f.startsWith('auto-') && f.endsWith('.db')).sort();
  while (olds.length > 7) {
    const f = olds.shift();
    try { fs.unlinkSync(pathJoin(backupDir, f)); } catch (_) { /* ignore */ }
  }
}

/** 数据保留日结：清理超期日志/任务历史 + 会话自动关闭 + 过期文件日志 + 自动备份 + 月度 VACUUM */
async function dailyDataCleanup() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastCleanupDay === today) return;
  lastCleanupDay = today;
  try {
    const settings = await getSettings();
    const days = Math.max(7, Number(settings.data_retention_days) || 90);
    const cutoff = `datetime('now','localtime','-${days} days')`;
    const tables = [
      'xy_system_logs', 'xy_reply_logs', 'xy_risk_logs', 'xy_notify_logs',
      'xy_delivery_logs', 'xy_publish_logs',
    ];
    let purged = 0;
    for (const t of tables) {
      const r = await query(`DELETE FROM ${t} WHERE created_at < ${cutoff}`);
      purged += r.affectedRows;
    }
    const rRuns = await query(`DELETE FROM xy_task_runs WHERE started_at < ${cutoff}`);
    purged += rRuns.affectedRows;
    // 会话自动关闭：auto_close_conv_days > 0 时，超期未互动的会话自动置为已关闭
    const closeDays = Number(settings.auto_close_conv_days) || 0;
    let closed = 0;
    if (closeDays > 0) {
      const r = await query("UPDATE xy_conversations SET status = 'closed' WHERE status = 'open' AND updated_at < datetime('now','localtime','-' || ? || ' days')", [closeDays]);
      closed = r.affectedRows;
    }
    // 文件日志：删除超期的 logs/app-YYYY-MM-DD.log
    const fs = require('fs');
    const dir = pathJoin(__dirname, '..', 'logs');
    let filesRemoved = 0;
    if (fs.existsSync(dir)) {
      const cutoffTs = Date.now() - days * 86400000;
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^app-(\d{4})-(\d{2})-(\d{2})\.log$/);
        if (!m) continue;
        const ts = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
        if (ts < cutoffTs) { try { fs.unlinkSync(pathJoin(dir, f)); filesRemoved++; } catch (_) { /* ignore */ } }
      }
    }
    // 自动备份（保留最近 7 份）
    let backedUp = false;
    try { await autoBackup(); backedUp = true; } catch (e) { logger.warn('task', '自动备份失败: ' + e.message); }
    // VACUUM 压缩（每月一次，库文件删除量大后回收空间）
    const month = today.slice(0, 7);
    if (lastVacuumMonth !== month) {
      lastVacuumMonth = month;
      try { query('VACUUM'); logger.info('task', '数据库 VACUUM 压缩完成'); } catch (_) { lastVacuumMonth = ''; }
    }
    if (purged + filesRemoved + closed > 0 || backedUp) {
      logger.info('task', `数据日结完成：清理 ${days} 天前日志 ${purged} 行、文件 ${filesRemoved} 个、自动关闭会话 ${closed} 个${backedUp ? '、已自动备份' : ''}`);
    }
  } catch (e) {
    logger.warn('task', '数据保留日结失败（不影响任务调度）: ' + e.message);
    lastCleanupDay = ''; // 允许下次 tick 重试
  }
}

async function runTask(task) {
  // 抢占式认领，避免重复执行
  const claim = await query(
    'UPDATE xy_tasks SET last_status = \'running\', last_run_at = datetime(\'now\',\'localtime\'), run_count = run_count + 1 '
    + 'WHERE id = ? AND last_status <> \'running\'',
    [task.id]
  );
  if (!claim || claim.affectedRows === 0) return null;

  const run = await query(
    'INSERT INTO xy_task_runs (task_id, task_type, status, started_at) VALUES (?, ?, \'running\', datetime(\'now\',\'localtime\'))',
    [task.id, task.task_type]
  );
  const runId = run.insertId;
  const started = Date.now();
  const handler = HANDLERS[task.task_type];
  try {
    if (!handler) throw new Error(`未知任务类型: ${task.task_type}`);
    const result = await handler(task);
    const duration = Date.now() - started;
    await query(
      "UPDATE xy_task_runs SET status = 'success', message = ?, affected = ?, finished_at = datetime('now','localtime'), duration_ms = ? WHERE id = ?",
      [String(result.message || '').slice(0, 500), Number(result.affected) || 0, duration, runId]
    );
    await query(
      "UPDATE xy_tasks SET last_status = 'success', last_message = ?, next_run_at = datetime('now','localtime','+' || ? || ' seconds') WHERE id = ?",
      [String(result.message || '').slice(0, 500), Number(task.interval_seconds) || 300, task.id]
    );
    logger.info('task', `任务「${task.name}」执行成功: ${result.message} (${duration}ms)`);
    return { run_id: runId, status: 'success', message: result.message, affected: result.affected };
  } catch (e) {
    const duration = Date.now() - started;
    await query(
      "UPDATE xy_task_runs SET status = 'failed', message = ?, finished_at = datetime('now','localtime'), duration_ms = ? WHERE id = ?",
      [String(e.message).slice(0, 500), duration, runId]
    );
    await query(
      "UPDATE xy_tasks SET last_status = 'failed', fail_count = fail_count + 1, last_message = ?, next_run_at = datetime('now','localtime','+' || ? || ' seconds') WHERE id = ?",
      [String(e.message).slice(0, 500), Number(task.interval_seconds) || 300, task.id]
    );
    await sysLog('error', 'task', `任务「${task.name}」执行失败: ${e.message}`, { task_id: task.id, run_id: runId });
    await notifyEvent('task_failed', `定时任务失败：${task.name}`, String(e.message));
    logger.error('task', `任务「${task.name}」执行失败: ${e.message}`);
    return { run_id: runId, status: 'failed', message: e.message };
  }
}

/** 手动立即执行指定任务 */
async function runTaskById(taskId) {
  const task = await queryOne('SELECT * FROM xy_tasks WHERE id = ?', [taskId]);
  if (!task) throw new ApiError(CODE.NOT_FOUND, '任务不存在');
  if (task.last_status === 'running') throw new ApiError(CODE.CONFLICT, '任务正在执行中，请稍后再试');
  return runTask(task);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    require('../auth').sweepSessions(); // 顺手清理过期登录会话
    await dailyDataCleanup(); // 数据保留日结（每天一次）
    // 恢复僵尸状态（进程中断/超时）
    await query(
      "UPDATE xy_tasks SET last_status = 'failed', last_message = '上次执行中断（进程重启或超时），已自动恢复' "
      + "WHERE last_status = 'running' AND last_run_at < datetime('now','localtime','-10 minutes')"
    );
    await query(
      "UPDATE xy_task_runs SET status = 'failed', message = '执行中断', finished_at = datetime('now','localtime') "
      + "WHERE status = 'running' AND started_at < datetime('now','localtime','-10 minutes')"
    );
    const due = await query(
      "SELECT * FROM xy_tasks WHERE enabled = 1 AND last_status <> 'running' "
      + "AND (next_run_at IS NULL OR next_run_at <= datetime('now','localtime'))"
    );
    for (const t of due) {
      try {
        await runTask(t);
      } catch (e) {
        logger.error('task', `任务调度异常 task=${t.id}: ${e.message}`);
      }
    }
  } catch (e) {
    logger.error('task', '调度器扫描失败: ' + e.message);
  } finally {
    ticking = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick(); }, 5000);
  logger.info('task', '定时任务调度器已启动（扫描间隔 5s）');
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('task', '定时任务调度器已停止');
  }
}

module.exports = { start, stop, tick, runTaskById, HANDLERS };
