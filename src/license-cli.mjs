#!/usr/bin/env node
/**
 * 极简发卡 CLI 工具
 *
 * 1. 批量生成 20 个密钥: node src/license-cli.mjs add 20
 * 2. 查看所有密钥及绑定账号: node src/license-cli.mjs list
 * 3. 开关强制鉴权: node src/license-cli.mjs enforce on   /  enforce off
 *    - off (默认): 开放模式，所有账号无需密钥直接可用（老用户不受影响）
 *    - on:  商业模式，所有账号必须绑定有效密钥才能调用
 */

import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { LicenseManager } from './license-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const licenseManager = new LicenseManager(path.join(__dirname, '..', 'data'));

const args = process.argv.slice(2);
const cmd = args[0] || 'list';

if (cmd === 'enforce') {
  const mode = (args[1] || '').toLowerCase();
  if (mode === 'on') {
    licenseManager.setEnforced(true);
    console.log('✅ 强制鉴权已开启：现在所有账号必须绑定有效密钥才能调用模型');
  } else if (mode === 'off') {
    licenseManager.setEnforced(false);
    console.log('✅ 强制鉴权已关闭：开放模式，所有账号无需密钥即可直接使用');
  } else {
    console.log(`当前强制鉴权模式: ${licenseManager.isEnforced() ? '开启 (商业拦截中)' : '关闭 (开放模式)'}`);
  }
} else if (cmd === 'add' || cmd === 'generate') {
  const count = parseInt(args[1] || '10', 10);
  const newKeys = [];
  for (let i = 0; i < count; i++) {
    // 简单美观的密钥，例如: AG-A8B9C7D6E5F4
    const code = 'AG-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    newKeys.push(code);
  }
  licenseManager.addKeys(newKeys);
  console.log(`\n🎉 成功生成 ${count} 个新密钥（直接复制导入发卡网）：\n` + '='.repeat(40));
  newKeys.forEach(k => console.log(k));
  console.log('='.repeat(40) + '\n');
} else if (cmd === 'list') {
  const all = licenseManager.getAll();
  console.log(`\n📋 当前强制鉴权模式: ${licenseManager.isEnforced() ? '开启 (商业拦截中)' : '关闭 (开放模式，无需密钥)'}`);
  console.log(`📋 当前所有密钥列表 (${Object.keys(all).length} 个)：`);
  console.table(Object.entries(all).map(([k, owner]) => ({
    '密钥': k,
    '绑定账号': owner || '未绑定（买家可用）'
  })));
} else {
  console.log(`
使用命令：
  node src/license-cli.mjs add 10     (生成 10 个密钥)
  node src/license-cli.mjs list       (查看所有密钥与绑定状态)
  node src/license-cli.mjs enforce off (开放模式：所有账号免密钥直接可用)
  node src/license-cli.mjs enforce on  (商业模式：必须绑定密钥)
`);
}
