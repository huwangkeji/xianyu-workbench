'use strict';
// 此文件由 pages.js 模块化拆分生成（MVC 视图层按业务域分模块，app.js 按路由懒加载）
// analyze：经营驾驶舱 / 利润中心 / 流量与市场 / 商品优化

PAGES.cockpit = async (c) => {
  const [d, stats] = await Promise.all([
    WB.get('/api/v1/cockpit/overview'),
    WB.get('/api/v1/stats/dashboard'),
  ]);
  const t = d.top;
  c.innerHTML = `
    ${pageHead('经营驾驶舱', '<button class="btn" id="cp-refresh">刷新</button>')}
    <div class="cards">
      <div class="card"><div class="card-t">账号在线</div><div class="card-v">${t.accounts.online} / ${t.accounts.total}</div><div class="card-s">今日消息 ${t.messages_today}</div></div>
      <div class="card"><div class="card-t">近30天净利润</div><div class="card-v ${t.profit_30d.net < 0 ? 'neg' : ''}">¥${Number(t.profit_30d.net).toFixed(2)}</div><div class="card-s">收入 ¥${Number(t.profit_30d.revenue).toFixed(2)} · 利润率 ${t.profit_30d.margin}%</div></div>
      <div class="card"><div class="card-t">近7天流量</div><div class="card-v">${t.traffic_7d.exposure}</div><div class="card-s">点击率 ${t.traffic_7d.ctr}% · 转化率 ${t.traffic_7d.cvr}%</div></div>
      <div class="card"><div class="card-t">待处理</div><div class="card-v">${t.pending_delivery + d.brief.todos.length}</div><div class="card-s">待发货 ${t.pending_delivery} · 待办 ${d.brief.todos.length}</div></div>
      <div class="card"><div class="card-t">风险</div><div class="card-v ${t.risk.high > 0 ? 'neg' : ''}">${t.risk.high}</div><div class="card-s">高危 · 中危 ${t.risk.medium}</div></div>
    </div>
    <div class="grid-2">
      <section class="panel">
        <h3>📌 今日待办（每日运营助手，点击跳转处理）</h3>
        ${d.brief.todos.length ? d.brief.todos.map((td) => {
          const target = { delivery: '#/orders', crm: '#/crm', aftersale: '#/aftersale', risk: '#/accounts', cards: '#/cards' }[td.type] || '';
          return `<div class="diag-item sev-${td.level === 'high' ? 'high' : 'medium'}">${esc(td.text)}
            ${target ? `<a href="${target}" class="btn btn-sm" style="float:right">去处理 →</a>` : ''}</div>`;
        }).join('') : '<div class="empty">暂无待办</div>'}
        ${WB.lineChart({
          width: 640,
          height: 160,
          series: [
            { label: '消息数', color: '#2f6fed', data: (stats.trend || []).map((t) => ({ x: t.date.slice(5), y: t.messages })) },
            { label: '订单数', color: '#23c07a', data: (stats.trend || []).map((t) => ({ x: t.date.slice(5), y: t.orders })) },
          ],
        })}
        <h3 class="sub-h">💡 经营建议</h3>
        ${d.brief.suggestions.map((s) => `<div class="diag-item sev-info">${esc(s)}</div>`).join('')}
        <div class="toolbar" style="margin-top:10px">
          <button class="btn btn-primary" id="cp-ai-brief" ${d.brief.ai_available ? '' : 'disabled title="需先在 AI 控制台配置默认供应商"'}>🧠 AI 解读今日经营</button>
        </div>
        <div id="cp-ai-result"></div>
      </section>
      <section class="panel">
        <h3>🗺️ 六大模块</h3>
        <div class="module-grid">
          ${Object.values(d.modules).map((m) => `
            <a class="module-card" href="${m.href}">
              <b>${esc(m.label)}</b>
              ${Object.entries(m.stats).map(([k, v]) => `<span>${esc(k)}：<b>${esc(v)}</b></span>`).join('')}
            </a>`).join('')}
        </div>
        <h3 class="sub-h">昨日经营</h3>
        <p class="hint" style="margin:0">成交 ${d.brief.yesterday.orders} 单 · 收入 ¥${Number(d.brief.yesterday.revenue).toFixed(2)} · 净利润 ¥${Number(d.brief.yesterday.net_profit).toFixed(2)}（近1天口径）</p>
      </section>
    </div>`;
  c.querySelector('#cp-refresh').onclick = () => WB.renderPage();
  c.querySelector('#cp-ai-brief').onclick = async () => {
    const box = c.querySelector('#cp-ai-result');
    box.innerHTML = '<div class="loading">AI 正在解读…</div>';
    try {
      const r = await WB.post('/api/v1/assistant/daily-brief/ai');
      box.innerHTML = `<div class="diag-item sev-ok"><pre class="pre" style="margin:0">${esc(r.content)}</pre>
        <button class="btn btn-sm" id="cp-ai-copy" style="margin-top:6px">复制解读</button></div>`;
      document.getElementById('cp-ai-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(r.content); WB.toast('已复制'); }
        catch (_) { WB.toast('复制失败，请手动选择文本复制', 'error'); }
      };
    } catch (e) { box.innerHTML = `<div class="diag-item sev-high">AI 解读失败：${esc(e.message)}</div>`; }
  };
};


/* ================= M14 流量分析 + M15 市场雷达（合并页：数据分析） ================= */
PAGES.analytics = async (c) => subTabPage(c, 'analytics', [['traffic', '📈 流量分析'], ['market', '🔍 市场雷达']], {
  traffic: WB.PAGES.traffic,
  market: WB.PAGES.market,
});

PAGES.traffic = async (c) => {
  let days = Number(c.dataset.days || 7);
  const mode = (await WB.get('/api/v1/system/mode/public')).mode;
  const [overview, diag] = await Promise.all([
    WB.get(`/api/v1/analytics/traffic/overview?days=${days}`),
    WB.get('/api/v1/analytics/traffic/diagnosis'),
  ]);
  const pctStr = (v) => (v * 100).toFixed(1) + '%';
  c.innerHTML = `
    ${pageHead('流量分析', `<select id="tr-days" style="width:120px">
      <option value="7" ${days === 7 ? 'selected' : ''}>近 7 天</option>
      <option value="14" ${days === 14 ? 'selected' : ''}>近 14 天</option>
      <option value="30" ${days === 30 ? 'selected' : ''}>近 30 天</option></select>
      <button class="btn" id="tr-refresh">刷新</button>`)}
    <div class="cards">
      <div class="card"><div class="card-t">诊断问题</div><div class="card-v">${diag.summary.total}</div><div class="card-s">高危 ${diag.summary.high} / 中危 ${diag.summary.medium}</div></div>
      <div class="card"><div class="card-t">监控商品</div><div class="card-v">${overview.length}</div><div class="card-s">近 7 天数据</div></div>
      <div class="card"><div class="card-t">总曝光 / 总浏览</div><div class="card-v">${overview.reduce((a, b) => a + b.exposure, 0)} / ${overview.reduce((a, b) => a + b.views, 0)}</div><div class="card-s"></div></div>
      <div class="card"><div class="card-t">总成交 / 金额</div><div class="card-v">${overview.reduce((a, b) => a + b.orders, 0)} / ¥${overview.reduce((a, b) => a + b.amount, 0).toFixed(2)}</div><div class="card-s"></div></div>
    </div>
    <h3 class="sub-h">⚠️ 诊断结果（自动分析）</h3>
    <div id="diag-list">${diag.findings.length ? diag.findings.map((f) => `
      <div class="diag-item sev-${f.severity}">
        <div><b>${esc(f.item_title)}</b>　${badge(f.severity === 'high' ? 'failed' : 'warning', f.severity === 'high' ? '高危' : '中危')}</div>
        <div class="diag-metric">${esc(f.metric)}</div>
        <div>${esc(f.message)}</div>
        <div class="diag-tip">💡 ${esc(f.suggestion)}</div>
      </div>`).join('') : '<div class="empty">未发现问题，各商品流量健康</div>'}</div>
    <h3 class="sub-h">商品流量漏斗（近 7 天）</h3>
    ${table(['商品', '账号', '曝光', '浏览', '点击率', '收藏', '咨询', '成交', '转化率', '成交额', '操作'],
      overview.map((i) => `<tr>
        <td class="clip" title="${esc(i.title)}">${esc(i.title)}</td><td>${esc(i.account_nickname || '')}</td>
        <td>${i.exposure}</td><td>${i.views}</td><td>${pctStr(i.ctr)}</td><td>${i.favorites}</td>
        <td>${i.inquiries}</td><td>${i.orders}</td><td>${pctStr(i.cvr)}</td><td>¥${Number(i.amount).toFixed(2)}</td>
        <td class="ops">
          <button class="btn btn-sm tr-sug" data-id="${i.item_id}">优化建议</button>
          <button class="btn btn-sm tr-trend" data-id="${i.item_id}">趋势</button>
        </td></tr>`).join(''))}
    ${mode === 'demo' ? `
    <h3 class="sub-h">🎬 录入模拟流量数据（仅演示模式可见，按天累计）</h3>
    <div class="toolbar">
      <select id="tr-item"></select>
      <input id="tr-exp" type="number" placeholder="曝光" style="width:90px">
      <input id="tr-view" type="number" placeholder="浏览" style="width:90px">
      <input id="tr-fav" type="number" placeholder="收藏" style="width:80px">
      <input id="tr-inq" type="number" placeholder="咨询" style="width:80px">
      <button class="btn" id="tr-submit">录入今日数据</button>
    </div>` : ''}`;
  c.querySelector('#tr-days').onchange = (e) => { days = Number(e.target.value); c.dataset.days = days; draw(); };
  c.querySelector('#tr-refresh').onclick = () => draw();
  c.querySelectorAll('.tr-sug').forEach((b) => { b.onclick = () => sugModal(b.dataset.id); });
  c.querySelectorAll('.tr-trend').forEach((b) => { b.onclick = () => trendModal(b.dataset.id, days); });
  const trItem = c.querySelector('#tr-item');
  if (trItem) {
    trItem.innerHTML = opts(overview, 'item_id', (i) => i.title);
    c.querySelector('#tr-submit').onclick = async () => {
      try {
        await WB.post('/api/v1/simulate/item-stats', {
          item_id: Number(trItem.value),
          exposure: Number(c.querySelector('#tr-exp').value) || 0,
          views: Number(c.querySelector('#tr-view').value) || 0,
          favorites: Number(c.querySelector('#tr-fav').value) || 0,
          inquiries: Number(c.querySelector('#tr-inq').value) || 0,
        });
      WB.toast('流量数据已录入');
      draw();
    } catch (e) { WB.toast(e.message, 'error'); }
    };
  }
};

async function trendModal(itemId, days) {
  const d = Math.max(1, Number(days) || 7);
  const r = await WB.get(`/api/v1/analytics/traffic/item/${itemId}?days=${d}`);
  const chart = r.rows.length ? WB.lineChart({
    width: 620,
    height: 190,
    series: [
      { label: '曝光', color: '#2f6fed', data: r.rows.map((row) => ({ x: String(row.stat_date).slice(5), y: Number(row.exposure) })) },
      { label: '浏览', color: '#23c07a', data: r.rows.map((row) => ({ x: String(row.stat_date).slice(5), y: Number(row.views) })) },
    ],
  }) : '';
  WB.openModal({
    title: `「${r.item.title}」近 ${d} 天趋势`,
    wide: true,
    body: `${chart}
      ${table(['日期', '曝光', '浏览', '收藏', '咨询', '成交', '金额'],
      r.rows.map((row) => `<tr><td>${esc(String(row.stat_date).slice(0, 10))}</td><td>${row.exposure}</td><td>${row.views}</td>
        <td>${row.favorites}</td><td>${row.inquiries}</td><td>${row.orders}</td><td>￥${Number(row.amount).toFixed(2)}</td></tr>`).join(''))}<div></div>`,
    onSubmit: async () => {},
  });
  document.querySelector('#modal-ok').textContent = '关闭';
}

async function sugModal(itemId) {
  const r = await WB.get(`/api/v1/analytics/traffic/suggestions/${itemId}`);
  WB.openModal({
    title: `优化建议：${r.item.title}`,
    wide: true,
    body: `
      <p class="hint">漏斗：曝光 ${r.funnel.exposure} → 浏览 ${r.funnel.views}（点击率 ${(r.funnel.ctr * 100).toFixed(1)}%）→ 咨询 ${r.funnel.inquiries} → 成交 ${r.funnel.orders}（转化率 ${(r.funnel.cvr * 100).toFixed(1)}%）</p>
      ${r.suggestions.map((s) => `<div class="diag-item sev-info"><b>【${esc(s.area)}】</b>${esc(s.message)}</div>`).join('')}
      <div></div>`,
    onSubmit: async () => {},
  });
  document.querySelector('#modal-ok').textContent = '关闭';
}

/** 通用 findings 列表渲染（商品体检/诊断共用） */

PAGES.market = async (c) => {
  let tab = c.dataset.tab || 'keywords';
  const draw = async () => {
    let body = '';
    if (tab === 'keywords') {
      const kws = await WB.get('/api/v1/analytics/market/keywords');
      body = `
        <div class="toolbar">
          <input id="mk-add" placeholder="新增监控关键词，如：二手手机" style="width:240px">
          <button class="btn btn-primary" id="mk-add-btn">添加关键词</button>
          <input id="mk-sim" placeholder="记录一次买家搜索（关键词）" style="width:220px">
          <button class="btn" id="mk-sim-btn">记录搜索</button>
          <button class="btn" id="mk-export">⬇ 导出</button>
          <button class="btn" id="mk-import">⬆ 导入</button>
        </div>
        ${table(['关键词', '搜索热度', '买家数', '市场均价', '趋势', '市场商品数', '我的在架商品', '操作'],
          kws.map((k) => `<tr><td><b>${esc(k.keyword)}</b></td><td>${k.search_count}</td><td>${k.buyer_count}</td>
            <td>${k.avg_price ? '¥' + Number(k.avg_price).toFixed(2) : '—'}</td>
            <td>${k.trend === 'up' ? '📈 上升' : k.trend === 'down' ? '📉 下降' : '➖ 持平'}</td>
            <td>${k.market_count}</td><td>${k.my_item_count}</td>
            <td><button class="btn btn-sm btn-danger mk-del" data-id="${k.id}">删除</button></td></tr>`).join(''))}`;
    } else if (tab === 'items') {
      const kind = c.dataset.kind || '';
      const items = await WB.get(`/api/v1/analytics/market/items?page_size=50${kind ? '&kind=' + kind : ''}`);
      body = `
        <div class="toolbar">
          <select id="mk-kind"><option value="">全部类型</option>
            <option value="hot" ${kind === 'hot' ? 'selected' : ''}>行业热门</option>
            <option value="competitor" ${kind === 'competitor' ? 'selected' : ''}>竞品</option>
            <option value="demand" ${kind === 'demand' ? 'selected' : ''}>新需求</option>
          </select>
          <button class="btn btn-primary" id="mk-scan">执行行情扫描</button>
        </div>
        ${table(['类型', '关键词', '标题', '店铺', '价格', '价格变动', '月销/热度', '最近采集'],
          items.list.map((m) => `<tr>
            <td>${{ hot: '热门', competitor: '竞品', demand: '新需求' }[m.kind]}</td><td>${esc(m.keyword)}</td>
            <td class="clip" title="${esc(m.title)}">${esc(m.title)}</td><td>${esc(m.shop_name)}</td>
            <td>¥${Number(m.price).toFixed(2)}</td>
            <td>${m.status === 'price_up' ? badge('warning', '↑涨价') : m.status === 'price_down' ? badge('ok', '↓降价') : badge('muted', '—')}</td>
            <td>${m.monthly_sales}</td><td>${fmt(m.last_seen_at)}</td></tr>`).join(''))}`;
    } else if (tab === 'alerts') {
      const alerts = await WB.get('/api/v1/analytics/market/competitors/alerts');
      body = `
        <h3 class="sub-h">📉 竞品降价（24h）</h3>
        ${table(['标题', '店铺', '关键词', '现价', '原价', '降幅', '采集时间'],
          alerts.drops.map((a) => `<tr><td class="clip">${esc(a.title)}</td><td>${esc(a.shop_name)}</td><td>${esc(a.keyword)}</td>
            <td>¥${a.price.toFixed(2)}</td><td>¥${a.prev_price.toFixed(2)}</td>
            <td>${badge('failed', '-' + a.drop_pct + '%')}</td><td>${fmt(a.last_seen_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-cell">暂无降价预警</td></tr>')}
        <h3 class="sub-h">🆕 新进入竞品（3 天内）</h3>
        ${table(['标题', '店铺', '关键词', '价格', '进入时间'],
          alerts.new_comers.map((a) => `<tr><td class="clip">${esc(a.title)}</td><td>${esc(a.shop_name)}</td><td>${esc(a.keyword)}</td><td>¥${a.price.toFixed(2)}</td><td>${fmt(a.first_seen_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-cell">暂无新竞品</td></tr>')}
        <h3 class="sub-h">🚀 销量激增竞品</h3>
        ${table(['标题', '店铺', '价格', '增幅'],
          alerts.sales_surges.map((a) => `<tr><td class="clip">${esc(a.title)}</td><td>${esc(a.shop_name)}</td><td>¥${a.price.toFixed(2)}</td><td>${badge('warning', '+' + a.surge_pct + '%')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-cell">暂无激增信号</td></tr>')}`;
    } else if (tab === 'radar') {
      const radar = await WB.get('/api/v1/radar/opportunities');
      body = `
        <p class="hint">商品机会雷达：聚合需求空缺、新需求、调价空间、热度上升与高意向买家信号，按可执行性排序。</p>
        ${radar.opportunities.map((o) => `
          <div class="diag-item sev-${o.score >= 80 ? 'high' : o.score >= 65 ? 'medium' : 'low'}">
            <div><b>[${{ demand_uncovered: '需求空缺', new_demand: '新需求', price_adjust: '调价机会', hot_keyword: '热度上升', buyer_followup: '催单机会' }[o.type] || o.type}]</b> ${esc(o.title)}　${badge('info', '机会分 ' + o.score)}</div>
            <div class="diag-metric">${esc(o.detail)}</div>
            <div class="diag-tip">🎯 ${esc(o.action)}</div>
          </div>`).join('') || '<div class="empty">暂未发现经营机会，保持监控</div>'}`;
    } else {
      body = `
        <div class="toolbar">
          <select id="mk-kw"></select>
          <button class="btn btn-primary" id="mk-pr-analyze">分析价格区间</button>
        </div>
        <div id="mk-pr-result"><div class="empty">选择关键词后点击分析</div></div>`;
    }
    c.innerHTML = `
      ${pageHead('市场雷达', '')}
      <p class="hint">数据来源：模拟行情扫描（真实环境对接平台市场数据）。「执行行情扫描」会更新关键词热度、采集热门商品与竞品价格、发现新需求；竞品显著降价将通过通知中心推送。</p>
      <div class="tabs">
        <button class="tab-btn ${tab === 'keywords' ? 'active' : ''}" data-tab="keywords">搜索关键词</button>
        <button class="tab-btn ${tab === 'items' ? 'active' : ''}" data-tab="items">热门与竞品</button>
        <button class="tab-btn ${tab === 'alerts' ? 'active' : ''}" data-tab="alerts">竞品预警</button>
        <button class="tab-btn ${tab === 'radar' ? 'active' : ''}" data-tab="radar">机会雷达</button>
        <button class="tab-btn ${tab === 'price' ? 'active' : ''}" data-tab="price">价格区间分析</button>
      </div>
      ${body}`;
    c.querySelectorAll('.tab-btn').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; c.dataset.tab = tab; draw(); }; });
    if (tab === 'keywords') {
      c.querySelector('#mk-add-btn').onclick = async () => {
        const kw = c.querySelector('#mk-add').value.trim();
        if (!kw) { WB.toast('请输入关键词', 'error'); return; }
        try { await WB.post('/api/v1/analytics/market/keywords', { keyword: kw }); WB.toast('已添加'); draw(); } catch (e) { WB.toast(e.message, 'error'); }
      };
      c.querySelector('#mk-export').onclick = async () => {
        try {
          const kws2 = await WB.get('/api/v1/analytics/market/keywords/export');
          const csv = '关键词,搜索热度,买家数,市场均价,趋势\r\n' + kws2.map((k) =>
            `"${k.keyword}",${k.search_count},${k.buyer_count},${k.avg_price || ''},${k.trend}`).join('\r\n');
          const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `keywords-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(a.href);
          WB.toast('关键词已导出');
        } catch (e) { WB.toast(e.message, 'error'); }
      };
      c.querySelector('#mk-import').onclick = () => {
        WB.openModal({
          title: '导入监控关键词（每行：关键词,热度,趋势）',
          body: `<textarea name="csv" rows="8" placeholder="二手手机,5200,up&#10;机械键盘,1900,flat"></textarea>
            <div class="check-row"><label><input type="checkbox" name="merge" checked> 与现有关键词合并（存在则累加热度）</label></div>`,
          onSubmit: async (v) => {
            const lines = String(v.csv || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            const keywords = lines.map((line) => {
              const [keyword, count, trend] = line.split(/[,，]/);
              return { keyword: (keyword || '').trim(), search_count: Number(count) || 0, trend: (trend || '').trim() };
            });
            const r = await WB.post('/api/v1/analytics/market/keywords/import', { keywords, replace: !v.merge });
            WB.toast(`导入完成：新增 ${r.imported}，合并/跳过 ${r.merged_or_skipped}`);
            draw();
          },
        });
      };
      c.querySelector('#mk-sim-btn').onclick = async () => {
        const kw = c.querySelector('#mk-sim').value.trim();
        if (!kw) { WB.toast('请输入关键词', 'error'); return; }
        try { await WB.post('/api/v1/simulate/search-keyword', { keyword: kw }); WB.toast('已记录搜索'); draw(); } catch (e) { WB.toast(e.message, 'error'); }
      };
      c.querySelectorAll('.mk-del').forEach((b) => {
        b.onclick = async () => {
          if (!WB.confirmDialog('确认删除该关键词监控？')) return;
          try { await WB.del(`/api/v1/analytics/market/keywords/${b.dataset.id}`); draw(); } catch (e) { WB.toast(e.message, 'error'); }
        };
      });
    } else if (tab === 'items') {
      c.querySelector('#mk-kind').onchange = (e) => { c.dataset.kind = e.target.value; draw(); };
      c.querySelector('#mk-scan').onclick = async () => {
        try {
          const r = await WB.post('/api/v1/analytics/market/scan');
          WB.toast(`扫描完成：更新 ${r.updated}，新增 ${r.added}，价格变动 ${r.price_changes}`);
          draw();
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    } else {
      const kws = await WB.get('/api/v1/analytics/market/keywords');
      c.querySelector('#mk-kw').innerHTML = opts(kws, 'keyword', (k) => k.keyword);
      c.querySelector('#mk-pr-analyze').onclick = async () => {
        const kw = c.querySelector('#mk-kw').value;
        try {
          const r = await WB.get(`/api/v1/analytics/market/price-range?keyword=${encodeURIComponent(kw)}`);
          document.getElementById('mk-pr-result').innerHTML = `
            <div class="cards">
              <div class="card"><div class="card-t">样本数</div><div class="card-v">${r.stats.count}</div></div>
              <div class="card"><div class="card-t">最低价</div><div class="card-v">¥${r.stats.min}</div></div>
              <div class="card"><div class="card-t">均价</div><div class="card-v">¥${r.stats.avg}</div></div>
              <div class="card"><div class="card-t">最高价</div><div class="card-v">¥${r.stats.max}</div></div>
            </div>
            <h3 class="sub-h">我的在架同款商品</h3>
            ${table(['我的商品', '我的价格', '对比市场均价', '结论'],
              r.my_items.length ? r.my_items.map((m) => `<tr><td class="clip">${esc(m.title)}</td><td>¥${m.price.toFixed(2)}</td>
                <td>${m.vs_avg_pct > 0 ? '+' : ''}${m.vs_avg_pct}%</td>
                <td>${m.vs_avg_pct > 20 ? badge('failed', '明显高于市场') : m.vs_avg_pct < -30 ? badge('warn', '偏低注意利润') : badge('ok', '有竞争力')}</td></tr>`).join('')
                : '<tr><td colspan="4" class="empty-cell">暂无匹配的在架商品</td></tr>')}`;
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    }
  };
  await draw();
};

/* ================= M16 智能商品优化 ================= */
PAGES.optimizer = async (c) => {
  let tab = c.dataset.tab || 'check';
  const draw = async () => {
    let body = '';
    if (tab === 'check') {
      const items = await WB.get('/api/v1/items?page_size=100');
      body = `
        <div class="toolbar"><button class="btn btn-primary" id="opt-run-all">一键体检全部商品</button></div>
        <div id="opt-results"><p class="hint">点击「一键体检」或单件商品「体检」查看：标题关键词、描述完整度、首图、价格竞争力、违禁词风险。</p></div>
        ${table(['商品', '账号', '价格', '首图', '状态', '操作'],
          items.list.map((i) => `<tr><td class="clip" title="${esc(i.title)}">${esc(i.title)}</td>
            <td>${esc(i.account_nickname || '')}</td><td>¥${Number(i.price).toFixed(2)}</td>
            <td>${i.main_image ? '✓' : '✗ 未配置'}</td><td>${badge(i.status)}</td>
            <td class="ops"><button class="btn btn-sm opt-check" data-id="${i.id}">体检</button></td></tr>`).join(''))}`;
    } else if (tab === 'materials') {
      const mats = await WB.get('/api/v1/optimizer/materials?page_size=100');
      body = `
        <div class="toolbar"><button class="btn btn-primary" id="mat-add">+ 新增素材</button></div>
        ${table(['ID', '名称', '用途', '内容', '标签', '使用次数', '操作'],
          mats.list.map((m) => `<tr><td>${m.id}</td><td>${esc(m.name)}</td>
            <td>${{ title: '标题', description: '描述', image: '首图' }[m.category]}</td>
            <td class="clip" title="${esc(m.content)}">${esc(m.content)}</td><td>${esc(m.tags)}</td><td>${m.use_count}</td>
            <td class="ops">
              <button class="btn btn-sm mat-copy" data-id="${m.id}">复制</button>
              <button class="btn btn-sm mat-use" data-id="${m.id}">应用</button>
              <button class="btn btn-sm mat-edit" data-id="${m.id}">编辑</button>
              <button class="btn btn-sm btn-danger mat-del" data-id="${m.id}">删除</button>
            </td></tr>`).join(''))}`;
    } else if (tab === 'lab') {
      body = `
        <div class="grid-2">
          <section class="panel">
            <h3>标题实验室</h3>
            <label>商品标题</label><input id="tl-title" placeholder="粘贴标题">
            <div class="form-row">
              <div><label>成色</label><select id="tl-cond"><option>全新</option><option>九五新</option><option selected>九成新</option><option>八成新</option><option>有瑕疵</option></select></div>
              <div><label>操作</label><button class="btn btn-primary" id="tl-run">分析</button>
                <button class="btn" id="tl-ai">🧠 AI 生成标题</button></div>
            </div>
            <div id="tl-result"></div>
          </section>
          <section class="panel">
            <h3>图片实验室（首图检查）</h3>
            <label>首图 URL</label><input id="il-img" placeholder="https://...">
            <label>商品标题（用于一致性检查）</label><input id="il-title">
            <button class="btn btn-primary" id="il-run">检查</button>
            <div id="il-result"></div>
          </section>
        </div>`;
    } else if (tab === 'estimate') {
      body = `
        <section class="panel">
          <h3>🏷️ 商品智能估价</h3>
          <div class="form-row">
            <div><label>商品标题</label><input id="ep-title" placeholder="如：九成新机械键盘 87键青轴"></div>
            <div><label>成色</label><select id="ep-cond"><option>全新</option><option>九五新</option><option selected>九成新</option><option>八成新</option><option>有瑕疵</option></select></div>
            <div><label>采购成本 ¥</label><input id="ep-cost" type="number" value="0"></div>
          </div>
          <div class="toolbar">
            <button class="btn btn-primary" id="ep-run">估价</button>
            <button class="btn" id="ep-ai">🧠 估价 + AI 点评</button>
          </div>
          <div id="ep-result"></div>
        </section>`;
    } else {
      body = `
        <div class="panel">
          <h3 class="sub-h">发布前风险检查</h3>
          <label>商品标题</label><input id="pc-title" placeholder="粘贴待发布的标题">
          <label>商品描述（可选）</label><textarea id="pc-desc" rows="3" placeholder="粘贴待发布的描述"></textarea>
          <button class="btn btn-primary" id="pc-run">检查</button>
          <div id="pc-result" style="margin-top:12px"></div>
        </div>`;
    }
    c.innerHTML = `
      ${pageHead('智能商品优化', '')}
      <div class="tabs">
        <button class="tab-btn ${tab === 'check' ? 'active' : ''}" data-tab="check">商品体检</button>
        <button class="tab-btn ${tab === 'materials' ? 'active' : ''}" data-tab="materials">发布素材库</button>
        <button class="tab-btn ${tab === 'lab' ? 'active' : ''}" data-tab="lab">标题/图片实验室</button>
        <button class="tab-btn ${tab === 'estimate' ? 'active' : ''}" data-tab="estimate">智能估价</button>
        <button class="tab-btn ${tab === 'precheck' ? 'active' : ''}" data-tab="precheck">发布前检查</button>
      </div>
      ${body}`;
    c.querySelectorAll('.tab-btn').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; c.dataset.tab = tab; draw(); }; });
    const showResult = (target, r) => {
      document.getElementById(target).innerHTML = `
        <div class="diag-item ${r.finding_count ? 'sev-medium' : 'sev-ok'}">
          <b>${r.score !== undefined ? `体检得分 ${r.score}（${r.grade}）` : (r.passed ? '✅ 检查通过，无高危风险' : '⚠️ 存在高危风险，建议修改后再发布')}</b>
        </div>
        ${r.findings.map((f) => `<div class="diag-item sev-${f.severity}">
          ${badge(f.severity === 'high' ? 'failed' : f.severity === 'medium' ? 'warning' : 'muted', { high: '高危', medium: '中危', low: '提示' }[f.severity])}
          ${esc(f.message)}<div class="diag-tip">💡 ${esc(f.suggestion)}</div></div>`).join('') || '<div class="empty">无问题项</div>'}`;
    };
    const runCheck = async (itemId) => {
      try {
        const r = await WB.get(`/api/v1/optimizer/check/${itemId}`);
        showResult('opt-results', r);
      } catch (e) { WB.toast(e.message, 'error'); }
    };
    if (tab === 'check') {
      c.querySelector('#opt-run-all').onclick = async () => {
        const btn = c.querySelector('#opt-run-all');
        btn.disabled = true;
        const items = await WB.get('/api/v1/items?page_size=100');
        const out = c.querySelector('#opt-results');
        const results = [];
        let done = 0;
        for (const i of items.list) {
          out.innerHTML = `<p class="hint">体检中… ${done}/${items.list.length}（${esc(i.title)}）</p>`;
          try {
            results.push(await WB.get(`/api/v1/optimizer/check/${i.id}`));
          } catch (_) { /* 单品失败不阻断 */ }
          done++;
        }
        btn.disabled = false;
        results.sort((a, b) => a.score - b.score);
        out.innerHTML = `
          <p class="hint">全部 ${results.length} 件商品体检完成（按得分升序）。平均分 ${results.length ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : 0}。</p>
          ${table(['商品', '得分', '评级', '问题数', '首要问题'],
            results.map((r) => `<tr><td class="clip" title="${esc(r.title)}">${esc(r.title)}</td>
              <td>${badge(r.score >= 85 ? 'success' : r.score >= 70 ? 'warning' : 'failed', String(r.score))}</td>
              <td>${esc(r.grade)}</td><td>${r.finding_count}</td>
              <td class="clip" title="${esc(r.findings[0] ? r.findings[0].message : '')}">${esc(r.findings[0] ? r.findings[0].message : '—')}</td></tr>`).join(''))}
          <div></div>`;
        WB.toast(`全部商品体检完成（${results.length} 件）`);
      };
      c.querySelectorAll('.opt-check').forEach((b) => { b.onclick = () => runCheck(b.dataset.id); });
    } else if (tab === 'materials') {
      const matForm = (m, onDone) => {
        WB.openModal({
          title: m ? `编辑素材 #${m.id}` : '新增素材',
          body: `<label>名称 <i class="req">*</i></label><input name="name" value="${esc(m ? m.name : '')}" required>
            <label>用途</label><select name="category"><option value="title" ${m && m.category === 'title' ? 'selected' : ''}>标题</option><option value="description" ${m && m.category === 'description' ? 'selected' : ''}>描述</option><option value="image" ${m && m.category === 'image' ? 'selected' : ''}>首图</option></select>
            <label>内容 <i class="req">*</i></label><textarea name="content" rows="4" required>${esc(m ? m.content : '')}</textarea>
            <label>标签（逗号分隔）</label><input name="tags" value="${esc(m ? m.tags : '')}">`,
          onSubmit: async (v) => {
            if (m) await WB.put(`/api/v1/optimizer/materials/${m.id}`, v);
            else await WB.post('/api/v1/optimizer/materials', v);
            WB.toast('已保存');
            onDone();
          },
        });
      };
      c.querySelector('#mat-add').onclick = () => matForm(null, draw);
      c.querySelectorAll('.mat-edit').forEach((b) => {
        b.onclick = () => matForm(mats.list.find((x) => String(x.id) === b.dataset.id), draw);
      });
      c.querySelectorAll('.mat-copy').forEach((b) => {
        b.onclick = async () => {
          const m = mats.list.find((x) => String(x.id) === b.dataset.id);
          try {
            await navigator.clipboard.writeText(m.content);
            WB.toast('内容已复制到剪贴板');
          } catch (_) {
            // 剪贴板 API 不可用（非 https 环境）时降级：弹窗展示供手动复制
            WB.openModal({ title: `素材内容：${m.name}`, body: `<textarea rows="6" readonly onclick="this.select()">${esc(m.content)}</textarea><div></div>`, onSubmit: async () => {} });
            document.querySelector('#modal-ok').textContent = '关闭';
          }
        };
      });
      c.querySelectorAll('.mat-del').forEach((b) => {
        b.onclick = async () => {
          if (!WB.confirmDialog('确认删除该素材？')) return;
          try { await WB.del(`/api/v1/optimizer/materials/${b.dataset.id}`); draw(); } catch (e) { WB.toast(e.message, 'error'); }
        };
      });
      c.querySelectorAll('.mat-use').forEach(async (b) => {
        b.onclick = async () => {
          try {
            const r = await WB.post(`/api/v1/optimizer/materials/${b.dataset.id}/use`);
            try { await navigator.clipboard.writeText(r.content); WB.toast('已复制到剪贴板并标记使用'); }
            catch (_) { WB.toast('已标记使用（内容见素材详情）'); }
          } catch (e) { WB.toast(e.message, 'error'); }
        };
      });
    } else if (tab === 'lab') {
      const showLab = (target, r) => {
        document.getElementById(target).innerHTML = `
          ${r.findings.map((f) => `<div class="diag-item sev-${f.severity}">${badge(f.severity === 'high' ? 'failed' : f.severity === 'medium' ? 'warning' : 'muted', { high: '高危', medium: '中危', low: '提示' }[f.severity])}${esc(f.message)}</div>`).join('') || '<div class="diag-item sev-ok">✅ 未发现问题</div>'}
          ${r.suggestions.map((s) => `<div class="diag-item sev-info">💡 ${esc(s)}</div>`).join('')}
          ${r.variants && r.variants.length ? `<div class="diag-item sev-ok"><b>优化变体：</b>${r.variants.map((v) => `<div>${esc(v)}</div>`).join('')}</div>` : ''}`;
      };
      c.querySelector('#tl-run').onclick = async () => {
        const title = c.querySelector('#tl-title').value.trim();
        if (!title) { WB.toast('请输入标题', 'error'); return; }
        try {
          const r = await WB.post('/api/v1/tools/title-lab', { title, goods_condition: c.querySelector('#tl-cond').value });
          showLab('tl-result', r);
        } catch (e) { WB.toast(e.message, 'error'); }
      };
      c.querySelector('#tl-ai').onclick = async () => {
        const title = c.querySelector('#tl-title').value.trim();
        if (!title) { WB.toast('请输入标题', 'error'); return; }
        try {
          const r = await WB.post('/api/v1/tools/title-lab/ai', { title });
          document.getElementById('tl-result').innerHTML = `<div class="diag-item sev-ok"><b>🧠 AI 生成（${esc(r.provider)}）：</b>${r.titles.map((t2) => `<div>${esc(t2)}</div>`).join('')}</div>`;
        } catch (e) { WB.toast(e.message, 'error'); }
      };
      c.querySelector('#il-run').onclick = async () => {
        try {
          const r = await WB.post('/api/v1/tools/image-lab', { main_image: c.querySelector('#il-img').value, title: c.querySelector('#il-title').value });
          showLab('il-result', r);
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    } else if (tab === 'estimate') {
      const showEp = (r) => {
        document.getElementById('ep-result').innerHTML = `
          <div class="diag-item sev-ok"><b>建议定价 ¥${r.suggested_price}</b>（区间 ¥${r.range[0]} - ¥${r.range[1]}，置信度 ${{ high: '高', medium: '中', low: '低' }[r.confidence]}）</div>
          ${r.rationale.map((s) => `<div class="diag-item sev-info">· ${esc(s)}</div>`).join('')}
          ${r.ai_comment ? `<div class="diag-item sev-ok"><b>🧠 AI 点评：</b>${esc(r.ai_comment)}</div>` : ''}`;
      };
      const collect = () => ({
        title: c.querySelector('#ep-title').value.trim(),
        goods_condition: c.querySelector('#ep-cond').value,
        cost_price: Number(c.querySelector('#ep-cost').value) || 0,
      });
      c.querySelector('#ep-run').onclick = async () => {
        const p = collect();
        if (!p.title) { WB.toast('请输入标题', 'error'); return; }
        try { showEp(await WB.post('/api/v1/tools/estimate-price', p)); } catch (e) { WB.toast(e.message, 'error'); }
      };
      c.querySelector('#ep-ai').onclick = async () => {
        const p = collect();
        if (!p.title) { WB.toast('请输入标题', 'error'); return; }
        try { showEp(await WB.post('/api/v1/tools/estimate-price', { ...p, use_ai: true })); } catch (e) { WB.toast(e.message, 'error'); }
      };
    } else {
      c.querySelector('#pc-run').onclick = async () => {
        try {
          const r = await WB.post('/api/v1/optimizer/precheck', {
            title: c.querySelector('#pc-title').value, description: c.querySelector('#pc-desc').value,
          });
          showResult('pc-result', r);
        } catch (e) { WB.toast(e.message, 'error'); }
      };
    }
  };
  await draw();
};

/* ================= M17 买家 CRM ================= */

PAGES.profit = async (c) => {
  let days = Number(c.dataset.days || 30);
  const draw = async () => {
    const [summary, byItem] = await Promise.all([
      WB.get(`/api/v1/analytics/profit/summary?days=${days}`),
      WB.get(`/api/v1/analytics/profit/by-item?days=${days}`),
    ]);
    const card = (t, v, cls) => `<div class="card"><div class="card-t">${t}</div><div class="card-v ${cls || ''}">${v}</div></div>`;
    c.innerHTML = `
      ${pageHead('利润中心', `<select id="pf-days" style="width:120px">
        <option value="7" ${days === 7 ? 'selected' : ''}>近 7 天</option>
        <option value="30" ${days === 30 ? 'selected' : ''}>近 30 天</option>
        <option value="90" ${days === 90 ? 'selected' : ''}>近 90 天</option></select>`)}
      <p class="hint">成本口径：商品中心中维护采购成本与运费包装成本；平台服务费率可在<a href="#/settings">「系统设置」</a>调整（当前 ${summary.fee_rate_pct}%）；退款/已退款订单计入退款损失与货物成本。</p>
      <div class="cards cards-7">
        ${card('收入', '¥' + summary.revenue.toFixed(2))}
        ${card('货物成本', '¥' + summary.cost.toFixed(2))}
        ${card('运费/包装', '¥' + summary.shipping.toFixed(2))}
        ${card('平台服务费', '¥' + summary.fees.toFixed(2))}
        ${card('退款损失', '¥' + summary.refund_loss.toFixed(2))}
        ${card('净利润', '¥' + summary.net_profit.toFixed(2), summary.net_profit >= 0 ? '' : 'neg')}
        ${card('利润率', summary.margin + '%', summary.margin >= 0 ? '' : 'neg')}
      </div>
      <section class="panel" style="margin-bottom:16px">
        <h3>🧮 利润计算器（发布/调价前速算）</h3>
        <div class="form-row">
          <div><label>售价 ¥</label><input id="cal-price" type="number" step="0.01" value="100"></div>
          <div><label>采购成本 ¥</label><input id="cal-cost" type="number" step="0.01" value="60"></div>
          <div><label>运费/包装 ¥</label><input id="cal-ship" type="number" step="0.01" value="5"></div>
          <div><label>数量</label><input id="cal-qty" type="number" value="1" min="1"></div>
          <div><label>服务费率%（留空用系统设置）</label><input id="cal-fee" type="number" step="0.1" placeholder="${summary.fee_rate_pct}"></div>
          <div><label>目标净利率%</label><input id="cal-target" type="number" step="1" placeholder="20"></div>
        </div>
        <button class="btn btn-primary" id="cal-run">计算</button>
        <div id="cal-result"></div>
      </section>
      <h3 class="sub-h">商品利润明细</h3>
      ${table(['商品', '销量', '收入', '货物成本', '运费/包装', '服务费', '退款损失', '净利润', '利润率'],
        byItem.map((i) => `<tr><td class="clip" title="${esc(i.title)}">${esc(i.title)}</td>
          <td>${i.sold_qty}${i.refund_loss > 0 ? `（退款 ${i.refund_loss > 0 ? 1 : 0}）` : ''}</td>
          <td>¥${i.revenue.toFixed(2)}</td><td>¥${i.cost.toFixed(2)}</td><td>¥${i.shipping.toFixed(2)}</td>
          <td>¥${i.fees.toFixed(2)}</td><td>¥${i.refund_loss.toFixed(2)}</td>
          <td class="${i.net_profit < 0 ? 'neg-text' : ''}">¥${i.net_profit.toFixed(2)}</td>
          <td>${i.margin}%</td></tr>`).join('') || '<tr><td colspan="9" class="empty-cell">近期待利润统计的成交数据（完成一笔发货后此处出数）</td></tr>')}
      <style>.neg-text{color:#d5494f;font-weight:700}</style>`;
    c.querySelector('#pf-days').onchange = (e) => { days = Number(e.target.value); c.dataset.days = days; draw(); };
    c.querySelector('#cal-run').onclick = async () => {
      const box = c.querySelector('#cal-result');
      try {
        const r = await WB.post('/api/v1/tools/profit-calculator', {
          price: c.querySelector('#cal-price').value,
          cost: c.querySelector('#cal-cost').value,
          shipping: c.querySelector('#cal-ship').value,
          quantity: c.querySelector('#cal-qty').value,
          fee_rate_pct: c.querySelector('#cal-fee').value,
          target_margin_pct: c.querySelector('#cal-target').value,
        });
        box.innerHTML = `
          <div class="diag-item sev-${r.unit_net >= 0 ? 'ok' : 'high'}">
            <b>${esc(r.verdict)}</b>：单件净利 ¥${r.unit_net}，${r.inputs.quantity} 件合计 ¥${r.total_net}，利润率 ${r.margin_pct}%（单件服务费 ¥${r.fee_per_unit}）
            ${r.break_even_price !== null ? `<div class="diag-metric">保本价 ¥${r.break_even_price}${r.suggest_price ? ` · 达成目标净利率的建议售价 ¥${r.suggest_price}` : ''}</div>` : ''}
          </div>`;
      } catch (e) { box.innerHTML = `<div class="diag-item sev-high">${esc(e.message)}</div>`; }
    };
  };
  await draw();
};
