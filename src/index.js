'use strict';
// 入口：加载配置 → 初始化数据库（可选）→ 启动 HTTP 服务与调度器
const http = require('http');
const path = require('path');
const { config } = require('./config');
const logger = require('./logger');
const { Router } = require('./http/router');
const { serveStatic } = require('./http/static');
const { ApiError, CODE, ok, fail, isApiError, readBody } = require('./http/respond');
const { requireAuth } = require('./auth');
const { closePool } = require('./db');
const { sysLog } = require('./services/logs');
const scheduler = require('./core/scheduler');
const modeService = require('./services/mode');
const registerApiRoutes = require('./routes/api');
const registerSimulateRoutes = require('./routes/simulate');

const router = new Router();
registerApiRoutes(router);
registerSimulateRoutes(router);

// 启动资源自检：前端入口文件损坏（误写/覆盖）时立即告警，避免"打开页面显示 JS 源码"这类问题静默发生
(function checkFrontendAssets() {
  const fs = require('fs');
  const indexPath = path.join(config.root, 'public', 'index.html');
  try {
    if (!fs.existsSync(indexPath)) {
      logger.error('app', `前端入口缺失：${indexPath}（public 目录不完整，请恢复 index.html）`);
      return;
    }
    const html = fs.readFileSync(indexPath, 'utf8');
    if (!/<!DOCTYPE html>/i.test(html)) {
      logger.error('app', 'public/index.html 内容异常（缺少 DOCTYPE，疑似被覆盖为其他内容），页面将无法正常渲染');
      return;
    }
    for (const f of ['js/api.js', 'js/ui.js', 'js/pages.js', 'js/app.js', 'css/app.css']) {
      const p = path.join(config.root, 'public', f);
      if (!fs.existsSync(p) || fs.statSync(p).size < 200) {
        logger.error('app', `前端资源缺失或异常：public/${f}`);
      }
    }
  } catch (_) { /* 自检失败不阻断启动 */ }
})();

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    const u = new URL(req.url, 'http://localhost');
    try { pathname = decodeURIComponent(u.pathname); } catch (_) { pathname = u.pathname; }

    if (pathname === '/health') {
      return ok(res, {
        status: 'up',
        uptime_seconds: Math.round(process.uptime()),
        time: new Date().toISOString(),
      });
    }

    if (pathname.startsWith('/api/')) {
      const m = router.match(req.method, pathname);
      if (!m) {
        if (router.hasPath(pathname)) {
          throw new ApiError(CODE.BAD_REQUEST, `不支持的请求方法: ${req.method} ${pathname}`);
        }
        throw new ApiError(CODE.NOT_FOUND, `接口不存在: ${req.method} ${pathname}`);
      }
      const ctx = { req, res, params: m.params, query: u.searchParams, body: {}, user: null };
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        const contentType = String(req.headers['content-type'] || '');
        if (/multipart\/form-data/i.test(contentType)) {
          // 文件上传：保留原始字节（路由内自行解析 multipart）
          ctx.rawBody = await readBodyBuffer(req, 10 * 1024 * 1024);
          ctx.contentType = contentType;
        } else {
          ctx.body = await readBody(req);
        }
      }
      if (!m.route.public) ctx.user = requireAuth(req);
      const result = await m.route.handler(ctx);
      if (!res.writableEnded) ok(res, result === undefined ? null : result);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new ApiError(CODE.NOT_FOUND, '静态资源仅支持 GET');
    }
    serveStatic(req, res, pathname);
  } catch (e) {
      if (isApiError(e)) {
        fail(res, e.code, e.message, e.data);
        logger.debug('http', `${req.method} ${pathname} -> code=${e.code} ${e.message}`);
      } else {
        logger.error('app', `请求处理异常 ${req.method} ${pathname}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
        sysLog('error', 'app', `请求处理异常 ${req.method} ${pathname}: ${e && e.message}`, { path: pathname });
        fail(res, CODE.INTERNAL, '服务器内部错误');
      }
  }
});

/** 读取原始请求体（Buffer，文件上传用） */
function readBodyBuffer(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new ApiError(CODE.BAD_REQUEST, '上传文件过大（最大 10MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 请求体过大时 readBody 会销毁连接，这里兜底避免崩溃
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

async function main() {
  modeService.setRestartHandler(restartForModeSwitch);
  logger.info('app', `闲鱼自动化工作台启动中（${config.host}:${config.port}，${modeService.getMode() === 'demo' ? '演示模式' : '生产模式'}，数据库 ${modeService.currentDbFile()}）`);
  scheduler.start();
  resumeRealListeners();

  server.listen(config.port, config.host, () => {
    logger.info('app', `HTTP 服务已启动: http://${config.host}:${config.port}（工作台页面）`);
    logger.info('app', `健康检查: http://${config.host}:${config.port}/health`);
    sysLog('info', 'app', `服务启动完成，端口 ${config.port}`);
  });
}

/** 启动时恢复在线真实账号的 WS 消息监听（服务重启后无需手动上线） */
function resumeRealListeners() {
  try {
    const { query } = require('./db');
    const xianyuLive = require('./core/xianyuLive');
    const { sysLog } = require('./services/logs');
    setTimeout(async () => {
      try {
        const rows = await query("SELECT * FROM xy_accounts WHERE status = 'online'");
        let resumed = 0;
        for (const acc of rows) {
          if (/^\d+$/.test(String(acc.account_id)) && acc.cookie && !/(demo=1|demo-cookie-)/.test(String(acc.cookie))) {
            await xianyuLive.startFor(acc);
            resumed++;
          }
        }
        if (resumed > 0) {
          logger.info('app', `已恢复 ${resumed} 个真实账号的消息监听`);
          sysLog('info', 'sync', `服务启动：恢复 ${resumed} 个真实账号的消息监听`);
        }
      } catch (e) {
        logger.warn('app', `恢复消息监听失败（不影响服务）: ${e.message}`);
      }
    }, 2000); // 等数据库/调度器就绪后再恢复
  } catch (_) { /* 忽略恢复失败 */ }
}

let shuttingDown = false;

/** 进程级异常防护：兜底记录但不退出（HTTP 服务继续存活，任务/监听不受未捕获异常拖垮） */
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  logger.error('app', '未处理的 Promise 拒绝（已兜底忽略）: ' + msg.split('\n').slice(0, 3).join(' | '));
});
process.on('uncaughtException', (err) => {
  logger.error('app', '未捕获异常（已兜底忽略）: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)));
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('app', `收到 ${signal}，开始优雅停机…`);
  try {
    scheduler.stop();
    await new Promise((resolve) => server.close(resolve));
    await closePool();
    logger.info('app', '停机完成');
  } catch (e) {
    logger.error('app', '停机异常: ' + e.message);
  }
  process.exit(0);
}

/** 模式切换自重启：优雅停机（释放端口/关闭库）→ 拉起新进程（新进程按新模式打开对应库）→ 退出 */
async function restartForModeSwitch(mode) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('app', `切换到${mode === 'demo' ? '演示' : '生产'}模式：优雅停机并拉起新进程…`);
  // 硬超时兜底：任何一步挂住也保证旧进程退出，让端口让位给新进程
  setTimeout(() => process.exit(0), 5000).unref();
  try {
    scheduler.stop();
    await new Promise((resolve) => {
      server.close(resolve);
      // 立即断开全部 keep-alive 连接：否则长连接会让 server.close() 永久挂起
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    await closePool();
  } catch (e) {
    logger.error('app', '停机异常: ' + e.message);
  }
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: config.root,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    logger.info('app', `新进程已拉起（pid=${child.pid}），当前进程退出`);
  } catch (e) {
    logger.error('app', '拉起新进程失败，请手动重启服务: ' + e.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('app', `未处理的 Promise 拒绝: ${reason && reason.stack ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error('app', `未捕获异常: ${err && err.stack ? err.stack : err}`);
});

main().catch((e) => {
  logger.error('app', `启动失败: ${e && e.stack ? e.stack : e}`);
  console.error(e);
  process.exit(1);
});
