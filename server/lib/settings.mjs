import crypto from 'node:crypto';
import { SETTINGS_PATH } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';

/** 内置分组：直连 / 拒绝 是固定出站，另外两个是用户可编辑的分组。 */
export const BUILTIN_OUTBOUNDS = [
  { tag: '直连', type: 'direct' },
  { tag: '拒绝', type: 'block' },
];

/**
 * 默认分流策略，顺序即匹配顺序，从上往下先命中先算。
 *
 * 结构参考 Open-Box 的分组方式：具体应用/服务在前（方便各自指定节点），
 * 「国内」和「国内IP」在后兜住直连。没有命中任何策略的流量由 route.final
 * （兜底 selector，默认走代理）处理——这样按裸 IP 发起的连接也能走上代理。
 */
export const DEFAULT_POLICIES = [
  {
    id: 'p-speed',
    name: '测速',
    enabled: true,
    rulesets: [],
    domain: ['speed.cloudflare.com', 'challenges.cloudflare.com'],
    domainSuffix: [
      'speedtest.net', 'speedtest.cn', 'fast.com', 'speedcheck.org', 'ustc.edu.cn',
      'ipip.net', 'ipinfo.io', 'ip-api.com', 'ipleak.net', 'ip-score.com', 'ipw.cn',
      'ifconfig.me', 'ip.sb', 'ipify.org', 'ip125.com', 'ip111.cn', 'ping0.cc',
      'browserleaks.com', 'browserleaks.org', 'browserleaks.net', 'browserscan.net',
      'dnsleaktest.com', 'dnsleaktest.org', 'dnscheck.tools', 'whoer.net', 'whoer.com',
      'whatismyip.com', 'whatismyip.com.tw', 'whoisip.me', 'ipaddress.me', 'ip2proxy.com',
      'vpnapi.io', 'incolumitas.com', 'addr.tools', 'workers.dev', 'skk.moe',
      'null-addr.com', 'null-addr.net', 'null-addr.org', 'null-addr.biz', 'null-addr.info',
      'surfshark.com', 'surfsharkdns.com', 'vultr.com', 'astrill.org', 'test-ipv6.com',
      'jsonp-ip.com', 'sspanel.net', 'yalala.com', 'whois.pconline.com.cn', 'b0.upaiyun.com',
    ],
    ipCidr: [],
    target: 'all-auto',
  },
  { id: 'p-ai', name: 'AI', enabled: true, rulesets: ['geosite-category-ai-!cn'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
  { id: 'p-youtube', name: 'Youtube', enabled: true, rulesets: ['geosite-youtube'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
  { id: 'p-tiktok', name: 'TikTok', enabled: true, rulesets: ['geosite-tiktok', 'geosite-tiktok@!cn'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
  { id: 'p-netflix', name: 'Netflix', enabled: true, rulesets: ['geosite-netflix'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
  { id: 'p-github', name: 'Github', enabled: true, rulesets: ['geosite-github'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
  { id: 'p-google', name: 'Google', enabled: true, rulesets: ['geosite-google'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
  { id: 'p-microsoft', name: 'Microsoft', enabled: true, rulesets: ['geosite-microsoft'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
  { id: 'p-apple', name: 'Apple', enabled: true, rulesets: ['geosite-apple'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
  { id: 'p-games', name: '游戏', enabled: true, rulesets: ['geosite-steam', 'geosite-sony'], domain: [], domainSuffix: [], ipCidr: [], target: 'all-auto' },
  { id: 'p-cn', name: '国内', enabled: true, rulesets: ['geosite-cn'], domain: [], domainSuffix: [], ipCidr: [], target: 'builtin-direct' },
  { id: 'p-cnip', name: '国内IP', enabled: true, rulesets: ['geoip-cn'], domain: [], domainSuffix: [], ipCidr: [], target: 'builtin-direct' },
];

/**
 * 官方 rule-set 仓库里确认存在的 tag（写代码时逐个 HEAD 验证过）。
 *
 * 为什么需要这个：sing-box 启动时如果某个 rule-set 拉不到（404），会直接
 * FATAL 起不来。Open-Box 用的是自带的 geodata（含 geosite-gfw 这类自定义
 * tag），换到官方仓库就 404 了。部署前先照这张表检查，比让内核崩循环好排查。
 *
 * 新增 tag 前先确认 URL 真的能下下来：
 *   curl -I https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/<tag>.srs
 */
export const KNOWN_RULESET_TAGS = new Set([
  // sing-geosite
  'geosite-category-ai-!cn', 'geosite-youtube', 'geosite-tiktok', 'geosite-tiktok@!cn',
  'geosite-netflix', 'geosite-github', 'geosite-google', 'geosite-microsoft',
  'geosite-apple', 'geosite-steam', 'geosite-sony', 'geosite-cn',
  'geosite-geolocation-!cn', 'geosite-telegram', 'geosite-twitter', 'geosite-disney',
  'geosite-openai', 'geosite-category-games', 'geosite-category-ads-all',
  // sing-geoip
  'geoip-cn', 'geoip-private', 'geoip-telegram', 'geoip-google', 'geoip-cloudflare',
  'geoip-facebook', 'geoip-twitter', 'geoip-netflix',
]);

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
    policies: DEFAULT_POLICIES.map((p) => ({ ...p })),
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
