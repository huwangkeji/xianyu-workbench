'use strict';
// 商品管理：商品 CRUD + 模板 + 批量发布 + 擦亮 + 发布日志
const { query, queryOne, withTransaction } = require('../db');
const { ApiError, CODE, pageOf, paged, str, int, bool, enumOf } = require('../http/respond');
const { sysLog } = require('./logs');
const { getConnector } = require('../core/connector');
const { getAccount, toPublicAccount } = require('./accounts');
const xianyuApi = require('./xianyuApi');

async function getItem(id) {
  const row = await queryOne(
    'SELECT i.*, a.nickname AS account_nickname FROM xy_items i LEFT JOIN xy_accounts a ON a.id = i.account_id WHERE i.id = ?',
    [id]
  );
  if (!row) throw new ApiError(CODE.NOT_FOUND, '商品不存在');
  return row;
}

async function listItems(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const accountId = q.get('account_id');
  const status = q.get('status');
  if (accountId) { where.push('i.account_id = ?'); params.push(Number(accountId)); }
  if (status) { where.push("i.status = ?"); params.push(status); }
  if (q.get('is_virtual') !== null && q.get('is_virtual') !== '') {
    where.push('i.is_virtual = ?'); params.push(q.get('is_virtual') === '1' || q.get('is_virtual') === 'true' ? 1 : 0);
  }
  const kw = q.get('keyword');
  if (kw) { where.push('i.title LIKE ?'); params.push(`%${kw}%`); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_items i WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT i.*, a.nickname AS account_nickname,
       (SELECT cp.id FROM xy_card_products cp WHERE cp.item_id = i.id LIMIT 1) AS card_product_id,
       (SELECT COUNT(*) FROM xy_card_codes cc WHERE cc.status = 'available' AND cc.product_id =
         (SELECT cp2.id FROM xy_card_products cp2 WHERE cp2.item_id = i.id LIMIT 1)) AS card_available,
       (SELECT COUNT(*) FROM xy_card_codes cc2 WHERE cc2.status = 'sold' AND cc2.product_id =
         (SELECT cp3.id FROM xy_card_products cp3 WHERE cp3.item_id = i.id LIMIT 1)) AS card_sold
     FROM xy_items i LEFT JOIN xy_accounts a ON a.id = i.account_id
     WHERE ${whereSql} ORDER BY i.id DESC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

/** 价格参数校验（非负数） */
function priceOf(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(CODE.BAD_REQUEST, `${name} 必须是不小于 0 的数字`);
  return Math.round(n * 100) / 100;
}

async function createItem(body, user) {
  const account = await getAccount(Number(body.account_id));
  const r = await query(
    `INSERT INTO xy_items (account_id, item_id, title, description, price, original_price, quantity, main_image, cost_price, shipping_cost, goods_condition, defect_note, is_virtual, status, polish_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      account.id,
      str(body.item_id, 'item_id', { required: true, max: 80 }),
      str(body.title, 'title', { required: true, max: 255 }),
      str(body.description, 'description', { max: 2000 }),
      priceOf(body.price, '售价'),
      priceOf(body.original_price, '原价'),
      int(body.quantity, 'quantity', { default: 1, min: 1, max: 999999 }),
      str(body.main_image, 'main_image', { max: 500 }),
      priceOf(body.cost_price, '采购成本'),
      priceOf(body.shipping_cost, '运费包装'),
      enumOf(body.goods_condition, 'goods_condition', ['全新', '九五新', '九成新', '八成新', '有瑕疵'], { default: '九成新' }),
      str(body.defect_note, 'defect_note', { max: 500 }),
      bool(body.is_virtual, 'is_virtual', false) ? 1 : 0,
      enumOf(body.status, 'status', ['on_sale', 'off_sale'], { default: 'on_sale' }),
      bool(body.polish_enabled, 'polish_enabled', true) ? 1 : 0,
    ]
  );
  await sysLog('info', 'app', `新增商品 ${body.item_id}（操作员 ${user.username}）`);
  return getItem(r.insertId);
}

async function updateItem(id, body, user) {
  const item = await getItem(id);
  const fields = {
    title: body.title !== undefined ? str(body.title, 'title', { required: true, max: 255 }) : item.title,
    description: body.description !== undefined ? str(body.description, 'description', { max: 2000 }) : item.description,
    price: body.price !== undefined ? priceOf(body.price, '售价') : item.price,
    original_price: body.original_price !== undefined ? priceOf(body.original_price, '原价') : item.original_price,
    quantity: body.quantity !== undefined ? int(body.quantity, 'quantity', { min: 1, max: 999999 }) : item.quantity,
    main_image: body.main_image !== undefined ? str(body.main_image, 'main_image', { max: 500 }) : item.main_image,
    cost_price: body.cost_price !== undefined ? priceOf(body.cost_price, '采购成本') : item.cost_price,
    shipping_cost: body.shipping_cost !== undefined ? priceOf(body.shipping_cost, '运费包装') : item.shipping_cost,
    goods_condition: body.goods_condition !== undefined ? enumOf(body.goods_condition, 'goods_condition', ['全新', '九五新', '九成新', '八成新', '有瑕疵']) : item.goods_condition,
    defect_note: body.defect_note !== undefined ? str(body.defect_note, 'defect_note', { max: 500 }) : item.defect_note,
    is_virtual: body.is_virtual !== undefined ? (bool(body.is_virtual, 'is_virtual') ? 1 : 0) : item.is_virtual,
    status: body.status !== undefined ? enumOf(body.status, 'status', ['on_sale', 'off_sale']) : item.status,
    polish_enabled: body.polish_enabled !== undefined ? (bool(body.polish_enabled, 'polish_enabled') ? 1 : 0) : item.polish_enabled,
  };
  await query(
    'UPDATE xy_items SET title = ?, description = ?, price = ?, original_price = ?, quantity = ?, '
    + 'main_image = ?, cost_price = ?, shipping_cost = ?, goods_condition = ?, defect_note = ?, '
    + "is_virtual = ?, status = ?, polish_enabled = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [fields.title, fields.description, fields.price, fields.original_price, fields.quantity,
      fields.main_image, fields.cost_price, fields.shipping_cost, fields.goods_condition, fields.defect_note,
      fields.is_virtual, fields.status, fields.polish_enabled, id]
  );
  await sysLog('info', 'app', `更新商品 #${id}（操作员 ${user.username}）`);
  return getItem(id);
}

/** 删除预检：返回关联数据计数 */
async function deleteItemPrecheck(id) {
  const item = await getItem(id);
  const c = async (sql) => Number((await queryOne(sql, [id])).c);
  return {
    item: { id: item.id, title: item.title },
    orders_history: await c('SELECT COUNT(*) AS c FROM xy_orders WHERE item_id = ?'),
    card_products: await c('SELECT COUNT(*) AS c FROM xy_card_products WHERE item_id = ?'),
    card_codes_available: await c("SELECT COUNT(*) AS c FROM xy_card_codes WHERE status = 'available' AND product_id IN (SELECT id FROM xy_card_products WHERE item_id = ?)"),
    rules: await c('SELECT COUNT(*) AS c FROM xy_reply_rules WHERE item_id = ?'),
  };
}

/**
 * 删除商品：
 * - 进行中订单 → 拒绝（原有保护）
 * - 有关联卡券/规则且未 cascade → 返回 40003 + 计数
 * - cascade=true → 级联删除卡券产品与可用卡密、规则解绑（item_id→NULL）；历史订单/统计保留
 */
async function deleteItem(id, user, options) {
  const pre = await deleteItemPrecheck(id);
  const used = await queryOne("SELECT COUNT(*) AS c FROM xy_orders WHERE item_id = ? AND status IN ('paid','refunding')", [id]);
  if (used.c > 0) throw new ApiError(CODE.CONFLICT, `该商品存在 ${used.c} 个进行中订单（待发货/售后中），不能删除`);
  const hasRelated = pre.card_products + pre.rules > 0;
  const cascade = !!(options && options.cascade);
  if (hasRelated && !cascade) {
    throw new ApiError(CODE.CONFLICT, '该商品存在关联卡券/回复规则，请确认后选择级联删除', pre);
  }
  if (cascade) {
    await withTransaction(async (conn) => {
      await conn.query('DELETE FROM xy_card_codes WHERE product_id IN (SELECT id FROM xy_card_products WHERE item_id = ?)', [id]);
      await conn.query('DELETE FROM xy_card_products WHERE item_id = ?', [id]);
      await conn.query('UPDATE xy_reply_rules SET item_id = NULL WHERE item_id = ?', [id]);
      await conn.query('DELETE FROM xy_items WHERE id = ?', [id]);
    });
  } else {
    await query('DELETE FROM xy_items WHERE id = ?', [id]);
  }
  await sysLog('info', 'app', `删除商品 #${id}「${pre.item.title}」（${cascade ? '含级联卡券/规则解绑' : '无关联数据'}，操作员 ${user.username}）`);
  return { id: Number(id), cascade, counts: pre };
}

/** 手动擦亮（走连接器，带风控间隔） */
async function polishItem(id, user) {
  const item = await getItem(id);
  const account = await getAccount(item.account_id);
  const connector = await getConnector();
  const r = await connector.polishItem(account, item);
  await sysLog('info', 'app', `手动擦亮商品 #${id}（操作员 ${user.username}）`);
  return r;
}

// ---------------- 模板 ----------------

async function listTemplates() {
  return query('SELECT * FROM xy_item_templates ORDER BY id DESC');
}

async function createTemplate(body) {
  const r = await query(
    'INSERT INTO xy_item_templates (name, title_pattern, description, price, original_price, is_virtual, quantity, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      str(body.name, 'name', { required: true, max: 128 }),
      str(body.title_pattern, 'title_pattern', { required: true, max: 255 }),
      str(body.description, 'description', { max: 2000 }),
      priceOf(body.price, '售价'),
      priceOf(body.original_price, '原价'),
      bool(body.is_virtual, 'is_virtual', false) ? 1 : 0,
      int(body.quantity, 'quantity', { default: 1, min: 1, max: 999999 }),
      str(body.address, 'address', { max: 255 }),
    ]
  );
  return queryOne('SELECT * FROM xy_item_templates WHERE id = ?', [r.insertId]);
}

async function updateTemplate(id, body) {
  const t = await queryOne('SELECT * FROM xy_item_templates WHERE id = ?', [id]);
  if (!t) throw new ApiError(CODE.NOT_FOUND, '模板不存在');
  const fields = {
    name: body.name !== undefined ? str(body.name, 'name', { required: true, max: 128 }) : t.name,
    title_pattern: body.title_pattern !== undefined ? str(body.title_pattern, 'title_pattern', { required: true, max: 255 }) : t.title_pattern,
    description: body.description !== undefined ? str(body.description, 'description', { max: 2000 }) : t.description,
    price: body.price !== undefined ? priceOf(body.price, '售价') : t.price,
    original_price: body.original_price !== undefined ? priceOf(body.original_price, '原价') : t.original_price,
    is_virtual: body.is_virtual !== undefined ? (bool(body.is_virtual, 'is_virtual') ? 1 : 0) : t.is_virtual,
    quantity: body.quantity !== undefined ? int(body.quantity, 'quantity', { min: 1, max: 999999 }) : t.quantity,
    address: body.address !== undefined ? str(body.address, 'address', { max: 255 }) : t.address,
  };
  await query(
    'UPDATE xy_item_templates SET name = ?, title_pattern = ?, description = ?, price = ?, original_price = ?, is_virtual = ?, quantity = ?, address = ? WHERE id = ?',
    [fields.name, fields.title_pattern, fields.description, fields.price, fields.original_price, fields.is_virtual, fields.quantity, fields.address, id]
  );
  return queryOne('SELECT * FROM xy_item_templates WHERE id = ?', [id]);
}

async function deleteTemplate(id) {
  const t = await queryOne('SELECT * FROM xy_item_templates WHERE id = ?', [id]);
  if (!t) throw new ApiError(CODE.NOT_FOUND, '模板不存在');
  await query('DELETE FROM xy_item_templates WHERE id = ?', [id]);
  return { id: Number(id) };
}

/**
 * 批量发布：按模板生成 count 件商品（标题 {n} 为序号占位），逐件记录发布日志
 */
async function batchPublish(body, user) {
  const account = await getAccount(Number(body.account_id));
  const templateId = Number(body.template_id);
  const t = await queryOne('SELECT * FROM xy_item_templates WHERE id = ?', [templateId]);
  if (!t) throw new ApiError(CODE.NOT_FOUND, '模板不存在');
  const count = int(body.count, 'count', { required: true, min: 1, max: 20 });
  const connector = await getConnector();
  const created = [];
  for (let n = 1; n <= count; n++) {
    const title = String(t.title_pattern).replace(/\{n\}/g, String(n)).slice(0, 255);
    const item = await connector.publishItem(account, {
      title,
      description: t.description,
      price: t.price,
      original_price: t.original_price,
      quantity: t.quantity,
      is_virtual: t.is_virtual,
    }, t.id);
    created.push({ id: item.id, item_id: item.item_id, title: item.title });
  }
  await sysLog('info', 'publish', `批量发布 ${count} 件商品（模板「${t.name}」，操作员 ${user.username}）`);
  return { account_id: account.id, template_id: t.id, count, created };
}

async function listPublishLogs(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const accountId = q.get('account_id');
  if (accountId) { where.push('p.account_id = ?'); params.push(Number(accountId)); }
  const status = q.get('status');
  if (status) { where.push('p.status = ?'); params.push(status); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_publish_logs p WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT p.*, a.nickname AS account_nickname FROM xy_publish_logs p
     LEFT JOIN xy_accounts a ON a.id = p.account_id
     WHERE ${whereSql} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

/**
 * 同步账号平台商品：从闲鱼拉取真实在架商品并入库（按平台商品ID去重，新增/更新）。
 * 仅支持有真实 Cookie 的账号（扫码登录或手填真实凭证）。
 */
async function syncAccountItems(accountId, user) {
  const account = await getAccount(accountId);
  const hasRealCookie = !!account.cookie && !/(demo=1|demo-cookie-)/.test(String(account.cookie));
  if (!hasRealCookie) {
    throw new ApiError(CODE.BIZ_FAIL, '该账号无真实 Cookie 凭证，无法同步平台商品（请使用扫码登录添加账号）');
  }
  const all = [];
  let apiTotalCount = null;
  for (let page = 1; page <= 10; page++) {
    const r = await xianyuApi.fetchAccountItems(account, page, 20);
    if (!r.ok) throw new ApiError(CODE.BIZ_FAIL, `同步失败：${r.reason}`);
    all.push(...r.items);
    if (r.totalCount !== null) apiTotalCount = r.totalCount;
    if (!r.hasMore) break;
  }
  let added = 0;
  let updated = 0;
  let descSynced = 0;
  for (const it of all) {
    const exists = await queryOne('SELECT id FROM xy_items WHERE account_id = ? AND item_id = ?', [account.id, it.item_id]);
    if (exists) {
      await query(
        'UPDATE xy_items SET title = ?, price = ?, main_image = ?, status = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?',
        [it.title, it.price, it.main_image, it.status, exists.id]
      );
      updated++;
    } else {
      const ins = await query(
        `INSERT INTO xy_items (account_id, item_id, title, description, price, original_price, quantity, main_image, goods_condition, is_virtual, status, polish_enabled)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, '九成新', 0, ?, 1)`,
        [account.id, it.item_id, it.title, '', it.price, it.price, it.main_image, it.status]
      );
      added++;
      // 新商品同步描述文案（详情接口，尽力而为；失败不影响商品入库）
      try {
        const d = await xianyuApi.fetchItemDetail(account, it.item_id);
        if (d.ok && (d.desc || d.main_image)) {
          await query(
            "UPDATE xy_items SET description = COALESCE(NULLIF(?,''), description), main_image = COALESCE(NULLIF(?,''), main_image), updated_at = datetime('now','localtime') WHERE id = ?",
            [d.desc, d.main_image, ins.insertId]
          );
          if (d.desc) descSynced++;
        }
      } catch (_) { /* 描述同步失败不阻塞 */ }
    }
  }
  await sysLog('info', 'connector', `同步平台商品：账号 ${account.account_id} 平台在售 ${apiTotalCount ?? all.length} 件，入库 ${all.length} 件（新增 ${added}，更新 ${updated}，文案同步 ${descSynced}，操作员 ${user.username}）`);
  return {
    total: all.length,
    api_total_count: apiTotalCount,
    added,
    updated,
    desc_synced: descSynced,
    account: toPublicAccount(await getAccount(accountId)),
  };
}

/**
 * 同步商品编辑到闲鱼平台（真实接口 editDetail → edit）：
 * 工作台里保存的标题/描述/价格/首图覆盖平台在售商品。
 * 仅支持有真实 Cookie 的账号；返回平台处理结果。
 */
async function syncItemToPlatform(id, body, user) {
  const item = await getItem(id);
  const account = await getAccount(item.account_id);
  const hasRealCookie = !!account.cookie && !/(demo=1|demo-cookie-)/.test(String(account.cookie));
  if (!hasRealCookie) {
    throw new ApiError(CODE.BIZ_FAIL, '该账号无真实 Cookie 凭证，无法同步到闲鱼（请使用扫码登录添加账号）');
  }
  if (!/^\d{6,}$/.test(String(item.item_id))) {
    throw new ApiError(CODE.BIZ_FAIL, `商品平台 ID 无效（${item.item_id}），无法同步到闲鱼`);
  }
  const patch = {
    item_id: item.item_id,
    title: body.title !== undefined ? body.title : item.title,
    description: body.description !== undefined ? body.description : (item.description || item.title),
    price: body.price !== undefined ? body.price : item.price,
    original_price: body.original_price !== undefined ? body.original_price : item.original_price,
    main_image: body.main_image !== undefined ? body.main_image : item.main_image,
  };
  const r = await xianyuApi.syncItemEdit(account, patch);
  if (!r.ok) {
    await sysLog('warn', 'connector', `商品 #${id} 同步到闲鱼失败: ${r.reason}（操作员 ${user.username}）`);
    throw new ApiError(CODE.BIZ_FAIL, r.reason);
  }
  await sysLog('info', 'connector', `商品 #${id}（${item.title}）已同步到闲鱼平台（操作员 ${user.username}）`);
  return { item_id: item.item_id, ret: r.ret, synced: { title: patch.title, description: patch.description, price: patch.price, main_image: patch.main_image } };
}

module.exports = {
  getItem, listItems, createItem, updateItem, deleteItem, deleteItemPrecheck, polishItem,
  listTemplates, createTemplate, updateTemplate, deleteTemplate, batchPublish, listPublishLogs,
  syncAccountItems, syncItemToPlatform,
};
