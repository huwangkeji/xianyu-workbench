'use strict';
// 一次性补丁：fetchAccountItems 的 totalCount 为 0/缺失时以解析结果兜底
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'services', 'xianyuApi.js');
let s = fs.readFileSync(file, 'utf8');
const from = "    totalCount: (r.data && r.data.totalCount !== undefined && r.data.totalCount !== null) ? Number(r.data.totalCount) : null,";
const to = [
  '    // 接口的 totalCount 偶发为 0/缺失（分页字段与新结构不同步）——以解析结果兜底',
  '    totalCount: (!r.data || r.data.totalCount === undefined || r.data.totalCount === null || Number(r.data.totalCount) === 0)',
  '      ? items.length',
  '      : Number(r.data.totalCount),',
].join('\n');
if (s.includes(from)) {
  s = s.replace(from, to);
  fs.writeFileSync(file, s);
  console.log('patched');
} else if (s.includes('以解析结果兜底')) {
  console.log('already patched');
} else {
  throw new Error('anchor not found');
}
