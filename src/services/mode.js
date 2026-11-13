'use strict';
// 运行模式管理：production（默认，无任何演示数据）/ demo（演示模式，独立数据库完全隔离）
// 模式标记存 data/mode.json（不属于任何数据库，重启后保持）；
// 切换模式由路由层调用 requestSwitch → index.js 注入的重启钩子完成"写标记 → 优雅停机 → 拉起新进程"。
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const logger = require('../logger');

const MODE_FILE = path.join(config.root, 'data', 'mode.json');
const MODES = ['production', 'demo'];

let restartHandler = null;

function getMode() {
  try {
    const j = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    return MODES.includes(j.mode) ? j.mode : 'production';
  } catch (_) {
    return 'production';
  }
}

function setMode(mode) {
  if (!MODES.includes(mode)) throw new Error('未知模式: ' + mode);
  fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true });
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode, switched_at: new Date().toISOString() }, null, 2));
}

/** 当前模式对应的 SQLite 库文件 */
function currentDbFile() {
  return getMode() === 'demo' ? config.db.demoFile : config.db.file;
}

/** index.js 启动时注入自重启实现（优雅停机 → 拉起新进程 → 退出） */
function setRestartHandler(fn) {
  restartHandler = fn;
}

/**
 * 切换运行模式：写标记并触发自重启（新进程重新登录）。
 * 返回 { changed, mode, restarting }；模式相同则不做任何事。
 */
function requestSwitch(mode) {
  if (!MODES.includes(mode)) throw new Error('未知模式: ' + mode);
  const current = getMode();
  if (current === mode) return { changed: false, mode, restarting: false };
  setMode(mode);
  logger.info('app', `运行模式切换: ${current} → ${mode}，准备自重启`);
  if (restartHandler) {
    setTimeout(() => {
      try { restartHandler(mode); } catch (e) { logger.error('app', '模式切换重启失败: ' + e.message); }
    }, 250); // 先让响应送达前端
  } else {
    logger.warn('app', '未注册重启处理器，模式标记已写入，需手动重启服务生效');
  }
  return { changed: true, mode, restarting: true };
}

/** 触发自重启（不改变模式）——演示数据重置等场景使用 */
function triggerRestart() {
  if (restartHandler) {
    setTimeout(() => {
      try { restartHandler(getMode()); } catch (e) { logger.error('app', '重启触发失败: ' + e.message); }
    }, 250);
    return true;
  }
  return false;
}

/** 删除演示库文件（调用方须先关闭数据库连接；下次打开自动按 seed_demo 重建） */
function resetDemoData() {
  if (getMode() !== 'demo') throw new Error('仅演示模式下可重置演示数据');
  for (const suffix of ['', '-wal', '-shm']) {
    const p = config.db.demoFile + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  logger.info('app', '演示库文件已删除，重启后将重新初始化演示数据');
}

module.exports = { getMode, setMode, currentDbFile, requestSwitch, setRestartHandler, triggerRestart, resetDemoData, MODES };
