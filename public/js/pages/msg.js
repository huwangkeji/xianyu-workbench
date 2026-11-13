'use strict';
// 此文件由 pages.js 模块化拆分生成（MVC 视图层按业务域分模块，app.js 按路由懒加载）
// msg：消息会话 / 自动回复 / 客户中心

PAGES.rules = async (c) => {
  let page = 1;
  const draw = async () => {
    const [r, accounts, items] = await Promise.all([
      WB.get(`/api/v1/reply-rules?page=${page}&page_size=15${accQ()}`),
      loadAccounts(),
      loadItems(),
    ]);
    c.innerHTML = `
      ${pageHead('自动回复规则', '<button class="btn" id="rule-test">🧪 规则测试器</button> <button class="btn btn-primary" id="add-rule">+ 新增规则</button>')}
      <p class="hint">匹配优先级：商品专属 &gt; 账号专属 &gt; 全局；同组内按优先级数值降序。未命中关键词时走「默认回复」类型规则（商品 &gt; 账号 &gt; 全局）。${WB.activeAccountId ? '当前仅显示作用于所选账号的规则（含全局规则）。' : ''}</p>
      ${table(['ID', '名称', '类型', '匹配方式', '关键词', '回复内容', '优先级', '作用域', '启用', '命中', '操作'],
        r.list.map((t) => `<tr>
          <td>${t.id}</td><td>${esc(t.name)}</td>
          <td>${{ text_keyword: '关键词', image_keyword: '图片关键词', default: '默认回复' }[t.rule_type]}</td>
          <td>${{ contains: '包含', exact: '精确', regex: '正则' }[t.match_type]}</td>
          <td class="clip" title="${esc(t.keywords)}">${esc(t.keywords)}</td>
          <td class="clip" title="${esc(t.reply_text)}">${esc(t.reply_text)}</td>
          <td>${t.priority}</td>
          <td>${t.item_id ? '商品#' + t.item_id : t.account_id ? esc(t.account_nickname || '账号#' + t.account_id) : '全局'}</td>
          <td>${t.enabled ? '✓' : '—'}</td><td>${t.hit_count}</td>
          <td class="ops">
            <button class="btn btn-sm act-toggle" data-id="${t.id}" data-en="${t.enabled ? 1 : 0}">${t.enabled ? '停用' : '启用'}</button>
            <button class="btn btn-sm act-edit" data-id="${t.id}">编辑</button>
            <button class="btn btn-sm btn-danger act-del" data-id="${t.id}">删除</button>
          </td></tr>`).join(''))}
      <div class="pager" id="pager"></div>`;
    WB.paginate(c.querySelector('#pager'), r.total, page, 15, (p) => { page = p; draw(); });
    c.querySelector('#add-rule').onclick = () => ruleModal(null, draw, accounts, items);
    c.querySelector('#rule-test').onclick = () => ruleTestModal(accounts, items);
    c.querySelectorAll('.act-toggle').forEach((b) => {
      b.onclick = () => WB.post(`/api/v1/reply-rules/${b.dataset.id}/toggle`, { enabled: b.dataset.en === '1' ? false : true })
        .then(draw).catch((e) => WB.toast(e.message, 'error'));
    });
    c.querySelectorAll('.act-del').forEach((b) => {
      b.onclick = async () => {
        const t = r.list.find((x) => String(x.id) === b.dataset.id);
        const ok = await WB.confirmDanger('删除回复规则', [
          `规则「${t.name}」（${{ text_keyword: '关键词', image_keyword: '图片关键词', default: '默认回复' }[t.rule_type]}）`,
          { text: '删除后该规则不再参与匹配，不可恢复。', danger: true },
        ], { confirmText: '确认删除' });
        if (!ok) return;
        try { await WB.del(`/api/v1/reply-rules/${b.dataset.id}`); WB.toast('已删除'); draw(); } catch (e) { WB.toast(e.message, 'error'); }
      };
    });
    c.querySelectorAll('.act-edit').forEach((b) => {
      b.onclick = async () => {
        const rule = (await WB.get(`/api/v1/reply-rules/${b.dataset.id}`));
        ruleModal(rule, draw, accounts, items);
      };
    });
  };
  await draw();
};

/** 规则测试器：输入买家消息 → 显示命中的规则与策略（不真实发送，可连续测试） */
function ruleTestModal(accounts, items) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-mask" id="rt-mask">
      <div class="modal modal-wide">
        <div class="modal-head"><span>规则测试器（不会真实回复买家）</span><button type="button" class="modal-x" id="rt-x">×</button></div>
        <div class="modal-body">
          <label>模拟账号</label><select id="rt-acc"><option value="">全局</option>${opts(accounts, 'id', (a) => a.nickname)}</select>
          <label>关联商品</label><select id="rt-item"><option value="">不限</option>${opts(items, 'id', (i) => i.title)}</select>
          <label>买家消息 <i class="req">*</i></label>
          <textarea id="rt-msg" rows="2" placeholder="如：在吗 / 怎么发货 / 随便聊聊"></textarea>
          <div id="rt-out" style="margin-top:10px"><div class="hint">输入消息后点「测试匹配」，将实时显示命中的规则与回复内容。</div></div>
        </div>
        <div class="modal-foot">
          <span class="modal-err" id="rt-err"></span>
          <button type="button" class="btn" id="rt-close">关闭</button>
          <button type="button" class="btn btn-primary" id="rt-run">测试匹配</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('#rt-x').onclick = close;
  root.querySelector('#rt-close').onclick = close;
  root.querySelector('#rt-mask').addEventListener('click', (e) => { if (e.target.id === 'rt-mask') close(); });
  root.querySelector('#rt-run').onclick = async () => {
    const out = root.querySelector('#rt-out');
    const msg = root.querySelector('#rt-msg').value.trim();
    const err = root.querySelector('#rt-err');
    err.textContent = '';
    if (!msg) { err.textContent = '请输入买家消息'; return; }
    const btn = root.querySelector('#rt-run');
    btn.disabled = true; btn.textContent = '匹配中…';
    try {
      const r = await WB.post('/api/v1/reply-rules/test', {
        account_id: root.querySelector('#rt-acc').value || null,
        item_id: root.querySelector('#rt-item').value || null,
        message: msg,
      });
      out.innerHTML = r.matched
        ? `<div class="diag-item sev-ok">✅ 命中规则：<b>${esc(r.rule.name || '#' + r.rule.id)}</b>
            （${{ text_keyword: '关键词', image_keyword: '图片关键词', default: '默认回复' }[r.rule.rule_type] || r.rule.rule_type} / ${{ contains: '包含', exact: '精确', regex: '正则' }[r.rule.match_type] || r.rule.match_type}，优先级 ${r.rule.priority}）</div>
          <div class="diag-item sev-info">回复内容：${esc(r.rule.reply_text)}${r.rule.reply_image_url ? `<br>附图：${esc(r.rule.reply_image_url)}` : ''}</div>`
        : '<div class="diag-item sev-warn">❌ 未命中任何规则（若开启 AI 兜底会走 AI 生成，否则按系统默认话术回复）</div>';
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false; btn.textContent = '测试匹配';
    }
  };
}

async function ruleModal(rule, done) {
  const accounts = await loadAccounts();
  const items = await loadItems();
  WB.openModal({
    title: rule ? `编辑规则 #${rule.id}` : '新增规则',
    wide: true,
    body: `
      <label>规则名称</label><input name="name" value="${esc(rule ? rule.name : '')}">
      <div class="form-row">
        <div><label>规则类型</label>
          <select name="rule_type">
            <option value="text_keyword" ${rule && rule.rule_type === 'text_keyword' ? 'selected' : ''}>文本关键词</option>
            <option value="image_keyword" ${rule && rule.rule_type === 'image_keyword' ? 'selected' : ''}>图片关键词（买家发图时回复）</option>
            <option value="default" ${rule && rule.rule_type === 'default' ? 'selected' : ''}>默认回复（兜底）</option>
          </select></div>
        <div><label>匹配方式</label>
          <select name="match_type">
            <option value="contains" ${rule && rule.match_type === 'contains' ? 'selected' : ''}>包含</option>
            <option value="exact" ${rule && rule.match_type === 'exact' ? 'selected' : ''}>精确</option>
            <option value="regex" ${rule && rule.match_type === 'regex' ? 'selected' : ''}>正则</option>
          </select></div>
      </div>
      <label>关键词（逗号分隔；正则时填单个表达式；默认回复可留空）</label>
      <input name="keywords" value="${esc(rule ? rule.keywords : '')}">
      <label>回复内容（支持 {买家昵称} {商品标题} {商品价格} {店铺名}）<i class="req">*</i></label>
      <textarea name="reply_text" rows="3" required>${esc(rule ? rule.reply_text : '')}</textarea>
      <div class="form-row">
        <div><label>优先级（数值大优先）</label><input name="priority" type="number" value="${rule ? rule.priority : 100}"></div>
        <div><label>作用账号</label>
          <select name="account_id"><option value="">全局</option>${opts(accounts, 'id', (a) => a.nickname, rule ? rule.account_id : '')}</select></div>
        <div><label>作用商品</label>
          <select name="item_id"><option value="">不限</option>${opts(items, 'id', (i) => i.title, rule ? rule.item_id : '')}</select></div>
      </div>
      <div class="check-row">
        <label><input type="checkbox" name="once_per_session" ${rule && rule.once_per_session ? 'checked' : ''}> 每会话只回复一次</label>
        <label><input type="checkbox" name="enabled" ${!rule || rule.enabled ? 'checked' : ''}> 启用</label>
      </div>`,
    onSubmit: async (v) => {
      const payload = { ...v, account_id: v.account_id || null, item_id: v.item_id || null };
      if (rule) await WB.put(`/api/v1/reply-rules/${rule.id}`, payload);
      else await WB.post('/api/v1/reply-rules', payload);
      WB.toast('已保存');
      done();
    },
  });
}

/* ================= 消息会话 ================= */
PAGES.messages = async (c) => {
  let convPage = 1;
  let selected = null;
  let selectedConv = null;
  let lastMsgId = 0;
  let keyword = c.dataset.keyword || '';
  let statusFilter = c.dataset.statusFilter || '';
  const jumpKw = sessionStorage.getItem('wb_conv_keyword');
  if (jumpKw) { sessionStorage.removeItem('wb_conv_keyword'); keyword = jumpKw; c.dataset.keyword = keyword; }
  let jumpOpen = null;
  const jumpOpenRaw = sessionStorage.getItem('wb_conv_open');
  if (jumpOpenRaw) { sessionStorage.removeItem('wb_conv_open'); jumpOpen = Number(jumpOpenRaw); }
  let pollTimer = null;
  let listTimer = null;
  let isDemoMode = false;
  WB.timers.push(() => { if (pollTimer) clearInterval(pollTimer); if (listTimer) clearInterval(listTimer); });
  WB.get('/api/v1/system/mode/public').then((m) => { isDemoMode = m && m.mode === 'demo'; syncHead(); }).catch(() => { });

  const drawList = async () => {
    const r = await WB.get(`/api/v1/conversations?page=${convPage}&page_size=15${accQ()}${keyword ? '&keyword=' + encodeURIComponent(keyword) : ''}${statusFilter ? '&status=' + statusFilter : ''}`);
    c.querySelector('#conv-list').innerHTML = (r.list || []).map((cv) => `
      <div class="conv-item ${selected === cv.id ? 'active' : ''}" data-id="${cv.id}">
        <div class="conv-top"><b>${esc(cv.buyer_nick)}</b>${cv.unread_count ? `<span class="unread">${cv.unread_count}</span>` : ''}${cv.status === 'closed' ? '<span class="hint">已关闭</span>' : ''}</div>
        <div class="conv-meta">${esc(cv.account_nickname || '')}${cv.item_title ? ' · ' + esc(cv.item_title) : ''}</div>
        <div class="conv-last">${esc(cv.last_message || '')}</div>
        <div class="conv-time">${fmt(cv.updated_at)}</div>
      </div>`).join('') || '<div class="empty">暂无会话（演示模式可在「演示模式」页注入买家消息）</div>';
    WB.paginate(c.querySelector('#conv-pager'), r.total, convPage, 15, (p) => { convPage = p; drawList(); });
    c.querySelectorAll('.conv-item').forEach((el) => { el.onclick = () => openConv(Number(el.dataset.id)); });
  };

  const drawMsgs = (msgs, replace) => {
    const box = c.querySelector('#msg-list');
    const stick = replace || box.scrollHeight - box.scrollTop - box.clientHeight < 60; // 用户贴近底部才自动跟随
    if (replace) box.innerHTML = '';
    for (const m of msgs) {
      const div = document.createElement('div');
      div.className = 'msg ' + (m.direction === 'out' ? 'msg-out' : 'msg-in');
      const bodyHtml = m.msg_type === 'image' && m.image_url
        ? `${m.content && m.content !== '[图片]' ? esc(m.content) + '<br>' : ''}<img src="${esc(m.image_url)}" alt="图片" style="max-width:180px;border-radius:6px" onerror="this.outerHTML='[图片加载失败]'">`
        : esc(m.content);
      div.innerHTML = `<div class="msg-bubble">${bodyHtml}</div>
        <div class="msg-meta">${m.direction === 'out' ? (m.source === 'auto' ? '自动回复' : '客服') : '买家'} · ${fmt(m.created_at)}${m.source === 'auto' ? ' 🤖' : ''}</div>`;
      box.appendChild(div);
    }
    if (stick) box.scrollTop = box.scrollHeight;
  };

  const openConv = async (id) => {
    selected = id;
    lastMsgId = 0;
    c.querySelectorAll('.conv-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.id) === id));
    try {
      selectedConv = await WB.get(`/api/v1/conversations/${id}`);
      await WB.post(`/api/v1/conversations/${id}/read`);
      const msgs = await WB.get(`/api/v1/conversations/${id}/messages?limit=100`);
      lastMsgId = msgs.length ? msgs[msgs.length - 1].id : 0;
      drawMsgs(msgs, true);
      const headBtn = c.querySelector('#conv-status-btn');
      if (headBtn) {
        headBtn.textContent = selectedConv.status === 'closed' ? '重开会话' : '关闭会话';
        headBtn.style.display = '';
      }
      drawList();
    } catch (e) { WB.toast(e.message, 'error'); }
  };

  c.innerHTML = `
    ${pageHead('消息会话', `
      <button class="btn btn-primary" id="conv-sync">🔄 同步历史会话</button>
      <button class="btn" id="conv-crm">👥 查买家档案</button>
      <button class="btn" id="conv-status-btn" style="display:none">关闭会话</button>
      <button class="btn" id="btn-send-img">🖼 发图片</button>
      <button class="btn" id="btn-phrases">⚡ 短语</button>
      <button class="btn" id="msg-read-all">全部标记已读</button>
      <button class="btn" id="conv-refresh">刷新列表</button>`)}
    <div id="conv-banner"></div>
    <div class="toolbar">
      <input id="f-kw" placeholder="搜索买家/消息内容" value="${esc(keyword)}" style="width:220px">
      <span id="f-status-host"></span>
      <button class="btn" id="f-go">筛选</button>
    </div>
    <div class="chat-layout">
      <div class="chat-left">
        <div id="conv-list"></div>
        <div class="pager" id="conv-pager"></div>
      </div>
      <div class="chat-right">
        <div class="msg-list" id="msg-list"><div class="empty">选择左侧会话查看消息</div></div>
        <div class="chat-input">
          <input id="reply-input" placeholder="输入客服回复内容（手动发送）">
          <button class="btn btn-primary" id="btn-send" disabled>发送</button>
        </div>
      </div>
    </div>`;
  const syncHead = () => {
    c.querySelector('#conv-crm').disabled = !selected;
    c.querySelector('#conv-status-btn').style.display = selected ? '' : 'none';
    if (selectedConv) c.querySelector('#conv-status-btn').textContent = selectedConv.status === 'closed' ? '重开会话' : '关闭会话';
    // 发送框提示真实/模拟通道（所选会话支持真实发送时明确告知）
    const input = c.querySelector('#reply-input');
    if (input) {
      if (selectedConv && selectedConv.real_channel) {
        input.placeholder = '输入回复内容（真实发送到买家闲鱼）';
        input.disabled = false;
      } else if (isDemoMode) {
        input.placeholder = '输入客服回复内容（演示模式，模拟发送）';
        input.disabled = false;
      } else {
        input.placeholder = selected ? '该会话未接入真实消息通道（账号需上线且收到买家真实消息后可回复）' : '选择左侧会话后输入回复';
        input.disabled = false;
      }
      const btn = c.querySelector('#btn-send');
      if (btn && !input.value.trim()) btn.disabled = true;
    }
  };
  c.querySelector('#conv-refresh').onclick = drawList;
  c.querySelector('#btn-send-img').onclick = () => {
    if (!selected) { WB.toast('请先选择会话', 'error'); return; }
    WB.openModal({
      title: '发送图片消息',
      body: `
        <label>图片地址（http/https）<i class="req">*</i></label>
        <input name="image_url" placeholder="https://..." required>
        <label>附言（可选）</label><input name="text" placeholder="如：实物实拍图，成色如图">`,
      onSubmit: async (v) => {
        await WB.post(`/api/v1/conversations/${selected}/send`, { content: v.text || '[图片]', image_url: v.image_url });
        WB.toast('图片消息已发送');
        const msgs = await WB.get(`/api/v1/conversations/${selected}/messages?after_id=${lastMsgId}`);
        lastMsgId = msgs.length ? msgs[msgs.length - 1].id : lastMsgId;
        drawMsgs(msgs);
        drawList();
      },
    });
  };
  c.querySelector('#btn-phrases').onclick = () => phrasesModal();
  // 自定义下拉筛选（会话状态）
  WB.select(c.querySelector('#f-status-host'), {
    options: [{ v: '', label: '全部状态' }, { v: 'open', label: '进行中' }, { v: 'closed', label: '已关闭' }],
    value: statusFilter,
    width: '130px',
    onChange: (v) => { statusFilter = v; c.dataset.statusFilter = v; convPage = 1; drawList(); },
  });
  c.querySelector('#f-go').onclick = () => { keyword = c.querySelector('#f-kw').value.trim(); c.dataset.keyword = keyword; c.dataset.statusFilter = statusFilter; convPage = 1; drawList(); };
  c.querySelector('#f-kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') c.querySelector('#f-go').click(); });
  // 同步平台历史会话（session.sync + user.query 真实接口）
  c.querySelector('#conv-sync').onclick = async () => {
    const btn = c.querySelector('#conv-sync');
    btn.disabled = true; btn.textContent = '⏳ 同步中…';
    try {
      const accId = WB.activeAccountId;
      const r = await WB.post('/api/v1/conversations/sync', accId ? { account_id: Number(accId) } : {});
      WB.toast(`同步完成：平台会话 ${r.total_sessions} 个（新增 ${r.new_conversations}），消息入库 ${r.synced_messages} 条`);
      drawList();
    } catch (e) {
      WB.toast(e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '🔄 同步历史会话';
    }
  };
  // 消息通道状态横幅：说明为什么收不到消息
  (async () => {
    try {
      const st = await WB.get('/api/v1/conversations/channel-status');
      const real = (st.accounts || []).filter((a) => a.is_real);
      if (!real.length) return;
      const bad = real.filter((a) => a.status === 'error' || a.cookie_state === 'expired' || (!a.ws_running && a.status !== 'offline'));
      if (!bad.length) return;
      const host = c.querySelector('#conv-banner');
      host.innerHTML = `<div class="hint" style="background:#fff7e6;border:1px solid #f0d9a8;border-radius:8px;padding:10px 12px;margin-bottom:12px">
        ⚠️ ${bad.map((a) => `「${esc(a.nickname)}」${a.cookie_state === 'expired' || a.status === 'error' ? '凭证已过期/掉线' : '消息通道未连接'}`).join('；')}，无法接收新消息 —— 请到 <a href="#/accounts">账号管理</a> 重新扫码上线${isDemoMode ? '（演示模式可用「演示模式」页注入买家消息）' : ''}。
      </div>`;
    } catch (_) { /* 状态获取失败不提示 */ }
  })();
  c.querySelector('#conv-crm').onclick = () => {
    if (!selectedConv) { WB.toast('请先选择会话', 'error'); return; }
    sessionStorage.setItem('wb_crm_keyword', selectedConv.buyer_nick);
    location.hash = '#/crm';
  };
  c.querySelector('#conv-status-btn').onclick = async () => {
    if (!selectedConv) return;
    const target = selectedConv.status === 'closed' ? 'open' : 'closed';
    try {
      await WB.post(`/api/v1/conversations/${selected}/status`, { status: target });
      WB.toast(target === 'closed' ? '会话已关闭' : '会话已重新打开');
      selectedConv.status = target;
      syncHead();
      drawList();
    } catch (e) { WB.toast(e.message, 'error'); }
  };
  c.querySelector('#msg-read-all').onclick = async () => {
    try {
      const r = await WB.post('/api/v1/conversations/read-all');
      WB.toast(`已将 ${r.conversations_cleared} 个会话标记为已读`);
      drawList();
    } catch (e) { WB.toast(e.message, 'error'); }
  };
  c.querySelector('#reply-input').oninput = (e) => { c.querySelector('#btn-send').disabled = !e.target.value.trim() || !selected; };
  c.querySelector('#btn-send').onclick = async () => {
    const input = c.querySelector('#reply-input');
    const btn = c.querySelector('#btn-send');
    if (!input.value.trim() || !selected || btn.disabled) return;
    btn.disabled = true; // 防重：发送期间禁用
    try {
      await WB.post(`/api/v1/conversations/${selected}/send`, { content: input.value.trim() });
      input.value = '';
      const msgs = await WB.get(`/api/v1/conversations/${selected}/messages?after_id=${lastMsgId}`);
      lastMsgId = msgs.length ? msgs[msgs.length - 1].id : lastMsgId;
      drawMsgs(msgs);
      drawList();
    } catch (e) { WB.toast(e.message, 'error'); }
    if (input.value.trim() && selected) btn.disabled = false;
    else if (!input.value.trim()) btn.disabled = true;
    input.focus();
  };
  pollTimer = setInterval(async () => {
    if (!selected) return;
    try {
      const msgs = await WB.get(`/api/v1/conversations/${selected}/messages?after_id=${lastMsgId}`);
      if (msgs.length) {
        lastMsgId = msgs[msgs.length - 1].id;
        drawMsgs(msgs);
      }
    } catch (_) { /* 静默轮询失败 */ }
  }, 3000);
  listTimer = setInterval(drawList, 15000); // 会话列表 15 秒自动刷新（新会话/新未读可见）
  await drawList();
  syncHead();
  if (jumpOpen) openConv(jumpOpen); // 从 CRM 跳入时自动打开关联会话
};

/** 快捷回复短语：点选插入输入框，可增删（存于系统设置 quick_phrases） */
function phrasesModal() {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-mask" id="ph-mask">
      <div class="modal">
        <div class="modal-head"><span>⚡ 快捷回复短语</span><button type="button" class="modal-x" id="ph-x">×</button></div>
        <div class="modal-body">
          <div id="ph-list"><div class="hint">加载中…</div></div>
          <div class="toolbar" style="margin-top:12px">
            <input id="ph-new" placeholder="新短语内容" style="flex:1">
            <button class="btn btn-primary" id="ph-add">添加</button>
          </div>
        </div>
        <div class="modal-foot"><span class="modal-err" id="ph-err"></span>
          <button type="button" class="btn btn-primary" id="ph-close">完成</button></div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('#ph-x').onclick = close;
  root.querySelector('#ph-close').onclick = close;
  root.querySelector('#ph-mask').addEventListener('click', (e) => { if (e.target.id === 'ph-mask') close(); });
  let phrases = [];
  const draw = (list) => {
    phrases = list || [];
    const box = root.querySelector('#ph-list');
    box.innerHTML = phrases.length
      ? phrases.map((p, i) => `<div class="diag-item sev-info" style="display:flex;justify-content:space-between;align-items:center">
          <span style="cursor:pointer" class="ph-pick" data-i="${i}">${esc(p.text)}</span>
          <button class="btn btn-sm btn-danger ph-del" data-i="${i}">删除</button></div>`).join('')
      : '<div class="empty">暂无短语，请在下方添加</div>';
    box.querySelectorAll('.ph-pick').forEach((el) => {
      el.onclick = () => {
        const input = document.getElementById('reply-input');
        if (!input) { WB.toast('请先选择会话', 'error'); return; }
        input.value = (input.value ? input.value + ' ' : '') + phrases[Number(el.dataset.i)].text;
        input.dispatchEvent(new Event('input'));
        close();
        input.focus();
      };
    });
    box.querySelectorAll('.ph-del').forEach((b) => {
      b.onclick = async () => {
        phrases.splice(Number(b.dataset.i), 1);
        await WB.put('/api/v1/reply-phrases', { phrases });
        draw(phrases);
      };
    });
  };
  root.querySelector('#ph-add').onclick = async () => {
    const input = root.querySelector('#ph-new');
    const text = input.value.trim();
    if (!text) { root.querySelector('#ph-err').textContent = '请输入短语内容'; return; }
    root.querySelector('#ph-err').textContent = '';
    phrases.push({ text });
    await WB.put('/api/v1/reply-phrases', { phrases });
    input.value = '';
    draw(phrases);
  };
  WB.get('/api/v1/reply-phrases').then(draw).catch((e) => { root.querySelector('#ph-err').textContent = e.message; });
}

/* ================= 商品管理（商品列表 + 商品优化 合并页） ================= */

PAGES.crm = async (c) => {
  let filter = c.dataset.filter || 'all';
  let keyword = c.dataset.keyword || '';
  let page = 1;
  // 支持从消息会话页跳转（带入买家昵称）
  const jumpKw = sessionStorage.getItem('wb_crm_keyword');
  if (jumpKw) { sessionStorage.removeItem('wb_crm_keyword'); keyword = jumpKw; c.dataset.keyword = keyword; filter = 'all'; }
  const draw = async () => {
    const [buyers, faq] = await Promise.all([
      WB.get(`/api/v1/crm/buyers?filter=${filter}&page=${page}&page_size=15${accQ()}${keyword ? '&keyword=' + encodeURIComponent(keyword) : ''}`),
      WB.get('/api/v1/crm/faq-stats'),
    ]);
    c.innerHTML = `
      ${pageHead('客户管理（CRM）', '')}
      <div class="tabs">
        ${[['all', '全部客户'], ['followup', '待跟进提醒'], ['high', '高意向'], ['converted', '已成交']].map(([k, label]) =>
          `<button class="tab-btn ${filter === k ? 'active' : ''}" data-filter="${k}">${label}</button>`).join('')}
      </div>
      <div class="toolbar">
        <input id="f-kw" placeholder="搜索买家昵称/ID" value="${esc(keyword)}" style="width:220px">
        <button class="btn" id="f-go">搜索</button>
      </div>
      ${table(['买家', '账号', '意向', '分类', '咨询/回复', '成交', '最近联系', '下次跟进', '备注', '操作'],
        buyers.list.map((b) => `<tr>
          <td><b>${esc(b.buyer_nick)}</b></td><td>${esc(b.account_nickname || '')}</td>
          <td>${b.intention_score} 分 ${badge({ high: 'ok', medium: 'info', low: 'muted', unknown: 'muted' }[b.intention_level], { high: '高意向', medium: '中意向', low: '低意向', unknown: '未知' }[b.intention_level])}</td>
          <td>${badge('info', b.category || '—')}</td>
          <td>${b.message_count_in} / ${b.message_count_out}</td>
          <td>${b.converted ? '✓ ' + esc(b.converted_order_no || '') : '—'}</td>
          <td>${fmt(b.last_contact_at)}</td>
          <td>${b.converted ? '—' : fmt(b.follow_up_at)}</td>
          <td class="clip" title="${esc(b.follow_up_note)}">${esc(b.follow_up_note || '')}</td>
          <td class="ops">
            <button class="btn btn-sm crm-detail" data-id="${b.id}">详情</button>
            ${!b.converted ? '<button class="btn btn-sm crm-done" data-id="' + b.id + '">标记已跟进</button>' : ''}
          </td></tr>`).join(''))}
      <div class="pager" id="pager"></div>
      <h3 class="sub-h">买家常见问题统计</h3>
      <div class="grid-2">
        <section class="panel"><h3>咨询分类</h3>${table(['分类', '买家数', '已成交'],
          faq.categories.map((x) => `<tr><td>${esc(x.category)}</td><td>${x.buyer_count}</td><td>${Number(x.converted_count)}</td></tr>`).join(''))}</section>
        <section class="panel"><h3>高频命中关键词</h3>${table(['关键词', '命中次数'],
          faq.top_keywords.map((x) => `<tr><td>${esc(x.keyword)}</td><td>${x.hit_count}</td></tr>`).join(''))}</section>
      </div>`;
    WB.paginate(c.querySelector('#pager'), buyers.total, page, 15, (p) => { page = p; draw(); });
    c.querySelectorAll('.tab-btn').forEach((b) => { b.onclick = () => { filter = b.dataset.filter; c.dataset.filter = filter; page = 1; draw(); }; });
    c.querySelector('#f-go').onclick = () => { keyword = c.querySelector('#f-kw').value.trim(); c.dataset.keyword = keyword; page = 1; draw(); };
    c.querySelector('#f-kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') c.querySelector('#f-go').click(); });
    c.querySelectorAll('.crm-detail').forEach((b) => { b.onclick = () => detailModal(b.dataset.id, draw); });
    c.querySelectorAll('.crm-done').forEach((b) => {
      b.onclick = () => {
        const buyer = buyers.list.find((x) => String(x.id) === b.dataset.id);
        WB.openModal({
          title: `标记已跟进：${buyer.buyer_nick}`,
          body: `<label>跟进备注（可选，会覆盖原备注）</label><textarea name="note" rows="2" placeholder="${esc(buyer.follow_up_note || '如：已发限时优惠促成')}"></textarea>`,
          onSubmit: async (v) => {
            await WB.post(`/api/v1/crm/buyers/${b.dataset.id}/followup-done`, { note: v.note || '' });
            WB.toast('已标记跟进，下次提醒已排期');
            draw();
          },
        });
      };
    });
  };
  await draw();
};

async function detailModal(buyerId, onNeedRefresh) {
  const d = await WB.get(`/api/v1/crm/buyers/${buyerId}`);
  WB.openModal({
    title: `客户档案：${d.buyer.buyer_nick}`,
    wide: true,
    body: `
      <p><b>意向：</b>${d.buyer.intention_score} 分（${d.buyer.intention_level}）　<b>分类：</b>${esc(d.buyer.category || '-')}　<b>成交：</b>${d.buyer.converted ? esc(d.buyer.converted_order_no) : '未成交'}</p>
      <p><b>关联会话：</b>${d.conversations.length
        ? d.conversations.map((cv) => `<a href="#/messages" class="crm-conv" data-id="${cv.id}" style="cursor:pointer;margin-right:8px">#${cv.id} ${esc(cv.item_title || '')} →去回复</a>`).join('')
        : '无'}</p>
      <p><b>最近聊天记录（归档）：</b></p>
      ${table(['时间', '方向', '内容'], d.messages.slice(-10).reverse().map((m) => `<tr><td>${fmt(m.created_at)}</td>
        <td>${m.direction === 'in' ? '买家' : '客服'}</td><td class="clip" title="${esc(m.content)}">${esc(m.content)}</td></tr>`).join(''))}
      <div></div>`,
    onSubmit: async () => {},
  });
  document.querySelector('#modal-ok').textContent = '关闭';
  document.querySelectorAll('.crm-conv').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      sessionStorage.setItem('wb_conv_open', a.dataset.id);
      location.hash = '#/messages';
    };
  });
}

/* ================= M18 利润分析 ================= */
