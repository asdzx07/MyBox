import crypto from 'node:crypto';
import { SETTINGS_PATH } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';

/** 内置分组：直连 / 拒绝 是固定出站，另外两个是用户可编辑的分组。 */
export const BUILTIN_OUTBOUNDS = [
  { tag: '直连', type: 'direct' },
  { tag: '拒绝', type: 'block' },
];

export function defaultSettings() {
  return {
    panel: {
      passwordHash: null,
      passwordSalt: null,
      sessionSecret: crypto.randomBytes(32).toString('hex'),
    },
    kernel: {
      version: null,
      autoStart: true,
      logLevel: 'warn',
      clashSecret: null,
    },
    network: {
      tun: {
        enabled: true,
        stack: 'mixed',
        mtu: 0,
        autoRoute: true,
        autoRedirect: true,
        strictRoute: false,
      },
      ipv6: false,
      rejectQuic: true,
      directBypass: true,
      directForNodes: true,
      bypassPorts: '',
    },
    dns: {
      mode: 'dnsmasq',
      split: true,
      direct: 'wan',
      directAddress: '',
      directProtocol: 'udp',
      directPort: 53,
      proxy: '1.1.1.1',
      proxyProtocol: 'tcp',
      proxyPort: 53,
      fakeIp: true,
      fakeIpRange: '198.19.0.0/16',
      region: 'cn',
      hijackPort: 7853,
    },
    subscriptions: [],
    nodes: [],
    groups: [
      { id: 'all-auto', name: '所有-自动', type: 'urltest', enabled: true, members: [], interval: '300s', tolerance: 100, idleTimeout: '12h' },
      { id: 'all-manual', name: '所有-手动', type: 'selector', enabled: true, mode: 'dynamic', members: [] },
    ],
    policies: [
      { id: 'p-ai', name: 'AI', enabled: true, rulesets: ['geosite-category-ai-!cn'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
      { id: 'p-youtube', name: 'Youtube', enabled: true, rulesets: ['geosite-youtube'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
      { id: 'p-telegram', name: 'Telegram', enabled: true, rulesets: ['geosite-telegram'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
      { id: 'p-github', name: 'Github', enabled: true, rulesets: ['geosite-github'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
      { id: 'p-google', name: 'Google', enabled: true, rulesets: ['geosite-google'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
      { id: 'p-cn', name: '国内', enabled: true, rulesets: ['geosite-cn'], domain: [], domainSuffix: [], ipCidr: [], target: 'builtin-direct' },
      { id: 'p-other', name: '其他地区', enabled: true, rulesets: ['geosite-geolocation-!cn'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
      { id: 'p-cnip', name: '国内IP', enabled: true, rulesets: ['geoip-cn'], domain: [], domainSuffix: [], ipCidr: [], target: 'builtin-direct' },
    ],
    meta: {
      lastDeployAt: null,
      lastDeployError: null,
    },
  };
}

/** 深合并：只补默认值里缺失的键，不覆盖用户已有的值。 */
function mergeDefaults(target, defaults) {
  if (Array.isArray(defaults)) return Array.isArray(target) ? target : defaults;
  if (defaults && typeof defaults === 'object') {
    const out = target && typeof target === 'object' ? { ...target } : {};
    for (const [k, v] of Object.entries(defaults)) {
      out[k] = k in out ? mergeDefaults(out[k], v) : v;
    }
    return out;
  }
  return target === undefined ? defaults : target;
}

let cache = null;

export function loadSettings({ force = false } = {}) {
  if (cache && !force) return cache;
  const stored = readJson(SETTINGS_PATH, null);
  cache = mergeDefaults(stored, defaultSettings());
  if (!stored) saveSettings(cache);
  return cache;
}

export function saveSettings(next) {
  cache = next;
  writeJsonAtomic(SETTINGS_PATH, next);
  return cache;
}

export function mutateSettings(fn) {
  const s = loadSettings({ force: true });
  const result = fn(s);
  saveSettings(s);
  return result;
}

export function newId(prefix = 'id') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}
