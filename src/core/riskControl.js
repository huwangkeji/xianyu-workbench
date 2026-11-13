'use strict';
// 风控：自动回复频率限制（单进程内存滑动窗口）+ 擦亮频率校验
// 说明：进程重启后计数归零，属工作台级模拟实现，见 docs/01 不确定项
const { riskLog } = require('../services/logs');

/** accountId -> 最近一分钟内已受理自动回复的时间戳数组 */
const replyWindows = new Map();

/**
 * 检查并记录一次自动回复受理。
 * 返回 { allowed, current }；不允许时不记录并写风控日志。
 */
function checkAndRecordReply(accountId, limitPerMin, accountName) {
  const now = Date.now();
  const arr = (replyWindows.get(accountId) || []).filter((t) => now - t < 60 * 1000);
  if (arr.length >= limitPerMin) {
    replyWindows.set(accountId, arr);
    riskLog(accountId, 'rate_limit', 'danger',
      `账号 ${accountName || accountId} 每分钟自动回复达到上限 ${limitPerMin}，本次回复被拦截`);
    // 风控拦截事件推送给订阅渠道（notifyEvent 内建冷却防轰炸）
    require('./notifier').notifyEvent('risk_intercept', '风控拦截：自动回复触发频率限制',
      `账号 ${accountName || accountId} 每分钟自动回复达到上限 ${limitPerMin}，已拦截并记录风控日志`)
      .catch(() => { /* 通知失败不影响主流程 */ });
    return { allowed: false, current: arr.length };
  }
  arr.push(now);
  replyWindows.set(accountId, arr);
  return { allowed: true, current: arr.length };
}

/** 擦亮最小间隔校验（基于商品最近擦亮时间，由调用方查询 DB） */
function isPolishTooSoon(lastPolishAt, minIntervalMinutes) {
  if (!lastPolishAt) return false;
  const last = new Date(lastPolishAt).getTime();
  if (!Number.isFinite(last)) return false;
  return Date.now() - last < minIntervalMinutes * 60 * 1000;
}

module.exports = { checkAndRecordReply, isPolishTooSoon };
