'use strict';
// 语法检查：对 src / scripts / public 下的全部 .js 文件执行 node --check
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'scripts', 'public'];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [];
for (const d of DIRS) walk(path.join(ROOT, d), files);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`OK   ${path.relative(ROOT, f)}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${path.relative(ROOT, f)}`);
    console.error(String(e.stderr || e.message));
  }
}
console.log(`\n共检查 ${files.length} 个文件，失败 ${failed} 个`);
process.exit(failed ? 1 : 0);
