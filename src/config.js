'use strict';
// 配置加载：.env（手动解析，不引入 dotenv）→ 环境变量 → 内置默认值
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadDotEnv(file) {
  const p = file || path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return false;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return true;
}
loadDotEnv();

function intEnv(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : def;
}

const config = {
  root: ROOT,
  port: intEnv('PORT', 8080),
  host: process.env.HOST || '127.0.0.1',
  db: {
    // SQLite 单文件数据库（相对路径基于项目根目录）；生产/演示模式各用一个库文件，完全隔离
    file: process.env.SQLITE_PATH
      ? path.resolve(ROOT, process.env.SQLITE_PATH)
      : path.join(ROOT, 'data', 'xianyu_workbench.db'),
    demoFile: process.env.SQLITE_DEMO_PATH
      ? path.resolve(ROOT, process.env.SQLITE_DEMO_PATH)
      : path.join(ROOT, 'data', 'xianyu_workbench_demo.db'),
  },
  log: {
    dir: process.env.LOG_DIR ? path.resolve(ROOT, process.env.LOG_DIR) : path.join(ROOT, 'logs'),
    level: process.env.LOG_LEVEL || 'info',
  },
  sessionTtlHours: intEnv('SESSION_TTL_HOURS', 24),
};

module.exports = { config, loadDotEnv };
