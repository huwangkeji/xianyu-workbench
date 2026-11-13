'use strict';
// 一次性探测：/r/Conversation/listNewestPagination 的正确帧参数
const xianyuLive = require('../src/core/xianyuLive');

const VARIANTS = [
  { tag: '[0,30]', body: [0, 30] },
  { tag: '[Date.now(),30]', body: [Date.now(), 30] },
  { tag: '["0","30"]', body: ['0', '30'] },
  { tag: '[{},30]', body: [{}, 30] },
  { tag: '[{startTimeStamp:0,limitNum:30}]', body: [{ startTimeStamp: 0, limitNum: 30 }] },
  { tag: '[0]', body: [0] },
  { tag: '[]', body: [] },
];

async function main() {
  for (const v of VARIANTS) {
    try {
      const resp = await xianyuLive.wsCall(1, '/r/Conversation/listNewestPagination', v.body, 5000);
      const body = Array.isArray(resp.body) ? resp.body[0] : resp.body;
      const keys = body && typeof body === 'object' ? Object.keys(body).join(',') : typeof body;
      console.log(`${v.tag}: OK code=${resp.code} body.keys=${keys}`);
      const s = JSON.stringify(body || {});
      console.log('  ', s.slice(0, 400));
      break; // 成功即停
    } catch (e) {
      console.log(`${v.tag}: FAIL ${e.message.slice(0, 80)}`);
    }
  }
  process.exit(0);
}
main();
