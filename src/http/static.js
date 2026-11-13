'use strict';
// 静态文件服务（public 目录），带路径穿越防护；版本化资源长缓存 + 文本资源 gzip
const zlib = require('zlib');
// 静态文件服务（public 目录），带路径穿越防护
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  const rootDir = path.normalize(path.join(__dirname, '..', '..', 'public'));
  let rel = pathname;
  try { rel = decodeURIComponent(pathname); } catch (_) { /* keep raw */ }
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(rootDir, rel));
  if (!target.startsWith(rootDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const isEntry = rel === '/index.html';
    // 带版本号(?v=)的 js/css 长缓存（版本变化由 index.html 的引用 URL 控制）；入口页始终协商缓存
    const cacheable = !isEntry && /^\.(js|css)$/.test(ext) && /\bv=[\w.]+/.test(req.url || '');
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheable ? 'public, max-age=604800' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    };
    const gzipOk = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
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
    stream.pipe(res);
  });
}

module.exports = { serveStatic };
