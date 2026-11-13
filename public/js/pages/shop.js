'use strict';
// 此文件由 pages.js 模块化拆分生成（MVC 视图层按业务域分模块，app.js 按路由懒加载）
// shop：商品中心 / 卡券库存 / 订单管理 / 售后纠纷

const itemsListPage = async (c) => {
  let page = 1;
  let keyword = c.dataset.keyword || '';
  // 侧栏全局账号切换器为主筛选：页内未手动筛选过时跟随当前选中账号（app.js 切换账号时会清空页内状态）
  let accountId = c.dataset.accountId || WB.activeAccountId || '';
  let status = c.dataset.status || '';
  // 支持从账号管理页跳转（sessionStorage 带入账号 → 按账号筛选）
  const jumpAcc = sessionStorage.getItem('wb_items_account');
  if (jumpAcc) {
    sessionStorage.removeItem('wb_items_account');
    try {
      const j = JSON.parse(jumpAcc);
      accountId = String(j.id || '');
      keyword = '';
    } catch (_) { keyword = jumpAcc; }
    c.dataset.accountId = accountId; c.dataset.keyword = keyword;
  }
  const draw = async () => {
    const qs = new URLSearchParams({ page: String(page), page_size: '15' });
    if (keyword) qs.set('keyword', keyword);
    if (accountId) qs.set('account_id', accountId);
    if (status) qs.set('status', status);
    const [r, accounts] = await Promise.all([
      WB.get(`/api/v1/items?${qs}`),
      loadAccounts(),
    ]);
    c.innerHTML = `
      ${pageHead('商品管理', `
        <button class="btn" id="it-sync-platform">🔄 同步平台商品</button>
        <button class="btn" id="pub-logs">发布日志</button>
        <button class="btn" id="shop-diag">🏥 全店诊断</button>
        <button class="btn" id="tpl-mgr">发布模板</button>
        <button class="btn" id="batch-pub">批量发布</button>
        <button class="btn btn-primary" id="add-item">+ 新增商品</button>`)}
      <div class="toolbar">
        <input id="f-kw" placeholder="搜索标题/商品ID" value="${esc(keyword)}" style="width:180px">
        <span id="f-acc-host"></span>
        <span id="f-status-host"></span>
        <button class="btn" id="f-go">筛选</button>
        <button class="btn" id="it-batch-on">批量上架</button>
        <button class="btn" id="it-batch-off">批量下架</button>
        <button class="btn" id="it-batch-polish">批量擦亮</button>
        <button class="btn" id="do-refresh">刷新</button>
      </div>
      ${table(['<input type="checkbox" id="sel-all-item">', '图', 'ID', '标题/文案', '账号', '价格', '库存', '虚拟', '状态', '擦亮(次数/最近)', '卡密库存', '操作'],
        r.list.map((i) => {
          const low = i.is_virtual && i.card_available < 5;
          const thumb = i.main_image
            ? `<img class="it-thumb" src="${esc(i.main_image)}" alt="" loading="lazy" onerror="this.outerHTML='<span title=\\'图片加载失败\\'>🖼️</span>'">`
            : '<span style="opacity:.4">—</span>';
          return `<tr>
          <td><input type="checkbox" class="item-sel" data-id="${i.id}"></td>
          <td>${thumb}</td>
          <td>${i.id}</td>
          <td class="clip" title="${esc(i.title)}"><b>${esc(i.title)}</b>${i.description ? `<br><span style="opacity:.6;font-size:12px">${esc(String(i.description).slice(0, 60))}</span>` : ''}</td>
          <td>${esc(i.account_nickname || '')}</td>
          <td>¥${Number(i.price).toFixed(2)}</td><td>${i.quantity}</td>
          <td>${i.is_virtual ? '✓' : '—'}</td><td>${badge(i.status)}</td>
          <td>${i.polish_count} / ${fmt(i.last_polish_at)}</td>
          <td>${i.is_virtual ? `<span class="${low ? 'neg-text' : ''}">${i.card_available} 可用</span> / ${i.card_sold} 已售${low ? ' <button class="btn btn-sm btn-danger" onclick="location.hash=\'#/cards\'">去补货</button>' : ''}` : '—'}</td>
          <td class="ops">
            <button class="btn btn-sm act-copy" data-id="${i.id}">文案</button>
            <button class="btn btn-sm act-platform" data-id="${i.id}" title="把工作台编辑的标题/文案/价格/首图同步到闲鱼平台">↗ 同步闲鱼</button>
            <button class="btn btn-sm act-polish" data-id="${i.id}">擦亮</button>
            <button class="btn btn-sm act-status" data-id="${i.id}" data-st="${i.status}">${i.status === 'on_sale' ? '下架' : '上架'}</button>
            <button class="btn btn-sm act-itemcheck" data-id="${i.id}">检测</button>
            <button class="btn btn-sm act-traffic" data-id="${i.id}">流量</button>
            <button class="btn btn-sm act-edit" data-id="${i.id}">编辑</button>
            <button class="btn btn-sm btn-danger act-del" data-id="${i.id}">删除</button>
          </td></tr>`;
        }).join(''))}
      <div class="pager" id="pager"></div>`;
    // 自定义下拉筛选（账号/状态）
    WB.select(c.querySelector('#f-acc-host'), {
      options: [{ v: '', label: '全部账号' }, ...accounts.map((a) => ({ v: a.id, label: a.nickname }))],
      value: accountId,
      width: '150px',
      onChange: (v) => { accountId = v; c.dataset.accountId = v; page = 1; draw(); },
    });
    WB.select(c.querySelector('#f-status-host'), {
      options: [{ v: '', label: '全部状态' }, { v: 'on_sale', label: '在架' }, { v: 'off_sale', label: '下架' }],
      value: status,
      width: '130px',
      onChange: (v) => { status = v; c.dataset.status = v; page = 1; draw(); },
    });
    WB.paginate(c.querySelector('#pager'), r.total, page, 15, (p) => { page = p; draw(); });
    c.querySelector('#sel-all-item').onchange = (e) => {
      c.querySelectorAll('.item-sel').forEach((cb) => { cb.checked = e.target.checked; });
    };
    const batchOp = async (op) => {
      const ids = [...c.querySelectorAll('.item-sel:checked')].map((cb) => cb.dataset.id);
      if (!ids.length) { WB.toast('请先勾选商品', 'error'); return; }
      let okN = 0;
      for (const id of ids) {
        try {
          if (op === 'polish') await WB.post(`/api/v1/items/${id}/polish`);
          else await WB.put(`/api/v1/items/${id}`, { status: op });
          okN++;
        } catch (e) { WB.toast(`商品 #${id}: ${e.message}`, 'error'); }
      }
      WB.toast(`批量操作完成（成功 ${okN}/${ids.length}）`);
      draw();
    };
    c.querySelector('#it-batch-on').onclick = () => batchOp('on_sale');
    c.querySelector('#it-batch-off').onclick = () => batchOp('off_sale');
    c.querySelector('#it-batch-polish').onclick = () => batchOp('polish');
    c.querySelector('#f-go').onclick = () => {
      keyword = c.querySelector('#f-kw').value.trim();
      c.dataset.keyword = keyword; c.dataset.accountId = accountId; c.dataset.status = status;
      page = 1; draw();
    };
    c.querySelector('#f-kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') c.querySelector('#f-go').click(); });
    c.querySelector('#do-refresh').onclick = draw;
    c.querySelector('#add-item').onclick = () => itemModal(null, draw);
    c.querySelector('#batch-pub').onclick = () => batchModal(draw);
    c.querySelector('#tpl-mgr').onclick = () => templateModal(draw);
    c.querySelector('#shop-diag').onclick = () => shopDiagModal();
    c.querySelector('#pub-logs').onclick = () => pubLogsModal();
    c.querySelector('#it-sync-platform').onclick = async () => {
      const accId = accountId || (WB.activeAccountId || '');
      if (!accId) { WB.toast('请先在筛选中选择要同步的账号', 'error'); return; }
      const btn = c.querySelector('#it-sync-platform');
      btn.disabled = true; btn.textContent = '⏳ 同步中…';
      try {
        const r = await WB.post(`/api/v1/accounts/${accId}/sync-items`, {});
        WB.toast(`同步完成：平台在售 ${r.api_total_count ?? r.total} 件，新增 ${r.added}，更新 ${r.updated}${r.desc_synced ? `，文案 ${r.desc_synced}` : ''}`);
        draw();
      } catch (e) { WB.toast(e.message, 'error'); btn.disabled = false; btn.textContent = '🔄 同步平台商品'; }
    };
    c.querySelectorAll('.act-copy').forEach((b) => {
      b.onclick = async () => {
        const item = await WB.get(`/api/v1/items/${b.dataset.id}`);
        copyEditModal(item, draw);
      };
    });
    c.querySelectorAll('.act-platform').forEach((b) => {
      b.onclick = async () => {
        if (!WB.confirmDialog('确认把工作台保存的标题/文案/价格/首图同步到闲鱼平台？平台将按工作台内容更新该商品。')) return;
        b.disabled = true; b.textContent = '⏳';
        try {
          const r = await WB.post(`/api/v1/items/${b.dataset.id}/sync-platform`, {});
          WB.toast('已同步到闲鱼平台（生效可能有短暂延迟）');
          draw();
        } catch (e) {
          WB.toast(e.message, 'error');
          b.disabled = false; b.textContent = '↗ 同步闲鱼';
        }
      };
    });
    c.querySelectorAll('.act-polish').forEach((b) => {
      b.onclick = () => WB.post(`/api/v1/items/${b.dataset.id}/polish`).then(() => { WB.toast('擦亮成功'); draw(); }).catch((e) => WB.toast(e.message, 'error'));
    });
    c.querySelectorAll('.act-status').forEach((b) => {
      b.onclick = () => WB.put(`/api/v1/items/${b.dataset.id}`, { status: b.dataset.st === 'on_sale' ? 'off_sale' : 'on_sale' })
        .then(draw).catch((e) => WB.toast(e.message, 'error'));
    });
    c.querySelectorAll('.act-edit').forEach((b) => {
      b.onclick = async () => { const item = await WB.get(`/api/v1/items/${b.dataset.id}`); itemModal(item, draw); };
    });
    c.querySelectorAll('.act-itemcheck').forEach((b) => {
      b.onclick = async () => {
        try {
          const [check, diag] = await Promise.all([
            WB.get(`/api/v1/optimizer/check/${b.dataset.id}`),
            WB.get(`/api/v1/diagnosis/item/${b.dataset.id}`),
          ]);
          itemCheckModal(check, diag);
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
    c.querySelectorAll('.act-traffic').forEach((b) => {
      b.onclick = () => itemTrafficModal(b.dataset.id);
    });
    c.querySelectorAll('.act-del').forEach((b) => {
      b.onclick = async () => {
        if (!WB.confirmDialog('确认删除该商品？')) return;
        try {
          await WB.del(`/api/v1/items/${b.dataset.id}`);
          WB.toast('已删除'); draw();
        } catch (e) {
          if (e.code !== 40003 || !e.data) { WB.toast(e.message, 'error'); return; }
          const d = e.data;
          const lines = [
            `商品「${d.item.title}」存在：卡券产品 ${d.card_products} 个（可用卡密 ${d.card_codes_available} 张）、专属回复规则 ${d.rules} 条`,
            { text: '级联删除将一并删除卡券产品与可用卡密，专属规则解绑为全局；历史订单与统计保留。', danger: true },
          ];
          const ok = await WB.confirmDanger(`删除商品「${d.item.title}」`, lines, { confirmText: '确认并级联删除' });
          if (!ok) return;
          try {
            const resp = await fetch(`/api/v1/items/${b.dataset.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + WB.token }, body: JSON.stringify({ cascade: true }) });
            const jr = await resp.json();
            if (!jr.success) throw new Error(jr.message);
            WB.toast('商品已级联删除');
            draw();
          } catch (e2) { WB.toast(e2.message, 'error'); }
        }
      };
    });
  };
  await draw();
};

/** 发布日志弹窗（分页） */
async function pubLogsModal() {
  let page = 1;
  const draw = async () => {
    const r = await WB.get(`/api/v1/publish-logs?page=${page}&page_size=12`);
    showInfoModal('发布日志', table(['时间', '账号', '标题', '结果', '说明'],
      (r.list || []).map((l) => `<tr><td>${fmt(l.created_at)}</td><td>${l.account_id}</td>
        <td class="clip" title="${esc(l.title)}">${esc(l.title)}</td><td>${badge(l.status)}</td>
        <td class="clip" title="${esc(l.message)}">${esc(l.message)}</td></tr>`).join('') || '<div class="empty">暂无发布记录</div>'));
    const pagerEl = document.querySelector('#modal-root .modal-body');
    const div = document.createElement('div');
    div.id = 'pub-pager';
    div.className = 'pager';
    pagerEl.appendChild(div);
    WB.paginate(div, r.total, page, 12, (p) => { page = p; document.getElementById('modal-x').click(); draw(); });
  };
  await draw();
}

/** 无忧卖页（轻运营销售模式跟踪，状态对齐官方 7 态） */
async function worryFreePage(c) {
  let status = c.dataset.status || '';
  let page = 1;
  const WF_LABELS = {
    pending_signup: '待报名', reviewing: '审核中', selling: '售卖中', signup_failed: '报名失败',
    ended: '已结束', exited: '已退出', unsupported: '不支持',
  };
  const draw = async () => {
    const qs = new URLSearchParams({ page: String(page), page_size: '12' });
    if (status) qs.set('status', status);
    if (WB.activeAccountId) qs.set('account_id', WB.activeAccountId);
    const r = await WB.get(`/api/v1/worry-free?${qs}`);
    const s = r.stats || {};
    c.innerHTML = `
      ${pageHead('无忧卖', `
        <button class="btn" id="wf-refresh">刷新</button>
        ${WB.user && WB.user.role === 'admin' ? '<button class="btn btn-primary" id="wf-enroll">📋 报名商品</button>' : ''}`)}
      <p class="hint">闲鱼无忧卖：官方轻运营销售模式，基于大数据分析与智能模型助力商品更快周转、更大效率。状态需按平台实际进度手动流转。</p>
      <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
        ${Object.entries(WF_LABELS).map(([k, label]) => `<div class="card"><div class="card-t">${label}</div><div class="card-v ${k === 'selling' && s[k] > 0 ? '' : ''}">${s[k] || 0}</div></div>`).join('')}
      </div>
      <div class="tabs">
        ${[['', '所有'], ['pending_signup', '待报名'], ['reviewing', '审核中'], ['selling', '售卖中'], ['signup_failed', '报名失败'], ['ended', '已结束'], ['exited', '已退出'], ['unsupported', '不支持']].map(([k, label]) =>
          `<button class="tab-btn ${status === k ? 'active' : ''}" data-status="${k}">${label}</button>`).join('')}
      </div>
      ${table(['商品', '平台商品ID', '账号', '状态', '报名', '审核', '开始售卖', '备注', '操作'],
        r.list.map((w) => `<tr>
          <td class="clip" title="${esc(w.item_title)}">${esc(w.item_title)}</td>
          <td>${esc(w.platform_item_id || '—')}</td><td>${esc(w.account_nickname || '')}</td>
          <td>${badge(w.status === 'selling' ? 'ok' : w.status === 'reviewing' || w.status === 'pending_signup' ? 'warn' : w.status === 'signup_failed' || w.status === 'unsupported' ? 'bad' : 'muted', WF_LABELS[w.status] || w.status)}</td>
          <td>${fmt(w.enrolled_at)}</td><td>${fmt(w.review_at)}</td><td>${fmt(w.selling_at)}</td>
          <td class="clip" title="${esc(w.remark)}">${esc(w.remark || '—')}</td>
          <td class="ops">
            <button class="btn btn-sm wf-status" data-id="${w.id}" data-cur="${w.status}">流转</button>
            ${WB.user && WB.user.role === 'admin' ? `<button class="btn btn-sm btn-danger wf-del" data-id="${w.id}">删除</button>` : ''}
          </td></tr>`).join('') || '<tr><td colspan="9" class="empty-cell">暂无无忧卖记录（点击右上角「报名商品」）</td></tr>')}
      <div class="pager" id="pager"></div>`;
    WB.paginate(c.querySelector('#pager'), r.total, page, 12, (p) => { page = p; draw(); });
    c.querySelectorAll('.tab-btn').forEach((b) => { b.onclick = () => { status = b.dataset.status; c.dataset.status = status; page = 1; draw(); }; });
    c.querySelector('#wf-refresh').onclick = draw;
    const enrollBtn = c.querySelector('#wf-enroll');
    if (enrollBtn) enrollBtn.onclick = async () => {
      const [accounts, items] = await Promise.all([loadAccounts(), WB.get('/api/v1/items?page_size=100&status=on_sale')]);
      WB.openModal({
        title: '无忧卖报名（选择在架商品，可多选）',
        wide: true,
        body: `
          <label>账号</label><select name="account_id">${opts(accounts, 'id', (a) => a.nickname)}</select>
          <div id="wf-item-area"><label>在架商品</label><p class="hint">选择账号后加载商品</p></div>`,
        onSubmit: async (v) => {
          const ids = [...document.querySelectorAll('#wf-item-area .wf-item-sel:checked')].map((cb) => cb.dataset.id);
          if (!ids.length) throw new Error('请至少勾选一件商品');
          const r = await WB.post('/api/v1/worry-free/enroll', { account_id: Number(v.account_id), item_ids: ids.map(Number) });
          WB.toast(r.message);
          draw();
        },
      });
      const accSel = document.querySelector('#wf-item-area') ? document.querySelector('[name=account_id]') : null;
      const loadItems = async (accId) => {
        const list = items.filter((i) => String(i.account_id) === String(accId) && i.status === 'on_sale');
        const area = document.getElementById('wf-item-area');
        area.innerHTML = `<label>在架商品（勾选报名，${list.length} 件可报）</label>` + (list.length
          ? list.map((i) => `<div class="check-row" style="margin:4px 0"><label style="cursor:pointer"><input type="checkbox" class="wf-item-sel" data-id="${i.id}" style="width:auto"> ${esc(i.title)}（¥${Number(i.price).toFixed(2)}）</label></div>`).join('')
          : '<p class="hint">该账号暂无可报名的在架商品</p>');
      };
      loadItems(accSel.value);
      accSel.onchange = (e) => loadItems(e.target.value);
    };
    c.querySelectorAll('.wf-status').forEach((b) => {
      b.onclick = () => {
        const row = r.list.find((x) => String(x.id) === b.dataset.id);
        WB.openModal({
          title: `无忧卖状态流转：${row.item_title.slice(0, 24)}`,
          body: `
            <label>当前状态：${WF_LABELS[row.status] || row.status}</label>
            <label>新状态</label><select name="status">
              ${Object.entries(WF_LABELS).map(([k, label]) => `<option value="${k}" ${k === row.status ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
            <label>备注</label><textarea name="remark" rows="2" placeholder="${esc(row.remark || '如：质检通过 / 描述需完善 / 平台已接手售卖')}"></textarea>`,
          onSubmit: async (v) => {
            await WB.put(`/api/v1/worry-free/${row.id}/status`, v);
            WB.toast('状态已更新');
            draw();
          },
        });
      };
    });
    c.querySelectorAll('.wf-del').forEach((b) => {
      b.onclick = async () => {
        const row = r.list.find((x) => String(x.id) === b.dataset.id);
        const ok = await WB.confirmDanger('删除无忧卖记录', [`记录「${row.item_title.slice(0, 24)}」（${WF_LABELS[row.status]}）`], { confirmText: '确认删除' });
        if (!ok) return;
        try { await WB.del(`/api/v1/worry-free/${b.dataset.id}`); draw(); } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
  };
  await draw();
}

PAGES.items = async (c) => subTabPage(c, 'items', [['list', '📦 商品列表'], ['optimizer', '🧰 商品优化'], ['worry', '🎯 无忧卖']], {
  list: itemsListPage,
  optimizer: WB.lazyPage('analyze', 'optimizer'),
  worry: worryFreePage,
});

async function itemModal(item, done) {
  const accounts = await loadAccounts();
  WB.openModal({
    title: item ? `编辑商品 #${item.id}` : '新增商品',
    wide: true,
    body: `
      <div class="form-row">
        <div><label>所属账号 <i class="req">*</i></label>
          <select name="account_id" ${item ? 'disabled' : 'required'}>${opts(accounts, 'id', (a) => a.nickname, item ? item.account_id : '')}</select></div>
        <div><label>平台商品ID ${item ? '' : '<i class="req">*</i>'}</label>
          <input name="item_id" value="${esc(item ? item.item_id : '')}" ${item ? 'disabled' : 'required'}></div>
      </div>
      <label>标题 <i class="req">*</i></label><input name="title" value="${esc(item ? item.title : '')}" required>
      <label>描述</label><textarea name="description" rows="2">${esc(item ? item.description || '' : '')}</textarea>
      <div class="form-row">
        <div><label>售价</label><input name="price" type="number" step="0.01" value="${item ? item.price : '0.00'}"></div>
        <div><label>原价</label><input name="original_price" type="number" step="0.01" value="${item ? item.original_price : '0.00'}"></div>
        <div><label>库存</label><input name="quantity" type="number" value="${item ? item.quantity : 1}"></div>
      </div>
      <div class="form-row">
        <div><label>采购成本/件（利润分析）</label><input name="cost_price" type="number" step="0.01" value="${item ? item.cost_price : '0.00'}"></div>
        <div><label>运费+包装/件（利润分析）</label><input name="shipping_cost" type="number" step="0.01" value="${item ? item.shipping_cost : '0.00'}"></div>
        <div><label>首图URL（商品优化检查）</label><input name="main_image" value="${esc(item ? item.main_image : '')}" placeholder="https://..."></div>
      </div>
      <div class="img-upload-row" id="it-img-row">
        <img id="it-img-preview" src="${esc(item && item.main_image ? item.main_image : '')}" ${item && item.main_image ? '' : 'hidden'} onerror="this.hidden=true">
        <div>
          <button type="button" class="btn btn-sm" id="it-img-pick">📤 上传图片到闲鱼CDN</button>
          <input type="file" id="it-img-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
          <p class="hint" style="margin:6px 0 0">上传后自动填入首图URL；修改文案/价格后可用列表里的「↗ 同步闲鱼」推送到平台。</p>
        </div>
      </div>
      <div class="form-row">
        <div><label>成色（二手商品管理/智能估价）</label><select name="goods_condition">
          ${['全新', '九五新', '九成新', '八成新', '有瑕疵'].map((x) => `<option ${item && item.goods_condition === x ? 'selected' : (!item && x === '九成新') ? 'selected' : ''}>${x}</option>`).join('')}
        </select></div>
        <div style="grid-column:span 2"><label>瑕疵说明（如实描述可减少售后）</label><input name="defect_note" value="${esc(item ? item.defect_note : '')}" placeholder="如：键帽轻微打油，不影响手感"></div>
      </div>
      <div class="check-row">
        <label><input type="checkbox" name="is_virtual" ${item && item.is_virtual ? 'checked' : ''}> 虚拟商品（参与自动发货）</label>
        <label><input type="checkbox" name="polish_enabled" ${!item || item.polish_enabled ? 'checked' : ''}> 参与定时擦亮</label>
        <label><input type="checkbox" name="status_on" ${!item || item.status === 'on_sale' ? 'checked' : ''}> 在架</label>
        ${item ? '<label><input type="checkbox" name="sync_platform"> ↗ 保存后同步到闲鱼平台</label>' : ''}
      </div>`,
    onSubmit: async (v) => {
      const payload = { ...v, status: v.status_on ? 'on_sale' : 'off_sale' };
      delete payload.status_on;
      delete payload.sync_platform;
      if (item) await WB.put(`/api/v1/items/${item.id}`, payload);
      else await WB.post('/api/v1/items', payload);
      if (item && v.sync_platform) {
        WB.toast('已保存，正在同步到闲鱼平台…');
        try {
          await WB.post(`/api/v1/items/${item.id}/sync-platform`, { title: payload.title, description: payload.description, price: payload.price, original_price: payload.original_price, main_image: payload.main_image });
          WB.toast('已同步到闲鱼平台（生效可能有短暂延迟）');
        } catch (e) {
          WB.toast('平台同步失败：' + e.message, 'error');
        }
      } else {
        WB.toast('已保存');
      }
      done();
    },
  });
  // 图片上传（multipart FormData → /api/v1/upload/image → 填入首图URL）
  const form = document.querySelector('#modal-form');
  const pickBtn = form.querySelector('#it-img-pick');
  const fileInput = form.querySelector('#it-img-file');
  const urlInput = form.querySelector('[name=main_image]');
  const preview = form.querySelector('#it-img-preview');
  if (pickBtn && fileInput) {
    pickBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const accSel = form.querySelector('[name=account_id]');
      const accId = item ? item.account_id : (accSel ? accSel.value : '');
      if (!accId) { WB.toast('请先选择所属账号', 'error'); return; }
      pickBtn.disabled = true; pickBtn.textContent = '⏳ 上传中…';
      try {
        const fd = new FormData();
        fd.append('file', f, f.name);
        const resp = await fetch(`/api/v1/upload/image?account_id=${accId}`, { method: 'POST', headers: { Authorization: 'Bearer ' + WB.token }, body: fd });
        const j = await resp.json();
        if (!j.success) throw new Error(j.message || '上传失败');
        urlInput.value = j.data.url;
        preview.src = j.data.url;
        preview.hidden = false;
        WB.toast('图片已上传闲鱼 CDN');
      } catch (e) {
        WB.toast(e.message, 'error');
      } finally {
        pickBtn.disabled = false; pickBtn.textContent = '📤 上传图片到闲鱼CDN';
        fileInput.value = '';
      }
    };
  }
  // 首图URL手动修改时同步预览
  if (urlInput && preview) {
    urlInput.addEventListener('change', () => {
      if (/^https?:\/\//.test(urlInput.value.trim())) { preview.src = urlInput.value.trim(); preview.hidden = false; }
    });
  }
}

/** 文案快速编辑弹窗（标题/描述，供自动回复与 AI 优化使用；平台侧商品不受影响） */
async function copyEditModal(item, done) {
  WB.openModal({
    title: `修改文案：${item.title.slice(0, 20)}${item.title.length > 20 ? '…' : ''}`,
    wide: true,
    body: `
      <div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:10px">
        ${item.main_image ? `<img src="${esc(item.main_image)}" style="width:88px;height:88px;object-fit:cover;border-radius:8px;background:#f2f4f8" onerror="this.style.display='none'">` : ''}
        <div style="flex:1">
          <p class="hint" style="margin:0 0 4px">平台商品ID：${esc(item.item_id)}　价格：¥${Number(item.price).toFixed(2)}</p>
          <p class="hint" style="margin:0">文案保存到工作台，用于自动回复变量 {{商品标题}}、AI 回复与优化建议；不直接改动闲鱼平台上架内容。</p>
        </div>
      </div>
      <label>标题</label><input name="title" value="${esc(item.title)}" maxlength="255" required>
      <label>描述文案</label><textarea name="description" rows="6" maxlength="2000" placeholder="商品卖点、成色说明、使用场景…">${esc(item.description || '')}</textarea>
      <div class="check-row" style="margin-top:8px">
        <label><input type="checkbox" name="sync_platform"> ↗ 同步到闲鱼平台（标题/文案/价格/首图一起推送）</label>
      </div>`,
    onSubmit: async (v) => {
      await WB.put(`/api/v1/items/${item.id}`, { title: v.title, description: v.description });
      if (v.sync_platform) {
        try {
          await WB.post(`/api/v1/items/${item.id}/sync-platform`, { title: v.title, description: v.description, price: item.price, original_price: item.original_price, main_image: item.main_image });
          WB.toast('文案已保存并同步到闲鱼平台');
        } catch (e) {
          WB.toast('文案已保存，但平台同步失败：' + e.message, 'error');
        }
      } else {
        WB.toast('文案已保存');
      }
      done();
    },
  });
}

async function batchModal(done) {
  const accounts = await loadAccounts();
  const tpls = await WB.get('/api/v1/item-templates');
  WB.openModal({
    title: '批量发布（按模板）',
    body: `
      <label>发布账号 <i class="req">*</i></label>
      <select name="account_id">${opts(accounts, 'id', (a) => a.nickname)}</select>
      <label>模板 <i class="req">*</i></label>
      <select name="template_id">${opts(tpls, 'id', (t) => `${t.name}（${t.title_pattern}）`)}</select>
      <label>数量（1-20，标题 {n} 替换为序号）</label>
      <input name="count" type="number" value="3" min="1" max="20">`,
    onSubmit: async (v) => {
      const r = await WB.post('/api/v1/items/batch-publish', v);
      WB.toast(`批量发布成功 ${r.created.length} 件`);
      done();
    },
  });
}

async function templateModal(done) {
  const close = WB.openModal({
    title: '发布模板管理',
    wide: true,
    body: `<div id="tpl-area">加载中…</div>
      <h3 class="sub-h"><span class="tpl-edit-mode">新增模板</span></h3>
      <div class="form-row">
        <div><label>模板名称 <i class="req">*</i></label><input name="name" required></div>
        <div><label>标题模板（{n} 为序号）<i class="req">*</i></label><input name="title_pattern" required></div>
      </div>
      <div class="form-row">
        <div><label>售价</label><input name="price" type="number" step="0.01" value="0"></div>
        <div><label>原价</label><input name="original_price" type="number" step="0.01" value="0"></div>
        <div><label>库存</label><input name="quantity" type="number" value="1"></div>
      </div>
      <label>描述</label><textarea name="description" rows="2"></textarea>
      <div class="check-row"><label><input type="checkbox" name="is_virtual"> 虚拟商品</label></div>`,
    onSubmit: async (v) => {
      const form = document.querySelector('#modal-form');
      const editId = form ? form.dataset.editId : null;
      if (editId) {
        await WB.put(`/api/v1/item-templates/${editId}`, v);
        WB.toast('模板已更新');
        delete form.dataset.editId;
        const label = form.querySelector('.tpl-edit-mode');
        if (label) label.textContent = '新增模板';
      } else {
        await WB.post('/api/v1/item-templates', v);
        WB.toast('模板已保存');
      }
      renderTplList();
      return new Promise(() => {}); // 阻止自动关闭，由用户手动关闭
    },
  });
  async function renderTplList() {
    const tpls = await WB.get('/api/v1/item-templates');
    const c2 = document.getElementById('tpl-area');
    if (!c2) return;
    c2.innerHTML = table(['ID', '名称', '标题模板', '售价', '虚拟', '操作'],
      tpls.map((t) => `<tr><td>${t.id}</td><td>${esc(t.name)}</td><td class="clip">${esc(t.title_pattern)}</td>
        <td>￥${Number(t.price).toFixed(2)}</td><td>${t.is_virtual ? '✓' : '—'}</td>
        <td><button class="btn btn-sm tpl-edit" data-id="${t.id}">编辑</button>
        <button class="btn btn-sm btn-danger tpl-del" data-id="${t.id}">删除</button></td></tr>`).join(''));
    c2.querySelectorAll('.tpl-del').forEach((b) => {
      b.onclick = async () => {
        if (!WB.confirmDialog('确认删除该模板？')) return;
        try { await WB.del(`/api/v1/item-templates/${b.dataset.id}`); renderTplList(); } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
    c2.querySelectorAll('.tpl-edit').forEach((b) => {
      b.onclick = () => {
        const t = tpls.find((x) => String(x.id) === b.dataset.id);
        const form = document.querySelector('#modal-form');
        // 复用弹窗内的"新增"表单区作为编辑区
        form.querySelector('[name=name]').value = t.name;
        form.querySelector('[name=title_pattern]').value = t.title_pattern;
        form.querySelector('[name=price]').value = t.price;
        form.querySelector('[name=original_price]').value = t.original_price;
        form.querySelector('[name=quantity]').value = t.quantity;
        form.querySelector('[name=description]').value = t.description || '';
        form.querySelector('[name=is_virtual]').checked = !!t.is_virtual;
        const label = form.querySelector('.tpl-edit-mode');
        if (label) label.textContent = `正在编辑模板 #${t.id}（保存即更新）`;
        form.dataset.editId = t.id;
        form.scrollIntoView({ behavior: 'smooth' });
      };
    });
  }
  renderTplList();
}

/* ================= 卡券库存 ================= */
PAGES.cards = async (c) => {
  let codePage = 1;
  let codeProduct = c.dataset.codeProduct || '';
  let codeStatus = c.dataset.codeStatus || '';
  let codeKeyword = c.dataset.codeKeyword || '';
  const draw = async () => {
    const products = await WB.get(`/api/v1/card-products?page_size=50${accQ()}`);
    const codes = await WB.get(`/api/v1/card-codes?page=${codePage}&page_size=15${codeProduct ? '&product_id=' + codeProduct : ''}${codeStatus ? '&status=' + codeStatus : ''}${codeKeyword ? '&keyword=' + encodeURIComponent(codeKeyword) : ''}`);
    const items = await loadItems();
    const virtualItems = items.filter((i) => i.is_virtual);
    c.innerHTML = `
      ${pageHead('卡券库存', '<button class="btn btn-primary" id="add-product">+ 新建卡券产品</button>')}
      <h3 class="sub-h">卡券产品</h3>
      ${table(['ID', '名称', '关联商品', '可用', '已售', '总数', '操作'],
        products.list.map((p) => {
          const low = Number(p.available_count) < 5;
          return `<tr>
          <td>${p.id}</td><td>${esc(p.name)}</td><td class="clip">${esc(p.item_title || p.item_id)}</td>
          <td class="${low ? 'neg-text' : ''}">${p.available_count}${low ? ' ⚠' : ''}</td><td>${p.sold_count}</td><td>${p.total_count}</td>
          <td class="ops">
            <button class="btn btn-sm act-import" data-id="${p.id}">导入卡密</button>
            <button class="btn btn-sm btn-danger act-pdel" data-id="${p.id}">删除</button>
          </td></tr>`;
        }).join(''))}
      <h3 class="sub-h">卡密明细</h3>
      <div class="toolbar">
        <input id="f-kw" placeholder="搜索卡密/订单号/买家" value="${esc(codeKeyword)}" style="width:200px">
        <select id="f-product"><option value="">全部产品</option>${opts(products.list, 'id', (p) => p.name, codeProduct)}</select>
        <select id="f-status"><option value="">全部状态</option>
          ${['available', 'sold', 'disabled'].map((s) => `<option value="${s}" ${s === codeStatus ? 'selected' : ''}>${badge(s).match(/>([^<]+)</)[1]}</option>`).join('')}
        </select>
        <button class="btn" id="f-go">筛选</button>
        <button class="btn" id="codes-export">⬇ 导出 CSV</button>
      </div>
      ${table(['ID', '产品', '内容', '状态', '订单号', '买家', '售出时间', '操作'],
        codes.list.map((cd) => `<tr><td>${cd.id}</td><td>${esc(cd.product_name || '')}</td>
          <td class="clip" title="${esc(cd.content)}">${esc(cd.content)}</td><td>${badge(cd.status)}</td>
          <td>${esc(cd.order_no || '-')}</td><td>${esc(cd.buyer_nick || '-')}</td><td>${fmt(cd.sold_at)}</td>
          <td class="ops">${cd.status === 'available' ? `<button class="btn btn-sm btn-danger act-cdis" data-id="${cd.id}">作废</button>` : ''}</td></tr>`).join(''))}
      <div class="pager" id="code-pager"></div>`;
    WB.paginate(c.querySelector('#code-pager'), codes.total, codePage, 15, (p) => { codePage = p; draw(); });
    c.querySelector('#f-product').onchange = (e) => { codeProduct = e.target.value; c.dataset.codeProduct = codeProduct; codePage = 1; draw(); };
    c.querySelector('#f-status').onchange = (e) => { codeStatus = e.target.value; c.dataset.codeStatus = codeStatus; codePage = 1; draw(); };
    c.querySelector('#f-go').onclick = () => {
      codeKeyword = c.querySelector('#f-kw').value.trim();
      c.dataset.codeKeyword = codeKeyword; codePage = 1; draw();
    };
    c.querySelector('#f-kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') c.querySelector('#f-go').click(); });
    c.querySelector('#codes-export').onclick = () => {
      const qs = new URLSearchParams();
      if (codeProduct) qs.set('product_id', codeProduct);
      if (codeStatus) qs.set('status', codeStatus);
      if (codeKeyword) qs.set('keyword', codeKeyword);
      fetch(`/api/v1/card-codes/export?${qs}`, { headers: { Authorization: 'Bearer ' + WB.token } })
        .then((resp) => resp.blob())
        .then((blob) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `card-codes-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(a.href);
          WB.toast('CSV 已导出');
        })
        .catch((e) => WB.toast('导出失败: ' + e.message, 'error'));
    };
    c.querySelectorAll('.act-cdis').forEach((b) => {
      b.onclick = async () => {
        const ok = await WB.confirmDanger('作废卡密', [
          '作废后该卡密状态变为 disabled，不可再用于自动发货，且不可恢复。',
        ], { confirmText: '确认作废' });
        if (!ok) return;
        try { await WB.post(`/api/v1/card-codes/${b.dataset.id}/disable`); WB.toast('已作废'); draw(); } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
    c.querySelector('#add-product').onclick = () => {
      if (!virtualItems.length) { WB.toast('暂无虚拟商品，请先创建', 'error'); return; }
      WB.openModal({
        title: '新建卡券产品',
        body: `<label>名称 <i class="req">*</i></label><input name="name" required>
          <label>关联虚拟商品</label><select name="item_id">${opts(virtualItems, 'id', (i) => i.title)}</select>`,
        onSubmit: async (v) => { await WB.post('/api/v1/card-products', v); WB.toast('已创建'); draw(); },
      });
    };
    c.querySelectorAll('.act-import').forEach((b) => {
      b.onclick = () => {
        WB.openModal({
          title: '导入卡密（每行一条）',
          body: '<textarea name="contents" rows="8" placeholder="CODE-0001&#10;CODE-0002" required></textarea>',
          onSubmit: async (v) => {
            const r = await WB.post('/api/v1/card-codes/import', { product_id: Number(b.dataset.id), contents: v.contents });
            WB.toast(`导入成功 ${r.imported} 张`);
            draw();
          },
        });
      };
    });
    c.querySelectorAll('.act-pdel').forEach((b) => {
      b.onclick = async () => {
        const p = products.list.find((x) => String(x.id) === b.dataset.id);
        const lines = [`产品「${p.name}」及其中全部可用卡密`];
        if (Number(p.available_count) > 0) lines.push({ text: `将删除 ${p.available_count} 张可用卡密（已售 ${p.sold_count} 张不受影响，历史保留）。`, danger: true });
        const ok = await WB.confirmDanger('删除卡券产品', lines, { confirmText: '确认删除' });
        if (!ok) return;
        try {
          const r = await WB.del(`/api/v1/card-products/${b.dataset.id}`);
          WB.toast(`已删除（清理可用卡密 ${r.codes_deleted} 张）`);
          draw();
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
  };
  await draw();
};

/* ================= 订单管理（订单列表 + 售后纠纷 合并页） ================= */
const ordersListPage = async (c) => {
  let status = c.dataset.status || '';
  let delivery = c.dataset.delivery || '';
  let keyword = c.dataset.keyword || '';
  let page = 1;
  const draw = async () => {
    const [r, st] = await Promise.all([
      WB.get(`/api/v1/orders?page=${page}&page_size=15${accQ()}${status ? '&status=' + status : ''}${delivery ? '&delivery_status=' + delivery : ''}${keyword ? '&keyword=' + encodeURIComponent(keyword) : ''}`),
      WB.get(`/api/v1/orders/stats?${WB.activeAccountId ? 'account_id=' + encodeURIComponent(WB.activeAccountId) : ''}`),
    ]);
    c.innerHTML = `
      ${pageHead('订单管理', `
        <button class="btn btn-primary" id="ord-sync">🔄 同步平台订单</button>
        <button class="btn" id="ord-export">⬇ 导出 CSV</button>
        <button class="btn" id="do-refresh">刷新</button>`)}
      <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
        <div class="card"><div class="card-t">待付款（售前）</div><div class="card-v">${st.presale.pending_paid}</div></div>
        <div class="card"><div class="card-t">待发货（售前）</div><div class="card-v">${st.presale.paid}</div></div>
        <div class="card"><div class="card-t">已发货（售前）</div><div class="card-v">${st.presale.delivered}</div></div>
        <div class="card"><div class="card-t">交易成功</div><div class="card-v">${st.completed}</div></div>
        <div class="card"><div class="card-t">退款中（售后）</div><div class="card-v ${st.aftersale.refunding > 0 ? 'neg-text' : ''}">${st.aftersale.refunding}</div></div>
        <div class="card"><div class="card-t">已退款（售后）</div><div class="card-v">${st.aftersale.refunded}</div></div>
        <div class="card"><div class="card-t">交易关闭</div><div class="card-v">${st.aftersale.closed}</div></div>
        <div class="card"><div class="card-t">全部订单</div><div class="card-v">${st.total}</div></div>
      </div>
      <div class="toolbar">
        <input id="f-kw" placeholder="搜索订单号/买家昵称" value="${esc(keyword)}" style="width:200px">
        <span id="f-status-host"></span>
        <span id="f-delivery-host"></span>
        <button class="btn" id="f-go">筛选</button>
      </div>
      ${table(['订单号', '商品', '账号', '买家', '数量', '金额', '状态', '发货', '评价', '下单时间', '操作'],
        r.list.map((o) => `<tr>
          <td>${esc(o.order_no)}</td><td class="clip" title="${esc(o.item_title || '')}">${esc(o.item_title || '')}</td>
          <td>${esc(o.account_nickname || '')}</td><td>${esc(o.buyer_nick)}</td>
          <td>${o.quantity}</td><td>￥${Number(o.amount).toFixed(2)}</td>
          <td>${badge(o.status)}</td><td>${badge(o.delivery_status)}</td><td>${o.is_rated ? '✓' : '—'}</td>
          <td>${fmt(o.placed_at)}</td>
          <td class="ops">
            <button class="btn btn-sm act-view" data-no="${esc(o.order_no)}">详情</button>
            ${o.delivery_status !== 'sent' && o.is_virtual ? `<button class="btn btn-sm act-deliver" data-no="${esc(o.order_no)}">发货</button>` : ''}
            ${!o.is_rated && (o.status === 'delivered' || o.status === 'completed') ? `<button class="btn btn-sm act-rate" data-no="${esc(o.order_no)}">评价</button>` : ''}
            ${(o.status === 'delivered' || o.status === 'completed') ? `<button class="btn btn-sm btn-danger act-refund" data-no="${esc(o.order_no)}">标记退款</button>` : ''}
          </td></tr>`).join(''))}
      <div class="pager" id="pager"></div>`;
    WB.paginate(c.querySelector('#pager'), r.total, page, 15, (p) => { page = p; draw(); });
    c.querySelector('#do-refresh').onclick = draw;
    // 自定义下拉筛选（订单状态/发货状态）
    WB.select(c.querySelector('#f-status-host'), {
      options: [{ v: '', label: '全部状态' }, ...['pending_paid', 'paid', 'delivered', 'completed', 'closed', 'refunding'].map((s) => ({ v: s, label: badge(s).match(/>([^<]+)</)[1] }))],
      value: status,
      width: '140px',
      onChange: (v) => { status = v; c.dataset.status = v; page = 1; draw(); },
    });
    WB.select(c.querySelector('#f-delivery-host'), {
      options: [{ v: '', label: '全部发货状态' }, ...['pending', 'sent', 'failed', 'none'].map((s) => ({ v: s, label: badge(s).match(/>([^<]+)</)[1] }))],
      value: delivery,
      width: '140px',
      onChange: (v) => { delivery = v; c.dataset.delivery = v; page = 1; draw(); },
    });
    c.querySelector('#ord-sync').onclick = async () => {
      const btn = c.querySelector('#ord-sync');
      btn.disabled = true; btn.textContent = '⏳ 同步中…';
      try {
        const accId = WB.activeAccountId;
        const r = await WB.post('/api/v1/orders/sync', accId ? { account_id: Number(accId) } : {});
        const fail = (r.accounts || []).filter((a) => !a.ok);
        WB.toast(`同步完成：共 ${r.total} 单（新增 ${r.added}，更新 ${r.updated}）${fail.length ? `，${fail.length} 个账号失败` : ''}`, fail.length ? 'error' : 'ok');
        page = 1;
        draw();
      } catch (e) { WB.toast(e.message, 'error'); btn.disabled = false; btn.textContent = '🔄 同步平台订单'; }
    };
    c.querySelector('#f-go').onclick = () => { keyword = c.querySelector('#f-kw').value.trim(); c.dataset.keyword = keyword; page = 1; draw(); };
    c.querySelector('#f-kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') c.querySelector('#f-go').click(); });
    c.querySelector('#ord-export').onclick = () => {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (delivery) qs.set('delivery_status', delivery);
      if (keyword) qs.set('keyword', keyword);
      // 带鉴权下载：fetch → blob → 触发下载
      fetch(`/api/v1/orders/export?${qs}`, { headers: { Authorization: 'Bearer ' + WB.token } })
        .then((resp) => resp.blob())
        .then((blob) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(a.href);
          WB.toast('CSV 已导出');
        })
        .catch((e) => WB.toast('导出失败: ' + e.message, 'error'));
    };
    c.querySelectorAll('.act-view').forEach((b) => {
      b.onclick = async () => {
        const o = await WB.get(`/api/v1/orders/${b.dataset.no}`);
        WB.openModal({
          title: `订单 ${o.order_no}`,
          wide: true,
          body: `
            <p><b>商品：</b>${esc(o.item_title || '')} × ${o.quantity}　<b>金额：</b>￥${Number(o.amount).toFixed(2)}</p>
            <p><b>买家：</b>${esc(o.buyer_nick)}　<b>状态：</b>${badge(o.status)} ${badge(o.delivery_status)}</p>
            <p><b>发货内容：</b></p><pre class="pre">${esc(o.delivery_content || o.delivery_fail_reason || '—')}</pre>
            <p><b>发货日志：</b></p>
            ${table(['时间', '结果', '重试', '备注'], (o.delivery_logs || []).map((l) =>
              `<tr><td>${fmt(l.created_at)}</td><td>${badge(l.status)}</td><td>${l.retry_count}</td><td class="clip">${esc(l.error_message || '')}</td></tr>`).join(''))}
            <div></div>`,
          onSubmit: async () => { /* 只读详情 */ },
        });
        c.querySelector('#modal-ok').textContent = '关闭';
      };
    });
    c.querySelectorAll('.act-deliver').forEach((b) => {
      b.onclick = () => WB.post(`/api/v1/orders/${b.dataset.no}/deliver`)
        .then(() => { WB.toast('发货成功'); draw(); }).catch((e) => WB.toast(e.message, 'error'));
    });
    c.querySelectorAll('.act-rate').forEach((b) => {
      b.onclick = () => WB.post(`/api/v1/orders/${b.dataset.no}/rate`)
        .then(() => { WB.toast('评价成功'); draw(); }).catch((e) => WB.toast(e.message, 'error'));
    });
    c.querySelectorAll('.act-refund').forEach((b) => {
      b.onclick = async () => {
        if (!WB.confirmDialog('确认将该订单标记为退款/售后？将计入退款损失并进入售后时效监控。')) return;
        try { await WB.post(`/api/v1/orders/${b.dataset.no}/refund`); WB.toast('已标记退款'); draw(); } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
  };
  await draw();
};


PAGES.orders = async (c) => subTabPage(c, 'orders', [['list', '🧾 订单列表'], ['aftersale', '⚖️ 售后纠纷']], {
  list: ordersListPage,
  aftersale: WB.PAGES.aftersale,
});


/* ================= 售后纠纷中心 ================= */
PAGES.aftersale = async (c) => {
  let keyword = c.dataset.keyword || '';
  const draw = async () => {
    const r = await WB.get(`/api/v1/aftersale/center${keyword ? '?keyword=' + encodeURIComponent(keyword) : ''}`);
    const th = r.stats.timeout_hours || 48;
    const sev = (h) => h >= th ? badge('failed', `已超时 ${h}h`) : badge('warning', `已开单 ${h}h`);
    c.innerHTML = `
    ${pageHead('售后纠纷中心', '<button class="btn" id="as-refresh">刷新</button>')}
    <div class="toolbar">
      <input id="f-kw" placeholder="搜索订单号/买家昵称" value="${esc(keyword)}" style="width:220px">
      <button class="btn" id="f-go">搜索</button>
    </div>
    <div class="cards">
      <div class="card"><div class="card-t">进行中售后</div><div class="card-v">${r.stats.ongoing}</div></div>
      <div class="card"><div class="card-t">已超时（${th}h）</div><div class="card-v ${r.stats.overdue > 0 ? 'neg' : ''}">${r.stats.overdue}</div><div class="card-s">需优先处理</div></div>
      <div class="card"><div class="card-t">退款完成</div><div class="card-v">${r.stats.resolved_refund}</div></div>
      <div class="card"><div class="card-t">协商完成</div><div class="card-v">${r.stats.resolved_reject}</div></div>
    </div>
    <h3 class="sub-h">⚠️ 进行中售后</h3>
    ${table(['订单号', '商品', '买家', '金额', '开单时长', '备注', '处理'],
      r.ongoing.map((o) => `<tr>
        <td>${esc(o.order_no)}</td><td class="clip">${esc(o.item_title || '')}</td><td>${esc(o.buyer_nick)}</td>
        <td>¥${Number(o.amount).toFixed(2)}</td><td>${sev(Number(o.hours_open))}</td>
        <td class="clip" title="${esc(o.aftersale_note)}">${esc(o.aftersale_note || '—')}</td>
        <td class="ops"><button class="btn btn-sm as-handle" data-no="${esc(o.order_no)}">处理</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty-cell">无进行中售后</td></tr>')}
    <h3 class="sub-h">已处理记录</h3>
    ${table(['订单号', '商品', '买家', '金额', '结果', '处理备注', '完成时间'],
      r.resolved.map((o) => `<tr><td>${esc(o.order_no)}</td><td class="clip">${esc(o.item_title || '')}</td><td>${esc(o.buyer_nick)}</td>
        <td>¥${Number(o.amount).toFixed(2)}</td>
        <td>${o.status === 'refunded' ? badge('failed', '已退款') : badge('muted', '协商完成')}</td>
        <td class="clip" title="${esc(o.aftersale_note)}">${esc(o.aftersale_note || '—')}</td>
        <td>${fmt(o.aftersale_closed_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-cell">暂无处理记录</td></tr>')}`;
  c.querySelectorAll('.as-handle').forEach((b) => {
    b.onclick = () => {
      WB.openModal({
        title: `处理售后 ${b.dataset.no}`,
        body: `
          <label>处理方式</label>
          <select name="action"><option value="refund">同意退款（计入退款损失）</option><option value="reject">拒绝退款 / 协商完成</option></select>
          <label>处理备注</label><textarea name="note" rows="3" placeholder="如：核实兑换码无效，已退款并补发"></textarea>`,
        onSubmit: async (v) => {
          if (v.action === 'refund') {
            // 资金敏感操作：二次确认
            const ok = await WB.confirmDanger('确认同意退款？', [
              { text: `订单 ${b.dataset.no} 将置为「已退款」，金额计入退款损失（利润分析）。`, danger: true },
              { text: '该操作立即生效，请确认已核实买家诉求。', danger: true },
            ], { confirmText: '确认同意退款' });
            if (!ok) throw new Error('已取消（未处理）');
          }
          await WB.post(`/api/v1/orders/${b.dataset.no}/aftersale/resolve`, v);
          WB.toast('售后已处理');
          draw();
        },
      });
    };
  });
  };
  await draw();
  c.querySelector('#as-refresh').onclick = draw;
  c.querySelector('#f-go').onclick = () => { keyword = c.querySelector('#f-kw').value.trim(); c.dataset.keyword = keyword; draw(); };
  c.querySelector('#f-kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') c.querySelector('#f-go').click(); });
};

/* ================= AI 控制台 ================= */

/** 商品「检测」：信息体检（标题/描述/首图/价格/违禁词）+ 综合诊断评分与行动清单 */
async function itemCheckModal(check, diag) {
  const title = (diag.item && diag.item.title) || check.title || `商品#${check.item_id}`;
  const scoreHtml = (label, v) => (v === undefined || v === null ? '' : `<div class="card"><div class="card-t">${label}</div><div class="card-v">${esc(String(v))}</div></div>`);
  showInfoModal(`商品检测：${title}`, `
    <div class="cards" style="grid-template-columns:repeat(4,1fr)">
      ${scoreHtml('体检得分', check.score)}
      ${scoreHtml('体检评级', check.grade)}
      ${scoreHtml('综合诊断分', diag.score === undefined ? null : `${diag.score}（${diag.grade || ''}）`)}
      ${scoreHtml('诊断问题/行动', `${diag.finding_count ?? 0} / ${diag.actions ? diag.actions.length : 0}`)}
    </div>
    <h3 class="sub-h">🔎 信息体检（标题/描述/首图/价格/违禁词/发货能力）</h3>
    ${findingsHtml(check.findings)}
    <h3 class="sub-h">🩺 综合诊断（质量+流量+价格+咨询+利润）</h3>
    ${findingsHtml(diag.findings)}
    ${diag.actions && diag.actions.length ? `<h3 class="sub-h">📋 行动清单</h3>
      <div>${diag.actions.map((a) => `
        <div class="diag-item sev-info"><b>P${a.priority || '-'} ${esc(a.area || '')}</b>　${esc(a.action)}</div>`).join('')}</div>` : ''}
    ${diag.ai_available ? `<div style="margin-top:10px;text-align:right"><button type="button" class="btn btn-primary" id="btn-ai-rx">🧠 生成 AI 经营处方</button><pre class="pre" id="ai-rx-out" style="display:none"></pre></div>` : ''}`);
  const rxBtn = document.querySelector('#btn-ai-rx');
  if (rxBtn) {
    rxBtn.onclick = async () => {
      rxBtn.disabled = true;
      rxBtn.textContent = 'AI 生成中…';
      try {
        const r = await WB.post(`/api/v1/diagnosis/item/${diag.item.id}/ai`);
        const out = document.querySelector('#ai-rx-out');
        out.style.display = '';
        out.textContent = (r.prescriptions || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
        rxBtn.style.display = 'none';
      } catch (e) {
        WB.toast(e.message, 'error');
        rxBtn.disabled = false;
        rxBtn.textContent = '🧠 生成 AI 经营处方';
      }
    };
  }
}

/** 商品「流量」：近 7 天趋势 + 漏斗 + 优化建议 */
async function itemTrafficModal(itemId) {
  const [tr, sug] = await Promise.all([
    WB.get(`/api/v1/analytics/traffic/item/${itemId}?days=7`),
    WB.get(`/api/v1/analytics/traffic/suggestions/${itemId}`),
  ]);
  const f = sug.funnel || {};
  showInfoModal(`流量诊断：${tr.item.title}`, `
    <p class="hint">漏斗：曝光 <b>${f.exposure ?? '-'}</b> → 浏览 <b>${f.views ?? '-'}</b>（点击率 <b>${f.ctr !== undefined ? (f.ctr * 100).toFixed(1) + '%' : '-'}</b>）
      → 收藏 ${f.favorites ?? '-'} → 咨询 <b>${f.inquiries ?? '-'}</b> → 成交 <b>${f.orders ?? '-'}</b>（转化率 <b>${f.cvr !== undefined ? (f.cvr * 100).toFixed(1) + '%' : '-'}</b>）</p>
    <h3 class="sub-h">📈 近 7 天趋势</h3>
    ${table(['日期', '曝光', '浏览', '收藏', '咨询', '成交', '金额'],
      (tr.rows || []).map((row) => `<tr><td>${esc(String(row.stat_date).slice(0, 10))}</td><td>${row.exposure}</td><td>${row.views}</td>
        <td>${row.favorites}</td><td>${row.inquiries}</td><td>${row.orders}</td><td>¥${Number(row.amount).toFixed(2)}</td></tr>`).join('') || '<div class="empty">暂无趋势数据</div>')}
    <h3 class="sub-h">💡 优化建议</h3>
    ${(sug.suggestions || []).length
      ? sug.suggestions.map((s) => `<div class="diag-item sev-info"><b>【${esc(s.area)}】</b>${esc(s.message)}</div>`).join('')
      : '<div class="empty">暂无建议（数据不足或流量健康）</div>'}`);
}

/** 全店诊断：在架商品按综合得分升序（最需处理的在前） */
async function shopDiagModal() {
  WB.toast('正在生成全店诊断…', 'info');
  const r = await WB.get('/api/v1/diagnosis/overview');
  const items = r.rows || [];
  showInfoModal(`全店经营诊断（共 ${r.summary && r.summary.total ? r.summary.total : items.length} 件在架商品，按得分升序）`, `
    ${items.length ? items.map((x) => `
      <div class="diag-item sev-${x.score >= 85 ? 'ok' : x.score >= 70 ? 'medium' : 'high'}">
        <div><b>${esc(x.title)}</b>　¥${Number(x.price).toFixed(2)}
          ${badge(x.score >= 85 ? 'success' : x.score >= 70 ? 'warning' : 'failed', `${x.score} 分（${x.grade}）`)}
          ${badge('info', `问题 ${x.finding_count} 项`)}</div>
        <div class="diag-metric">${esc(x.top_finding || '—')}</div>
        <div class="diag-tip">💡 ${esc(x.top_action || '—')}</div>
      </div>`).join('') : '<div class="empty">暂无在架商品可诊断</div>'}`);
}

/* ================= M15 市场监控 ================= */
