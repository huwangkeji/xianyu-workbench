'use strict';
// 模拟操作路由：仅演示模式可用（生产模式全部拒绝，杜绝模拟数据混入真实业务）
// 说明：真实环境这些事件来自闲鱼（WebSocket/订单推送），由连接器实现边界隔离
const { ApiError, CODE, str, int, enumOf } = require('../http/respond');
const { getConnector } = require('../core/connector');
const { getAccount } = require('../services/accounts');
const { getItem } = require('../services/items');
const analytics = require('../services/analytics');
const market = require('../services/market');
const { getMode } = require('../services/mode');

/** 演示模式门控：非 demo 模式一律拒绝 */
function assertDemoMode() {
  if (getMode() !== 'demo') {
    throw new ApiError(CODE.BIZ_FAIL, '模拟操作仅限演示模式使用（当前为生产模式）；请到「演示模式」页切换');
  }
}

module.exports = function registerSimulateRoutes(router) {
  // 模拟买家发消息（自动回复链路入口）
  router.post('/api/v1/simulate/buyer-message', async (ctx) => {
    assertDemoMode();
    const accountId = int(ctx.body.account_id, 'account_id', { required: true, min: 1 });
    const account = await getAccount(accountId);
    const connector = await getConnector();
    const payload = {
      buyer_id: str(ctx.body.buyer_id, 'buyer_id', { max: 80 }),
      buyer_nick: str(ctx.body.buyer_nick, 'buyer_nick', { required: true, max: 128 }),
      item_id: ctx.body.item_id ? int(ctx.body.item_id, 'item_id', { min: 1 }) : null,
      text: str(ctx.body.text, 'text', { required: true, max: 2000 }),
      msg_type: enumOf(ctx.body.msg_type, 'msg_type', ['text', 'image'], { default: 'text' }),
      image_url: str(ctx.body.image_url, 'image_url', { max: 500 }),
    };
    return connector.submitBuyerMessage(account, payload);
  });

  // 模拟买家下单支付（自动发货链路入口）
  router.post('/api/v1/simulate/order', async (ctx) => {
    assertDemoMode();
    const accountId = int(ctx.body.account_id, 'account_id', { required: true, min: 1 });
    const itemId = int(ctx.body.item_id, 'item_id', { required: true, min: 1 });
    const account = await getAccount(accountId);
    const item = await getItem(itemId);
    if (item.account_id !== account.id) {
      throw new ApiError(CODE.BIZ_FAIL, '商品不属于该账号');
    }
    const connector = await getConnector();
    return connector.submitOrder(account, item, {
      quantity: ctx.body.quantity,
      buyer_nick: str(ctx.body.buyer_nick, 'buyer_nick', { max: 128 }),
      buyer_id: str(ctx.body.buyer_id, 'buyer_id', { max: 80 }),
      spec_value: str(ctx.body.spec_value, 'spec_value', { max: 128 }),
      is_bargain: ctx.body.is_bargain,
    });
  });

  // 模拟 Cookie 过期告警（风控链路演示）
  router.post('/api/v1/simulate/cookie-expire', async (ctx) => {
    assertDemoMode();
    const accountId = int(ctx.body.account_id, 'account_id', { required: true, min: 1 });
    const account = await getAccount(accountId);
    const connector = await getConnector();
    const state = await connector.checkCookie(account);
    return { account_id: account.id, nickname: account.nickname, check: state };
  });

  // 录入商品流量数据（曝光/浏览/收藏/咨询/成交），按天累计
  router.post('/api/v1/simulate/item-stats', async (ctx) => {
    assertDemoMode();
    return analytics.upsertItemStats({
      item_id: int(ctx.body.item_id, 'item_id', { required: true, min: 1 }),
      date: str(ctx.body.date, 'date', { max: 10 }) || undefined,
      exposure: ctx.body.exposure, views: ctx.body.views,
      favorites: ctx.body.favorites, inquiries: ctx.body.inquiries,
      orders: ctx.body.orders, amount: ctx.body.amount,
    });
  });

  // 记录买家搜索关键词（市场监控数据源）
  router.post('/api/v1/simulate/search-keyword', async (ctx) => {
    assertDemoMode();
    return market.recordSearch(str(ctx.body.keyword, 'keyword', { required: true, max: 64 }), ctx.body.count);
  });
};
