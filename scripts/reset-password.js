'use strict';
// 重置工作台登录密码：node scripts/reset-password.js [用户名] [新密码]
// 不带参数时进入交互式输入；密码使用与 src/auth.js 相同的 scrypt 格式（scrypt$salt$hash）
// 例：node scripts/reset-password.js admin new123456
const readline = require('readline');
const crypto = require('crypto');
const { query, queryOne, closePool } = require('../src/db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

async function main() {
  let username = (process.argv[2] || '').trim();
  let password = process.argv[3] || '';

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  try {
    if (!username) {
      username = (await ask('要重置的用户名（回车默认 admin）: ')).trim() || 'admin';
    }
    while (!password) {
      password = await ask('新密码（至少 6 位）: ');
      if (!password) {
        console.log('  密码不能为空，请重新输入');
        continue;
      }
      const again = await ask('再次输入新密码确认: ');
      if (again !== password) {
        console.log('  两次输入不一致，请重新设置');
        password = '';
      }
    }
  } finally {
    rl.close();
  }

  if (String(password).length < 6) {
    console.error('  [FAIL] 密码至少 6 位');
    await closePool();
    process.exit(1);
  }

  const exists = await queryOne('SELECT id FROM xy_users WHERE username = ?', [username]);
  if (!exists) {
    console.error(`  [FAIL] 用户不存在: ${username}（可先运行 node scripts/doctor.js 查看用户列表）`);
    await closePool();
    process.exit(1);
  }
  const r = await query('UPDATE xy_users SET password_hash = ? WHERE username = ?', [hashPassword(password), username]);
  await closePool();
  if (!r.affectedRows) {
    console.error(`  [FAIL] 用户不存在: ${username}`);
    process.exit(1);
  }
  console.log(`  [OK] 已重置用户 ${username} 的密码，请用新密码登录工作台`);
}

main().catch(async (e) => {
  console.error('  [FAIL] 重置失败: ' + (e && e.message));
  try { await closePool(); } catch (_) { /* ignore */ }
  process.exit(1);
});
