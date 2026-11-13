'use strict';
// 一次性脚本：后端性能与稳定加固
// 1) sendJson 支持 gzip（>1KB 且客户端支持时压缩，列表类大响应显著减小传输体积）
// 2) 静态资源：带版本号的 js/css 长缓存 + 首页 no-cache（彻底解决改版后浏览器缓存旧文件）
// 3) 静态文本资源 gzip
// 4) db.js 预编译语句缓存（热查询免重复 prepare）
const fs = require('fs');
const path = require('path');

// ---- 1. respond.js sendJson gzip ----
const respondFile = path.join(__dirname, '..', 'src', 'http', 'respond.js');
let respond = fs.readFileSync(respondFile, 'utf8');
if (!respond.includes('gzipSync')) {
  respond = respond.replace(
    /'use strict';/,
    `'use strict';\n// 统一响应（ok/fail/分页），大负载自动 gzip（零依赖 zlib）\nconst zlib = require('zlib');`
  );
  respond = respond.replace(
    `function sendJson(res, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}`,
    `function sendJson(res, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
  // 大响应自动 gzip（>1KB 且客户端支持）
  const accept = String(res.req && res.req.headers && res.req.headers['accept-encoding'] || '');
  if (body.length > 1024 && /\\bgzip\\b/.test(accept)) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(zlib.gzipSync(Buffer.from(body, 'utf8')));
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}`
  );
  fs.writeFileSync(respondFile, respond);
  console.log('respond.js: sendJson gzip OK');
} else {
  console.log('respond.js: already patched');
}

// ---- 2+3. static.js 缓存与 gzip ----
const staticFile = path.join(__dirname, '..', 'src', 'http', 'static.js');
let stat = fs.readFileSync(staticFile, 'utf8');
if (!stat.includes('gzipSync')) {
  stat = stat.replace(
    /'use strict';/,
    `'use strict';\n// 静态文件服务（public 目录），带路径穿越防护；版本化资源长缓存 + 文本资源 gzip\nconst zlib = require('zlib');`
  );
  stat = stat.replace(
    `    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(target);
    stream.on('error', (e) => {
      logger.error('static', '读取静态文件失败: ' + e.message);
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);`,
    `    const ext = path.extname(target).toLowerCase();
    const isEntry = rel === '/index.html';
    // 带版本号(?v=)的 js/css 长缓存（版本变化由 index.html 的引用 URL 控制）；入口页始终协商缓存
    const cacheable = !isEntry && /^\\.(js|css)$/.test(ext) && /\\bv=[\\w.]+/.test(req.url || '');
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheable ? 'public, max-age=604800' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    };
    const gzipOk = /\\bgzip\\b/.test(String(req.headers['accept-encoding'] || ''))
      && ['.js', '.css', '.html', '.json', '.svg'].includes(ext);
    if (gzipOk) headers['Vary'] = 'Accept-Encoding';
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }
    if (gzipOk) {
      // 文本资源 gzip（本地文件体积小，同步读+压缩，一次性写回）
      fs.readFile(target, (e2, buf) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Not Found');
        }
        const zbuf = zlib.gzipSync(buf, { level: 6 });
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = zbuf.length;
        res.writeHead(200, headers);
        res.end(zbuf);
      });
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    const stream = fs.createReadStream(target);
    stream.on('error', (e) => {
      logger.error('static', '读取静态文件失败: ' + e.message);
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);`
  );
  fs.writeFileSync(staticFile, stat);
  console.log('static.js: cache+gzip OK');
} else {
  console.log('static.js: already patched');
}

// ---- 4. db.js 预编译语句缓存 ----
const dbFile = path.join(__dirname, '..', 'src', 'db.js');
let db = fs.readFileSync(dbFile, 'utf8');
if (!db.includes('stmtCache')) {
  db = db.replace(
    `let db = null;
let chain = Promise.resolve(); // 全局串行队列：单连接上避免并发写交叉
let txDepth = 0;`,
    `let db = null;
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
}`
  );
  db = db.replace(
    `function execInternal(sql, params) {
  const d = getDb();
  const stmt = d.prepare(sql);`,
    `function execInternal(sql, params) {
  const d = getDb();
  const stmt = getStmt(d, sql);`
  );
  db = db.replace(
    `  const run = () => {
    const d = getDb();
    const stmt = d.prepare(sql);`,
    `  const run = () => {
    const d = getDb();
    const stmt = getStmt(d, sql);`
  );
  fs.writeFileSync(dbFile, db);
  console.log('db.js: statement cache OK');
} else {
  console.log('db.js: already patched');
}
