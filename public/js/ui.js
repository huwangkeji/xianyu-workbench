'use strict';
// UI 工具：转义 / 时间 / 徽标 / 提示 / 弹窗 / 危险确认 / 分页
window.WB = window.WB || {};

WB.esc = function (s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
};

WB.fmtTime = function (v) {
  if (!v) return '-';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '-';
  return `${y}${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const BADGE_MAP = {
  online: ['ok', '在线'], offline: ['muted', '离线'], error: ['bad', '异常'], disabled: ['muted', '已禁用'],
  on_sale: ['ok', '在架'], off_sale: ['muted', '下架'],
  available: ['ok', '可用'], locked: ['warn', '锁定'], sold: ['muted', '已售'],
  success: ['ok', '成功'], failed: ['bad', '失败'], running: ['info', '执行中'], never: ['muted', '未执行'],
  filtered: ['warn', '已过滤'], skipped: ['muted', '跳过'],
  sent: ['ok', '已发货'], pending: ['warn', '待发货'], none: ['muted', '无需发货'],
  pending_paid: ['muted', '待付款'], paid: ['info', '已付款'], delivered: ['ok', '已发货'],
  completed: ['muted', '已完成'], closed: ['muted', '已关闭'], refunding: ['warn', '退款中'],
  refunded: ['bad', '已退款'],
  mock: ['info', 'mock'], warn: ['warn', '警告'], danger: ['bad', '危险'], info: ['info', '信息'],
  debug: ['muted', 'debug'], warning: ['warn', '警告'],
  // Cookie 状态
  ok: ['ok', '有效'], expiring: ['warn', '即将过期'], expired: ['bad', '已过期'], unknown: ['muted', '未知'], none: ['muted', '未配置'],
};
WB.badge = function (v, label) {
  const m = BADGE_MAP[v] || ['muted', v];
  return `<span class="badge b-${m[0]}">${WB.esc(label || m[1] || v)}</span>`;
};

WB.toast = function (msg, type) {
  const box = document.getElementById('toast-box');
  const div = document.createElement('div');
  div.className = 'toast ' + (type === 'error' ? 't-error' : type === 'info' ? 't-info' : 't-ok');
  div.textContent = msg;
  box.appendChild(div);
  setTimeout(() => { div.classList.add('show'); }, 10);
  setTimeout(() => {
    div.classList.remove('show');
    setTimeout(() => div.remove(), 300);
  }, 3000);
};

/** 打开表单弹窗。body 为 HTML 字符串（表单元素需带 name）；onSubmit(values) 抛错则留在弹窗 */
WB.openModal = function ({ title, body, wide, onSubmit, hideFoot }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-mask" id="modal-mask">
      <div class="modal ${wide ? 'modal-wide' : ''}">
        <div class="modal-head">
          <span>${WB.esc(title)}</span>
          <button type="button" class="modal-x" id="modal-x">×</button>
        </div>
        <form id="modal-form" class="modal-body">${body}</form>
        ${hideFoot ? '' : `
        <div class="modal-foot">
          <span class="modal-err" id="modal-err"></span>
          <button type="button" class="btn" id="modal-cancel">取消</button>
          <button type="submit" class="btn btn-primary" id="modal-ok" form="modal-form">保存</button>
        </div>`}
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('#modal-x').onclick = close;
  if (hideFoot) {
    root.querySelector('#modal-cancel').onclick = close;
    root.querySelector('#modal-ok').onclick = close;
  } else {
    root.querySelector('#modal-cancel').onclick = close;
    root.querySelector('#modal-mask').addEventListener('click', (e) => { if (e.target.id === 'modal-mask') close(); });
    root.querySelector('#modal-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const values = {};
      for (const el of form.querySelectorAll('input[name], select[name], textarea[name]')) {
        if (el.type === 'checkbox') values[el.name] = el.checked;
        else values[el.name] = el.value;
      }
      const errEl = root.querySelector('#modal-err');
      const okBtn = root.querySelector('#modal-ok');
      errEl.textContent = '';
      okBtn.disabled = true; // 防重：提交期间禁用保存按钮
      const origText = okBtn.textContent;
      okBtn.textContent = '处理中…';
      try {
        await onSubmit(values);
        close();
      } catch (err) {
        errEl.textContent = err.message || String(err);
        okBtn.disabled = false;
        okBtn.textContent = origText;
      }
    });
  }
  return close;
};

// 普通 confirm（模态、非阻塞，替代原生 window.confirm，避免阻塞页面且样式统一）
WB.confirmDialog = function (titleOrText, message) {
  // 兼容两种调用：confirmDialog('消息') / confirmDialog('标题', '详细消息')
  const t = String(titleOrText || '');
  return WB.confirmModal(message ? t : '操作确认', message || t, { confirmText: '确认' });
};

/**
 * 通用确认弹窗（返回 Promise<boolean>）
 * confirmModal(title, message, { confirmText })：message 支持多行（\n 自动换行）
 */
WB.confirmModal = function (title, message, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-mask" id="cm-mask">
        <div class="modal">
          <div class="modal-head"><span>${WB.esc(title)}</span><button type="button" class="modal-x" id="cm-x">×</button></div>
          <div class="modal-body">
            <p class="cm-msg">${WB.esc(String(message || '')).replace(/\n/g, '<br>')}</p>
          </div>
          <div class="modal-foot">
            <button type="button" class="btn" id="cm-cancel">取消</button>
            <button type="button" class="btn btn-primary" id="cm-ok">${WB.esc(opts.confirmText || '确认')}</button>
          </div>
        </div>
      </div>`;
    const done = (v) => { root.innerHTML = ''; resolve(v); };
    root.querySelector('#cm-x').onclick = () => done(false);
    root.querySelector('#cm-cancel').onclick = () => done(false);
    root.querySelector('#cm-mask').addEventListener('click', (e) => { if (e.target.id === 'cm-mask') done(false); });
    root.querySelector('#cm-ok').onclick = () => done(true);
    root.querySelector('#cm-ok').focus();
  });
};

/**
 * 危险操作确认（模态、红按钮、后果列表）。返回 Promise<boolean>。
 * confirmDanger(title, lines[], { confirmText, needText })：
 *   lines: 后果条目（字符串或 {text, danger:true}）
 *   needText: 提供时需在输入框中输入该文字才能确认（高危操作，如级联删除账号）
 */
WB.confirmDanger = function (title, lines, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const need = opts.needText || '';
    root.innerHTML = `
      <div class="modal-mask" id="dg-mask">
        <div class="modal">
          <div class="modal-head"><span>${WB.esc(title)}</span><button type="button" class="modal-x" id="dg-x">×</button></div>
          <div class="modal-body">
            <ul class="dg-list">${(lines || []).map((l) => {
              const t = typeof l === 'string' ? { text: l } : l;
              return `<li class="${t.danger ? 'dg-danger' : ''}">${WB.esc(t.text)}</li>`;
            }).join('')}</ul>
            ${need ? `<label style="margin-top:10px;display:block">请输入 <b>${WB.esc(need)}</b> 以确认：</label><input id="dg-input" autocomplete="off">` : ''}
          </div>
          <div class="modal-foot">
            <button type="button" class="btn" id="dg-cancel">取消</button>
            <button type="button" class="btn btn-danger" id="dg-ok" ${need ? 'disabled' : ''}>${WB.esc(opts.confirmText || '确认删除')}</button>
          </div>
        </div>
      </div>`;
    const done = (v) => { root.innerHTML = ''; resolve(v); };
    root.querySelector('#dg-x').onclick = () => done(false);
    root.querySelector('#dg-cancel').onclick = () => done(false);
    root.querySelector('#dg-mask').addEventListener('click', (e) => { if (e.target.id === 'dg-mask') done(false); });
    const okBtn = root.querySelector('#dg-ok');
    if (need) {
      const input = root.querySelector('#dg-input');
      input.focus();
      input.addEventListener('input', () => { okBtn.disabled = input.value.trim() !== need; });
    }
    okBtn.onclick = () => { if (!need || root.querySelector('#dg-input').value.trim() === need) done(true); };
  });
};

/* ================= 全局选项卡统一样式（自动增强所有原生 <select>） ================= */
/* 原生 select 的下拉弹层无法自定义样式（各系统渲染不一致）。这里把页面上出现的所有
   原生 select 自动替换为统一的 wb-select 样式组件：保留原生 select 于 DOM 中（隐藏），
   点击选项时回写 select.value 并派发 change 事件——既有 onchange/表单收集逻辑全部兼容。 */

let _enhanceScheduled = false;

/** 增强单个原生 select（幂等：已增强的跳过） */
function enhanceOneSelect(sel) {
  if (!sel || sel.dataset.wbEnhanced || sel.tagName !== 'SELECT') return;
  if (sel.multiple || sel.disabled) return;
  if (!sel.options.length) return;
  sel.dataset.wbEnhanced = '1';

  const wrap = document.createElement('span');
  wrap.className = 'wb-select wb-select-enh';
  // 继承原生 select 的布局尺寸
  const cs = getComputedStyle(sel);
  wrap.style.width = cs.width;
  wrap.style.minWidth = cs.minWidth === '0px' ? '120px' : cs.minWidth;
  wrap.style.display = cs.display === 'inline' ? 'inline-block' : cs.display;

  const render = () => {
    const cur = sel.options[sel.selectedIndex] || sel.options[0];
    wrap.innerHTML = `
      <button type="button" class="wb-select-btn">
        <span class="wb-select-label">${WB.esc(cur ? cur.textContent : '')}</span>
        <span class="wb-caret">▾</span>
      </button>
      <div class="wb-select-menu" hidden>
        ${[...sel.options].map((o, idx) => `<div class="wb-select-item${idx === sel.selectedIndex ? ' active' : ''}" data-idx="${idx}">${WB.esc(o.textContent)}</div>`).join('')}
      </div>`;
  };
  render();

  const btn = wrap.querySelector('.wb-select-btn');
  const menu = wrap.querySelector('.wb-select-menu');
  btn.onclick = (e) => {
    e.stopPropagation();
    if (sel.disabled) return;
    const willOpen = menu.hidden;
    WB.closeSelects();
    if (willOpen) {
      menu.hidden = false;
      wrap.classList.add('open');
      const active = menu.querySelector('.wb-select-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
  };
  menu.querySelectorAll('.wb-select-item').forEach((it) => {
    it.onclick = (e) => {
      e.stopPropagation();
      WB.closeSelects();
      const idx = Number(it.dataset.idx);
      if (idx === sel.selectedIndex) { render(); return; }
      sel.selectedIndex = idx;
      render();
      // 同步既有逻辑：派发原生 change 事件（工具栏 onchange、表单收集均依赖）
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
  });
  // select.value 被程序性修改时刷新显示
  sel.addEventListener('change', () => render());
  sel.addEventListener('wb:refresh', () => render());

  sel.classList.add('wb-hidden-native');
  sel.parentNode.insertBefore(wrap, sel);
}

/** 扫描容器内所有未增强的原生 select */
WB.enhanceSelects = function (root) {
  const scope = root || document;
  scope.querySelectorAll('select:not(.wb-hidden-native)').forEach(enhanceOneSelect);
};

/** DOM 变化时自动增强新增的 select（页面重绘/弹窗打开均覆盖） */
const _selectObserver = new MutationObserver(() => {
  if (_enhanceScheduled) return;
  _enhanceScheduled = true;
  queueMicrotask(() => {
    _enhanceScheduled = false;
    WB.enhanceSelects(document.getElementById('root') || document);
    const modal = document.getElementById('modal-root');
    if (modal) WB.enhanceSelects(modal);
  });
});

/** 启动全局选项卡增强（app.js 启动时调用一次） */
WB.startSelectEnhancer = function () {
  WB.enhanceSelects(document);
  _selectObserver.observe(document.body, { childList: true, subtree: true });
};

/** 分页控件：渲染到 el，onPage(newPage)。页码钳制：删除末页最后一条后自动回跳有效页 */
WB.paginate = function (el, total, page, pageSize, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, page), pages); // 钳制
  el.innerHTML = `
    <span class="pg-info">共 ${total} 条 / ${pages} 页</span>
    <button class="btn btn-sm" id="pg-prev" ${cur <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="pg-info">${cur} / ${pages}</span>
    <button class="btn btn-sm" id="pg-next" ${cur >= pages ? 'disabled' : ''}>下一页</button>`;
  el.querySelector('#pg-prev').onclick = () => onPage(cur - 1);
  el.querySelector('#pg-next').onclick = () => onPage(cur + 1);
};

/* ================= 自定义下拉选择（替代原生 select 弹层，跟随主题） ================= */

/** 关闭所有打开的下拉 */
WB.closeSelects = function () {
  document.querySelectorAll('.wb-select-menu').forEach((m) => {
    m.hidden = true;
    if (m.parentElement) m.parentElement.classList.remove('open');
  });
};
document.addEventListener('click', () => WB.closeSelects());

/**
 * 在宿主元素内渲染自定义下拉。
 * @param {HTMLElement} host 宿主（span/div，由页面 innerHTML 预留）
 * @param {{options:[{v,label}], value:string|number, placeholder?:string, width?:string, onChange?:(v)=>void}} cfg
 */
WB.select = function (host, cfg) {
  if (!host) return null;
  const options = (cfg.options || []).map((o) => ({ v: String(o.v), label: String(o.label) }));
  const cur = options.find((o) => o.v === String(cfg.value === undefined || cfg.value === null ? '' : cfg.value));
  host.classList.add('wb-select');
  if (cfg.width) host.style.width = cfg.width;
  host.innerHTML = `
    <button type="button" class="wb-select-btn">
      <span class="wb-select-label">${WB.esc(cur ? cur.label : (cfg.placeholder || '请选择'))}</span>
      <span class="wb-caret">▾</span>
    </button>
    <div class="wb-select-menu" hidden>
      ${options.map((o) => `<div class="wb-select-item${o.v === String(cfg.value === undefined || cfg.value === null ? '' : cfg.value) ? ' active' : ''}" data-v="${WB.esc(o.v)}">${WB.esc(o.label)}</div>`).join('')}
    </div>`;
  const btn = host.querySelector('.wb-select-btn');
  const label = host.querySelector('.wb-select-label');
  const menu = host.querySelector('.wb-select-menu');
  btn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    WB.closeSelects();
    if (willOpen) {
      menu.hidden = false;
      host.classList.add('open');
      // 展开时让当前选中项滚入视野
      const active = menu.querySelector('.wb-select-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
  };
  menu.querySelectorAll('.wb-select-item').forEach((it) => {
    it.onclick = (e) => {
      e.stopPropagation();
      WB.closeSelects();
      menu.querySelectorAll('.wb-select-item').forEach((x) => x.classList.remove('active'));
      it.classList.add('active');
      label.textContent = (options.find((o) => o.v === it.dataset.v) || {}).label || it.textContent;
      if (cfg.onChange) cfg.onChange(it.dataset.v);
    };
  });
  return { host, getValue: () => (menu.querySelector('.wb-select-item.active') || {}).dataset ? menu.querySelector('.wb-select-item.active').dataset.v : String(cfg.value === undefined ? '' : cfg.value) };
};

WB.options = function (list, valueKey, labelFn, selected) {
  return list.map((v) =>
    `<option value="${WB.esc(v[valueKey])}" ${String(v[valueKey]) === String(selected === undefined || selected === null ? '' : selected) ? 'selected' : ''}>${WB.esc(labelFn(v))}</option>`
  ).join('');
};

WB.table = function (headers, rowsHtml) {
  return `<div class="table-wrap"><table class="tbl">
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="9" class="empty-cell">暂无数据</td></tr>'}</tbody></table></div>`;
};

/**
 * 零依赖 SVG 折线图（多条系列）。
 * sparkline({ width, height, series: [{ label, color, data: [{x, y}] }] })
 * 返回 SVG 字符串；x 为类目文本（等距分布），y 为数值。
 */
WB.lineChart = function ({ width = 560, height = 180, series }) {
  const all = (series || []).flatMap((s) => s.data || []);
  if (!all.length) return '<div class="empty">暂无图表数据</div>';
  const dark = document.documentElement.classList.contains('dark');
  const gridColor = dark ? '#2b3440' : '#e6eaf1';
  const textColor = dark ? '#8a94a2' : '#9aa5b1';
  const labels = all.map((p) => p.x);
  const n = labels.length;
  const maxV = Math.max(1, ...all.map((p) => Number(p.y) || 0));
  const padL = 44, padR = 12, padT = 14, padB = 24;
  const W = Math.max(width, padL + padR + n * 30);
  const innerW = W - padL - padR;
  const innerH = height - padT - padB;
  const xAt = (i) => padL + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const yAt = (v) => padT + innerH - ((Number(v) || 0) / maxV) * innerH;
  const gridY = [0, 0.5, 1].map((f) => padT + innerH - f * innerH);
  let svg = `<svg viewBox="0 0 ${W} ${height}" style="width:100%;max-width:${W}px;display:block">`;
  for (const [i, gy] of gridY.entries()) {
    svg += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${gridColor}" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${gy + 4}" text-anchor="end" font-size="10" fill="${textColor}">${Math.round(maxV * [1, 0.5, 0][i])}</text>`;
  }
  const step = Math.max(1, Math.ceil(n / 12));
  labels.forEach((lb, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    svg += `<text x="${xAt(i)}" y="${height - 6}" text-anchor="middle" font-size="10" fill="${textColor}">${escHtml(lb)}</text>`;
  });
  for (const s of series || []) {
    if (!s.data || !s.data.length) continue;
    const pts = s.data.map((p, i) => `${xAt(i)},${yAt(p.y)}`).join(' ');
    svg += `<polyline points="${pts}" fill="none" stroke="${s.color || '#2f6fed'}" stroke-width="2" stroke-linejoin="round"/>`;
    for (let i = 0; i < s.data.length; i++) {
      svg += `<circle cx="${xAt(i)}" cy="${yAt(s.data[i].y)}" r="2.5" fill="${s.color || '#2f6fed'}"><title>${escHtml(s.data[i].x)}: ${s.data[i].y}</title></circle>`;
    }
  }
  svg += '</svg>';
  const legend = (series || []).filter((s) => s.data && s.data.length).map((s) =>
    `<span style="margin-right:12px"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color};margin-right:4px"></span>${escHtml(s.label)}</span>`).join('');
  return `<div style="overflow-x:auto">${svg}</div><div class="hint" style="margin-top:4px">${legend}</div>`;
};
