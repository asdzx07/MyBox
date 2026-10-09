#!/usr/bin/env node
/**
 * 应急工具：重置或清空 MyBox 控制面板登录密码
 *
 * 用法：
 *   node tools/reset-password.mjs <新密码>
 *   node tools/reset-password.mjs --clear (清空密码，进入初次使用设置模式)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.MYBOX_ROOT = process.env.MYBOX_ROOT || path.resolve(here, '..');

const { setPassword } = await import('../server/lib/auth.mjs');
const { mutateSettings } = await import('../server/lib/settings.mjs');

const arg = process.argv[2];

if (!arg || arg === '--help' || arg === '-h') {
  console.log(`
MyBox 密码管理工具
==================
用法:
  node tools/reset-password.mjs <新密码>       设置新的面板密码 (至少6位)
  node tools/reset-password.mjs --clear        清空密码 (打开网页即可重新初始化)
`);
  process.exit(0);
}

if (arg === '--clear') {
  mutateSettings((s) => {
    s.panel = s.panel || {};
    s.panel.passwordHash = null;
    s.panel.passwordSalt = null;
  });
  console.log('✓ 面板密码已清空！请直接刷新面板网页重新设置新密码。');
  process.exit(0);
}

if (arg.length < 6) {
  console.error('错误: 密码长度必须至少为 6 位！');
  process.exit(1);
}

try {
  setPassword(arg);
  console.log(`✓ 成功！面板密码已重置为: ${arg}`);
} catch (err) {
  console.error(`重置失败: ${err.message}`);
  process.exit(1);
}
