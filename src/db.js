'use strict';
// 数据库层：node:sqlite 单文件数据库（Node >= 22.5 内置，零外部依赖）
// 与原 mysql2 版保持相同 API，调用方无需改动：
//   1. query(sql, params)：SELECT/PRAGMA 返回行数组；INSERT/UPDATE/DELETE 返回 { insertId, affectedRows }
//   2. queryOne(sql, params)：单行或 null
//   3. withTransaction(fn)：事务内 conn.query 返回 [rows]（mysql2 解构形状，见 core/deliveryEngine.js）
// 时间约定：TEXT 存本地时间 'YYYY-MM-DD HH:MM:SS'，SQL 内统一 datetime('now','localtime')（与原 NOW() 语义一致）
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const logger = require('./logger');
const { getMode } = require('./services/mode');

// 屏蔽 node:sqlite 的 ExperimentalWarning（其余 warning 照常输出）
process.on('warning', (w) => {
  if (w && w.name === 'ExperimentalWarning' && /sqlite/i.test(String(w.message || ''))) return;
  console.warn(w && w.stack ? w.stack : w);
});

const { DatabaseSync } = require('node:sqlite');

let db = null;
let chain = Promise.resolve(); // 全局串行队列：单连接上避免并发写交叉
let txDepth = 0;
const stmtCache = new Map(); // 预编译语句缓存（热查询免重复 prepare，上限防膨胀）
const STMT_CACHE_MAX = 256;

function getStmt(d, sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = d.prepare(sql);
    if (stmtCache.size >= STMT_CACHE_MAX) stmtCache.clear(); // 简单防膨胀：动态 SQL 多时整表重置
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

/** JS Date -> 本地时间字符串 'YYYY-MM-DD HH:MM:SS'（node:sqlite 不接受 Date 参数） */
function localDateTimeString(d) {
  const t = d instanceof Date ? d : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} `
    + `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

function getDb() {
  if (db) return db;
  const mode = getMode();
  const file = mode === 'demo' ? config.db.demoFile : config.db.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = OFF;'); // 与原约定一致：不使用外键，关系由服务层维护
  autoInit(db, mode, file);
  logger.info('db', `SQLite 已打开（${mode === 'demo' ? '演示模式' : '生产模式'}）: ${file}`);
  return db;
}

/** 幂等自动初始化：无表则建表；用户为空则按模式写入种子（生产=纯生产种子，演示=丰富演示数据） */
function autoInit(d, mode, file) {
  // schema 始终幂等执行（全部为 CREATE IF NOT EXISTS / CREATE TRIGGER IF NOT EXISTS），
  // 支持版本升级时自动补齐新增的表/索引/触发器
  d.exec(fs.readFileSync(path.join(config.root, 'sql', 'schema.sql'), 'utf8'));
  ensureColumns(d);
  logger.info('db', '表结构校验完成（sql/schema.sql 幂等执行）');
  const row = d.prepare('SELECT COUNT(*) AS c FROM xy_users').get();
  if (Number(row.c) === 0) {
    const seedFile = mode === 'demo' ? 'seed_demo.sql' : 'seed_core.sql';
    d.exec(fs.readFileSync(path.join(config.root, 'sql', seedFile), 'utf8'));
    logger.info('db', `初始化数据完成（sql/${seedFile}，${mode === 'demo' ? '演示' : '生产'}模式）`);
  }
}

/** 轻量列迁移：已有库补齐后加的列（SQLite 的 CREATE TABLE IF NOT EXISTS 不会更新旧表） */
function ensureColumns(d) {
  const has = (table, col) => d.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
  const add = (table, col, ddl) => {
    if (!has(table, col)) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      logger.info('db', `列迁移：${table} 新增 ${col}`);
    }
  };
  add('xy_conversations', 'session_id', '`session_id` TEXT NULL'); // 闲鱼会话 ID（真实发送消息用）
  add('xy_messages', 'ext_id', '`ext_id` TEXT NULL'); // 平台消息标识（真实通道去重）
  add('xy_orders', 'status_text', '`status_text` TEXT NULL'); // 平台侧订单状态原文（同步落库）
}

function normalizeParams(params) {
  const arr = params || [];
  return arr.map((v) => {
    if (v === undefined) throw new Error('SQL 参数包含 undefined（请显式传 null）');
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) throw new Error('SQL 参数不支持 Date 对象，请用 localDateTimeString() 转字符串');
    return v;
  });
}

const READ_SQL = /^\s*(SELECT|PRAGMA|VALUES)\b/i;

function execInternal(sql, params) {
  const d = getDb();
  const stmt = getStmt(d, sql);
  const args = normalizeParams(params);
  if (READ_SQL.test(sql)) return stmt.all(...args);
  const r = stmt.run(...args);
  return { insertId: Number(r.lastInsertRowid), affectedRows: Number(r.changes) };
}

/** 顶层查询：SELECT 返回行数组，写语句返回 { insertId, affectedRows } */
async function query(sql, params) {
  if (txDepth > 0) return execInternal(sql, params); // 事务内重入直连
  const p = chain.then(() => execInternal(sql, params));
  chain = p.then(() => {}, () => {});
  return p;
}

/** 查询单行，无结果返回 null */
async function queryOne(sql, params) {
  const run = () => {
    const d = getDb();
    const stmt = getStmt(d, sql);
    const args = normalizeParams(params);
    return READ_SQL.test(sql) ? (stmt.get(...args) || null) : execInternal(sql, params);
  };
  if (txDepth > 0) return run();
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}

/** 事务内连接对象：保持 mysql2 的 conn.query 解构形状 [rows] */
function txConn() {
  return {
    query: async (sql, params) => [await query(sql, params)],
    execute: async (sql, params) => [await query(sql, params)],
  };
}

/** 串行化事务：fn(conn) 抛错自动回滚。fn 内请用 conn.query，不要做外部 I/O 长等待 */
async function withTransaction(fn) {
  const run = async () => {
    if (txDepth > 0) return fn(txConn()); // 队列串行下不可达，防御性兜底
    const d = getDb();
    d.exec('BEGIN IMMEDIATE');
    txDepth += 1;
    try {
      const result = await fn(txConn());
      d.exec('COMMIT');
      return result;
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch (_) { /* 忽略回滚异常 */ }
      throw e;
    } finally {
      txDepth -= 1;
    }
  };
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}

/** 关闭数据库（保留原函数名，调用方不变） */
async function closePool() {
  if (db) {
    try { db.close(); } catch (_) { /* 忽略 */ }
    db = null;
  }
}

/** 兼容导出：原连接池入口，现返回 node:sqlite DatabaseSync 实例 */
function getPool() {
  return getDb();
}

module.exports = { getPool, query, queryOne, withTransaction, closePool, localDateTimeString };
