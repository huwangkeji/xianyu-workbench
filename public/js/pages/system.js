'use strict';
// 此文件由 pages.js 模块化拆分生成（MVC 视图层按业务域分模块，app.js 按路由懒加载）
// system：账号管理 / 定时任务 / 通知中心 / AI 控制台 / 日志中心 / 系统设置 / 演示模式 / 风险中心

PAGES.accounts = async (c) => {
  let status = c.dataset.status || '';
  let keyword = c.dataset.keyword || '';
  let page = 1;
  const draw = async () => {
    const r = await WB.get(`/api/v1/accounts?page=${page}&page_size=15${status ? '&status=' + status : ''}${keyword ? '&keyword=' + encodeURIComponent(keyword) : ''}`);
    c.innerHTML = `
      ${pageHead('账号管理', '<button class="btn btn-primary" id="qr-add">📱 扫码添加</button> <button class="btn btn-primary" id="add-acc">+ 新增账号</button>')}
      <div class="toolbar">
        <input id="f-kw" placeholder="搜索昵称/账号标识" value="${esc(keyword)}" style="width:200px">
        <select id="f-status"><option value="">全部状态</option>
          ${['online', 'offline', 'error', 'disabled'].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${badge(s).match(/>([^<]+)</)[1]}</option>`).join('')}
        </select>
        <button class="btn" id="f-go">搜索</button>
        <button class="btn" id="acc-check-all">🔍 可用性检查（全部）</button>
        <button class="btn" id="acc-batch-on">批量上线</button>
        <button class="btn" id="acc-batch-off">批量下线</button>
        <button class="btn" id="do-refresh">刷新</button>
      </div>
      ${table(['<input type="checkbox" id="sel-all-acc">', 'ID', '账号标识', '昵称', '状态', '自动回复', '自动发货', '自动评价', 'Cookie', '商品/会话', '操作'],
        r.list.map((a) => {
          const cs = a.cookie_state || 'unknown';
          const sessDead = a.status === 'error'; // 可用性检查判定登录会话失效（Cookie 到期时间为估计值，以检查为准）
          const csBadge = sessDead ? badge('bad', '会话失效')
            : cs === 'none' ? '<span class="hint">未配置</span>'
              : `${badge(cs === 'ok' ? 'ok' : cs, cs === 'expiring' ? `即将过期(${a.cookie_hours}h)` : cs === 'expired' ? '已过期' : cs === 'unknown' ? '未知' : '有效')}`;
          const statusCell = `${badge(a.status)}${sessDead ? '<div class="hint" style="margin-top:2px">登录会话已失效<br>重新扫码即恢复</div>' : ''}`;
          const cookieCell = `${csBadge}<div class="hint">${fmt(a.cookie_expires_at)}${sessDead ? '<br>到期时间仅为估计' : ''}</div>`;
          return `<tr>
          <td><input type="checkbox" class="acc-sel" data-id="${a.id}"></td>
          <td>${a.id}</td><td>${esc(a.account_id)}</td><td>${esc(a.nickname)}${a.paused ? ' ' + badge('warning', `接管中(${a.paused_minutes}分)`) : ''}${a.is_default ? ' ' + badge('ok', '默认') : ''}</td><td>${statusCell}</td>
          <td>${a.auto_reply_enabled ? '✓' : '—'}</td><td>${a.auto_delivery_enabled ? '✓' : '—'}</td><td>${a.auto_rate_enabled ? '✓' : '—'}</td>
          <td>${cookieCell}</td>
          <td><a href="#/items" class="acc-jump-items" data-nick="${esc(a.nickname)}" style="cursor:pointer">${a.item_count}</a> / <a href="#/messages" class="acc-jump-conv" data-nick="${esc(a.nickname)}" style="cursor:pointer">${a.conversation_count}</a></td>
          <td class="ops">
            ${a.status === 'online' ? `<button class="btn btn-sm act-off" data-id="${a.id}">下线</button>` : `<button class="btn btn-sm act-on" data-id="${a.id}">上线</button>`}
            ${a.is_default ? '' : (WB.user && WB.user.role === 'admin' ? `<button class="btn btn-sm act-def" data-id="${a.id}" title="设为工作台默认账号（登录后自动选中）">设为默认</button>` : '')}
            <button class="btn btn-sm act-sync" data-id="${a.id}" title="从闲鱼拉取该账号在架商品">同步商品</button>
            <button class="btn btn-sm act-cookie" data-id="${a.id}">刷新Cookie</button>
            <button class="btn btn-sm act-pause" data-id="${a.id}" data-paused="${a.paused ? 1 : 0}">${a.paused ? '恢复回复' : '人工接管'}</button>
            <button class="btn btn-sm act-check" data-id="${a.id}">检查</button>
            <button class="btn btn-sm act-edit" data-id="${a.id}">编辑</button>
            <button class="btn btn-sm btn-danger act-del" data-id="${a.id}">删除</button>
          </td></tr>`;
        }).join(''))}
      <div class="pager" id="pager"></div>`;
    WB.paginate(c.querySelector('#pager'), r.total, page, 15, (p) => { page = p; draw(); });
    c.querySelector('#sel-all-acc').onchange = (e) => {
      c.querySelectorAll('.acc-sel').forEach((cb) => { cb.checked = e.target.checked; });
    };
    const batchToggle = async (target) => {
      const ids = [...c.querySelectorAll('.acc-sel:checked')].map((cb) => cb.dataset.id);
      if (!ids.length) { WB.toast('请先勾选账号', 'error'); return; }
      for (const id of ids) {
        await WB.post(`/api/v1/accounts/${id}/${target}`).catch((e) => WB.toast(e.message, 'error'));
      }
      WB.toast(`已批量${target === 'online' ? '上线' : '下线'} ${ids.length} 个账号`);
      draw();
    };
    c.querySelector('#acc-batch-on').onclick = () => batchToggle('online');
    c.querySelector('#acc-batch-off').onclick = () => batchToggle('offline');
    c.querySelectorAll('.acc-jump-items').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        const tr = a.closest('tr');
        const acc = r.list.find((x) => String(x.id) === tr.querySelector('.acc-sel').dataset.id);
        sessionStorage.setItem('wb_items_account', JSON.stringify({ id: acc.id, nickname: acc.nickname }));
        location.hash = '#/items';
      };
    });
    c.querySelectorAll('.acc-jump-conv').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        sessionStorage.setItem('wb_conv_keyword', a.dataset.nick);
        location.hash = '#/messages';
      };
    });
    c.querySelector('#f-status').onchange = (e) => { status = e.target.value; c.dataset.status = status; page = 1; draw(); };
    c.querySelector('#f-go').onclick = () => { keyword = c.querySelector('#f-kw').value.trim(); c.dataset.keyword = keyword; page = 1; draw(); };
    c.querySelector('#f-kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') c.querySelector('#f-go').click(); });
    c.querySelector('#do-refresh').onclick = draw;
    c.querySelector('#add-acc').onclick = () => accModal(null, accDone);
    c.querySelector('#qr-add').onclick = () => qrModal(accDone);
    c.querySelector('#acc-check-all').onclick = () => checkAllAccountsModal(draw);
    c.querySelectorAll('.act-on').forEach((b) => { b.onclick = () => WB.post(`/api/v1/accounts/${b.dataset.id}/online`).then(draw).catch((e) => WB.toast(e.message, 'error')); });
    c.querySelectorAll('.act-off').forEach((b) => { b.onclick = () => WB.post(`/api/v1/accounts/${b.dataset.id}/offline`).then(draw).catch((e) => WB.toast(e.message, 'error')); });
    c.querySelectorAll('.act-def').forEach((b) => {
      b.onclick = async () => {
        try {
          await WB.put('/api/v1/settings', { default_account_id: String(b.dataset.id) });
          WB.toast('已设为默认账号（登录/刷新页面后自动选中）');
          WB.refreshAccountSwitcher();
          draw();
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
    c.querySelectorAll('.act-cookie').forEach((b) => { b.onclick = () => WB.post(`/api/v1/accounts/${b.dataset.id}/refresh-cookie`).then((r) => WB.toast(r.message || 'Cookie 已刷新')).catch((e) => WB.toast(e.message, 'error')); });
    c.querySelectorAll('.act-sync').forEach((b) => {
      b.onclick = async () => {
        WB.toast('正在从闲鱼拉取该账号在架商品…', 'info');
        try {
          const r = await WB.post(`/api/v1/accounts/${b.dataset.id}/sync-items`);
          const plat = r.api_total_count !== null && r.api_total_count !== undefined ? `平台在售 ${r.api_total_count} 件，` : '';
          WB.toast(`同步完成：${plat}入库 ${r.total} 件（新增 ${r.added}，更新 ${r.updated}），请到「商品中心」查看`);
          draw();
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
    c.querySelectorAll('.act-pause').forEach((b) => {
      b.onclick = async () => {
        const paused = b.dataset.paused === '1';
        if (paused) {
          try {
            await WB.post(`/api/v1/accounts/${b.dataset.id}/pause`, { minutes: 0 });
            WB.toast('已恢复自动回复');
            draw();
          } catch (e) { WB.toast(e.message, 'error'); }
          return;
        }
        WB.openModal({
          title: '人工接管（暂停自动回复）',
          body: `
            <label>接管时长（分钟，到点自动恢复自动回复）</label>
            <input name="minutes" type="number" min="1" max="1440" value="60">
            <p class="hint">接管期间该账号的买家消息<b>不会自动回复</b>，请到「消息会话」人工处理；可随时点击"恢复回复"提前结束。</p>`,
          onSubmit: async (v) => {
            const r = await WB.post(`/api/v1/accounts/${b.dataset.id}/pause`, { minutes: Number(v.minutes) || 60 });
            WB.toast(`已进入人工接管 ${r.paused_minutes} 分钟`);
            draw();
          },
        });
      };
    });
    c.querySelectorAll('.act-check').forEach((b) => {
      b.onclick = async () => {
        WB.toast('正在检查该账号可用性…', 'info');
        try {
          const r = await WB.post(`/api/v1/accounts/${b.dataset.id}/check`);
          WB.toast(`${r.nickname}: ${r.available ? '✅ 可用' : '❌ 不可用'} — ${r.reason}`, r.available ? 'ok' : 'error');
          draw();
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
    c.querySelectorAll('.act-del').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.id;
        try {
          // 第一次尝试（无级联）：有关联数据时后端返回 40003 + 计数 → 弹后果确认
          await WB.del(`/api/v1/accounts/${id}`);
          WB.toast('已删除');
          accDone();
          return;
        } catch (e) {
          if (e.code !== 40003 || !e.data) { WB.toast(e.message, 'error'); return; }
          const d = e.data;
          const lines = [
            `账号「${d.account.nickname}」（${d.account.account_id}）存在以下关联数据：`,
            `商品 ${d.items} 件、订单 ${d.orders} 单、会话 ${d.conversations} 个、买家档案 ${d.buyers} 条、回复规则 ${d.rules} 条、卡券产品 ${d.card_products} 个`,
            { text: '级联删除将一并清除以上全部业务数据（回复/风控等历史日志保留）；否则请先处理关联数据。', danger: true },
          ];
          const ok = await WB.confirmDanger(`删除账号「${d.account.nickname}」`, lines, { confirmText: '确认并级联删除', needText: d.account.account_id });
          if (!ok) return;
          try {
            const resp = await fetch(`/api/v1/accounts/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + WB.token }, body: JSON.stringify({ cascade: true }) });
            const jr = await resp.json();
            if (!jr.success) throw new Error(jr.message);
            WB.toast('账号及其业务数据已级联删除');
            accDone();
          } catch (e2) { WB.toast(e2.message, 'error'); }
        }
      };
    });
    c.querySelectorAll('.act-edit').forEach((b) => {
      b.onclick = async () => {
        const acc = await WB.get(`/api/v1/accounts/${b.dataset.id}`);
        accModal(acc, accDone);
      };
    });
  };
  // 账号增删改后同步刷新侧栏切换器（默认标记/账号列表可能变化）
  const accDone = () => { draw(); WB.refreshAccountSwitcher(); };
  await draw();
};

function accModal(acc, done) {
  WB.openModal({
    title: acc ? `编辑账号 #${acc.id}` : '新增账号',
    body: `
      <label>平台账号标识 ${acc ? '' : '<i class="req">*</i>'}</label>
      <input name="account_id" value="${esc(acc ? acc.account_id : '')}" ${acc ? 'disabled' : 'required'}>
      <label>昵称 <i class="req">*</i></label><input name="nickname" value="${esc(acc ? acc.nickname : '')}" required>
      <label>Cookie${acc ? '（留空 = 保留原凭证）' : ''}</label><textarea name="cookie" rows="3" placeholder="${acc ? '留空则不修改 Cookie' : '真实凭证请用「扫码添加」；手填场景才在此粘贴'}"></textarea>
      <div class="form-row">
        <div><label>回复延迟下限(ms，0=用全局设置)</label><input name="reply_delay_min_ms" type="number" min="0" max="60000" value="${acc ? acc.reply_delay_min_ms : 0}"></div>
        <div><label>回复延迟上限(ms，0=用全局设置)</label><input name="reply_delay_max_ms" type="number" min="0" max="60000" value="${acc ? acc.reply_delay_max_ms : 0}"></div>
      </div>
      <label>备注</label><input name="remark" value="${esc(acc ? acc.remark : '')}">
      <div class="check-row">
        <label><input type="checkbox" name="auto_reply_enabled" ${!acc || acc.auto_reply_enabled ? 'checked' : ''}> 自动回复</label>
        <label><input type="checkbox" name="auto_delivery_enabled" ${!acc || acc.auto_delivery_enabled ? 'checked' : ''}> 自动发货</label>
        <label><input type="checkbox" name="auto_rate_enabled" ${acc && acc.auto_rate_enabled ? 'checked' : ''}> 自动评价</label>
      </div>`,
    onSubmit: async (v) => {
      if (acc) { const { account_id, ...rest } = v; await WB.put(`/api/v1/accounts/${acc.id}`, rest); }
      else await WB.post('/api/v1/accounts', v);
      WB.toast('已保存');
      done();
    },
  });
}

/* ================= 扫码添加账号（闲鱼 App 扫码登录，见 services/qrlogin.js） ================= */
function qrModal(done) {
  const root = document.getElementById('modal-root');
  let timer = null;
  let sessionId = null;
  let deadline = 0;

  const close = () => { if (timer) { clearInterval(timer); timer = null; } root.innerHTML = ''; };
  const stopPoll = () => { if (timer) { clearInterval(timer); timer = null; } };
  const box = () => root.querySelector('#qr-area');
  const statusEl = () => root.querySelector('#qr-status');
  const setStatus = (html, cls) => {
    const el = statusEl();
    if (el) el.innerHTML = `<span class="qr-status ${cls || ''}">${html}</span>`;
  };
  const remainSec = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

  function applyStatus(st) {
    if (st.status === 'waiting') {
      setStatus(`等待扫码…（请用闲鱼 App「扫一扫」，剩 ${remainSec()} 秒）`);
    } else if (st.status === 'scanned') {
      setStatus(`已扫描，请在手机上确认登录（剩 ${remainSec()} 秒）`, 'warn');
    } else if (st.status === 'verification_required') {
      stopPoll();
      const link = st.verification_url ? ` <a href="${esc(st.verification_url)}" target="_blank" rel="noopener">打开验证页面</a>` : '';
      setStatus(`触发风控，需要手机验证。${link}完成后可重新扫码`, 'bad');
    } else if (st.status === 'success') {
      stopPoll();
      const acc = st.account || {};
      const name = acc.nickname || st.unb || '账号';
      setStatus(`登录成功：<b>${esc(name)}</b>（${esc(st.unb || acc.account_id || '')}）已加入账号列表`, 'ok');
      WB.toast(`账号 ${name} 已添加`);
      setTimeout(() => { close(); done(); }, 900);
    } else if (st.status === 'expired') {
      stopPoll();
      setStatus('二维码已过期，请点击「重新生成」', 'bad');
    } else if (st.status === 'cancelled') {
      stopPoll();
      setStatus('已在手机上取消登录，可点击「重新生成」', 'bad');
    } else if (st.status === 'failed') {
      stopPoll();
      setStatus('登录失败（未捕获登录凭证或入库失败），请重新生成二维码重试', 'bad');
    }
  }

  async function pollOnce() {
    try {
      applyStatus(await WB.get('/api/v1/accounts/qr-login/' + sessionId));
    } catch (e) {
      stopPoll();
      setStatus('查询扫码状态失败: ' + esc(e.message), 'bad');
    }
  }

  function startPolling(expiresIn) {
    deadline = Date.now() + expiresIn * 1000;
    let tick = 0;
    timer = setInterval(() => {
      tick += 1;
      if (tick % 2 === 0) pollOnce(); // 每 2 秒查一次状态；倒计时每秒刷新
      else if (timer) {
        const cur = statusEl();
        if (cur && cur.querySelector('.qr-status') && cur.textContent.indexOf('等待扫码') >= 0) {
          setStatus(`等待扫码…（请用闲鱼 App「扫一扫」，剩 ${remainSec()} 秒）`);
        }
      }
    }, 1000);
  }

  async function start() {
    stopPoll();
    sessionId = null;
    if (box()) box().innerHTML = '<div class="qr-status">正在生成二维码…</div>';
    setStatus('');
    try {
      const r = await WB.post('/api/v1/accounts/qr-login/start');
      sessionId = r.session_id;
      let svg = '';
      try {
        const qr = qrcode(0, 'L');
        qr.addData(r.qr_content);
        qr.make();
        svg = qr.createSvgTag({ cellSize: 4, margin: 2 });
      } catch (e) {
        box().innerHTML = `<div class="qr-status bad">二维码渲染失败: ${esc(e.message)}</div>`;
        return;
      }
      box().innerHTML = svg;
      setStatus('等待扫码…（请用闲鱼 App「扫一扫」）');
      startPolling(r.expires_in);
    } catch (e) {
      if (box()) box().innerHTML = '';
      setStatus('生成二维码失败: ' + esc(e.message), 'bad');
    }
  }

  root.innerHTML = `
    <div class="modal-mask" id="qr-mask">
      <div class="modal">
        <div class="modal-head">
          <span>扫码添加闲鱼账号</span>
          <button type="button" class="modal-x" id="qr-x">×</button>
        </div>
        <div class="modal-body">
          <div class="qr-box"><div id="qr-area" class="qr-area">正在生成二维码…</div><div id="qr-status"></div></div>
        </div>
        <div class="modal-foot">
          <span class="modal-err"></span>
          <button type="button" class="btn" id="qr-regen">重新生成</button>
          <button type="button" class="btn btn-primary" id="qr-close">关闭</button>
        </div>
      </div>
    </div>`;
  root.querySelector('#qr-x').onclick = close;
  root.querySelector('#qr-close').onclick = close;
  root.querySelector('#qr-regen').onclick = start;
  root.querySelector('#qr-mask').addEventListener('click', (e) => { if (e.target.id === 'qr-mask') close(); });
  start();
  return close;
}

/** 批量可用性检查弹窗（真实账号走闲鱼凭证校验，演示账号按状态判定） */
async function checkAllAccountsModal(done) {
  WB.toast('正在检查全部账号（真实账号需请求闲鱼接口，请稍候）…', 'info');
  const r = await WB.post('/api/v1/accounts/check-all');
  WB.openModal({
    title: `账号可用性检查：可用 ${r.summary.available} / 共 ${r.summary.total}（不可用 ${r.summary.unavailable}）`,
    wide: true,
    body: table(['账号标识', '昵称', '状态', '检查结果', '说明'],
      r.results.map((x) => `<tr>
        <td>${esc(x.account_identifier)}</td><td>${esc(x.nickname)}</td><td>${badge(x.status)}</td>
        <td>${x.available ? badge('success', '可用') : badge('failed', '不可用')}${x.simulated ? ' <span class="hint">模拟</span>' : ''}</td>
        <td class="clip" title="${esc(x.reason)}">${esc(x.reason)}</td>
      </tr>`).join('')) + '<div></div>',
    onSubmit: async () => {},
  });
  document.querySelector('#modal-ok').textContent = '关闭';
  if (done) done();
}

/* ================= 运行模式切换（生产 ⇄ 演示，切换自动重启并要求重新登录） ================= */

/* ================= 定时任务 ================= */
PAGES.tasks = async (c) => {
  const TYPE_LABELS = {
    item_polish: '擦亮', order_sync: '订单同步', delivery_retry: '发货补发', auto_rate: '自动评价',
    cookie_check: 'Cookie检查', crm_followup: '客户跟进', market_scan: '行情扫描', daily_brief: '每日运营简报',
  };
  const draw = async () => {
    const [tasks, accounts] = await Promise.all([WB.get('/api/v1/tasks' + (WB.activeAccountId ? '?account_id=' + encodeURIComponent(WB.activeAccountId) : '')), loadAccounts()]);
    const allPaused = tasks.length > 0 && tasks.every((t) => !t.enabled);
    c.innerHTML = `
      ${pageHead('定时任务', `
        <button class="btn" id="task-toggle-all">${allPaused ? '▶ 全部启用' : '⏸ 全部暂停'}</button>
        <button class="btn btn-primary" id="task-add">+ 新建任务</button>
        <button class="btn" id="do-refresh">刷新</button>`)}
      <p class="hint">调度器每 5 秒扫描到期任务；手动执行不受启用状态限制。失败任务自动记录并计入失败次数，进程重启后中断任务自动恢复。可新建同类型任务绑定到单个账号（如仅擦亮某账号的商品）。${WB.activeAccountId ? '当前显示绑定所选账号的任务及全局任务。' : ''}</p>
      ${table(['ID', '任务', '类型', '账号', '间隔(秒)', '启用', '上次状态', '上次结果', '上次/下次执行', '次数(成/败)', '操作'],
        tasks.map((t) => `<tr>
          <td>${t.id}</td><td>${esc(t.name)}</td>
          <td>${TYPE_LABELS[t.task_type] || t.task_type}</td>
          <td>${t.account_id ? esc(t.account_nickname || ('#' + t.account_id)) : '全部'}</td>
          <td>${t.interval_seconds}</td><td>${t.enabled ? '✓' : '—'}</td>
          <td>${badge(t.last_status)}</td><td class="clip" title="${esc(t.last_message)}">${esc(t.last_message || '-')}</td>
          <td>${fmt(t.last_run_at)}<br>${fmt(t.next_run_at)}</td>
          <td>${t.run_count - t.fail_count}/${t.fail_count}</td>
          <td class="ops">
            <button class="btn btn-sm act-run" data-id="${t.id}">立即执行</button>
            <button class="btn btn-sm act-edit" data-id="${t.id}">编辑</button>
            <button class="btn btn-sm act-hist" data-id="${t.id}">历史</button>
            <button class="btn btn-sm btn-danger act-del" data-id="${t.id}">删除</button>
          </td></tr>`).join(''))}`;
    c.querySelector('#do-refresh').onclick = draw;
    c.querySelector('#task-add').onclick = () => {
      WB.openModal({
        title: '新建定时任务',
        body: `
          <label>任务名称 <i class="req">*</i></label><input name="name" required placeholder="如：仅擦亮数码二店">
          <label>任务类型 <i class="req">*</i></label>
          <select name="task_type">${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <label>绑定账号（不选 = 全部账号）</label>
          <select name="account_id"><option value="">全部账号</option>${opts(accounts, 'id', (a) => a.nickname)}</select>
          <label>执行间隔（秒，≥10）</label><input name="interval_seconds" type="number" min="10" value="300">
          <div class="check-row"><label><input type="checkbox" name="enabled" checked> 启用</label></div>`,
        onSubmit: async (v) => { await WB.post('/api/v1/tasks', v); WB.toast('任务已创建'); draw(); },
      });
    };
    c.querySelector('#task-toggle-all').onclick = async () => {
      const target = !allPaused;
      if (!WB.confirmDialog(target ? '确认全部启用？' : '确认全部暂停？（不影响正在执行的任务）')) return;
      for (const t of tasks) {
        if (t.enabled !== (target ? 1 : 0)) {
          await WB.put(`/api/v1/tasks/${t.id}`, { enabled: target }).catch((e) => WB.toast(`「${t.name}」${e.message}`, 'error'));
        }
      }
      WB.toast(target ? '已全部启用' : '已全部暂停');
      draw();
    };
    c.querySelectorAll('.act-run').forEach((b) => {
      b.onclick = () => WB.post(`/api/v1/tasks/${b.dataset.id}/run`)
        .then((r) => { WB.toast(`执行${r.status === 'success' ? '成功' : '失败'}：${r.message}`); draw(); })
        .catch((e) => WB.toast(e.message, 'error'));
    });
    c.querySelectorAll('.act-edit').forEach((b) => {
      b.onclick = () => {
        const t = tasks.find((x) => String(x.id) === b.dataset.id);
        WB.openModal({
          title: `编辑任务「${t.name}」`,
          body: `<label>任务名称</label><input name="name" value="${esc(t.name)}" required>
            <label>执行间隔（秒，≥10）</label><input name="interval_seconds" type="number" min="10" value="${t.interval_seconds}">
            <div class="check-row"><label><input type="checkbox" name="enabled" ${t.enabled ? 'checked' : ''}> 启用</label></div>`,
          onSubmit: async (v) => { await WB.put(`/api/v1/tasks/${t.id}`, v); WB.toast('已保存'); draw(); },
        });
      };
    });
    c.querySelectorAll('.act-hist').forEach((b) => {
      b.onclick = async () => {
        const r = await WB.get(`/api/v1/task-runs?task_id=${b.dataset.id}&page_size=15`);
        WB.openModal({
          title: '任务执行历史（最近15次）',
          wide: true,
          body: table(['ID', '状态', '结果', '处理数', '开始', '耗时(ms)'],
            r.list.map((run) => `<tr><td>${run.id}</td><td>${badge(run.status)}</td>
              <td class="clip">${esc(run.message)}</td><td>${run.affected}</td><td>${fmt(run.started_at)}</td><td>${run.duration_ms || '-'}</td></tr>`).join('')) + '<div></div>',
          onSubmit: async () => {},
        });
        const okBtn = document.querySelector('#modal-ok');
        okBtn.textContent = '关闭';
      };
    });
    c.querySelectorAll('.act-del').forEach((b) => {
      b.onclick = async () => {
        const t = tasks.find((x) => String(x.id) === b.dataset.id);
        const ok = await WB.confirmDanger('删除定时任务', [
          `任务「${t.name}」（${TYPE_LABELS[t.task_type] || t.task_type}）`,
          { text: '将同时删除该任务的全部执行历史，不可恢复。', danger: true },
        ], { confirmText: '确认删除' });
        if (!ok) return;
        try { await WB.del(`/api/v1/tasks/${t.id}`); WB.toast('已删除'); draw(); } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
  };
  await draw();
};

/* ================= 通知中心 ================= */
PAGES.notify = async (c) => {
  const EVENT_LABELS = {
    new_order: '新订单', delivery_failed: '发货失败', risk_intercept: '风控拦截',
    followup_due: '客户跟进提醒', task_failed: '任务失败', risk_alert: '风险预警', competitor_alert: '竞品降价',
  };
  const draw = async () => {
    let logEvent = c.dataset.logEvent || '';
    let logStatus = c.dataset.logStatus || '';
    const [channels, rules, logs] = await Promise.all([
      WB.get('/api/v1/notify/channels'),
      WB.get('/api/v1/notify/rules'),
      WB.get(`/api/v1/notify/logs?page_size=10${logEvent ? '&event_type=' + logEvent : ''}${logStatus ? '&status=' + logStatus : ''}`),
    ]);
    c.innerHTML = `
      ${pageHead('通知中心', '<button class="btn btn-primary" id="add-ch">+ 新增渠道</button>')}
      <h3 class="sub-h">通知渠道（webhook_url 以 mock:// 开头表示仅记录不真实推送）</h3>
      ${table(['ID', '名称', '类型', '推送地址', '启用', '订阅数', '操作'],
        channels.map((ch) => `<tr><td>${ch.id}</td><td>${esc(ch.name)}</td><td>${esc(ch.channel_type)}</td>
          <td class="clip" title="${esc(ch.webhook_url)}">${esc(ch.webhook_url)}</td><td>${ch.enabled ? '✓' : '—'}</td><td>${ch.rule_count}</td>
          <td class="ops">
            <button class="btn btn-sm act-ch-test" data-id="${ch.id}">测试</button>
            <button class="btn btn-sm act-ch-edit" data-id="${ch.id}">编辑</button>
            <button class="btn btn-sm btn-danger act-ch-del" data-id="${ch.id}">删除</button>
          </td></tr>`).join(''))}
      <h3 class="sub-h">通知规则（事件 → 渠道，可订阅：${Object.values(EVENT_LABELS).join(' / ')}）</h3>
      <div class="toolbar">
        <button class="btn btn-primary" id="add-rule">+ 新增通知规则</button>
      </div>
      ${table(['ID', '事件', '渠道', '启用', '操作'],
        rules.map((r) => `<tr><td>${r.id}</td>
          <td>${EVENT_LABELS[r.event_type] || esc(r.event_type)}</td>
          <td>${esc(r.channel_name || ('#' + r.channel_id))}</td><td>${r.enabled ? '✓' : '—'}</td>
          <td class="ops">
            <button class="btn btn-sm act-r-toggle" data-id="${r.id}" data-en="${r.enabled ? 1 : 0}">${r.enabled ? '停用' : '启用'}</button>
            <button class="btn btn-sm btn-danger act-r-del" data-id="${r.id}">删除</button>
          </td></tr>`).join(''))}
      <h3 class="sub-h">推送日志（最近 10 条）</h3>
      <div class="toolbar">
        <select id="nl-event"><option value="">全部事件</option>
          ${Object.entries(EVENT_LABELS).map(([k, v]) => `<option value="${k}" ${logEvent === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <select id="nl-status"><option value="">全部状态</option>
          ${['success', 'failed', 'mock'].map((s) => `<option value="${s}" ${logStatus === s ? 'selected' : ''}>${badge(s).match(/>([^<]+)</)[1]}</option>`).join('')}
        </select>
      </div>
      ${table(['时间', '渠道', '事件', '标题', '状态', '错误'],
        logs.list.map((l) => `<tr><td>${fmt(l.created_at)}</td><td>${esc(l.channel_name)}</td><td>${EVENT_LABELS[l.event_type] || esc(l.event_type)}</td>
          <td class="clip">${esc(l.title)}</td><td>${badge(l.status)}</td><td class="clip">${esc(l.error_message || '')}</td></tr>`).join(''))}`;
    c.querySelector('#nl-event').onchange = (e) => { logEvent = e.target.value; c.dataset.logEvent = logEvent; draw(); };
    c.querySelector('#nl-status').onchange = (e) => { logStatus = e.target.value; c.dataset.logStatus = logStatus; draw(); };
    c.querySelector('#add-ch').onclick = () => chModal(null, draw);
    c.querySelectorAll('.act-ch-edit').forEach((b) => {
      b.onclick = () => chModal(channels.find((x) => String(x.id) === b.dataset.id), draw);
    });
    c.querySelectorAll('.act-ch-test').forEach((b) => {
      b.onclick = async () => {
        WB.toast('测试消息发送中…', 'info');
        try {
          const r = await WB.post(`/api/v1/notify/channels/${b.dataset.id}/test`);
          WB.toast(`「${r.channel_name}」${r.message}`, r.status === 'failed' ? 'error' : 'ok');
          draw();
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
    c.querySelectorAll('.act-ch-del').forEach((b) => {
      b.onclick = async () => {
        const ch = channels.find((x) => String(x.id) === b.dataset.id);
        const ok = await WB.confirmDanger('删除通知渠道', [
          `渠道「${ch.name}」及其订阅的 ${ch.rule_count} 条通知规则`,
          { text: '删除后该渠道将不再收到任何事件推送。', danger: true },
        ], { confirmText: '确认删除' });
        if (!ok) return;
        try { await WB.del(`/api/v1/notify/channels/${b.dataset.id}`); draw(); } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
    c.querySelector('#add-rule').onclick = () => {
      if (!channels.length) { WB.toast('请先创建通知渠道', 'error'); return; }
      WB.openModal({
        title: '新增通知规则',
        body: `<label>事件类型</label><select name="event_type">
            ${Object.entries(EVENT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <label>渠道</label><select name="channel_id">${opts(channels, 'id', (ch) => ch.name)}</select>`,
        onSubmit: async (v) => { await WB.post('/api/v1/notify/rules', v); WB.toast('已创建'); draw(); },
      });
    };
    c.querySelectorAll('.act-r-toggle').forEach((b) => {
      b.onclick = () => WB.put(`/api/v1/notify/rules/${b.dataset.id}`, { enabled: b.dataset.en === '1' ? false : true })
        .then(draw).catch((e) => WB.toast(e.message, 'error'));
    });
    c.querySelectorAll('.act-r-del').forEach((b) => {
      b.onclick = async () => {
        if (!WB.confirmDialog('确认删除该通知规则？')) return;
        try { await WB.del(`/api/v1/notify/rules/${b.dataset.id}`); draw(); } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
  };
  await draw();
};

function chModal(ch, done) {
  WB.openModal({
    title: ch ? `编辑渠道 #${ch.id}` : '新增通知渠道',
    body: `
      <label>名称 <i class="req">*</i></label><input name="name" value="${esc(ch ? ch.name : '')}" required>
      <label>类型</label><select name="channel_type">
        ${['wecom', 'dingtalk', 'feishu', 'bark', 'webhook'].map((t) => `<option value="${t}" ${ch && ch.channel_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <label>webhook 地址（mock:// 开头=仅记录）</label><input name="webhook_url" value="${esc(ch ? ch.webhook_url : '')}">
      <label>加签密钥${ch ? '（留空 = 保留原值）' : ''}</label><input name="secret" value="" placeholder="${ch && ch.secret_set ? '已配置，留空保留' : '未配置'}">
      <div class="check-row"><label><input type="checkbox" name="enabled" ${!ch || ch.enabled ? 'checked' : ''}> 启用</label></div>`,
    onSubmit: async (v) => {
      if (ch) { const { ...rest } = v; if (!rest.secret) delete rest.secret; await WB.put(`/api/v1/notify/channels/${ch.id}`, rest); }
      else await WB.post('/api/v1/notify/channels', v);
      WB.toast('已保存');
      done();
    },
  });
}

/* ================= 日志中心 ================= */
PAGES.logs = async (c) => {
  let tab = c.dataset.tab || 'reply';
  let page = 1;
  let keyword = c.dataset.keyword || '';
  let level = c.dataset.level || '';
  const draw = async () => {
    const kwQ = keyword ? '&keyword=' + encodeURIComponent(keyword) : '';
    const lvQ = level ? '&level=' + level : '';
    let body = '';
    if (tab === 'reply') {
      const r = await WB.get(`/api/v1/logs/reply?page=${page}&page_size=20${kwQ}${accQ()}`);
      body = table(['时间', '账号', '买家消息', '结果', '原因', '策略', '命中', '回复内容'],
        r.list.map((l) => `<tr><td>${fmt(l.created_at)}</td><td>${esc(l.account_nickname || l.account_id)}</td>
          <td class="clip" title="${esc(l.source_message)}">${esc(l.source_message)}</td>
          <td>${badge(l.process_status)}</td><td>${esc(l.decision_reason)}</td><td>${esc(l.reply_strategy)}</td>
          <td>${esc(l.matched_keyword || '-')}</td><td class="clip" title="${esc(l.reply_text || '')}">${esc(l.reply_text || '-')}</td></tr>`).join(''));
      body += `<div class="pager" id="pager"></div>`;
      c.innerHTML = head() + body;
      WB.paginate(c.querySelector('#pager'), r.total, page, 20, (p) => { page = p; draw(); });
    } else if (tab === 'system') {
      const r = await WB.get(`/api/v1/logs/system?page=${page}&page_size=20${kwQ}${lvQ}`);
      body = table(['时间', '级别', '模块', '内容'],
        r.list.map((l) => `<tr><td>${fmt(l.created_at)}</td><td>${badge(l.level)}</td><td>${esc(l.module)}</td>
          <td class="clip" title="${esc(l.message)}">${esc(l.message)}</td></tr>`).join(''));
      body += `<div class="pager" id="pager"></div>`;
      c.innerHTML = head() + body;
      WB.paginate(c.querySelector('#pager'), r.total, page, 20, (p) => { page = p; draw(); });
    } else {
      const r = await WB.get(`/api/v1/logs/risk?page=${page}&page_size=20${lvQ}${accQ()}`);
      body = table(['时间', '账号', '事件', '级别', '详情'],
        r.list.map((l) => `<tr><td>${fmt(l.created_at)}</td><td>${esc(l.account_nickname || l.account_id || '-')}</td>
          <td>${esc(l.event_type)}</td><td>${badge(l.level)}</td><td class="clip" title="${esc(l.detail)}">${esc(l.detail)}</td></tr>`).join(''));
      body += `<div class="pager" id="pager"></div>`;
      c.innerHTML = head() + body;
      WB.paginate(c.querySelector('#pager'), r.total, page, 20, (p) => { page = p; draw(); });
    }
    const fgo = c.querySelector('#f-go');
    if (fgo) {
      fgo.onclick = () => {
        keyword = (c.querySelector('#f-kw') || {}).value?.trim() || '';
        level = (c.querySelector('#f-level') || {}).value || '';
        c.dataset.keyword = keyword; c.dataset.level = level;
        page = 1; draw();
      };
      const fk = c.querySelector('#f-kw');
      if (fk) fk.addEventListener('keydown', (e) => { if (e.key === 'Enter') fgo.click(); });
    }
    c.querySelectorAll('.tab-btn').forEach((b) => {
      b.onclick = () => { tab = b.dataset.tab; c.dataset.tab = tab; page = 1; draw(); };
    });
  };
  function head() {
    const levelOptions = tab === 'system'
      ? ['debug', 'info', 'warn', 'error'].map((l) => `<option value="${l}" ${level === l ? 'selected' : ''}>${l}</option>`).join('')
      : (tab === 'risk' ? ['info', 'warning', 'danger'].map((l) => `<option value="${l}" ${level === l ? 'selected' : ''}>${l}</option>`).join('') : '');
    return `
      ${pageHead('日志中心', '<button class="btn" id="do-refresh">刷新</button>')}
      <div class="tabs">
        <button class="tab-btn ${tab === 'reply' ? 'active' : ''}" data-tab="reply">回复日志</button>
        <button class="tab-btn ${tab === 'system' ? 'active' : ''}" data-tab="system">系统日志</button>
        <button class="tab-btn ${tab === 'risk' ? 'active' : ''}" data-tab="risk">风控日志</button>
      </div>
      <div class="toolbar">
        ${tab !== 'risk' ? `<input id="f-kw" placeholder="${tab === 'reply' ? '搜索消息/回复关键词' : '搜索日志内容'}" value="${esc(keyword)}" style="width:220px">` : ''}
        ${tab !== 'reply' ? `<select id="f-level"><option value="">全部级别</option>${levelOptions}</select>` : ''}
        <button class="btn" id="f-go">筛选</button>
      </div>`;
  }
  await draw();
  c.querySelector('#do-refresh').onclick = draw;
};

/* ================= 系统设置 ================= */
PAGES.settings = async (c) => {
  let tab = c.dataset.tab || 'sys';
  const isAdmin = WB.user && WB.user.role === 'admin';
  const tabs = [['sys', '⚙️ 系统设置'], ['users', '👥 用户管理'], ['backup', '💾 备份与恢复']].filter(([k]) => k === 'sys' || isAdmin);
  let active = sessionStorage.getItem('wb_tab_settings') || 'sys';
  if (!tabs.some(([k]) => k === active)) active = 'sys';

  const drawSys = async (c2) => {
    const settings = await WB.get('/api/v1/settings');
    const field = (s) => {
      if (s.type === 'enum') {
        return `<select name="${s.key}">${s.values.map((v) => `<option value="${v}" ${v === s.value ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
      }
      if (s.type === 'int') {
        return `<input name="${s.key}" type="number" value="${esc(s.value)}">`;
      }
      return `<input name="${s.key}" value="${esc(s.value)}">`;
    };
    c2.innerHTML = `
      ${pageHead('系统设置', '<button class="btn" id="reset-defaults">恢复默认值</button> <button class="btn btn-primary" id="save-settings">保存全部</button>')}
      <p class="hint">connector_mode=live 为真实对接预留位（未实现，保存后引擎动作将返回 50101）。会话有效期 session_ttl_hours 保存后需重新登录生效。</p>
      <form id="settings-form" class="panel">
        ${settings.map((s) => `<div class="set-row"><div><b>${esc(s.key)}</b><div class="set-remark">${esc(s.remark)}<div class="hint">默认：${esc(String(s.default))}</div></div></div>
          <div class="set-field">${field(s)}</div></div>`).join('')}
      </form>`;
    c2.querySelector('#save-settings').onclick = async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = '保存中…';
      const values = {};
      for (const el of c2.querySelectorAll('#settings-form [name]')) values[el.name] = el.value;
      try {
        await WB.put('/api/v1/settings', values);
        WB.toast('设置已保存（部分设置在下次登录时生效）');
      } catch (err) { WB.toast(err.message, 'error'); }
      btn.disabled = false;
      btn.textContent = '保存全部';
    };
    c2.querySelector('#reset-defaults').onclick = async () => {
      const ok = await WB.confirmDanger('恢复全部默认值', [
        '将把所有设置项重置为系统默认值（当前修改未保存的也会丢失）。',
      ], { confirmText: '确认恢复默认' });
      if (!ok) return;
      const defaults = {};
      for (const s of settings) defaults[s.key] = String(s.default);
      try {
        await WB.put('/api/v1/settings', defaults);
        WB.toast('已恢复默认值');
        draw();
      } catch (err) { WB.toast(err.message, 'error'); }
    };
  };

  const drawUsers = async (c2) => {
    const users = await WB.get('/api/v1/users');
    c2.innerHTML = `
      ${pageHead('用户管理', '<button class="btn btn-primary" id="user-add">+ 新建用户</button>')}
      <p class="hint">operator（操作员）无法访问：系统设置保存、模式切换、AI 供应商、删除类与任务增删等高危操作。修改/禁用/重置密码后该用户登录态立即失效。</p>
      ${table(['ID', '用户名', '显示名', '角色', '状态', '在线', '创建时间', '操作'],
        users.map((u) => `<tr><td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.display_name || '')}</td>
          <td>${badge(u.role === 'admin' ? 'info' : 'muted', u.role === 'admin' ? '管理员' : '操作员')}</td>
          <td>${badge(u.status === 'active' ? 'ok' : 'muted', u.status === 'active' ? '启用' : '已禁用')}</td>
          <td>${u.online ? '🟢' : '—'}</td><td>${fmt(u.created_at)}</td>
          <td class="ops">
            <button class="btn btn-sm usr-edit" data-id="${u.id}">编辑</button>
            <button class="btn btn-sm usr-reset" data-id="${u.id}">重置密码</button>
            <button class="btn btn-sm btn-danger usr-del" data-id="${u.id}" ${String(u.id) === String(WB.user.userId) ? 'disabled title="不能删除当前账号"' : ''}>删除</button>
          </td></tr>`).join(''))}`;
    c2.querySelector('#user-add').onclick = () => {
      WB.openModal({
        title: '新建用户',
        body: `<label>用户名 <i class="req">*</i></label><input name="username" required>
          <label>初始密码（≥6 位）<i class="req">*</i></label><input name="password" required>
          <label>显示名</label><input name="display_name">
          <label>角色</label><select name="role"><option value="operator">操作员</option><option value="admin">管理员</option></select>
          <div class="check-row"><label><input type="checkbox" name="status" checked> 启用</label></div>`,
        onSubmit: async (v) => { await WB.post('/api/v1/users', v); WB.toast('用户已创建'); draw(); },
      });
    };
    c2.querySelectorAll('.usr-edit').forEach((b) => {
      b.onclick = () => {
        const u = users.find((x) => String(x.id) === b.dataset.id);
        WB.openModal({
          title: `编辑用户：${u.username}`,
          body: `<label>显示名</label><input name="display_name" value="${esc(u.display_name || '')}">
            <label>角色</label><select name="role"><option value="operator" ${u.role === 'operator' ? 'selected' : ''}>操作员</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理员</option></select>
            <label>状态</label><select name="status"><option value="active" ${u.status === 'active' ? 'selected' : ''}>启用</option><option value="disabled" ${u.status === 'disabled' ? 'selected' : ''}>禁用</option></select>`,
          onSubmit: async (v) => {
            await WB.put(`/api/v1/users/${u.id}`, v);
            WB.toast('已保存（状态/角色变更会使其登录态失效）');
            if (String(u.id) === String(WB.user.userId)) WB.renderPage(); else draw();
          },
        });
      };
    });
    c2.querySelectorAll('.usr-reset').forEach((b) => {
      b.onclick = () => {
        const u = users.find((x) => String(x.id) === b.dataset.id);
        WB.openModal({
          title: `重置密码：${u.username}`,
          body: `<label>新密码（≥6 位）<i class="req">*</i></label><input name="new_password" required>`,
          onSubmit: async (v) => {
            await WB.post(`/api/v1/users/${u.id}/reset-password`, { new_password: v.new_password });
            WB.toast(`已重置 ${u.username} 的密码`);
          },
        });
      };
    });
    c2.querySelectorAll('.usr-del').forEach((b) => {
      b.onclick = async () => {
        const u = users.find((x) => String(x.id) === b.dataset.id);
        const ok = await WB.confirmDanger('删除用户', [
          `用户「${u.username}」（${u.role === 'admin' ? '管理员' : '操作员'}）`,
          { text: '删除后无法恢复，该用户将立即退出登录。', danger: true },
        ], { confirmText: '确认删除' });
        if (!ok) return;
        try { await WB.del(`/api/v1/users/${b.dataset.id}`); WB.toast('已删除'); draw(); } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
  };

  const drawBackup = async (c2) => {
    const backups = await WB.get('/api/v1/system/backups');
    c2.innerHTML = `
      ${pageHead('备份与恢复', '<button class="btn btn-primary" id="bk-now">💾 立即备份</button>')}
      <p class="hint">备份当前模式的数据库文件到 data/backups（每日日结也会自动备份，保留最近 7 份）。<b>恢复</b>会用备份文件覆盖当前数据库并自动重启服务——请确认当前业务数据已妥善处理。生产/演示模式各自独立备份。</p>
      ${table(['文件', '大小', '创建时间', '操作'],
        backups.map((b) => `<tr><td>${esc(b.file)}</td><td>${b.size_kb} KB</td><td>${fmt(b.created_at)}</td>
          <td class="ops">
            <a class="btn btn-sm" href="/api/v1/system/backups/download?file=${encodeURIComponent(b.file)}">下载</a>
            <button class="btn btn-sm btn-danger bk-restore" data-file="${esc(b.file)}">恢复</button>
          </td></tr>`).join('') || '<div class="empty">暂无备份，点击右上角「立即备份」</div>')}`;
    c2.querySelector('#bk-now').onclick = async () => {
      try {
        const r = await WB.post('/api/v1/system/backup');
        WB.toast(`已备份：${r.file}`);
        draw();
      } catch (e) { WB.toast(e.message, 'error'); }
    };
    c2.querySelectorAll('.bk-restore').forEach((b) => {
      b.onclick = async () => {
        const ok = await WB.confirmDanger('从备份恢复数据库', [
          { text: `将用备份「${b.dataset.file}」覆盖当前数据库并自动重启服务。`, danger: true },
          { text: '当前数据库中未备份的业务数据将全部丢失！', danger: true },
        ], { confirmText: '确认恢复并重启' });
        if (!ok) return;
        try {
          await WB.post('/api/v1/system/backups/restore', { file: b.dataset.file });
          WB.toast('正在恢复，服务自动重启后需重新登录…', 'info');
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
  };

  const render = async () => {
    c.innerHTML = `<div class="tabs">${tabs.map(([k, label]) => `<button class="tab-btn ${active === k ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</div><div id="sub-view"></div>`;
    c.querySelectorAll('.tab-btn').forEach((b) => { b.onclick = () => { active = b.dataset.tab; sessionStorage.setItem('wb_tab_settings', active); render(); }; });
    const sub = c.querySelector('#sub-view');
    if (active === 'users') await drawUsers(sub);
    else if (active === 'backup') await drawBackup(sub);
    else await drawSys(sub);
  };
  await render();
};

/* ================= 经营驾驶舱 ================= */

PAGES.ai = async (c) => {
  const [providers, presets, chatPresets] = await Promise.all([
    WB.get('/api/v1/ai/providers'),
    WB.get('/api/v1/ai/presets'),
    WB.get('/api/v1/ai/chat-presets'),
  ]);
  const TYPE_LABEL = { openai_compatible: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini' };
  const builtinPrompts = chatPresets.builtin || [];
  let customPrompts = (chatPresets.custom || []).map((p) => ({ ...p, custom: true }));
  const allPrompts = () => [...builtinPrompts, ...customPrompts];
  c.innerHTML = `
    ${pageHead('AI 控制台', '<button class="btn" id="ai-batch">⚡ 批量添加</button> <button class="btn btn-primary" id="ai-add">+ 添加供应商</button>')}
    <p class="hint">支持国内外主流大模型：DeepSeek / 通义千问 / Kimi / 智谱GLM / 豆包 / MiniMax / OpenAI / Claude / Gemini。
    配置默认供应商后，可用 AI 能力：自动回复兜底（系统设置开启）、经营驾驶舱 AI 解读、商品经营诊断 AI 处方、标题 AI 生成、智能估价 AI 点评。API Key 仅保存在本机数据库。</p>
    ${table(['ID', '名称', '协议', '模型', 'Base URL', 'Key', '默认', '启用', '最近测试', '操作'],
      providers.map((p) => `<tr>
        <td>${p.id}</td><td>${esc(p.name)}</td><td>${TYPE_LABEL[p.provider_type]}</td><td class="clip">${esc(p.model)}</td>
        <td class="clip" title="${esc(p.base_url)}">${esc(p.base_url)}</td>
        <td>${p.has_key ? '✓' : '✗'}</td><td>${p.is_default ? '⭐' : ''}</td><td>${p.enabled ? '✓' : '—'}</td>
        <td>${p.last_test_at ? (p.last_test_ok ? badge('ok', '通过') : badge('failed', '失败')) : '—'}</td>
        <td class="ops">
          <button class="btn btn-sm ai-test" data-id="${p.id}">测试</button>
          ${!p.is_default ? `<button class="btn btn-sm ai-default" data-id="${p.id}">设默认</button>` : ''}
          <button class="btn btn-sm act-edit" data-id="${p.id}">编辑</button>
          <button class="btn btn-sm btn-danger ai-del" data-id="${p.id}">删除</button>
        </td></tr>`).join('') || '<tr><td colspan="10" class="empty-cell">尚未配置 AI 供应商</td></tr>')}
    <h3 class="sub-h">🧠 AI 助手（对话测试）</h3>
    <section class="panel">
      <label>系统提示词预设（选择后自动填充，可再修改）</label>
      <div class="toolbar" style="margin-bottom:0">
        <select id="chat-preset" style="flex:1">
          <option value="">自定义（手动输入）</option>
          ${allPrompts().map((p) => `<option value="${esc(p.name)}" data-custom="${p.custom ? 1 : 0}">${esc(p.name)}${p.custom ? '（自定义）' : ''}</option>`).join('')}
        </select>
        <button class="btn" id="chat-save-preset" title="将当前输入保存为自定义预设">💾 存为预设</button>
        <button class="btn" id="chat-del-preset" disabled title="删除当前选中的自定义预设">🗑 删除</button>
      </div>
      <textarea id="chat-sys" rows="2" placeholder="如：你是闲鱼运营专家"></textarea>
      <label>提问</label><textarea id="chat-input" rows="3" placeholder="如：帮我写一句二手键盘的商品卖点"></textarea>
      <button class="btn btn-primary" id="chat-run">发送</button>
      <div id="chat-result"></div>
    </section>`;
  // 系统提示词预设交互
  const presetSel = c.querySelector('#chat-preset');
  const sysInput = c.querySelector('#chat-sys');
  const delBtn = c.querySelector('#chat-del-preset');
  const syncDelBtn = () => {
    const opt = presetSel.selectedOptions[0];
    delBtn.disabled = !(opt && opt.dataset.custom === '1');
  };
  presetSel.onchange = () => {
    const opt = presetSel.selectedOptions[0];
    if (!opt || !opt.value) return;
    const p = allPrompts().find((x) => x.name === opt.value);
    if (p) sysInput.value = p.prompt;
    syncDelBtn();
  };
  c.querySelector('#chat-save-preset').onclick = () => {
    const prompt = sysInput.value.trim();
    if (!prompt) { WB.toast('请先输入系统提示词', 'error'); return; }
    WB.openModal({
      title: '保存为自定义预设',
      body: `<label>预设名称 <i class="req">*</i></label><input name="name" required placeholder="如：我的售后客服话术">`,
      onSubmit: async (v) => {
        customPrompts.push({ name: v.name.trim(), prompt });
        customPrompts = await WB.put('/api/v1/ai/chat-prompts', { custom: customPrompts.map((x) => ({ name: x.name, prompt: x.prompt })) });
        customPrompts = customPrompts.map((x) => ({ ...x, custom: true }));
        WB.toast('预设已保存');
        WB.renderPage();
      },
    });
  };
  delBtn.onclick = async () => {
    const opt = presetSel.selectedOptions[0];
    if (!opt || opt.dataset.custom !== '1') return;
    const ok = await WB.confirmDanger('删除自定义预设', [`预设「${opt.value}」`], { confirmText: '确认删除' });
    if (!ok) return;
    customPrompts = customPrompts.filter((x) => x.name !== opt.value);
    customPrompts = await WB.put('/api/v1/ai/chat-prompts', { custom: customPrompts.map((x) => ({ name: x.name, prompt: x.prompt })) });
    presetSel.value = '';
    sysInput.value = '';
    syncDelBtn();
    WB.renderPage();
  };
  syncDelBtn();
  const provModal = (p) => {
    WB.openModal({
      title: p ? `编辑供应商：${p.name}` : '添加 AI 供应商',
      wide: true,
      body: `
        <label>厂家预设（自动填充地址与推荐模型）</label>
        <select id="ai-preset"><option value="">手动填写</option>${presets.map((x) => `<option value="${x.key}" data-type="${x.provider_type}" data-url="${esc(x.base_url)}" data-models="${esc(JSON.stringify(x.models || [x.model]))}">${esc(x.label)}</option>`).join('')}</select>
        <label>显示名称 <i class="req">*</i></label><input name="name" value="${esc(p ? p.name : '')}" required>
        <div class="form-row">
          <div><label>协议类型</label><select name="provider_type">
            <option value="openai_compatible" ${p && p.provider_type === 'openai_compatible' ? 'selected' : ''}>OpenAI 兼容（DeepSeek/千问/Kimi/GLM/豆包等）</option>
            <option value="anthropic" ${p && p.provider_type === 'anthropic' ? 'selected' : ''}>Anthropic</option>
            <option value="gemini" ${p && p.provider_type === 'gemini' ? 'selected' : ''}>Gemini</option>
          </select></div>
          <div><label>模型 <i class="req">*</i>（可选推荐或手输）</label><input name="model" value="${esc(p ? p.model : '')}" list="ai-model-list" required><datalist id="ai-model-list"></datalist></div>
          <div><label>Temperature（0-2）</label><input name="temperature" value="${p ? p.temperature : '0.7'}"></div>
          <div><label>Max Tokens（64-8192）</label><input name="max_tokens" type="number" min="64" max="8192" value="${p ? p.max_tokens : 1024}"></div>
        </div>
        <label>Base URL <i class="req">*</i></label><input name="base_url" value="${esc(p ? p.base_url : '')}" required>
        <label>API Key（编辑时留空表示不修改）</label><input name="api_key" type="password" placeholder="${p && p.has_key ? '已保存，留空保持不变' : 'sk-...'}">
        <div class="check-row">
          <label><input type="checkbox" name="enabled" ${!p || p.enabled ? 'checked' : ''}> 启用</label>
          <label><input type="checkbox" name="is_default" ${p && p.is_default ? 'checked' : ''}> 设为默认</label>
        </div>`,
      onSubmit: async (v) => {
        v.max_tokens = Math.min(8192, Math.max(64, Number(v.max_tokens) || 1024));
        if (p) await WB.put(`/api/v1/ai/providers/${p.id}`, v);
        else await WB.post('/api/v1/ai/providers', v);
        WB.toast('已保存');
        WB.renderPage();
      },
    });
    const presetSel = document.getElementById('ai-preset');
    presetSel.onchange = () => {
      const opt = presetSel.selectedOptions[0];
      if (!opt || !opt.value) return;
      const form = document.getElementById('modal-form');
      const models = JSON.parse(opt.dataset.models || '[]');
      form.querySelector('[name=provider_type]').value = opt.dataset.type;
      form.querySelector('[name=base_url]').value = opt.dataset.url;
      form.querySelector('[name=model]').value = models[0] || '';
      const dl = form.querySelector('#ai-model-list');
      dl.innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
    };
    if (p && p.model) {
      const dl = document.getElementById('modal-form').querySelector('#ai-model-list');
      dl.innerHTML = `<option value="${esc(p.model)}">`;
    }
  };
  c.querySelector('#ai-add').onclick = () => provModal(null);
  c.querySelector('#ai-batch').onclick = () => {
    WB.openModal({
      title: '⚡ 批量添加供应商（勾选后一键创建）',
      wide: true,
      body: `
        <p class="hint">勾选需要接入的厂家，将按推荐地址与默认模型批量创建（API Key 之后在各供应商上补填）。已存在同名供应商的会自动跳过。</p>
        ${presets.map((x, i) => `<div class="set-row" style="grid-template-columns:26px 1fr auto;align-items:center">
          <div><input type="checkbox" class="ai-batch-sel" data-i="${i}" style="width:auto"></div>
          <div><b>${esc(x.label)}</b><div class="set-remark">${esc(x.base_url)} · 默认模型 ${esc((x.models || [])[0] || '')}</div></div>
          <div>${x.provider_type === 'openai_compatible' ? '兼容' : x.provider_type === 'anthropic' ? 'Anthropic' : 'Gemini'}</div>
        </div>`).join('')}`,
      onSubmit: async (v) => {
        const picked = [...document.querySelectorAll('.ai-batch-sel:checked')].map((cb) => presets[Number(cb.dataset.i)]);
        if (!picked.length) throw new Error('请至少勾选一个厂家');
        const providers = picked.map((x) => ({
          name: x.label.replace(/（.*）/, ''),
          provider_type: x.provider_type,
          base_url: x.base_url,
          model: (x.models || [])[0] || '',
          enabled: 1,
        }));
        const r = await WB.post('/api/v1/ai/providers/batch', { providers });
        WB.toast(`批量添加完成：新建 ${r.created_count} 个${r.skipped.length ? `，跳过 ${r.skipped.length} 个（已存在）` : ''}`);
        WB.renderPage();
      },
    });
  };
  c.querySelector('#ai-add').onclick = () => provModal(null);
  c.querySelectorAll('.act-edit').forEach((b) => {
    b.onclick = () => provModal(providers.find((x) => String(x.id) === b.dataset.id));
  });
  c.querySelectorAll('.ai-del').forEach((b) => {
    b.onclick = async () => {
      if (!WB.confirmDialog('确认删除该 AI 供应商？')) return;
      try { await WB.del(`/api/v1/ai/providers/${b.dataset.id}`); WB.renderPage(); } catch (e) { WB.toast(e.message, 'error'); }
    };
  });
  c.querySelectorAll('.ai-test').forEach((b) => {
    b.onclick = async () => {
      WB.toast('测试中…');
      try {
        const r = await WB.post(`/api/v1/ai/providers/${b.dataset.id}/test`);
        WB.toast(r.ok ? '✅ 连通成功' : '❌ 失败：' + r.message.slice(0, 80), r.ok ? 'ok' : 'error');
        WB.renderPage();
      } catch (e) { WB.toast(e.message, 'error'); }
    };
  });
  c.querySelectorAll('.ai-default').forEach((b) => {
    b.onclick = async () => {
      try { await WB.put(`/api/v1/ai/providers/${b.dataset.id}`, { is_default: true, enabled: true }); WB.toast('已设为默认'); WB.renderPage(); } catch (e) { WB.toast(e.message, 'error'); }
    };
  });
  c.querySelector('#chat-run').onclick = async () => {
    const box = c.querySelector('#chat-result');
    const prompt = c.querySelector('#chat-input').value.trim();
    if (!prompt) { WB.toast('请输入问题', 'error'); return; }
    box.innerHTML = '<div class="loading">AI 思考中…</div>';
    try {
      const r = await WB.post('/api/v1/ai/chat', { prompt, system: c.querySelector('#chat-sys').value });
      box.innerHTML = `<pre class="pre">${esc(r.content)}</pre><p class="hint" style="margin-top:6px">${esc(r.provider)} / ${esc(r.model)}</p>`;
    } catch (e) { box.innerHTML = `<div class="diag-item sev-high">${esc(e.message)}</div>`; }
  };
};
PAGES.simulate = async (c) => {
  const mode = (await WB.get('/api/v1/system/mode')).mode;

  // ---- 生产模式：入口引导页（与演示数据完全隔离） ----
  if (mode !== 'demo') {
    c.innerHTML = `
      ${pageHead('演示模式', '')}
      <section class="panel" style="text-align:center;padding:46px 24px">
        <div style="font-size:44px;margin-bottom:8px">🎬</div>
        <h3>当前为生产模式</h3>
        <p class="hint" style="max-width:640px;margin:10px auto;line-height:2">
          生产模式与演示数据<b>完全隔离</b>：不包含任何演示账号、商品、订单或流量数据。<br>
          演示模式使用<b>独立数据库</b>，内置各功能完整演示数据，可注入买家消息/订单，<br>
          体验自动回复、自动发货、风控、通知与经营分析全流程；演示操作不会触碰生产数据。
        </p>
        <button class="btn btn-primary" id="btn-go-demo" style="margin-top:14px">🎬 切换到演示模式（服务自动重启，需重新登录）</button>
        <p class="login-tip" id="demo-tip" style="margin-top:10px">生产模式 ⇄ 演示模式 可随时互相切换，随时可以切回。</p>
      </section>`;
    c.querySelector('#btn-go-demo').onclick = () => switchModeWithRestart('demo');
    return;
  }

  // ---- 演示模式：完整模拟控制台 ----
  const [accounts, items] = await Promise.all([loadAccounts(), loadItems()]);
  c.innerHTML = `
    ${pageHead('演示模式', `
      <button class="btn" id="demo-reset">♻ 重置演示数据</button>
      <button class="btn" id="btn-go-prod">⏹ 返回生产模式（自动重启）</button>`)}
    <p class="hint">🎬 <b>演示模式运行中</b>：数据位于独立演示库，与生产数据完全隔离。以下控制台注入买家消息/订单事件，
    驱动自动回复 / 自动发货 / 风控 / 通知全流程。回复存在随机延迟（风控），发送后请在「消息会话」「日志中心」查看。</p>
    <div class="grid-2">
      <section class="panel">
        <h3>📩 模拟买家发消息（自动回复）</h3>
        <label>账号</label><select id="s-acc">${opts(accounts, 'id', (a) => `${a.nickname}（${a.status}）`)}</select>
        <label>买家昵称</label><input id="s-nick" value="测试买家">
        <label>关联商品（可选）</label><select id="s-item"><option value="">不限</option>${opts(items, 'id', (i) => i.title)}</select>
        <label>消息内容</label><textarea id="s-text" rows="2" placeholder="如：在吗 / 怎么发货 / 随便聊聊"></textarea>
        <button class="btn btn-primary" id="btn-s-msg">发送消息</button>
      </section>
      <section class="panel">
        <h3>🛒 模拟买家下单（自动发货）</h3>
        <label>账号</label><select id="o-acc">${opts(accounts, 'id', (a) => `${a.nickname}（${a.status}）`)}</select>
        <label>商品</label><select id="o-item">${opts(items, 'id', (i) => `${i.title}${i.is_virtual ? ' [虚拟]' : ''}`)}</select>
        <label>数量</label><input id="o-qty" type="number" value="1" min="1" max="99">
        <label>买家昵称</label><input id="o-nick" value="下单买家">
        <button class="btn btn-primary" id="btn-s-order">提交订单</button>
      </section>
    </div>
    <section class="panel">
      <h3>🔐 Cookie 过期检查（风控演示）</h3>
      <div class="toolbar">
        <select id="c-acc">${opts(accounts, 'id', (a) => a.nickname)}</select>
        <button class="btn" id="btn-s-cookie">执行检查</button>
      </div>
    </section>
    <section class="panel"><h3>执行结果</h3><pre class="pre" id="sim-result">（等待操作）</pre></section>`;

  const out = (v) => { c.querySelector('#sim-result').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
  c.querySelector('#btn-go-prod').onclick = () => switchModeWithRestart('production');
  c.querySelector('#demo-reset').onclick = async () => {
    const ok = await WB.confirmDanger('重置演示数据', [
      '将删除演示数据库并重新初始化为内置演示数据。',
      { text: '演示库中的所有改动（含测试产生的会话/订单/账号）都会丢失；生产库不受影响。', danger: true },
    ], { confirmText: '确认重置' });
    if (!ok) return;
    try {
      // 通过模式切换到当前模式（写标记 + 自重启）前先删演示库：用专用开关 demo-reset
      await fetch('/api/v1/system/demo-reset', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + WB.token }, body: '{}' });
      WB.toast('演示数据重置中，服务自动重启…', 'info');
      await waitServiceRestart(0);
    } catch (e) { WB.toast('重置失败: ' + e.message, 'error'); }
  };
  c.querySelector('#btn-s-msg').onclick = async () => {
    const text = c.querySelector('#s-text').value.trim();
    if (!text) { WB.toast('请输入消息内容', 'error'); return; }
    try {
      const r = await WB.post('/api/v1/simulate/buyer-message', {
        account_id: Number(c.querySelector('#s-acc').value),
        buyer_nick: c.querySelector('#s-nick').value.trim() || '测试买家',
        item_id: c.querySelector('#s-item').value || null,
        text,
      });
      out(r);
      WB.toast('消息已受理，自动回复将在随机延迟后发出');
    } catch (e) { out('错误: ' + e.message); WB.toast(e.message, 'error'); }
  };
  c.querySelector('#btn-s-order').onclick = async () => {
    try {
      const r = await WB.post('/api/v1/simulate/order', {
        account_id: Number(c.querySelector('#o-acc').value),
        item_id: Number(c.querySelector('#o-item').value),
        quantity: Number(c.querySelector('#o-qty').value) || 1,
        buyer_nick: c.querySelector('#o-nick').value.trim() || '下单买家',
      });
      out(r);
      WB.toast('订单已提交');
    } catch (e) { out('错误: ' + e.message); WB.toast(e.message, 'error'); }
  };
  c.querySelector('#btn-s-cookie').onclick = async () => {
    try {
      const r = await WB.post('/api/v1/simulate/cookie-expire', { account_id: Number(c.querySelector('#c-acc').value) });
      out(r);
    } catch (e) { out('错误: ' + e.message); WB.toast(e.message, 'error'); }
  };
};


/* ================= 售后纠纷中心 ================= */

/* ================= M19 风险中心 ================= */
PAGES.riskcenter = async (c) => {
  const r = await WB.get('/api/v1/risk/center');
  const sevBadge = (s) => badge(s === 'high' ? 'failed' : s === 'medium' ? 'warning' : 'muted', { high: '高危', medium: '中危', low: '低危' }[s]);
  // 按类别给出"去处理"跳转目标
  const LINKS = {
    account_status: ['#/accounts', '去账号管理'],
    cookie_expired: ['#/accounts', '去账号管理'],
    duplicate_items: ['#/items', '去商品管理'],
    item_violation: ['#/items', '去商品管理'],
    after_sales: ['#/aftersale', '去售后中心'],
    task: ['#/tasks', '去定时任务'],
    system_error: ['#/logs', '去日志中心'],
    risk_events: ['#/logs', '去日志中心'],
  };
  c.innerHTML = `
    ${pageHead('风险中心', '<button class="btn btn-primary" id="rk-rescan">重新扫描</button>')}
    <div class="cards">
      <div class="card"><div class="card-t">高危</div><div class="card-v neg-text">${r.summary.high}</div></div>
      <div class="card"><div class="card-t">中危</div><div class="card-v">${r.summary.medium}</div></div>
      <div class="card"><div class="card-t">低危</div><div class="card-v">${r.summary.low}</div></div>
      <div class="card"><div class="card-t">风险类别</div><div class="card-v">${r.summary.group_count}</div><div class="card-s">扫描于 ${fmt(r.scanned_at)}</div></div>
    </div>
    ${r.groups.length ? r.groups.map((g) => {
      const link = LINKS[g.type] || ['#/riskcenter', ''];
      return `
      <section class="panel" style="margin-bottom:14px">
        <h3>${esc(g.label)}　${sevBadge(g.severity)}　<span class="hint" style="margin:0">类型: ${esc(g.type)}</span>
          ${link[1] ? `<a href="${link[0]}" class="btn btn-sm" style="float:right">→ ${link[1]}</a>` : ''}</h3>
        ${table(['级别', '主体', '说明'], g.items.map((i) => `<tr><td>${sevBadge(i.severity)}</td>
          <td class="clip">${esc(i.nickname || i.title || i.order_no || i.name || i.account_id || i.task_id || i.item_id || '—')}</td>
          <td>${esc(i.detail)}</td></tr>`).join(''))}
      </section>`;
    }).join('') : '<div class="empty">✅ 未发现风险项</div>'}`;
  c.querySelector('#rk-rescan').onclick = () => WB.renderPage();
};
