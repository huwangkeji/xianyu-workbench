'use strict';
// 一键诊断：node scripts/doctor.js
// 检查：配置生效值 → HTTP 健康检查 → SQLite 连通与用户列表 → 最近系统日志
// 有任一项失败则退出码为 1（供 start.bat 或 CI 使用）
const http = require('http');
const fs = require('fs');
const { query, queryOne, closePool } = require('../src/db');
const { config } = require('../src/config');
const modeService = require('../src/services/mode');

let failed = 0;
const ok = (m) => console.log('  [OK]   ' + m);
const bad = (m) => { failed += 1; console.log('  [FAIL] ' + m); };
const step = (m) => console.log('  [..]   ' + m);

function fmtDateTime(v) {
  if (typeof v === 'string') return v.slice(0, 19);
  if (v instanceof Date) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} `
      + `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  return String(v);
}

function healthCheck() {
  return new Promise((resolve) => {
    const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
    const req = http.get({ host, port: config.port, path: '/health', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, body: body.slice(0, 200) }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时（3 秒无响应）')));
    req.on('error', (e) => resolve({ ok: false, body: e.message }));
  });
}

async function main() {
  const mode = modeService.getMode();
  const dbFile = modeService.currentDbFile();
  console.log(`  配置: http://${config.host}:${config.port} | ${mode === 'demo' ? '演示模式' : '生产模式'} | db=${dbFile}（存在: ${fs.existsSync(dbFile) ? '是' : '否'}） | log=${config.log.dir}`);

  step('健康检查 /health');
  const h = await healthCheck();
  if (h.ok) ok('服务在线: ' + h.body);
  else bad('健康检查未通过（' + h.body + '）— 服务可能未启动或端口不对');

  step('数据库连接');
  try {
    const v = await queryOne('SELECT sqlite_version() AS v');
    const users = await query('SELECT id, username, role, status FROM xy_users ORDER BY id');
    ok(`SQLite ${v.v} 连接正常，工作台用户 ${users.length} 个: `
      + users.map((u) => `${u.username}(${u.role}/${u.status})`).join(', '));
    const logs = await query(
      'SELECT level, module, message, created_at FROM xy_system_logs ORDER BY id DESC LIMIT 5'
    );
    console.log('  最近 5 条系统日志:');
    if (!logs.length) console.log('    （空）');
    for (const l of logs) {
      console.log(`    [${fmtDateTime(l.created_at)}] [${l.level}] [${l.module}] ${String(l.message).slice(0, 80)}`);
    }
  } catch (e) {
    bad('数据库连接失败: ' + e.message);
  }
  await closePool();

  console.log(failed ? `诊断完成：${failed} 项异常` : '诊断完成：全部正常');
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('诊断脚本异常: ' + (e && e.message));
  try { await closePool(); } catch (_) { /* ignore */ }
  process.exit(1);
});
