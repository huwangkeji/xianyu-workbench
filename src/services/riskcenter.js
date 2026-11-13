'use strict';
// M19 店铺风险管理：账号异常 / Cookie 失效 / 商品违规 / 重复商品 / 售后超时 / 任务异常
const { query, queryOne } = require('../db');
const { getSettings } = require('../services/settings');
const { sysLog } = require('./logs');
const { notifyEvent } = require('../core/notifier');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * 全量风险扫描（页面「重新扫描」与定时巡检共用），实时计算不落库。
 * 返回 { summary, groups }，group: { type, severity, label, items }
 */
async function scanRiskCenter() {
  const settings = await getSettings();
  const afterSalesHours = Math.max(1, Number(settings.after_sales_timeout_hours) || 48);
  const violationWords = String(settings.violation_words || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const groups = [];

  // 1) 账号状态异常 + 登录状态失效
  const accounts = await query('SELECT * FROM xy_accounts');
  const accountIssues = [];
  for (const a of accounts) {
    if (a.status === 'error') {
      accountIssues.push({ severity: 'high', account_id: a.id, nickname: a.nickname, detail: '账号状态异常（连接错误），自动化已停止' });
    } else if (a.status === 'disabled') {
      accountIssues.push({ severity: 'low', account_id: a.id, nickname: a.nickname, detail: '账号已禁用' });
    } else if (a.status === 'offline' && a.auto_reply_enabled) {
      accountIssues.push({ severity: 'medium', account_id: a.id, nickname: a.nickname, detail: '账号离线但自动回复开关开启，买家消息无人应答' });
    }
    if (a.cookie_expires_at) {
      const hours = (new Date(a.cookie_expires_at).getTime() - Date.now()) / 3600000;
      if (hours <= 0) {
        accountIssues.push({ severity: 'high', account_id: a.id, nickname: a.nickname, detail: '登录状态已失效（Cookie 过期），请立即刷新' });
      } else if (hours < 48) {
        accountIssues.push({ severity: 'high', account_id: a.id, nickname: a.nickname, detail: `登录状态约 ${Math.floor(hours)} 小时后失效（Cookie 即将过期）` });
      }
    }
  }
  if (accountIssues.length) {
    groups.push({ type: 'account', severity: accountIssues.some((i) => i.severity === 'high') ? 'high' : 'medium', label: '账号与登录状态', items: accountIssues });
  }

  // 2) 商品违规风险（违禁词扫描）
  const items = await query("SELECT id, title, description, account_id FROM xy_items WHERE status = 'on_sale'");
  const violationItems = [];
  for (const it of items) {
    const text = `${it.title} ${it.description || ''}`;
    const hits = violationWords.filter((w) => w && text.includes(w));
    if (hits.length) {
      violationItems.push({ severity: 'high', item_id: it.id, title: it.title, detail: `命中违禁/风险词：${hits.join('、')}` });
    }
  }
  if (violationItems.length) {
    groups.push({ type: 'item_violation', severity: 'high', label: '商品违规风险', items: violationItems });
  }

  // 3) 重复商品检测（标题完全相同的在架商品）
  const dupRows = await query(
    "SELECT title, COUNT(*) AS cnt, group_concat(id) AS ids FROM xy_items WHERE status = 'on_sale' GROUP BY title HAVING COUNT(*) > 1"
  );
  if (dupRows.length) {
    groups.push({
      type: 'duplicate_items', severity: 'medium', label: '重复商品检测',
      items: dupRows.map((d) => ({ severity: 'medium', title: d.title, detail: `相同标题在架商品 ${d.cnt} 件（ID: ${d.ids}），涉嫌重复铺货，建议差异化标题` })),
    });
  }

  // 4) 售后超时提醒
  const refundOrders = await query(
    "SELECT order_no, buyer_nick, amount, updated_at, CAST((julianday(datetime('now','localtime')) - julianday(updated_at)) * 24 AS INTEGER) AS hours_open FROM xy_orders WHERE status = 'refunding' ORDER BY updated_at ASC"
  );
  if (refundOrders.length) {
    const overdue = refundOrders.filter((o) => Number(o.hours_open) >= afterSalesHours);
    const opening = refundOrders.filter((o) => Number(o.hours_open) < afterSalesHours);
    const items2 = [
      ...overdue.map((o) => ({ severity: 'high', order_no: o.order_no, buyer_nick: o.buyer_nick, detail: `售后已开单 ${o.hours_open} 小时未处理（阈值 ${afterSalesHours} 小时），金额 ¥${round2(o.amount)}` })),
      ...opening.map((o) => ({ severity: 'medium', order_no: o.order_no, buyer_nick: o.buyer_nick, detail: `售后处理中，已开单 ${o.hours_open} 小时，金额 ¥${round2(o.amount)}` })),
    ];
    groups.push({ type: 'after_sales', severity: overdue.length ? 'high' : 'medium', label: '售后处理', items: items2 });
  }

  // 5) 自动化任务异常监控
  const failedTasks = await query("SELECT id, name, last_message, fail_count, last_run_at FROM xy_tasks WHERE last_status = 'failed' OR fail_count > 0");
  if (failedTasks.length) {
    groups.push({
      type: 'task', severity: 'medium', label: '自动化任务异常',
      items: failedTasks.map((t) => ({ severity: t.last_status === 'failed' ? 'medium' : 'low', task_id: t.id, name: t.name, detail: `失败 ${t.fail_count} 次，最近：${t.last_message || '-'}` })),
    });
  }
  const errLog = await queryOne("SELECT COUNT(*) AS c FROM xy_system_logs WHERE level = 'error' AND created_at >= datetime('now','localtime','-24 hours')");
  if (Number(errLog.c) > 0) {
    groups.push({
      type: 'system_error', severity: 'low', label: '系统错误日志（24h）',
      items: [{ severity: 'low', detail: `近 24 小时共 ${errLog.c} 条系统错误日志，请到「日志中心→系统日志」按级别筛选排查` }],
    });
  }

  // 6) 高危风控事件透出（近 24h danger 级风控日志）
  const dangerCount = await queryOne("SELECT COUNT(*) AS c FROM xy_risk_logs WHERE level = 'danger' AND created_at >= datetime('now','localtime','-24 hours')");
  if (Number(dangerCount.c) > 0) {
    groups.push({
      type: 'risk_events', severity: 'medium', label: '风控拦截事件（24h）',
      items: [{ severity: 'medium', detail: `近 24 小时发生 ${dangerCount.c} 次 danger 级风控拦截（如回复超频），请降低自动化强度` }],
    });
  }

  const summary = {
    high: groups.reduce((a, g) => a + g.items.filter((i) => i.severity === 'high').length, 0),
    medium: groups.reduce((a, g) => a + g.items.filter((i) => i.severity === 'medium').length, 0),
    low: groups.reduce((a, g) => a + g.items.filter((i) => i.severity === 'low').length, 0),
    group_count: groups.length,
  };
  const result = { summary, groups, scanned_at: new Date().toISOString() };
  await sysLog('info', 'app', `风险扫描完成：高危 ${summary.high} / 中危 ${summary.medium} / 低危 ${summary.low}`);
  if (summary.high > 0) {
    await notifyEvent('risk_alert', `风险扫描发现 ${summary.high} 项高危问题`, groups.filter((g) => g.severity === 'high').map((g) => `${g.label}(${g.items.length})`).join('、'));
  }
  return result;
}

module.exports = { scanRiskCenter };
