'use strict';
// 人工接管模式：账号级"暂停自动回复 N 分钟"，到点自动恢复（内存态，服务重启即解除）
const pauses = new Map(); // accountId -> pauseUntil(ts)

/** 暂停某账号自动回复；minutes=0 立即恢复 */
function pause(accountId, minutes) {
  const m = Math.max(0, Number(minutes) || 0);
  if (m <= 0) {
    pauses.delete(accountId);
    return { paused: false };
  }
  const until = Date.now() + m * 60000;
  pauses.set(accountId, until);
  return { paused: true, minutes: m, until };
}

/** 当前是否处于接管中（返回剩余毫秒，0=未接管） */
function remaining(accountId) {
  const until = pauses.get(accountId);
  if (!until) return 0;
  const rest = until - Date.now();
  if (rest <= 0) {
    pauses.delete(accountId);
    return 0;
  }
  return rest;
}

function clear(accountId) {
  pauses.delete(accountId);
}

module.exports = { pause, remaining, clear };
