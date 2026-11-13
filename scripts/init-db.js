'use strict';
// 数据库初始化（SQLite 版）：按当前运行模式打开对应库文件 → 幂等建表/种子
// 用法：node scripts/init-db.js [--recreate|--demo|--production]
//   --recreate   删除当前模式的库文件后重建（含 -wal/-shm）
//   --demo       操作演示库（xianyu_workbench_demo.db）
//   --production 操作生产库（默认）
// 说明：服务启动时 db.js 也会自动初始化，本脚本用于显式初始化/重置。
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const modeService = require('../src/services/mode');
const { getPool, closePool } = require('../src/db');

async function main() {
  if (process.argv.includes('--demo')) modeService.setMode('demo');
  else if (process.argv.includes('--production')) modeService.setMode('production');
  const mode = modeService.getMode();
  const file = modeService.currentDbFile();

  const recreate = process.argv.includes('--recreate');
  await closePool(); // 若已打开先关闭，确保删除文件不被占用
  if (recreate) {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = file + suffix;
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`已删除 ${path.basename(p)}`);
      }
    }
  }
  const db = getPool();
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  db.exec(schema);
  console.log(`表结构执行完成（sql/schema.sql，${mode === 'demo' ? '演示' : '生产'}模式）`);

  const row = db.prepare('SELECT COUNT(*) AS c FROM xy_users').get();
  if (Number(row.c) === 0) {
    const seedFile = mode === 'demo' ? 'seed_demo.sql' : 'seed_core.sql';
    const seed = fs.readFileSync(path.join(__dirname, '..', 'sql', seedFile), 'utf8');
    db.exec(seed);
    console.log(`初始化数据执行完成（sql/${seedFile}）`);
  } else {
    console.log('数据库已有数据，跳过初始化数据（如需重置请使用 --recreate）');
  }
  console.log(`数据库初始化完成：${file}`);
  await closePool();
}

main().catch((e) => {
  console.error('数据库初始化失败:', e && e.message);
  process.exit(1);
});

