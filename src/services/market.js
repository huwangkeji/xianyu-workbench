'use strict';
// M15 关键词与市场监控（模拟行情扫描）
const { query, queryOne, withTransaction } = require('../db');
const { ApiError, CODE, pageOf, paged } = require('../http/respond');
const { sysLog } = require('./logs');
const { notifyEvent } = require('../core/notifier');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

async function listKeywords() {
  const rows = await query(
    `SELECT k.*,
       (SELECT COUNT(*) FROM xy_market_items m WHERE m.keyword = k.keyword AND m.status <> 'gone') AS market_count,
       (SELECT COUNT(*) FROM xy_items i WHERE i.status = 'on_sale' AND i.title LIKE ('%' || k.keyword || '%')) AS my_item_count
     FROM xy_search_keywords k ORDER BY k.search_count DESC`
  );
  return rows;
}

async function addKeyword(body) {
  const keyword = String(body.keyword || '').trim().slice(0, 64);
  if (!keyword) throw new ApiError(CODE.BAD_REQUEST, '关键词不能为空');
  const dup = await queryOne('SELECT id FROM xy_search_keywords WHERE keyword = ?', [keyword]);
  if (dup) throw new ApiError(CODE.CONFLICT, '关键词已存在');
  const r = await query(
    "INSERT INTO xy_search_keywords (keyword, search_count, buyer_count, avg_price, trend, last_searched_at) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))",
    [keyword, Math.max(0, Number(body.search_count) || randInt(50, 500)), 0,
      body.avg_price !== undefined && body.avg_price !== '' ? Number(body.avg_price) || 0 : null,
      ['up', 'flat', 'down'].includes(body.trend) ? body.trend : 'flat']
  );
  await sysLog('info', 'app', `新增监控关键词「${keyword}」`);
  return queryOne('SELECT * FROM xy_search_keywords WHERE id = ?', [r.insertId]);
}

/** 关键词导出（全部字段） */
async function exportKeywords() {
  return query('SELECT keyword, search_count, buyer_count, avg_price, trend FROM xy_search_keywords ORDER BY search_count DESC');
}

/** 关键词导入：{keywords: [{keyword, search_count?, trend?}], replace?}，按关键词去重（存在则累加热度） */
async function importKeywords(body) {
  const arr = Array.isArray(body.keywords) ? body.keywords : null;
  if (!arr) throw new ApiError(CODE.BAD_REQUEST, 'keywords 必须是数组');
  let imported = 0;
  let skipped = 0;
  for (const item of arr.slice(0, 500)) {
    const kw = String(item && item.keyword || '').trim().slice(0, 64);
    if (!kw) { skipped++; continue; }
    const count = Math.max(0, Number(item.search_count) || 0);
    const trend = ['up', 'flat', 'down'].includes(item.trend) ? item.trend : 'flat';
    const existing = await queryOne('SELECT id, search_count FROM xy_search_keywords WHERE keyword = ?', [kw]);
    if (existing) {
      await query('UPDATE xy_search_keywords SET search_count = search_count + ?, trend = ?, last_searched_at = datetime(\'now\',\'localtime\') WHERE id = ?',
        [count, trend, existing.id]);
      skipped++;
    } else {
      await query("INSERT INTO xy_search_keywords (keyword, search_count, trend, last_searched_at) VALUES (?, ?, ?, datetime('now','localtime'))", [kw, count, trend]);
      imported++;
    }
  }
  await sysLog('info', 'app', `关键词导入：新增 ${imported}，合并/跳过 ${skipped}`);
  return { imported, merged_or_skipped: skipped };
}

async function deleteKeyword(id) {
  const kw = await queryOne('SELECT * FROM xy_search_keywords WHERE id = ?', [id]);
  if (!kw) throw new ApiError(CODE.NOT_FOUND, '关键词不存在');
  const mi = await queryOne('SELECT COUNT(*) AS c FROM xy_market_items WHERE keyword = ?', [kw.keyword]);
  await withTransaction(async (conn) => {
    await conn.query('DELETE FROM xy_market_items WHERE keyword = ?', [kw.keyword]);
    await conn.query('DELETE FROM xy_search_keywords WHERE id = ?', [id]);
  });
  return { id: Number(id), market_items_deleted: mi.c };
}

/** 记录一次买家搜索（模拟控制台调用）：已存在则累计，不存在则新增 */
async function recordSearch(keyword, count) {
  const kw = String(keyword || '').trim().slice(0, 64);
  if (!kw) throw new ApiError(CODE.BAD_REQUEST, '关键词不能为空');
  const n = Math.max(1, Number(count) || 1);
  const existing = await queryOne('SELECT * FROM xy_search_keywords WHERE keyword = ?', [kw]);
  if (existing) {
    await query(
      "UPDATE xy_search_keywords SET search_count = search_count + ?, buyer_count = buyer_count + ?, last_searched_at = datetime('now','localtime'), trend = ? WHERE id = ?",
      [n, Math.max(1, Math.round(n / 2)), 'up', existing.id]
    );
    return { keyword: kw, search_count: Number(existing.search_count) + n, created: false };
  }
  await query(
    "INSERT INTO xy_search_keywords (keyword, search_count, buyer_count, avg_price, trend, last_searched_at) VALUES (?, ?, ?, NULL, 'up', datetime('now','localtime'))",
    [kw, n, Math.max(1, Math.round(n / 2))]
  );
  await sysLog('info', 'app', `发现新搜索关键词「${kw}」（热度 ${n}）`);
  return { keyword: kw, search_count: n, created: true };
}

async function listMarketItems(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const kind = q.get('kind');
  const keyword = q.get('keyword');
  if (kind && ['hot', 'competitor', 'demand'].includes(kind)) { where.push('kind = ?'); params.push(kind); }
  if (keyword) { where.push('keyword = ?'); params.push(keyword); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_market_items WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT * FROM xy_market_items WHERE ${whereSql}
     ORDER BY monthly_sales DESC, id ASC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

/** 同款商品价格区间分析（对比我的在架商品） */async function priceRange(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new ApiError(CODE.BAD_REQUEST, '缺少 keyword 参数');
  const rows = await query(
    "SELECT title, shop_name, price, monthly_sales, kind FROM xy_market_items WHERE keyword = ? AND status <> 'gone'",
    [kw]
  );
  if (!rows.length) throw new ApiError(CODE.NOT_FOUND, `关键词「${kw}」暂无市场行情数据，请先执行行情扫描`);
  const prices = rows.map((r) => Number(r.price)).sort((a, b) => a - b);
  const sum = prices.reduce((a, b) => a + b, 0);
  const stats = {
    count: prices.length,
    min: round2(prices[0]),
    max: round2(prices[prices.length - 1]),
    avg: round2(sum / prices.length),
    median: round2(prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2),
  };
  const mine = await query(
    "SELECT id, title, price FROM xy_items WHERE status = 'on_sale' AND title LIKE ?",
    [`%${kw}%`]
  );
  const myItems = mine.map((m) => ({
    ...m,
    price: Number(m.price),
    vs_avg_pct: stats.avg > 0 ? Math.round(((Number(m.price) - stats.avg) / stats.avg) * 100) : 0,
  }));
  return { keyword: kw, stats, market: rows, my_items: myItems };
}

/**
 * 模拟行情扫描：
 * 1) 更新关键词热度；2) 更新/新增热门商品；3) 采集竞品并识别价格变动；4) 发现新需求
 */
async function runMarketScan() {
  const kws = await query('SELECT * FROM xy_search_keywords ORDER BY search_count DESC LIMIT 10');
  let updated = 0;
  let added = 0;
  let priceChanges = 0;
  for (const kw of kws) {
    // 1) 热度波动 + 趋势判定
    const delta = randInt(-8, 60);
    await query(
      "UPDATE xy_search_keywords SET search_count = max(0, search_count + ?), buyer_count = max(0, buyer_count + ?), last_searched_at = datetime('now','localtime') WHERE id = ?",
      [delta, Math.floor(delta / 2), kw.id]
    );

    // 2) 热门商品：更新销量，偶发新增
    const hots = await query("SELECT * FROM xy_market_items WHERE keyword = ? AND kind = 'hot'", [kw.keyword]);
    if (hots.length < 3 && Math.random() < 0.6) {
      const base = Number(kw.avg_price) || 100;
      await query(
        "INSERT INTO xy_market_items (kind, keyword, title, shop_name, price, monthly_sales, status, last_seen_at) VALUES ('hot', ?, ?, ?, ?, ?, 'active', datetime('now','localtime'))",
        [kw.keyword, `${kw.keyword} 热销款 #${randInt(10, 99)}`, `热门店铺${randInt(1, 99)}`,
          round2(base * (0.8 + Math.random() * 0.5)), randInt(80, 2500)]
      );
      added++;
    }
    for (const h of hots) {
      await query(
        "UPDATE xy_market_items SET monthly_sales = max(0, monthly_sales + ?), last_seen_at = datetime('now','localtime') WHERE id = ?",
        [randInt(-20, 80), h.id]
      );
      updated++;
    }

    // 3) 竞品追踪（该关键词命中我的在架商品时）
    const mine = await query("SELECT * FROM xy_items WHERE status = 'on_sale' AND title LIKE ?", [`%${kw.keyword}%`]);
    if (mine.length) {
      const comps = await query("SELECT * FROM xy_market_items WHERE keyword = ? AND kind = 'competitor'", [kw.keyword]);
      if (comps.length < 2) {
        const anchor = Number(mine[0].price) || Number(kw.avg_price) || 100;
        await query(
          "INSERT INTO xy_market_items (kind, keyword, title, shop_name, price, monthly_sales, status, last_seen_at) VALUES ('competitor', ?, ?, ?, ?, ?, 'active', datetime('now','localtime'))",
          [kw.keyword, `${kw.keyword} 同款-竞品店${randInt(1, 20)}`, `竞争店铺${String.fromCharCode(64 + randInt(1, 26))}`,
            round2(anchor * (0.72 + Math.random() * 0.4)), randInt(30, 300)]
        );
        added++;
      }
      for (const c of comps) {
        const newPrice = round2(Number(c.price) * (0.92 + Math.random() * 0.16));
        const status = newPrice > Number(c.price) ? 'price_up' : (newPrice < Number(c.price) ? 'price_down' : 'active');
        await query(
          "UPDATE xy_market_items SET prev_price = price, price = ?, status = ?, last_seen_at = datetime('now','localtime') WHERE id = ?",
          [newPrice, status, c.id]
        );
        if (status === 'price_down' && Number(c.price) > 0 && ((Number(c.price) - newPrice) / Number(c.price)) * 100 >= 5) {
          // 竞品显著降价（≥5%）→ 通知
          await notifyEvent('competitor_alert', `竞品降价：${c.title}`,
            `关键词「${c.keyword}」竞品「${c.shop_name}」价格 ¥${round2(c.price)} → ¥${newPrice}`);
          priceChanges++;
        } else if (status !== 'active') {
          priceChanges++;
        }
        updated++;
      }
    }

    // 4) 新需求发现（上升趋势关键词偶发产生求购/新需求）
    if (kw.trend === 'up' && Math.random() < 0.35) {
      await query(
        "INSERT INTO xy_market_items (kind, keyword, title, shop_name, price, monthly_sales, status, last_seen_at) VALUES ('demand', ?, ?, '市场观察', ?, ?, 'active', datetime('now','localtime'))",
        [kw.keyword, `【新需求】${kw.keyword} 相关求购热度上升`, round2(Number(kw.avg_price) || 100 * 1), randInt(10, 90)]
      );
      added++;
    }
  }
  const result = { keywords: kws.length, updated, added, price_changes: priceChanges };
  await sysLog('info', 'app', `市场行情扫描完成：关键词 ${kws.length}，更新 ${updated}，新增 ${added}，价格变动 ${priceChanges}`);
  return result;
}

/**
 * 竞品筛选（M22 增强）：按关键词/价格变动方向/最低降幅过滤竞品
 */
async function filterCompetitors(q) {
  const pg = pageOf(q);
  const where = ["kind = 'competitor'"];
  const params = [];
  const keyword = q.get('keyword');
  const change = q.get('change'); // down | up | any
  const minDropPct = Number(q.get('min_drop_pct') || 0);
  if (keyword) { where.push('keyword = ?'); params.push(keyword); }
  if (change === 'down') where.push("status = 'price_down'");
  else if (change === 'up') where.push("status = 'price_up'");
  if (change === 'down' && minDropPct > 0) {
    where.push('prev_price IS NOT NULL AND prev_price > 0 AND (prev_price - price) / prev_price * 100 >= ?');
    params.push(minDropPct);
  }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_market_items WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT *, CASE WHEN prev_price > 0 THEN ROUND((prev_price - price) / prev_price * 100, 1) ELSE 0 END AS change_pct
     FROM xy_market_items WHERE ${whereSql}
     ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

/**
 * 竞品预警（M22 增强）：降价/新竞品进入/竞品销量激增 三类信号
 */
async function competitorAlerts() {
  const drops = await query(
    `SELECT *, CASE WHEN prev_price > 0 THEN ROUND((prev_price - price) / prev_price * 100, 1) ELSE 0 END AS drop_pct
     FROM xy_market_items WHERE kind = 'competitor' AND status = 'price_down'
       AND last_seen_at >= datetime('now','localtime','-24 hours') ORDER BY drop_pct DESC LIMIT 20`
  );
  const newComers = await query(
    "SELECT * FROM xy_market_items WHERE kind = 'competitor' AND first_seen_at >= datetime('now','localtime','-3 days') ORDER BY first_seen_at DESC LIMIT 10"
  );
  const salesSurges = await query(
    `SELECT *, ROUND(monthly_sales / max(prev_monthly_sales, 1) - 1, 2) AS surge
     FROM (SELECT *, LAG(monthly_sales) OVER (PARTITION BY title ORDER BY id) AS prev_monthly_sales FROM xy_market_items WHERE kind = 'competitor') t
     WHERE prev_monthly_sales IS NOT NULL AND monthly_sales >= prev_monthly_sales * 1.5
     ORDER BY surge DESC LIMIT 10`
  );
  return {
    drops: drops.map((d) => ({ id: d.id, keyword: d.keyword, title: d.title, shop_name: d.shop_name, price: round2(d.price), prev_price: round2(d.prev_price), drop_pct: Number(d.drop_pct), last_seen_at: d.last_seen_at })),
    new_comers: newComers.map((d) => ({ id: d.id, keyword: d.keyword, title: d.title, shop_name: d.shop_name, price: round2(d.price), first_seen_at: d.first_seen_at })),
    sales_surges: salesSurges.map((d) => ({ id: d.id, keyword: d.keyword, title: d.title, shop_name: d.shop_name, price: round2(d.price), surge_pct: round2(Number(d.surge) * 100) })),
  };
}

module.exports = { listKeywords, addKeyword, deleteKeyword, exportKeywords, importKeywords, recordSearch, listMarketItems, priceRange, runMarketScan, filterCompetitors, competitorAlerts };
