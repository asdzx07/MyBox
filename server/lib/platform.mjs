import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { createLogger } from './log.mjs';

const execFileAsync = promisify(execFile);
const log = createLogger('platform');

export const SERVICES = { panel: 'mybox-panel', kernel: 'mybox-kernel' };

/**
 * 平台探测。
 *   openwrt  —— /etc/init.d + procd
 *   systemd  —— Debian / Ubuntu 等
 *   other    —— 两者都没有（开发机上跑面板用）
 */
export function detect() {
  if (process.platform !== 'linux') return { id: 'other', supervisor: 'none' };
  if (fs.existsSync('/etc/openwrt_release')) return { id: 'openwrt', supervisor: 'procd' };
  if (fs.existsSync('/run/systemd/system')) return { id: 'systemd', supervisor: 'systemd' };
  return { id: 'linux', supervisor: 'none' };
}

export function isOpenWrt() {
  return detect().id === 'openwrt';
}

async function run(cmd, args, { allowFail = true } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 30000 });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    if (!allowFail) throw err;
    return { ok: false, out: (err.stdout || err.stderr || err.message || '').trim() };
  }
}

function serviceScript(name) {
  return `/etc/init.d/${name}`;
}

export function hasService(name) {
  const p = detect();
  if (p.id === 'openwrt') return fs.existsSync(serviceScript(name));
  return true;
}

/** 启停服务。返回 { ok, out }。 */
export async function serviceControl(name, action) {
  const p = detect();
  if (p.id === 'openwrt') {
    if (!fs.existsSync(serviceScript(name))) {
      return { ok: false, out: `${serviceScript(name)} 不存在` };
    }
    return run(serviceScript(name), [action]);
  }
  if (p.id === 'systemd') {
    return run('systemctl', [action, name]);
  }
  return { ok: false, out: '当前平台没有服务管理器' };
}

/** 服务是否在跑。 */
export async function serviceActive(name) {
  const p = detect();
  if (p.id === 'openwrt') {
    if (!fs.existsSync(serviceScript(name))) return false;
    const r = await run(serviceScript(name), ['status']);
    // procd 的 status 输出 running / inactive
    return /\brunning\b/i.test(r.out);
  }
  if (p.id === 'systemd') {
    const r = await run('systemctl', ['is-active', name]);
    return r.out === 'active';
  }
  return false;
}

/** 设为开机自启 / 取消。 */
export async function serviceEnable(name, on = true) {
  const p = detect();
  if (p.id === 'openwrt') {
    if (!fs.existsSync(serviceScript(name))) return { ok: false, out: '服务脚本不存在' };
    return run(serviceScript(name), [on ? 'enable' : 'disable']);
  }
  if (p.id === 'systemd') {
    return run('systemctl', [on ? 'enable' : 'disable', name]);
  }
  return { ok: false, out: '当前平台没有服务管理器' };
}

/** 装好服务脚本后让服务管理器重新读一遍。 */
export async function serviceReload() {
  const p = detect();
  if (p.id === 'systemd') await run('systemctl', ['daemon-reload']);
  // procd 每次调 /etc/init.d/xxx 都会重新读脚本，不需要额外动作
  return { ok: true };
}

/**
 * 把随包的服务脚本装到系统里。
 * OpenWrt 从 system/openwrt/initd 拷到 /etc/init.d，systemd 从 system/ 拷 unit。
 */
export async function installServiceFiles(root) {
  const p = detect();
  const installed = [];

  if (p.id === 'openwrt') {
    const src = `${root}/system/openwrt/initd`;
    for (const name of Object.values(SERVICES)) {
      const from = `${src}/${name}`;
      const to = serviceScript(name);
      if (!fs.existsSync(from)) continue;
      fs.copyFileSync(from, to);
      fs.chmodSync(to, 0o755);
      installed.push(to);
    }
    return installed;
  }

  if (p.id === 'systemd') {
    const src = `${root}/system`;
    for (const name of Object.values(SERVICES)) {
      const from = `${src}/${name}.service`;
      const to = `/etc/systemd/system/${name}.service`;
      if (!fs.existsSync(from)) continue;
      fs.copyFileSync(from, to);
      fs.chmodSync(to, 0o644);
      installed.push(to);
    }
    await serviceReload();
    return installed;
  }

  return installed;
}

export function describe() {
  const p = detect();
  const labels = {
    openwrt: 'OpenWrt / iStoreOS（procd）',
    systemd: 'Linux（systemd）',
    linux: 'Linux（无服务管理器）',
    other: `${process.platform}（开发模式，不管理系统服务）`,
  };
  return { ...p, label: labels[p.id] ?? p.id };
}

export function logPlatform() {
  const d = describe();
  log.info('运行平台：%s', d.label);
  return d;
}
