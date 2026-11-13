'use strict';
// API 请求封装
window.WB = window.WB || {};
WB.token = localStorage.getItem('wb_token') || '';
WB.user = null;

WB.setToken = function (t) {
  WB.token = t || '';
  if (t) localStorage.setItem('wb_token', t);
  else localStorage.removeItem('wb_token');
};

WB.api = async function (method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (WB.token) headers['Authorization'] = 'Bearer ' + WB.token;
  let resp;
  try {
    resp = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('网络错误：' + e.message);
  }
  let data = null;
  try { data = await resp.json(); } catch (_) { data = null; }
  if (!data) throw new Error('响应解析失败（HTTP ' + resp.status + '）');
  if (!data.success) {
    if (data.code === 40101 && WB.onUnauthorized) WB.onUnauthorized();
    const err = new Error(data.message || ('业务错误 ' + data.code));
    err.code = data.code;
    err.data = data.data;
    throw err;
  }
  return data.data;
};

WB.get = (p) => WB.api('GET', p);
WB.post = (p, b) => WB.api('POST', p, b || {});
WB.put = (p, b) => WB.api('PUT', p, b || {});
WB.del = (p) => WB.api('DELETE', p);
