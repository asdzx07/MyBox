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
 * 接管 dnsmasq：把它的上游指向内核的 DNS 入站。
 * 返回接管详情，失败时抛出——调用方负责回滚。
 */
export async function applyDnsmasq({ dnsPort = KERNEL.dnsPort, listen = '127.0.0.1' } = {}) {
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
    // 起不来就回滚，否则整网 DNS 断掉
    if (before === null) fs.rmSync(target, { force: true });
    else fs.writeFileSync(target, before);
    await dnsmasqRestart();
    throw new Error(`dnsmasq 重启失败，已回滚：${restart.out}`);
  }

  writeJsonAtomic(STATE_FILE, { ...readJson(STATE_FILE, {}), dnsmasq: { confDir, file: target, before } });
  log.info('dnsmasq 已接管 → %s#%d', listen, dnsPort);
  return { confDir, file: target, noresolv: !conflict };
}

/** 还原 dnsmasq。内核起不来时必须调这个，否则整网无解析。 */
export async function restoreDnsmasq() {
  const state = readJson(STATE_FILE, {})?.dnsmasq;
  if (!state?.file) return { restored: false };
  try {
    if (state.before === null || state.before === undefined) {
      fs.rmSync(state.file, { force: true });
    } else {
      fs.writeFileSync(state.file, state.before);
    }
    await dnsmasqRestart();
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
  if (!state?.file) return { takenOver: false };
  return { takenOver: fs.existsSync(state.file), confDir: state.confDir, file: state.file };
}
