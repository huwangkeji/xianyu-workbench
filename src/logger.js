'use strict';
// 文件 + 控制台日志（业务日志另存数据库，见 services/logs.js）
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let currentLevel = LEVELS[config.log.level] !== undefined ? LEVELS[config.log.level] : LEVELS.info;

function pad(n, w) { return String(n).padStart(w || 2, '0'); }

function fmtTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function safeDetail(v) {
  if (v === undefined || v === null) return '';
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  } catch (_) {
    return String(v);
  }
}

function write(level, module, message, detail) {
  if ((LEVELS[level] || 0) < currentLevel) return;
  const line = `[${fmtTime(new Date())}] [${level.toUpperCase().padEnd(5)}] [${module}] ${message}${detail ? ' ' + safeDetail(detail) : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  try {
    fs.mkdirSync(config.log.dir, { recursive: true });
    const d = new Date();
    const name = `app-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`;
    fs.appendFileSync(path.join(config.log.dir, name), line + '\n');
  } catch (_) {
    // 文件写入失败不影响服务运行
  }
}

module.exports = {
  debug: (m, msg, d) => write('debug', m, msg, d),
  info: (m, msg, d) => write('info', m, msg, d),
  warn: (m, msg, d) => write('warn', m, msg, d),
  error: (m, msg, d) => write('error', m, msg, d),
};
