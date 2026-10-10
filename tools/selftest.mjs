/**
 * 自检：造一份带样例节点的设置，生成 sing-box 配置并写盘，
 * 然后用官方 sing-box 校验（脚本会打印出校验命令）。
 *
 *   MYBOX_ROOT=./runtime node tools/selftest.mjs
 *   ./runtime/bin/sing-box check -c ./runtime/etc/config.json
 *
 * 其它 MYBOX_ROOT 路径默认拒绝清理；确认是独立测试目录后追加 --allow-external-root（生产目录始终禁止）。
 * 这个脚本不联网，只用本地数据，方便在没有订阅时也能验证配置生成逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSelftestRoot } from './selftest-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const allowExternalRoot = process.argv.includes('--allow-external-root');
let configuredRoot;

try {
  const validation = validateSelftestRoot({
    projectRoot,
    configuredRoot: process.env.MYBOX_ROOT,
    allowExternalRoot,
  });
  configuredRoot = validation.root;
  console.log(`[selftest] 将重置数据目录：${path.join(configuredRoot, 'etc')}、${path.join(configuredRoot, 'data')}`);
  if (allowExternalRoot && validation.isExternal) {
    console.warn('[selftest] 已通过 --allow-external-root 明确允许清理自定义运行目录。');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

process.env.MYBOX_ROOT = configuredRoot;

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
  // 非 Linux 上建不出 tun，冒烟测试跑不起来，本地只验配置生成
  if (process.platform !== 'linux') s.network.tun.enabled = false;

  // 自检要自成一体：去掉远程规则集，不然样例节点域名是假的、规则集下不下来，
  // 内核会因为网络原因起不来，掩盖真正想测的结构问题。
  // 规则集 URL 是否可下载由部署时的校验负责。
  for (const p of s.policies) p.rulesets = [];
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
const smoke = process.argv.includes('--smoke');

if (smoke) {
  // 冒烟测试：真的把内核拉起来几秒，看它会不会 FATAL。
  // sing-box check 只解析配置，抓不到「空 direct 出站」这类只在启动阶段才暴露的错误。
  const { spawn } = await import('node:child_process');
  const bin = process.platform === 'win32'
    ? path.join(ROOT, 'bin', 'sing-box.exe')
    : path.join(ROOT, 'bin', 'sing-box');

  if (!fs.existsSync(bin)) {
    console.log(`\n跳过冒烟测试：找不到内核 ${bin}`);
  } else {
    console.log('\n冒烟测试：启动内核 6 秒…');
    const child = spawn(bin, ['run', '-c', CONFIG_PATH, '-D', path.join(ROOT, 'data')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });

    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 6000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));

    const fatal = output.split('\n').filter((l) => /FATAL|panic/.test(l));
    const errors = output.split('\n').filter((l) => /ERROR/.test(l));
    if (exited !== null && exited !== 0) {
      console.log(`  ✗ 内核提前退出（code=${exited}）`);
      console.log(fatal.length ? fatal.map((l) => `    ${l}`).join('\n') : output.trim());
      process.exitCode = 1;
    } else if (fatal.length) {
      console.log('  ✗ 启动阶段 FATAL：');
      console.log(fatal.map((l) => `    ${l}`).join('\n'));
      process.exitCode = 1;
    } else {
      console.log('  ✓ 内核启动正常，没有 FATAL');
      if (errors.length) {
        console.log(`  （${errors.length} 条 ERROR，通常是规则集下载失败，不影响结论）`);
        console.log(errors.slice(0, 3).map((l) => `    ${l}`).join('\n'));
      }
    }
  }
}

console.log(`\n配置校验：\n  ${path.join(ROOT, 'bin', 'sing-box')} check -c ${CONFIG_PATH}`);
