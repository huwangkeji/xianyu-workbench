'use strict';
// 统一响应（ok/fail/分页），大负载自动 gzip（零依赖 zlib）
const zlib = require('zlib');
// 统一响应与参数校验
// 响应格式与上游项目约定一致：{ success, code, message, data }，
// 业务错误同样返回 HTTP 200，由 success/code 区分（见 docs/03-接口约定.md）。
const CODE = {
  OK: 200,
  BAD_REQUEST: 40001,     // 参数错误
  NOT_FOUND: 40002,       // 资源不存在
  BIZ_FAIL: 40003,        // 业务校验失败
  CONFLICT: 40004,        // 状态冲突
  UNAUTHORIZED: 40101,    // 未登录 / 令牌失效
  FORBIDDEN: 40301,       // 无权限
  INTERNAL: 50001,        // 服务器内部错误
  NOT_IMPLEMENTED: 50101, // 预留扩展点未实现（如真实闲鱼连接器）
};

class ApiError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.data = data === undefined ? null : data;
  }
}

function sendJson(res, payload) {
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
  if (body.length > 1024 && /\bgzip\b/.test(accept)) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(zlib.gzipSync(Buffer.from(body, 'utf8')));
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}

function ok(res, data, message) {
  sendJson(res, { success: true, code: CODE.OK, message: message || '操作成功', data: data === undefined ? null : data });
}

function fail(res, code, message, data) {
  sendJson(res, { success: false, code, message, data: data || null });
}

function isApiError(e) {
  return e instanceof ApiError;
}

/** 读取并解析 JSON 请求体 */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limitBytes || 2 * 1024 * 1024)) {
        reject(new ApiError(CODE.BAD_REQUEST, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_) {
        reject(new ApiError(CODE.BAD_REQUEST, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------- 校验工具 ----------------

function assert(condition, message) {
  if (!condition) throw new ApiError(CODE.BAD_REQUEST, message);
}

function str(v, name, opts) {
  opts = opts || {};
  if (v === undefined || v === null) {
    if (opts.required) throw new ApiError(CODE.BAD_REQUEST, `缺少参数 ${name}`);
    return opts.default !== undefined ? opts.default : '';
  }
  const s = String(v).trim();
  if (opts.required && !s) throw new ApiError(CODE.BAD_REQUEST, `参数 ${name} 不能为空`);
  if (opts.max && s.length > opts.max) throw new ApiError(CODE.BAD_REQUEST, `参数 ${name} 超长（最大 ${opts.max} 字符）`);
  return s;
}

function int(v, name, opts) {
  opts = opts || {};
  const def = opts.default !== undefined ? opts.default : 0;
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw new ApiError(CODE.BAD_REQUEST, `缺少参数 ${name}`);
    return def;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new ApiError(CODE.BAD_REQUEST, `参数 ${name} 必须是整数`);
  if (opts.min !== undefined && n < opts.min) throw new ApiError(CODE.BAD_REQUEST, `参数 ${name} 不能小于 ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new ApiError(CODE.BAD_REQUEST, `参数 ${name} 不能大于 ${opts.max}`);
  return n;
}

function bool(v, name, def) {
  if (v === undefined || v === null || v === '') return !!def;
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  throw new ApiError(CODE.BAD_REQUEST, `参数 ${name} 必须是布尔值`);
}

function enumOf(v, name, values, opts) {
  opts = opts || {};
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw new ApiError(CODE.BAD_REQUEST, `缺少参数 ${name}`);
    return opts.default !== undefined ? opts.default : null;
  }
  if (!values.includes(v)) throw new ApiError(CODE.BAD_REQUEST, `参数 ${name} 必须是 ${values.join('/')} 之一`);
  return v;
}

/** 分页参数，query 为 URLSearchParams */
function pageOf(query) {
  const page = int(query.get('page'), 'page', { default: 1, min: 1 });
  const pageSize = int(query.get('page_size'), 'page_size', { default: 20, min: 1, max: 200 });
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function paged(list, total, pg) {
  return { list, total, page: pg.page, page_size: pg.pageSize };
}

module.exports = { CODE, ApiError, ok, fail, sendJson, isApiError, readBody, assert, str, int, bool, enumOf, pageOf, paged };
