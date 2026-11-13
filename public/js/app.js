'use strict';
// 路由与启动（含移动端抽屉导航）
window.WB = window.WB || {};

// 侧边导航（合并后 5 组）：流量+市场 → 数据分析；优化并入商品中心；售后并入订单管理
const NAV_GROUPS = [
  { label: '经营总览', items: [['cockpit', '经营驾驶舱', '🚀'], ['profit', '利润中心', '💰'], ['analytics', '流量与市场', '📈']] },
  { label: '商品与订单', items: [['items', '商品中心', '📦'], ['cards', '卡券库存', '🎟️'], ['orders', '订单管理', '🧾']] },
  { label: '消息与客户', items: [['messages', '消息会话', '💬'], ['rules', '自动回复', '🤖'], ['crm', '客户中心', '👥']] },
  { label: '自动化', items: [['tasks', '定时任务', '⏰'], ['notify', '通知中心', '🔔'], ['ai', 'AI 控制台', '🧠'], ['logs', '日志中心', '📋']] },
  { label: '系统', items: [['accounts', '账号管理', '👤'], ['riskcenter', '风险中心', '🛡️'], ['settings', '系统设置', '⚙️'], ['simulate', '演示模式', '🧪']] },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items); // 兼容旧引用（路由表）

// 旧路由 → 新路由 + 子页签（兼容收藏的旧地址）
const ROUTE_MAP = { dashboard: 'cockpit', traffic: 'analytics', market: 'analytics', optimizer: 'items', aftersale: 'orders' };
const SUB_MAP = { traffic: 'traffic', market: 'market', optimizer: 'optimizer', aftersale: 'aftersale' };

WB.timers = [];

function clearTimers() {
  for (const t of WB.timers) clearInterval(t);
  WB.timers = [];
  if (WB._badgeTimer) { clearInterval(WB._badgeTimer); WB._badgeTimer = null; }
}

function parseRoute() {
  const raw = (location.hash.replace(/^#\/?/, '') || 'cockpit').split('/')[0];
  const mapped = ROUTE_MAP[raw] || raw;
  if (SUB_MAP[raw]) sessionStorage.setItem('wb_tab_' + mapped, SUB_MAP[raw]); // 旧地址带出目标子页签
  return mapped;
}
function currentRoute() {
  return parseRoute();
}

function renderLogin() {
  clearTimers();
  document.getElementById('root').innerHTML = `
    <div class="login-wrap">
      <div class="login-left">
        <div class="login-brand">
          <span class="login-logo">🐟</span>
          <div>
            <h1>闲鱼自动化工作台</h1>
            <p>多账号运营 · 智能回复 · 数据驱动</p>
          </div>
        </div>
        <div class="login-hero">
          <h2>让 AI 替你盯店<br>回复、发货、擦亮全自动</h2>
          <p>从买家咨询自动回复、虚拟商品卡密秒发，到流量分析与经营诊断，全流程自动化，稳定可靠的店铺运营流水线。</p>
        </div>
        <div class="login-cards">
          <div class="login-featcard"><b>🤖 自动回复</b><span>关键词规则命中 · 随机延迟防风控 · AI 兜底</span></div>
          <div class="login-featcard"><b>📦 自动发货</b><span>虚拟商品卡密秒发 · 失败自动补发</span></div>
          <div class="login-featcard"><b>📈 经营分析</b><span>流量漏斗 · 利润核算 · 市场行情雷达</span></div>
          <div class="login-featcard"><b>🛡️ 风控与通知</b><span>频率拦截留痕 · 事件多渠道推送</span></div>
        </div>
        <div class="login-copy">© 2026 闲鱼自动化工作台 · 仅供学习研究，请遵守平台规则</div>
      </div>
      <div class="login-right">
        <div class="login-box">
          <div class="login-brand-mini">🐟 闲鱼自动化工作台</div>
          <h2>欢迎登录</h2>
          <p class="login-sub2">请输入账号密码进入工作台</p>
          <label>用户名</label>
          <input id="login-user" value="admin" autocomplete="username">
          <label>密码</label>
          <div class="pw-wrap">
            <input id="login-pass" type="password" value="" autocomplete="current-password">
            <button type="button" class="pw-eye" id="pw-eye" title="显示/隐藏密码">👁</button>
          </div>
          <button class="btn btn-primary btn-block" id="login-btn">登 录</button>
          <p class="login-err" id="login-err"></p>
          <div class="login-forgot" id="forgot-pw">❓ 忘记密码？</div>
          <p class="login-tip" id="login-tip"></p>
          <p class="login-lock-hint">连续登录失败将临时锁定，请妥善保管登录密码</p>
        </div>
      </div>
    </div>`;
  // 演示模式提示（公开端点，不带任何敏感信息）
  fetch('/api/v1/system/mode/public', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    if (j && j.data && j.data.mode === 'demo') {
      const tip = document.getElementById('login-tip');
      tip.innerHTML = '<span class="demo-pill">🎬 演示模式</span> 当前运行在独立演示数据库，可在工作台内一键切回生产模式';
    }
  }).catch(() => { });
  // 密码可见性切换
  const passInput = document.getElementById('login-pass');
  document.getElementById('pw-eye').onclick = () => {
    passInput.type = passInput.type === 'password' ? 'text' : 'password';
  };
  // 忘记密码：提示重置方式
  document.getElementById('forgot-pw').onclick = () => {
    const err = document.getElementById('login-err');
    err.textContent = '请联系管理员重置密码（服务器可执行：node scripts/reset-password.js）';
  };
  const doLogin = async () => {
    const u = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value;
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const r = await WB.api('POST', '/api/v1/auth/login', { username: u, password: p });
      WB.setToken(r.token);
      WB.user = r.user;
      location.hash = '#/cockpit';
      renderShell();
      WB.renderPage();
      startBadgePolling();
    } catch (e) {
      document.getElementById('login-err').textContent = e.message;
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  };
  document.getElementById('login-btn').onclick = doLogin;
  document.getElementById('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

function closeNav() { document.body.classList.remove('nav-open'); }

/** 暗色模式切换（记忆于 localStorage，CSS 通过 html.dark 覆盖） */
function applyTheme() {
  const dark = localStorage.getItem('wb_dark') === '1';
  document.documentElement.classList.toggle('dark', dark);
  document.querySelectorAll('.theme-btn').forEach((b) => { b.textContent = dark ? '☀️' : '🌙'; b.title = dark ? '切换亮色模式' : '切换暗色模式'; });
}
function toggleTheme() {
  localStorage.setItem('wb_dark', localStorage.getItem('wb_dark') === '1' ? '0' : '1');
  applyTheme();
}

function renderShell() {
  const route = currentRoute();
  const navItem = NAV.find(([id]) => id === route);
  document.getElementById('root').innerHTML = `
    <aside class="sidebar" id="sidebar">
      <div class="logo logo-row"><span>🐟 闲鱼工作台</span><button class="theme-btn" id="theme-btn-side" title="切换暗色模式">🌙</button></div>
      <div class="acct-switch" id="acct-switch">
        <div class="nav-group-label">当前账号</div>
        <button type="button" class="acct-current" id="acct-current" title="点击切换账号">
          <span class="acct-avatar" id="acct-avatar">🌐</span>
          <span class="acct-name" id="acct-name">全部账号</span>
          <span class="acct-caret">▾</span>
        </button>
        <div class="acct-menu" id="acct-menu" hidden></div>
      </div>
      <nav id="side-nav">${NAV_GROUPS.map((g) => `
        <div class="nav-group"><div class="nav-group-label">${escHtml(g.label)}</div>
        ${g.items.map(([id, label, icon]) => `
          <a href="#/${id}" data-route="${id}" class="${id === route ? 'active' : ''}">
            <span class="nav-ico">${icon}</span><span class="nav-label">${escHtml(label)}</span>
            ${id === 'messages' ? '<span class="nav-badge" id="unread-badge" style="display:none"></span>' : ''}
          </a>`).join('')}
        </div>`).join('')}
      </nav>
      <div class="user-area">
        <div class="user-chip" id="user-chip" title="点击修改密码">👤 ${escHtml(WB.user ? WB.user.display_name || WB.user.username : '')}</div>
        <button class="btn btn-sm btn-block" id="logout-btn">退出登录</button>
      </div>
    </aside>
    <div class="nav-overlay" id="nav-overlay"></div>
    <div class="main-wrap">
      <header class="topbar">
        <button class="btn btn-sm" id="nav-toggle" aria-label="菜单">☰</button>
        <span class="tb-title">${escHtml(navItem ? navItem[1] : '')}</span>
        <button class="theme-btn" id="theme-btn-top" title="切换暗色模式">🌙</button>
      </header>
      <main id="view" class="content"></main>
    </div>`;
  document.getElementById('logout-btn').onclick = async () => {
    try { await WB.api('POST', '/api/v1/auth/logout', {}); } catch (_) { /* ignore */ }
    WB.setToken('');
    renderLogin();
  };
  // 修改密码
  document.getElementById('user-chip').onclick = () => passwordModal();
  // 暗色模式切换
  applyTheme();
  ['theme-btn-side', 'theme-btn-top'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.onclick = toggleTheme;
  });
  // 全局账号切换（自定义下拉）
  WB.refreshAccountSwitcher();
  const acctBtn = document.getElementById('acct-current');
  if (acctBtn) acctBtn.onclick = (e) => { e.stopPropagation(); toggleAcctMenu(); };
  // 移动端抽屉
  document.getElementById('nav-toggle').onclick = () => document.body.classList.toggle('nav-open');
  document.getElementById('nav-overlay').onclick = closeNav;
  document.querySelectorAll('#side-nav a').forEach((a) => {
    a.onclick = () => {
      document.querySelectorAll('#side-nav a').forEach((x) => x.classList.remove('active'));
      a.classList.add('active');
      closeNav();
      const t = NAV.find(([id]) => id === a.dataset.route);
      const tb = document.querySelector('.tb-title');
      if (tb && t) tb.textContent = t[1];
    };
  });
}

function escHtml(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 修改密码弹窗 */
function passwordModal() {
  WB.openModal({
    title: '修改登录密码',
    body: `
      <label>原密码 <i class="req">*</i></label><input name="old_password" type="password" required>
      <label>新密码（至少 6 位）<i class="req">*</i></label><input name="new_password" type="password" required>
      <label>确认新密码 <i class="req">*</i></label><input name="new_password2" type="password" required>`,
    onSubmit: async (v) => {
      if (v.new_password !== v.new_password2) throw new Error('两次输入的新密码不一致');
      const r = await WB.api('POST', '/api/v1/auth/password', { old_password: v.old_password, new_password: v.new_password });
      WB.toast(`密码已修改（其它登录会话已失效 ${r.other_sessions_removed} 个）`);
    },
  });
}

/** 全局账号切换器（自定义下拉，匹配侧栏暗色主题）：当前选中账号（localStorage 记忆）+ 默认账号（系统设置）回填 */
// localStorage('wb_active_account')：null=首次进入（回填默认账号）；''=用户明确选择"全部账号"；其它=账号 ID
WB.activeAccountId = localStorage.getItem('wb_active_account') || '';
WB._acctNeedBackfill = localStorage.getItem('wb_active_account') === null;
WB.defaultAccountId = '0';
WB.accountList = [];

const STATUS_LABEL = { online: '在线', offline: '离线', error: '异常', disabled: '已禁用' };

function acctMenuOpen() {
  const menu = document.getElementById('acct-menu');
  const wrap = document.getElementById('acct-switch');
  if (!menu || !wrap) return false;
  return !menu.hidden && wrap.classList.contains('open');
}

function toggleAcctMenu(force) {
  const menu = document.getElementById('acct-menu');
  const wrap = document.getElementById('acct-switch');
  if (!menu || !wrap) return;
  const open = typeof force === 'boolean' ? force : menu.hidden;
  menu.hidden = !open;
  wrap.classList.toggle('open', open);
}

// 点击面板其它区域 / Esc 关闭下拉（全局只注册一次）
document.addEventListener('click', (e) => {
  if (!acctMenuOpen()) return;
  if (e.target.closest && e.target.closest('#acct-switch')) return;
  toggleAcctMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && acctMenuOpen()) toggleAcctMenu(false);
});

/** 选中账号在菜单中的行（含状态点/默认徽标/在线状态） */
function acctMenuItemHtml(a, active) {
  return `<button type="button" class="acct-item${active ? ' active' : ''}" data-val="${escHtml(a.id)}">
    <span class="acct-dot ${escHtml(a.status || 'offline')}"></span>
    <span class="acct-item-name" title="${escHtml(a.nickname || a.account_id)}">${escHtml(a.nickname || a.account_id)}</span>
    ${a.is_default ? '<span class="acct-def">默认</span>' : ''}
    <span class="acct-status">${escHtml(STATUS_LABEL[a.status] || '离线')}</span>
  </button>`;
}

WB.refreshAccountSwitcher = async function () {
  const trigger = document.getElementById('acct-current');
  if (!trigger) return;
  try {
    const [accounts, settings] = await Promise.all([
      WB.get('/api/v1/accounts?page_size=200'),
      WB.get('/api/v1/settings'),
    ]);
    WB.accountList = accounts.list || [];
    const def = (settings.find ? settings.find((x) => x.key === 'default_account_id') : null);
    WB.defaultAccountId = String((def && def.value) || '0');
    // 仅首次进入（从未选择过）时回填默认账号；用户明确选的"全部账号"（''）不回填
    if (WB._acctNeedBackfill) {
      WB._acctNeedBackfill = false;
      if (WB.defaultAccountId !== '0') {
        WB.activeAccountId = WB.defaultAccountId;
        localStorage.setItem('wb_active_account', WB.activeAccountId);
      }
    }
    const acc = WB.accountList.find((x) => String(x.id) === WB.activeAccountId);
    if (!acc && WB.activeAccountId !== '') { // 选中的账号已被删除 → 回落到默认/全部
      WB.activeAccountId = WB.defaultAccountId !== '0' ? WB.defaultAccountId : '';
      localStorage.setItem('wb_active_account', WB.activeAccountId);
    }
    // 触发器：当前账号名 + 头像
    const cur = acc;
    document.getElementById('acct-avatar').textContent = cur ? '👤' : '🌐';
    document.getElementById('acct-name').textContent = cur ? (cur.nickname || cur.account_id) : '全部账号';
    trigger.title = cur
      ? `当前账号：${cur.nickname || cur.account_id}（${STATUS_LABEL[cur.status] || '离线'}）· 点击切换`
      : '当前查看全部账号 · 点击切换';
    // 菜单：全部账号 + 账号列表（状态点 + 默认徽标）
    const menu = document.getElementById('acct-menu');
    menu.innerHTML = `<button type="button" class="acct-item${WB.activeAccountId === '' ? ' active' : ''}" data-val="">
        <span class="acct-dot all"></span><span class="acct-item-name">🌐 全部账号</span>
        <span class="acct-hint">汇总视图</span>
      </button>`
      + WB.accountList.map((a) => acctMenuItemHtml(a, String(a.id) === WB.activeAccountId)).join('');
    menu.querySelectorAll('.acct-item').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        toggleAcctMenu(false);
        if (btn.dataset.val !== WB.activeAccountId) switchAccount(btn.dataset.val);
      };
    });
  } catch (_) { /* 接口异常时保持现状 */ }
};

WB.getActiveAccountId = function () {
  return WB.activeAccountId || '';
};

function switchAccount(val) {
  WB.activeAccountId = String(val || '');
  localStorage.setItem('wb_active_account', WB.activeAccountId);
  // 清空页内筛选状态（dataset 会被各页面用来恢复筛选），避免旧筛选覆盖全局账号
  const view = document.getElementById('view');
  if (view) for (const k of Object.keys(view.dataset)) delete view.dataset[k];
  WB.refreshAccountSwitcher(); // 立即更新触发器文案与选中行
  WB.renderPage();
  const acc = WB.accountList.find((x) => String(x.id) === WB.activeAccountId);
  WB.toast(acc ? `已切换到账号「${acc.nickname || acc.account_id}」` : '已切换到全部账号（汇总视图）', 'info');
}


function startBadgePolling() {
  if (WB._badgeTimer) clearInterval(WB._badgeTimer);
  const refresh = async () => {
    try {
      const r = await WB.api('GET', '/api/v1/conversations/unread-summary');
      const el = document.getElementById('unread-badge');
      if (!el) return;
      const n = Number(r.total_unread) || 0;
      el.style.display = n > 0 ? '' : 'none';
      el.textContent = n > 99 ? '99+' : String(n);
    } catch (_) { /* 静默 */ }
  };
  refresh();
  WB._badgeTimer = setInterval(refresh, 30000);
}

WB.renderPage = async function () {
  clearTimers();
  const route = currentRoute();
  const c = document.getElementById('view');
  if (!c) return;
  // 切页时关闭遗留弹窗（避免弹窗叠加在新页面上）
  const mr = document.getElementById('modal-root');
  if (mr) mr.innerHTML = '';
  const navItem = NAV.find(([id]) => id === route);
  const tb = document.querySelector('.tb-title');
  if (tb && navItem) tb.textContent = navItem[1];
  // 模块化按需加载：路由 → 页面模块（common 常驻，业务域模块首次访问时加载一次）
  if (route !== 'login') {
    try {
      await WB.loadModule(ROUTE_MODULES[route] || 'shop');
    } catch (e) {
      c.innerHTML = `<div class="loading">${escHtml(e.message)}</div>`;
      return;
    }
  }
  if (!(WB.PAGES && WB.PAGES[route])) {
    c.innerHTML = `<div class="loading">页面不存在</div>`;
    return;
  }
  c.innerHTML = `<div class="loading">加载中…</div>`;
  try {
    await WB.PAGES[route](c);
    startBadgePolling(); // 页面切换后保持角标活跃
  } catch (e) {
    c.innerHTML = `<div class="loading">加载失败: ${escHtml(e.message)}</div>`;
  }
};

/* ================= 页面模块懒加载（模块化 MVC 视图层） ================= */
/* common 常驻（共享助手），业务域模块按路由首次访问时加载一次，之后走浏览器缓存 */

const ROUTE_MODULES = {
  cockpit: 'analyze', profit: 'analyze', analytics: 'analyze', traffic: 'analyze', market: 'analyze', optimizer: 'analyze',
  items: 'shop', cards: 'shop', orders: 'shop', aftersale: 'shop',
  messages: 'msg', rules: 'msg', crm: 'msg',
  tasks: 'system', notify: 'system', ai: 'system', logs: 'system', accounts: 'system', riskcenter: 'system', settings: 'system', simulate: 'system',
};
const LOADED_MODULES = new Set(['common']);
const MODULE_LOADERS = {};

WB.loadModule = function (name) {
  if (LOADED_MODULES.has(name)) return Promise.resolve();
  if (!MODULE_LOADERS[name]) {
    MODULE_LOADERS[name] = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = `js/pages/${name}.js?v=3.1`;
      sc.onload = () => { LOADED_MODULES.add(name); resolve(); };
      sc.onerror = () => { delete MODULE_LOADERS[name]; reject(new Error('页面模块加载失败: ' + name)); };
      document.head.appendChild(sc);
    });
  }
  return MODULE_LOADERS[name];
};

/** 跨模块子页签的延迟渲染器（如 商品中心→商品优化 属 analyze 模块） */
WB.lazyPage = function (module, key) {
  return async (c) => {
    await WB.loadModule(module);
    return WB.PAGES[key](c);
  };
};

WB.onUnauthorized = function () {
  clearTimers();
  WB.setToken('');
  renderLogin();
};

document.addEventListener('DOMContentLoaded', async () => {
  // 全局选项卡统一样式：所有原生 <select> 自动替换为 wb-select 组件（含动态页面/弹窗）
  WB.startSelectEnhancer();
  if (WB.token) {
    // 用已有 token 拉取当前用户信息（失败则回登录页）
    try {
      WB.user = await WB.api('GET', '/api/v1/auth/me');
      renderShell();
      WB.renderPage();
      startBadgePolling();
      return;
    } catch (e) {
      if (e.code !== 40101) { /* 非鉴权错误也回登录页（token 无法证明身份） */ }
    }
  }
  renderLogin();
});
window.addEventListener('hashchange', () => WB.renderPage());
