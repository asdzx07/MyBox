import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 运行时根目录。Linux 上默认 /opt/boxpilot；开发时用 BOXPILOT_ROOT 指到本地。
export const ROOT = process.env.BOXPILOT_ROOT
  ? path.resolve(process.env.BOXPILOT_ROOT)
  : '/opt/boxpilot';

export const BIN_DIR = path.join(ROOT, 'bin');
export const ETC_DIR = path.join(ROOT, 'etc');
export const DATA_DIR = path.join(ROOT, 'data');
export const PANEL_DIR = path.join(ROOT, 'panel');

export const FLIP_DIR = path.join(DATA_DIR, 'flip');
export const RULESET_DIR = path.join(DATA_DIR, 'rulesets');
export const GEO_DIR = path.join(DATA_DIR, 'geodata');

export const SINGBOX_BIN = path.join(BIN_DIR, 'sing-box');
export const CONFIG_PATH = path.join(ETC_DIR, 'config.json');
export const CONFIG_CANDIDATE_PATH = path.join(ETC_DIR, 'config.candidate.json');
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
export const PORT_FILE = path.join(DATA_DIR, 'panel-port');
export const VERSION_FILE = path.join(BIN_DIR, 'VERSION.json');

// 内核固定占用的端口。面板端口不能和这些撞。
export const RESERVED_PORTS = [53, 22, 80, 443, 9095, 7853, 7891];

export const KERNEL = {
  // Clash API
  clashApiPort: 9095,
  clashApiHost: '127.0.0.1',
  // DNS 入站（dnsmasq 指向它）
  dnsPort: 7853,
  // 回环入站（本机走代理用）
  loopbackPort: 7891,
  tunName: 'boxpilot-tun',
  nftTable: 'boxpilot',
  routeTable: 2022,
  // 内核自身流量的 fwmark，和 ip rule 里的值必须一致
  fwmark: 0x2024,
  // 「直连不进内核」的标记位
  bypassMark: 0x02000000,
  // ip rule 起始优先级
  rulePriority: 9000,
};

export const DEFAULT_PANEL_PORT = 3036;

export function isLinux() {
  return os.platform() === 'linux';
}

export function isOpenWrt() {
  return isLinux() && fs.existsSync('/etc/openwrt_release');
}
