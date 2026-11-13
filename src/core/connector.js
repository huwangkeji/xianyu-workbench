'use strict';
// 连接器层：工作台与闲鱼平台之间的抽象边界。
// - SimulatedConnector：内置模拟实现，通过「模拟控制台」API 注入买家消息/订单等事件，
//   使自动回复、自动发货等全流程可以在本地真实跑通。
// - LiveConnector：真实对接预留扩展点。与闲鱼服务器的 WebSocket 连接、消息签名、
//   Cookie 鉴权等属于平台私有协议，本项目不实现（见 docs/01 不确定项与合规说明）。
const { query, queryOne } = require('../db');
const { ApiError, CODE } = require('../http/respond');
const replyEngine = require('./replyEngine');
const ordersService = require('../services/orders');
const riskControl = require('./riskControl');
const { sysLog, riskLog } = require('../services/logs');
const { getSettings } = require('../services/settings');

class SimulatedConnector {
  constructor() { this.mode = 'simulated'; }

  /** 买家消息进入 */
  async submitBuyerMessage(account, payload) {
    return replyEngine.handleBuyerMessage(account, payload);
  }

  /** 买家下单支付 */
  async submitOrder(account, item, payload) {
    return ordersService.createPaidOrder(account, item, payload);
  }

  /** 刷新 Cookie（模拟：顺延 7 天） */
  async refreshCookie(account) {
    await query("UPDATE xy_accounts SET cookie_expires_at = datetime('now','localtime','+7 days'), updated_at = datetime('now','localtime') WHERE id = ?", [account.id]);
    await sysLog('info', 'connector', `账号 ${account.nickname} Cookie 已刷新（模拟，顺延 7 天）`);
    return { account_id: account.id, cookie_expires_at_shift: '+7d' };
  }

  /** 发布商品（模拟：直接入库并记录发布日志） */
  async publishItem(account, fields, templateId) {
    const itemId = 'ITEM-SIM-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
    const r = await query(
      `INSERT INTO xy_items (account_id, item_id, title, description, price, original_price, quantity, is_virtual, status, polish_enabled, template_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'on_sale', 1, ?)`,
      [account.id, itemId, fields.title, fields.description || '', fields.price, fields.original_price || 0,
        fields.quantity || 1, fields.is_virtual ? 1 : 0, templateId || null]
    );
    await query(
      "INSERT INTO xy_publish_logs (account_id, item_id, template_id, title, status, message) VALUES (?, ?, ?, ?, 'success', '模拟发布成功')",
      [account.id, r.insertId, templateId || null, fields.title]
    );
    return queryOne('SELECT * FROM xy_items WHERE id = ?', [r.insertId]);
  }

  /** 擦亮商品（带最小间隔风控） */
  async polishItem(account, item) {
    const settings = await getSettings();
    const minMinutes = Math.max(1, Number(settings.polish_min_interval_minutes) || 30);
    if (riskControl.isPolishTooSoon(item.last_polish_at, minMinutes)) {
      await riskLog(account.id, 'polish_limited', 'warning',
        `商品「${item.title}」距上次擦亮不足 ${minMinutes} 分钟，已拦截本次擦亮`);
      throw new ApiError(CODE.BIZ_FAIL, `擦亮过于频繁：距上次擦亮不足 ${minMinutes} 分钟（风控拦截，已记录风控日志）`);
    }
    await query("UPDATE xy_items SET last_polish_at = datetime('now','localtime'), polish_count = polish_count + 1 WHERE id = ?", [item.id]);
    return { item_id: item.id, polished_at: new Date().toISOString() };
  }

  /** 拉取新订单（模拟：恒为 0，用于演示 order_sync 任务链路） */
  async fetchNewOrders(account) {
    return { account_id: account.id, account_name: account.nickname, new_orders: 0 };
  }

  /** Cookie 有效性检查（模拟：按过期时间判定） */
  async checkCookie(account) {
    if (!account.cookie_expires_at) return { account_id: account.id, state: 'unknown' };
    const expires = new Date(account.cookie_expires_at).getTime();
    const hours = (expires - Date.now()) / 3600000;
    if (hours <= 0) {
      await riskLog(account.id, 'cookie_expired', 'danger', `账号 ${account.nickname} Cookie 已过期`);
      await query("UPDATE xy_accounts SET status = 'error', updated_at = datetime('now','localtime') WHERE id = ?", [account.id]);
      return { account_id: account.id, state: 'expired', hours: Math.floor(hours) };
    }
    if (hours < 48) {
      await riskLog(account.id, 'cookie_expiring', 'warning',
        `账号 ${account.nickname} Cookie 将在 ${Math.floor(hours)} 小时后过期，请及时刷新`);
      return { account_id: account.id, state: 'expiring', hours: Math.floor(hours) };
    }
    return { account_id: account.id, state: 'ok', hours: Math.floor(hours) };
  }
}

class LiveConnector {
  constructor() { this.mode = 'live'; }

  _unsupported() {
    throw new ApiError(CODE.NOT_IMPLEMENTED,
      'live 连接器未实现：与闲鱼真实对接（WebSocket/签名/Cookie 鉴权）属平台私有协议，'
      + '请按 docs/03-接口约定.md 的 Connector 扩展点自行实现并自担合规风险');
  }
  async submitBuyerMessage() { this._unsupported(); }
  async submitOrder() { this._unsupported(); }
  async refreshCookie() { this._unsupported(); }
  async publishItem() { this._unsupported(); }
  async polishItem() { this._unsupported(); }
  async fetchNewOrders() { this._unsupported(); }
  async checkCookie() { this._unsupported(); }
}

/** 按系统设置 connector_mode 返回连接器实例 */
async function getConnector() {
  const settings = await getSettings();
  return settings.connector_mode === 'live' ? new LiveConnector() : new SimulatedConnector();
}

module.exports = { getConnector, SimulatedConnector, LiveConnector };
