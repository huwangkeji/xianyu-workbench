'use strict';
// 此文件由 pages.js 模块化拆分生成（MVC 视图层按业务域分模块，app.js 按路由懒加载）
// common：全局共享助手（常驻加载；页面模块通过全局作用域引用）
const PAGES = {};
WB.PAGES = PAGES; // 供 app.js 路由分发
const esc = WB.esc, fmt = WB.fmtTime, badge = WB.badge, opts = WB.options, table = WB.table;

function pageHead(title, extra) {
  return `<div class="page-head"><h2>${esc(title)}</h2><div class="page-actions">${extra || ''}</div></div>`;
}

/** 全局账号过滤：侧栏切换器选中的账号自动附加到支持 account_id 的查询 */
function accQ() {
  return WB.activeAccountId ? '&account_id=' + encodeURIComponent(WB.activeAccountId) : '';
}

async function loadAccounts() {
  const r = await WB.get('/api/v1/accounts?page_size=200');
  return r.list || [];
}
async function loadItems() {
  const r = await WB.get('/api/v1/items?page_size=200');
  return r.list || [];
}

/* ================= 账号管理 ================= */

async function switchModeWithRestart(mode) {
  const label = mode === 'demo' ? '演示模式' : '生产模式';
  if (!(await WB.confirmDialog(`切换到${label}`, '服务将自动重启并清除登录状态，需要重新登录。确认继续？'))) return;
  try {
    WB.toast(`正在切换到${label}，服务重启中…`, 'info');
    await WB.post('/api/v1/system/mode', { mode });
    await waitServiceRestart(0);
  } catch (e) {
    WB.toast('切换失败: ' + e.message, 'error');
  }
}

async function waitServiceRestart(n) {
  if (n > 30) {
    WB.toast('等待重启超时，请稍后手动刷新页面', 'error');
    return;
  }
  await new Promise((r) => setTimeout(r, 1500));
  try {
    await fetch('/health', { cache: 'no-store' });
    localStorage.removeItem('wb_token'); // 服务已重启，回到登录页重新登录
    location.reload();
  } catch (_) {
    await waitServiceRestart(n + 1);
  }
}

/* ================= 自动回复规则 ================= */

/* 合并页包装器：一页多签（状态记忆在 sessionStorage，旧地址经路由映射带入） */
function subTabPage(c, route, tabs, pages) {
  let active = sessionStorage.getItem('wb_tab_' + route) || tabs[0][0];
  if (!tabs.some(([k]) => k === active)) active = tabs[0][0];
  const render = async () => {
    c.innerHTML = `
      <div class="tabs">
        ${tabs.map(([k, label]) => `<button class="tab-btn ${active === k ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}
      </div>
      <div id="sub-view"></div>`;
    c.querySelectorAll('.tab-btn').forEach((b) => {
      b.onclick = () => { active = b.dataset.tab; sessionStorage.setItem('wb_tab_' + route, active); render(); };
    });
    await pages[active](c.querySelector('#sub-view'));
  };
  return render();
}

function findingsHtml(list) {
  if (!list || !list.length) return '<div class="empty">✅ 未发现问题</div>';
  return list.map((f) => `<div class="diag-item sev-${f.severity === 'high' ? 'high' : f.severity === 'medium' ? 'medium' : 'low'}">
    <div>${badge(f.severity === 'high' ? 'failed' : f.severity === 'medium' ? 'warning' : 'info', f.severity === 'high' ? '高' : f.severity === 'medium' ? '中' : '低')}
      ${f.area ? `【${esc(f.area)}】` : ''}${esc(f.message)}</div>
    ${f.suggestion ? `<div class="diag-tip">💡 ${esc(f.suggestion)}</div>` : ''}
  </div>`).join('');
}

function showInfoModal(title, bodyHtml) {
  WB.openModal({ title, wide: true, body: bodyHtml + '<div></div>', onSubmit: async () => {} });
  document.querySelector('#modal-ok').textContent = '关闭';
}
