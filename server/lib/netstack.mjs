import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR, KERNEL } from './paths.mjs';
import { createLogger } from './log.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';

const execFileAsync = promisify(execFile);
const log = createLogger('netstack');

const STATE_FILE = path.join(DATA_DIR, 'netstack-state.json');
const MANAGED_CONF = 'mybox.conf';

async function run(cmd, args, { allowFail = true } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 20000 });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    if (!allowFail) throw err;
    return { ok: false, out: (err.stdout || err.stderr || err.message || '').trim() };
  }
}

export function isOpenWrt() {
  return fs.existsSync('/etc/openwrt_release');
}

/* ------------------------------------------------------------ IP 转发 */

async function readSysctl(key) {
  const r = await run('sysctl', ['-n', key]);
  return r.ok ? r.out.trim() : null;
}

/** 作为旁路由/主路由给局域网分流，必须打开 IP 转发。 */
export async function enableForwarding() {
  const key = 'net.ipv4.ip_forward';
  const before = await readSysctl(key);
  if (before !== '1') {
    await run('sysctl', ['-w', `${key}=1`]);
    log.info('已打开 IPv4 转发（原值 %s）', before ?? '未知');
  }
  return { key, before };
}

export async function restoreForwarding(before) {
  if (before === '0') await run('sysctl', ['-w', 'net.ipv4.ip_forward=0']);
}

/* -------------------------------------------------------- dnsmasq 接管 */

/**
 * 找出 dnsmasq 读的 conf-dir。
 * OpenWrt 上优先用 uci 的 confdir，没有就用 init 脚本的默认 /tmp/dnsmasq.<段名>.d。
 */
async function dnsmasqConfDir() {
  if (isOpenWrt()) {
    const uci = await run('uci', ['-q', 'get', 'dhcp.@dnsmasq[0].confdir']);
    if (uci.ok && uci.out) {
      const first = uci.out.split(',')[0].trim();
      if (first.startsWith('/')) return first;
    }
    const show = await run('uci', ['-q', 'show', 'dhcp.@dnsmasq[0]']);
    const m = show.out.match(/^dhcp\.([^.=]+)=dnsmasq/m);
    return `/tmp/dnsmasq${m ? `.${m[1]}` : ''}.d`;
  }
  // Debian / Ubuntu：dnsmasq 的 conf-dir 常见于 /etc/dnsmasq.d
  return '/etc/dnsmasq.d';
}

async function dnsmasqRestart() {
  if (isOpenWrt()) return run('/etc/init.d/dnsmasq', ['restart']);
  if (fs.existsSync('/run/systemd/system')) return run('systemctl', ['restart', 'dnsmasq']);
  return run('service', ['dnsmasq', 'restart']);
}

/**
 * 检查是否已经有别处设了 noresolv / log-facility。
 *
 * 这是踩过的坑：dnsmasq 2.9x 遇到重复的关键字会直接拒绝启动（illegal repeated
 * keyword），DNS 和 DHCP 一起停。所以动 dnsmasq 前必须先看别人设过没有。
 */
async function globalOptionAlreadySet(option, confDir) {
  const files = [];
  if (isOpenWrt()) {
    files.push('/etc/dnsmasq.conf');
    for (const f of fs.existsSync('/var/etc') ? fs.readdirSync('/var/etc') : []) {
      if (f.startsWith('dnsmasq.conf')) files.push(path.join('/var/etc', f));
    }
  } else {
    files.push('/etc/dnsmasq.conf');
  }
  if (confDir && fs.existsSync(confDir)) {
    for (const f of fs.readdirSync(confDir)) {
      if (f === MANAGED_CONF) continue;
      files.push(path.join(confDir, f));
    }
  }

  const re = new RegExp(`^\\s*${option}\\s*[=]`, 'm');
  for (const file of files) {
    try {
      if (re.test(fs.readFileSync(file, 'utf8'))) return file;
    } catch {
      /* 读不了就跳过 */
    }
  }
  // OpenWrt 还可能在 uci 里设了
  if (isOpenWrt()) {
    const uciKey = option === 'noresolv' ? 'noresolv' : 'logfacility';
    const r = await run('uci', ['-q', 'get', `dhcp.@dnsmasq[0].${uciKey}`]);
    if (r.ok && r.out) return `uci dhcp.@dnsmasq[0].${uciKey}`;
  }
  return null;
}

/**
 * 找出真实的上游 DNS，用作接管失败时的兜底。
 *
 * 为什么不直接用备份值：如果之前已经装过别的代理面板（比如 Open-Box），
 * dnsmasq 的 server 本来就指向那个面板的 DNS 端口。这种情况下「还原备份」
 * 等于还原成一个已经没人监听的地址，全 LAN 还是解析不了。
 */
async function discoverUpstreamDns() {
  for (const file of ['/tmp/resolv.conf.d/resolv.conf.auto', '/tmp/resolv.conf.auto', '/etc/resolv.conf']) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const found = lines
        .filter((l) => /^\s*nameserver\s+/.test(l))
        .map((l) => l.trim().split(/\s+/)[1])
        .filter((ip) => ip && !ip.startsWith('127.') && ip !== '::1');
      if (found.length) return found.slice(0, 2);
    } catch {
      /* 下一个 */
    }
  }
  return ['223.5.5.5', '119.29.29.29'];
}

/** 备份里指向内核自己 DNS 端口的条目要剔除，否则还原后全 LAN 无解析。 */
function sanitizeDnsBackup(servers, ownPort) {
  const kept = (servers ?? []).filter((s) => !s.includes(`#${ownPort}`) && !s.includes(`:${ownPort}`));
  return kept.length ? kept : null;
}

async function uciGet(option) {
  const r = await run('uci', ['-q', 'get', option]);
  if (!r.ok || !r.out) return null;
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function uciCommit() {
  return run('uci', ['-q', 'commit', 'dhcp']);
}

/**
 * OpenWrt：直接改 uci 的 dnsmasq server 选项。
 *
 * 为什么不能只在 conf-dir 里塞一行 server=：uci 里原有的 server（比如别人装的
 * mosdns 占着 5335）不会消失，dnsmasq 会同时问两个上游，分流就漏了。
 * 必须把 server 列表整体接管过来，并且把原值备份下来以便还原。
 */
async function applyDnsmasqOpenWrt({ dnsPort, listen }) {
  const section = 'dhcp.@dnsmasq[0]';
  const currentServers = await uciGet(`${section}.server`);

  // 剔除指向内核自己端口的条目：装了别的代理面板时原值可能就是那个端口，
  // 留着它会让「还原」变成一个死地址。
  const cleanServers = sanitizeDnsBackup(currentServers, dnsPort);
  const before = {
    server: cleanServers ?? await discoverUpstreamDns(),
    noresolv: await uciGet(`${section}.noresolv`),
    replacedSelfReferential: Boolean(currentServers && !cleanServers),
  };
  if (before.replacedSelfReferential) {
    log.warn('原 dnsmasq 上游指向 %s#%d（已失效的代理面板），还原时将改用真实上游 DNS', listen, dnsPort);
  }

  await run('uci', ['-q', 'delete', `${section}.server`]);
  await run('uci', ['-q', 'add_list', `${section}.server=${listen}#${dnsPort}`]);
  await run('uci', ['-q', 'set', `${section}.noresolv=1`]);
  await uciCommit();

  const restart = await dnsmasqRestart();
  if (!restart.ok) {
    // 起不来就回滚，否则整网 DNS 断掉
    await uciRollbackDnsmasq(before);
    throw new Error(`dnsmasq 重启失败，已回滚：${restart.out}`);
  }

  writeJsonAtomic(STATE_FILE, { ...readJson(STATE_FILE, {}), dnsmasq: { mode: 'uci', section, before } });
  log.info('dnsmasq 已接管（uci）→ %s#%d', listen, dnsPort);
  return { confDir: 'uci', noresolv: true };
}

async function uciRollbackDnsmasq(before) {
  const section = 'dhcp.@dnsmasq[0]';
  // 备份为空（或原本就没设过）时用真实上游 DNS，不能留空——
  // 留空 + noresolv 被删掉的话还能靠 resolv.conf 兜住，但显式给更稳。
  const servers = before?.server?.length ? before.server : await discoverUpstreamDns();

  await run('uci', ['-q', 'delete', `${section}.server`]);
  for (const v of servers) {
    await run('uci', ['-q', 'add_list', `${section}.server=${v}`]);
  }
  if (before?.noresolv?.length) {
    await run('uci', ['-q', 'set', `${section}.noresolv=${before.noresolv[0]}`]);
  } else {
    await run('uci', ['-q', 'delete', `${section}.noresolv`]);
  }
  await uciCommit();
}

/**
 * 接管 dnsmasq：把它的上游指向内核的 DNS 入站。
 * 失败时抛错并回滚——调用方负责记录。
 */
export async function applyDnsmasq({ dnsPort = KERNEL.dnsPort, listen = '127.0.0.1' } = {}) {
  if (isOpenWrt()) return applyDnsmasqOpenWrt({ dnsPort, listen });

  const confDir = await dnsmasqConfDir();
  fs.mkdirSync(confDir, { recursive: true });

  const conflict = await globalOptionAlreadySet('noresolv', confDir);
  const lines = [
    '# 由 MyBox 生成，请勿手工修改。',
    '# 上游指向内核的 DNS 入站，由内核按分流规则决定用哪个上游 DNS。',
    `server=${listen}#${dnsPort}`,
  ];
  if (!conflict) lines.push('noresolv=1');
  else log.warn('noresolv 已被 %s 设置，跳过（避免 dnsmasq 重复关键字启动失败）', conflict);

  const target = path.join(confDir, MANAGED_CONF);
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

  fs.writeFileSync(target, `${lines.join('\n')}\n`);

  const restart = await dnsmasqRestart();
  if (!restart.ok) {
    if (before === null) fs.rmSync(target, { force: true });
    else fs.writeFileSync(target, before);
    await dnsmasqRestart();
    throw new Error(`dnsmasq 重启失败，已回滚：${restart.out}`);
  }

  writeJsonAtomic(STATE_FILE, { ...readJson(STATE_FILE, {}), dnsmasq: { mode: 'confdir', confDir, file: target, before } });
  log.info('dnsmasq 已接管 → %s#%d', listen, dnsPort);
  return { confDir, file: target, noresolv: !conflict };
}

/** 还原 dnsmasq。内核起不来或卸载时必须调这个，否则整网无解析。 */
export async function restoreDnsmasq() {
  const state = readJson(STATE_FILE, {})?.dnsmasq;
  if (!state) return { restored: false };

  try {
    if (state.mode === 'uci') {
      await uciRollbackDnsmasq(state.before);
      await dnsmasqRestart();
    } else if (state.file) {
      if (state.before === null || state.before === undefined) fs.rmSync(state.file, { force: true });
      else fs.writeFileSync(state.file, state.before);
      await dnsmasqRestart();
    }
  } catch (err) {
    log.error('还原 dnsmasq 失败：%s', err.message);
  }

  const next = readJson(STATE_FILE, {});
  delete next.dnsmasq;
  writeJsonAtomic(STATE_FILE, next);
  log.info('dnsmasq 已还原');
  return { restored: true };
}

/* -------------------------------------------------------------- 入口 */

export async function apply(settings) {
  const result = { forwarding: null, dnsmasq: null, warnings: [] };

  if (!fs.existsSync('/proc/sys/net/ipv4')) {
    result.warnings.push('非 Linux 环境：跳过系统网络配置（仅生成配置、启停内核）。');
    return result;
  }

  result.forwarding = await enableForwarding();

  if (settings.dns.mode === 'dnsmasq') {
    try {
      result.dnsmasq = await applyDnsmasq({ dnsPort: settings.dns.hijackPort || KERNEL.dnsPort });
    } catch (err) {
      result.warnings.push(`dnsmasq 接管失败：${err.message}`);
    }
  } else {
    await restoreDnsmasq();
  }

  return result;
}

export async function cleanup() {
  const state = readJson(STATE_FILE, {});
  await restoreDnsmasq();
  if (state.forwarding?.before === '0') await restoreForwarding('0');
  fs.rmSync(STATE_FILE, { force: true });
}

export async function dnsmasqStatus() {
  const state = readJson(STATE_FILE, {})?.dnsmasq;
  if (!state) return { takenOver: false };
  if (state.mode === 'uci') {
    const servers = await uciGet('dhcp.@dnsmasq[0].server');
    return {
      takenOver: Boolean(servers?.some((s) => s.includes(`#${KERNEL.dnsPort}`))),
      confDir: 'uci',
      servers: servers ?? [],
    };
  }
  return { takenOver: Boolean(state.file && fs.existsSync(state.file)), confDir: state.confDir, file: state.file };
}
