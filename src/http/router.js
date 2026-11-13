'use strict';
// 极简路由：支持 'GET /api/v1/accounts/:id' 形式的路径参数
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts) {
    const keys = [];
    const regexStr = '^' + pattern.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (m, k) => {
      keys.push(k);
      return '/([^/]+)';
    }) + '/?$';
    this.routes.push({
      method,
      pattern,
      regex: new RegExp(regexStr),
      keys,
      handler,
      public: !!(opts && opts.public),
    });
  }

  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }

  /** 该路径是否存在（不管方法），用于 404/405 提示 */
  hasPath(pathname) {
    return this.routes.some((r) => r.regex.test(pathname));
  }
}

module.exports = { Router };
