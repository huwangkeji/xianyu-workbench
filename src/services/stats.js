'use strict';
// 仪表盘统计
const { queryOne, query } = require('../db');

async function dashboard() {
  const [accounts, items, messagesToday, autoReplyToday, ordersToday, pendingDelivery, cardStock, tasks, riskToday] = await Promise.all([
    queryOne("SELECT COUNT(*) AS total, SUM(status = 'online') AS online, SUM(status = 'error') AS error FROM xy_accounts"),
    queryOne("SELECT COUNT(*) AS total, SUM(is_virtual = 1) AS virtual_cnt FROM xy_items WHERE status = 'on_sale'"),
    queryOne("SELECT COUNT(*) AS total, SUM(direction = 'in') AS in_cnt, SUM(direction = 'out') AS out_cnt FROM xy_messages WHERE created_at >= date('now','localtime')"),
    queryOne("SELECT COUNT(*) AS total FROM xy_reply_logs WHERE process_status = 'success' AND created_at >= date('now','localtime')"),
    queryOne("SELECT COUNT(*) AS total, SUM(amount) AS amount FROM xy_orders WHERE created_at >= date('now','localtime')"),
    queryOne("SELECT COUNT(*) AS total FROM xy_orders WHERE status = 'paid' AND delivery_status IN ('pending','failed')"),
    queryOne("SELECT COUNT(*) AS total FROM xy_card_codes WHERE status = 'available'"),
    queryOne("SELECT COUNT(*) AS total, SUM(enabled = 1) AS enabled, SUM(last_status = 'failed') AS failed FROM xy_tasks"),
    queryOne("SELECT COUNT(*) AS total FROM xy_risk_logs WHERE created_at >= date('now','localtime')"),
  ]);
  const n = (v) => (v === null || v === undefined ? 0 : Number(v));

  const [msgTrend, orderTrend] = await Promise.all([
    query("SELECT date(created_at) AS d, COUNT(*) AS c FROM xy_messages WHERE created_at >= date('now','localtime','-6 days') GROUP BY d"),
    query("SELECT date(created_at) AS d, COUNT(*) AS c, SUM(amount) AS amount FROM xy_orders WHERE created_at >= date('now','localtime','-6 days') GROUP BY d"),
  ]);
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const m = msgTrend.find((r) => r.d === key);
    const o = orderTrend.find((r) => r.d === key);
    trend.push({ date: key, messages: n(m && m.c), orders: n(o && o.c), order_amount: Number((o && o.amount) || 0) });
  }

  const [recentReplyLogs, recentSystemLogs, taskList] = await Promise.all([
    query(
      'SELECT l.*, a.nickname AS account_nickname FROM xy_reply_logs l LEFT JOIN xy_accounts a ON a.id = l.account_id '
      + 'ORDER BY l.id DESC LIMIT 8'
    ),
    query('SELECT * FROM xy_system_logs ORDER BY id DESC LIMIT 8'),
    query(
      'SELECT t.*, a.nickname AS account_nickname FROM xy_tasks t LEFT JOIN xy_accounts a ON a.id = t.account_id '
      + 'ORDER BY t.enabled DESC, t.next_run_at ASC LIMIT 10'
    ),
  ]);

  return {
    accounts: { total: n(accounts.total), online: n(accounts.online), error: n(accounts.error) },
    items: { on_sale: n(items.total), virtual: n(items.virtual_cnt) },
    messages_today: { total: n(messagesToday.total), in: n(messagesToday.in_cnt), out: n(messagesToday.out_cnt) },
    auto_reply_today: n(autoReplyToday.total),
    orders_today: { total: n(ordersToday.total), amount: Number(ordersToday.amount || 0) },
    pending_delivery: n(pendingDelivery.total),
    card_stock: n(cardStock.total),
    tasks: { total: n(tasks.total), enabled: n(tasks.enabled), failed: n(tasks.failed) },
    risk_today: n(riskToday.total),
    trend,
    recent_reply_logs: recentReplyLogs,
    recent_system_logs: recentSystemLogs,
    task_list: taskList,
  };
}

module.exports = { dashboard };
