'use strict';
// 卡券库存：卡券产品 + 卡密导入/查询
const { query, queryOne } = require('../db');
const { ApiError, CODE, pageOf, paged, str, int } = require('../http/respond');
const { sysLog } = require('./logs');

async function listProducts(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const itemId = q.get('item_id');
  if (itemId) { where.push('p.item_id = ?'); params.push(Number(itemId)); }
  const accountId = q.get('account_id'); // 全局账号切换器：只看该账号商品绑定的卡券产品
  if (accountId) { where.push('i.account_id = ?'); params.push(Number(accountId)); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_card_products p LEFT JOIN xy_items i ON i.id = p.item_id WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT p.*, i.title AS item_title, i.price AS item_price,
       (SELECT COUNT(*) FROM xy_card_codes c WHERE c.product_id = p.id AND c.status = 'available') AS available_count,
       (SELECT COUNT(*) FROM xy_card_codes c WHERE c.product_id = p.id AND c.status = 'sold') AS sold_count,
       (SELECT COUNT(*) FROM xy_card_codes c WHERE c.product_id = p.id) AS total_count
     FROM xy_card_products p LEFT JOIN xy_items i ON i.id = p.item_id
     WHERE ${whereSql} ORDER BY p.id ASC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

async function createProduct(body) {
  const itemId = int(body.item_id, 'item_id', { required: true, min: 1 });
  const item = await queryOne('SELECT * FROM xy_items WHERE id = ?', [itemId]);
  if (!item) throw new ApiError(CODE.NOT_FOUND, '关联商品不存在');
  if (!item.is_virtual) throw new ApiError(CODE.BIZ_FAIL, '仅虚拟商品可配置卡券产品');
  const r = await query('INSERT INTO xy_card_products (item_id, name) VALUES (?, ?)', [itemId, str(body.name, 'name', { required: true, max: 128 })]);
  await sysLog('info', 'app', `新增卡券产品「${body.name}」（商品 #${itemId}）`);
  return queryOne('SELECT * FROM xy_card_products WHERE id = ?', [r.insertId]);
}

async function deleteProduct(id) {
  const p = await queryOne('SELECT * FROM xy_card_products WHERE id = ?', [id]);
  if (!p) throw new ApiError(CODE.NOT_FOUND, '卡券产品不存在');
  const sold = await queryOne("SELECT COUNT(*) AS c FROM xy_card_codes WHERE product_id = ? AND status = 'sold'", [id]);
  if (sold.c > 0) throw new ApiError(CODE.CONFLICT, '该产品已有售出卡密，不能删除');
  const avail = await queryOne("SELECT COUNT(*) AS c FROM xy_card_codes WHERE product_id = ? AND status = 'available'", [id]);
  await query('DELETE FROM xy_card_codes WHERE product_id = ?', [id]);
  await query('DELETE FROM xy_card_products WHERE id = ?', [id]);
  return { id: Number(id), codes_deleted: avail.c };
}

/** 批量导入卡密：contents 为文本，每行一条 */
async function importCodes(body, user) {
  const productId = int(body.product_id, 'product_id', { required: true, min: 1 });
  const product = await queryOne('SELECT * FROM xy_card_products WHERE id = ?', [productId]);
  if (!product) throw new ApiError(CODE.NOT_FOUND, '卡券产品不存在');
  const raw = String(body.contents || '');
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 2000);
  if (!lines.length) throw new ApiError(CODE.BAD_REQUEST, '卡密内容不能为空（每行一条）');
  for (const line of lines) {
    await query("INSERT INTO xy_card_codes (product_id, content, status) VALUES (?, ?, 'available')", [productId, line.slice(0, 2000)]);
  }
  await sysLog('info', 'app', `导入卡密 ${lines.length} 张到产品「${product.name}」（操作员 ${user.username}）`);
  return { product_id: productId, imported: lines.length };
}

async function listCodes(q) {
  const pg = pageOf(q);
  const where = ['1=1'];
  const params = [];
  const productId = q.get('product_id');
  const status = q.get('status');
  const keyword = q.get('keyword');
  if (productId) { where.push('c.product_id = ?'); params.push(Number(productId)); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (keyword) { where.push('(c.content LIKE ? OR c.order_no LIKE ? OR c.buyer_nick LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  const whereSql = where.join(' AND ');
  const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM xy_card_codes c WHERE ${whereSql}`, params);
  const list = await query(
    `SELECT c.*, p.name AS product_name FROM xy_card_codes c
     LEFT JOIN xy_card_products p ON p.id = c.product_id
     WHERE ${whereSql} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
    [...params, pg.pageSize, pg.offset]
  );
  return paged(list, totalRow.c, pg);
}

/** 卡密导出（CSV，同筛选条件，≤5000 行） */
async function exportCodes(q) {
  const where = ['1=1'];
  const params = [];
  const productId = q.get('product_id');
  const status = q.get('status');
  const keyword = q.get('keyword');
  if (productId) { where.push('c.product_id = ?'); params.push(Number(productId)); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (keyword) { where.push('(c.content LIKE ? OR c.order_no LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  return query(
    `SELECT c.id, c.content, c.status, c.order_no, c.buyer_nick, c.sold_at, p.name AS product_name
     FROM xy_card_codes c LEFT JOIN xy_card_products p ON p.id = c.product_id
     WHERE ${where.join(' AND ')} ORDER BY c.id ASC LIMIT 5000`,
    params
  );
}

async function disableCode(id) {
  const code = await queryOne('SELECT * FROM xy_card_codes WHERE id = ?', [id]);
  if (!code) throw new ApiError(CODE.NOT_FOUND, '卡密不存在');
  if (code.status === 'sold') throw new ApiError(CODE.CONFLICT, '已售出卡密不能禁用');
  await query("UPDATE xy_card_codes SET status = 'disabled' WHERE id = ?", [id]);
  return { id: Number(id), status: 'disabled' };
}

module.exports = { listProducts, createProduct, deleteProduct, importCodes, listCodes, exportCodes, disableCode };
