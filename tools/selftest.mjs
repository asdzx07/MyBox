/**
 * 自检：造一份带样例节点的设置，生成 sing-box 配置并写盘，
 * 然后用官方 sing-box 校验（脚本会打印出校验命令）。
 *
 *   MYBOX_ROOT=./runtime node tools/selftest.mjs
 *   ./runtime/bin/sing-box check -c ./runtime/etc/config.json
 *
 * 这个脚本不联网，只用本地数据，方便在没有订阅时也能验证配置生成逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.MYBOX_ROOT ||= path.join(here, '..', 'runtime');

const { ensureDirs, writeJsonAtomic, writeSmallFile } = await import('../server/lib/fsx.mjs');
const { loadSettings, mutateSettings } = await import('../server/lib/settings.mjs');
const { generateConfig, buildNodeDirectRuleSet, nodeDirectRuleSetPath, buildDirectIpRuleSet, directIpRuleSetPath } = await import('../server/lib/configgen.mjs');
const { setFlip } = await import('../server/lib/flip.mjs');
const { CONFIG_PATH, ROOT } = await import('../server/lib/paths.mjs');

const SAMPLE_NODES = [
  {
    type: 'vless', tag: '样例 | 日本-reality', server: 'jp.example.com', server_port: 443,
    uuid: '11111111-2222-3333-4444-555555555555', flow: 'xtls-rprx-vision',
    tls: { enabled: true, server_name: 'www.microsoft.com', utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', short_id: '0123abcd' } },
  },
  {
    type: 'vmess', tag: '样例 | 美国-ws', server: 'us.example.com', server_port: 443,
    uuid: '66666666-7777-8888-9999-000000000000', security: 'auto', alter_id: 0,
    transport: { type: 'ws', path: '/ws', headers: { Host: 'us.example.com' } },
    tls: { enabled: true, server_name: 'us.example.com' },
  },
  {
    type: 'trojan', tag: '样例 | 香港-trojan', server: 'hk.example.com', server_port: 443,
    password: 'hunter2', tls: { enabled: true, server_name: 'hk.example.com' },
  },
  {
    type: 'shadowsocks', tag: '样例 | 新加坡-ss', server: 'sg.example.com', server_port: 8388,
    method: 'aes-256-gcm', password: 'p@ssw0rd',
  },
  {
    type: 'hysteria2', tag: '样例 | 台湾-hy2', server: 'tw.example.com', server_port: 443,
    password: 'hy2pass', obfs: { type: 'salamander', password: 'obfspass' },
    tls: { enabled: true, server_name: 'tw.example.com' },
  },
  {
    type: 'tuic', tag: '样例 | 韩国-tuic', server: 'kr.example.com', server_port: 443,
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', password: 'tuicpass',
    congestion_control: 'bbr', tls: { enabled: true, server_name: 'kr.example.com' },
  },
];

ensureDirs();

// 清掉上次跑的运行时数据，保证每次都是干净起点
for (const dir of ['etc', 'data']) {
  fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
}
ensureDirs();

mutateSettings((s) => {
  // 故意带上 __subscriptionId：这是面板的内部标记，绝不能被写进内核配置
  // （sing-box 会以 unknown field 拒绝整份配置）。这是踩过的坑，留作回归。
  s.nodes = SAMPLE_NODES.map((n) => ({ ...n, __subscriptionId: 'sub-sample' }));
  s.subscriptions = [{ id: 'sub-sample', name: '样例订阅', url: 'https://example.com/sub', enabled: true, nodeCount: SAMPLE_NODES.length }];
  s.groups[0].members = SAMPLE_NODES.map((n) => n.tag);
});

const settings = loadSettings({ force: true });

for (const p of settings.policies.filter((x) => x.enabled)) setFlip(p.id, true);
const nodeDirect = buildNodeDirectRuleSet(settings.nodes);
writeSmallFile(nodeDirectRuleSetPath(), `${JSON.stringify(nodeDirect)}\n`, { mode: 0o644 });

if (settings.network.directBypass) {
  const directIp = buildDirectIpRuleSet(settings);
  writeSmallFile(directIpRuleSetPath(), `${JSON.stringify(directIp)}\n`, { mode: 0o644 });
}

const { config, warnings, bypassSets } = generateConfig(settings);
writeJsonAtomic(CONFIG_PATH, config, { mode: 0o600 });

console.log(`配置已生成：${CONFIG_PATH}`);
console.log(`  出站 ${config.outbounds.length} 个 · 路由规则 ${config.route.rules.length} 条 · 规则集 ${config.route.rule_set.length} 个`);
console.log(`  DNS 服务器 ${config.dns.servers.length} 个 · DNS 规则 ${config.dns.rules.length} 条`);
console.log(`  入站：${config.inbounds.map((i) => `${i.type}/${i.tag}`).join(', ')}`);
if (bypassSets.length) {
  console.log(`  直连不进内核：${bypassSets.join(', ')}`);
}
if (warnings.length) console.log(`\n提示：\n  - ${warnings.join('\n  - ')}`);
console.log(`\n下一步校验：\n  ${path.join(ROOT, 'bin', 'sing-box')} check -c ${CONFIG_PATH}`);
