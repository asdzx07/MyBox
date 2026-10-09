import path from 'node:path';
import { KERNEL, DATA_DIR, RULESET_DIR } from './paths.mjs';
import { flipTag } from './flip.mjs';
import { BUILTIN_OUTBOUNDS } from './settings.mjs';

const GEOSITE_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set';
const GEOIP_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set';

export const DIRECT_TAG = '直连';
export const BLOCK_TAG = '拒绝';

/** 规则集 tag → 官方 rule-set 仓库地址。 */
export function ruleSetUrl(tag) {
  if (tag.startsWith('geosite-')) return `${GEOSITE_BASE}/${tag}.srs`;
  if (tag.startsWith('geoip-')) return `${GEOIP_BASE}/${tag}.srs`;
  return null;
}

export const NODE_DIRECT_RULESET = 'node-direct';
export const DIRECT_IP_RULESET = 'direct-ip';

export function nodeDirectRuleSetPath() {
  return path.join(RULESET_DIR, `${NODE_DIRECT_RULESET}.json`);
}

export function directIpRuleSetPath() {
  return path.join(RULESET_DIR, `${DIRECT_IP_RULESET}.json`);
}

/** 节点服务器域名直连规则集的内容（本地 source 格式）。 */
export function buildNodeDirectRuleSet(nodes) {
  const domains = new Set();
  for (const n of nodes) {
    const server = n?.server;
    if (server && !/^[\d.:]+$/.test(server)) domains.add(server);
  }
  return {
    version: 3,
    rules: domains.size ? [{ domain: [...domains] }] : [{ domain: ['node-direct.invalid'] }],
  };
}

const PRIVATE_CIDRS = [
  '127.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16',
  '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4',
];

/**
 * 「直连不进内核」用的本地 IP 集合。
 *
 * 私网 + 所有「目标是直连/拒绝」的策略里用户手写的 ip_cidr。
 * 这些地址会被塞进 tun 的 route_exclude_address_set —— 内核对它们
 * 不建路由，包根本进不了 tun，真正做到零开销直连。
 */
export function buildDirectIpRuleSet(settings) {
  const cidrs = new Set(PRIVATE_CIDRS);
  for (const p of settings.policies) {
    if (!p.enabled) continue;
    const target = resolveTarget(p.target);
    if (target !== DIRECT_TAG && target !== BLOCK_TAG) continue;
    for (const c of p.ipCidr || []) cidrs.add(c);
  }
  return { version: 3, rules: [{ ip_cidr: [...cidrs] }] };
}

/**
 * 收集「不进内核」的规则集 tag。
 * 只有带 IP 的规则集（geoip-*）才有意义 —— geosite-* 是纯域名，抽不出 IP。
 */
function directBypassRuleSets(settings) {
  const tags = new Set([DIRECT_IP_RULESET]);
  for (const p of settings.policies) {
    if (!p.enabled) continue;
    const target = resolveTarget(p.target);
    if (target !== DIRECT_TAG && target !== BLOCK_TAG) continue;
    for (const tag of p.rulesets || []) {
      if (tag.startsWith('geoip-')) tags.add(tag);
    }
  }
  return [...tags];
}

/** 策略的 target 可能是内置标记，映射成真实出站 tag。 */
function resolveTarget(target) {
  if (target === 'builtin-direct') return DIRECT_TAG;
  if (target === 'builtin-block') return BLOCK_TAG;
  return target;
}

/* -------------------------------------------------------------- outbounds */

function buildOutbounds(settings) {
  const outbounds = [];
  const tags = new Set();

  for (const n of settings.nodes) {
    if (!n?.tag || tags.has(n.tag)) continue;
    tags.add(n.tag);
    outbounds.push(n);
  }

  for (const b of BUILTIN_OUTBOUNDS) {
    if (!tags.has(b.tag)) {
      tags.add(b.tag);
      outbounds.push({ ...b });
    }
  }

  const nodeTags = [...tags].filter((t) => !BUILTIN_OUTBOUNDS.some((b) => b.tag === t));

  for (const g of settings.groups) {
    if (!g.enabled) continue;
    const isDynamic = g.type === 'selector' && g.mode === 'dynamic';

    let members = isDynamic
      ? nodeTags.filter((t) => (g.keywords || []).some((k) => t.toLowerCase().includes(String(k).toLowerCase())))
      : (g.members || []).filter((t) => tags.has(t));

    // 自动择优组没配成员时收编全部节点，否则组是空的、选了它就没网
    if (g.type === 'urltest' && members.length === 0) members = [...nodeTags];
    // 空组兜底成直连，保证配置永远合法
    if (members.length === 0) members = [DIRECT_TAG];

    if (g.type === 'urltest') {
      outbounds.push({
        type: 'urltest',
        tag: g.name,
        outbounds: members,
        url: g.testUrl || 'http://www.gstatic.com/generate_204',
        interval: g.interval || '300s',
        tolerance: Number(g.tolerance) || 100,
        idle_timeout: g.idleTimeout || '12h',
      });
    } else {
      outbounds.push({
        type: 'selector',
        tag: g.name,
        outbounds: members,
        default: g.default && members.includes(g.default) ? g.default : members[0],
      });
    }
    tags.add(g.name);
  }

  return { outbounds, names: tags, nodeTags };
}

/* ------------------------------------------------------------------ DNS */

function buildDns(settings, names) {
  const { dns, network } = settings;

  // 代理 DNS 需要一个出口：优先第一个自动择优组，否则直连
  const proxyDetour = settings.groups.find((g) => g.enabled && g.type === 'urltest')?.name
    || settings.groups.find((g) => g.enabled)?.name
    || DIRECT_TAG;
  const effectiveProxyDetour = names.has(proxyDetour) ? proxyDetour : DIRECT_TAG;

  const proxyServerTag = dns.fakeIp ? 'dns-fakeip' : 'dns-proxy';

  const servers = [
    {
      type: dns.directProtocol || 'udp',
      tag: 'dns-direct',
      server: dns.direct === 'wan' ? '223.5.5.5' : (dns.directAddress || '223.5.5.5'),
      server_port: Number(dns.directPort) || 53,
      detour: DIRECT_TAG,
    },
    {
      type: dns.proxyProtocol || 'tcp',
      tag: 'dns-proxy',
      server: dns.proxy || '1.1.1.1',
      server_port: Number(dns.proxyPort) || 53,
      detour: effectiveProxyDetour,
    },
  ];

  if (dns.fakeIp) {
    servers.push({
      type: 'fakeip',
      tag: 'dns-fakeip',
      inet4_range: dns.fakeIpRange || '198.19.0.0/16',
      ...(network.ipv6 ? { inet6_range: 'fc00::/18' } : {}),
    });
  }

  const rules = [];

  // 屏蔽 HTTPS/SVCB 记录：防止浏览器拿 DoH 记录绕过 DNS 分流
  rules.push({ query_type: ['HTTPS', 'SVCB'], action: 'predefined', rcode: 'NOERROR' });

  // 节点服务器域名走直连 DNS
  rules.push({ rule_set: [NODE_DIRECT_RULESET], server: 'dns-direct' });

  // 按策略分流：走代理的用代理 DNS（开了 FakeIP 就用 FakeIP），直连的用直连 DNS。
  // 用 flip 开关把住，和路由规则同进同出——保证「DNS 和连接走同一边」。
  if (dns.split) {
    for (const p of settings.policies) {
      if (!p.enabled) continue;
      const conditions = policyConditions(p);
      if (!conditions.length) continue;

      const target = resolveTarget(p.target);
      const isProxy = target !== DIRECT_TAG && target !== BLOCK_TAG;
      rules.push({
        type: 'logical',
        mode: 'and',
        rules: [...conditions, { rule_set: [flipTag(p.id)] }],
        server: isProxy ? proxyServerTag : 'dns-direct',
      });
    }
  }

  return {
    servers,
    rules,
    final: 'dns-direct',
    strategy: network.ipv6 ? 'prefer_ipv4' : 'ipv4_only',
  };
}

/* ----------------------------------------------------------------- route */

function policyConditions(p) {
  const conditions = [];
  if (p.rulesets?.length) conditions.push({ rule_set: [...p.rulesets] });
  if (p.domain?.length) conditions.push({ domain: [...p.domain] });
  if (p.domainSuffix?.length) conditions.push({ domain_suffix: [...p.domainSuffix] });
  if (p.ipCidr?.length) conditions.push({ ip_cidr: [...p.ipCidr] });
  return conditions;
}

function buildRoute(settings, names) {
  const { network, policies } = settings;
  const rules = [];

  rules.push({ action: 'sniff' });

  if (settings.dns.mode === 'dnsmasq') rules.push({ inbound: ['dns-in'], action: 'hijack-dns' });
  rules.push({ protocol: 'dns', action: 'hijack-dns' });

  // 节点服务器直连，避免自己套自己
  if (network.directForNodes) rules.push({ rule_set: [NODE_DIRECT_RULESET], outbound: DIRECT_TAG });

  rules.push({ ip_is_private: true, outbound: DIRECT_TAG });

  const bypassPorts = String(network.bypassPorts || '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535);
  if (bypassPorts.length) rules.push({ port: bypassPorts, outbound: DIRECT_TAG });

  for (const p of policies) {
    if (!p.enabled) continue;
    const conditions = policyConditions(p);
    if (!conditions.length) continue;

    const target = resolveTarget(p.target);
    if (!names.has(target)) continue;

    const switchRule = { rule_set: [flipTag(p.id)] };
    const isProxy = target !== DIRECT_TAG && target !== BLOCK_TAG;

    if (network.rejectQuic && isProxy) {
      rules.push({
        type: 'logical',
        mode: 'and',
        rules: [...conditions, switchRule, { network: 'udp', port: 443 }],
        action: 'reject',
      });
    }

    rules.push({
      type: 'logical',
      mode: 'and',
      rules: [...conditions, switchRule],
      outbound: target,
    });
  }

  // 规则集定义
  const ruleSets = [{ type: 'local', tag: NODE_DIRECT_RULESET, format: 'source', path: nodeDirectRuleSetPath() }];
  const seen = new Set([NODE_DIRECT_RULESET]);

  if (network.directBypass) {
    seen.add(DIRECT_IP_RULESET);
    ruleSets.push({ type: 'local', tag: DIRECT_IP_RULESET, format: 'source', path: directIpRuleSetPath() });
  }

  for (const p of policies) {
    if (!p.enabled) continue;

    const flip = flipTag(p.id);
    if (!seen.has(flip)) {
      seen.add(flip);
      ruleSets.push({ type: 'local', tag: flip, format: 'source', path: path.join(DATA_DIR, 'flip', `${flip}.json`) });
    }

    for (const tag of p.rulesets || []) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      const url = ruleSetUrl(tag);
      if (!url) continue;
      ruleSets.push({
        type: 'remote',
        tag,
        format: 'binary',
        url,
        update_interval: '24h',
        download_detour: DIRECT_TAG,
      });
    }
  }

  return {
    rules,
    rule_set: ruleSets,
    final: DIRECT_TAG,
    auto_detect_interface: true,
    default_domain_resolver: { server: 'dns-direct' },
  };
}

/* -------------------------------------------------------------- inbounds */

function buildInbounds(settings, bypassSets = []) {
  const { network, dns } = settings;
  const inbounds = [];

  if (network.tun?.enabled) {
    const tun = {
      type: 'tun',
      tag: 'tun-in',
      interface_name: KERNEL.tunName,
      address: ['172.19.0.1/30'],
      auto_route: network.tun.autoRoute !== false,
      strict_route: Boolean(network.tun.strictRoute),
      stack: network.tun.stack || 'mixed',
      udp_timeout: '60s',
      route_exclude_address: [
        '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12',
        '192.168.0.0/16', '224.0.0.0/4', '255.255.255.255/32',
      ],
      // 「直连不进内核」：这些 IP 集合内的目标内核对它们不建路由，
      // 包进不了 tun，直连零开销。集合来自「目标是直连」的策略。
      ...(bypassSets.length ? { route_exclude_address_set: bypassSets } : {}),
      dns_mode: 'hijack',
      dns_address: ['172.19.0.2'],
    };
    if (Number(network.tun.mtu) > 0) tun.mtu = Number(network.tun.mtu);
    if (network.ipv6) {
      tun.address.push('fdfe:dcba:9876::1/126');
      tun.route_exclude_address.push('fc00::/7', 'fe80::/10', 'ff00::/8');
    }
    if (network.tun.autoRedirect && process.platform === 'linux') {
      // auto_redirect 依赖 nftables，只在 Linux 上有意义
      tun.auto_redirect = true;
      tun.auto_redirect_output_mark = KERNEL.fwmark;
    }
    inbounds.push(tun);
  }

  if (dns.mode === 'dnsmasq') {
    inbounds.push({
      type: 'direct',
      tag: 'dns-in',
      listen: '0.0.0.0',
      listen_port: Number(dns.hijackPort) || KERNEL.dnsPort,
    });
  }

  inbounds.push({
    type: 'mixed',
    tag: 'loopback-in',
    listen: '127.0.0.1',
    listen_port: KERNEL.loopbackPort,
  });

  return inbounds;
}

/* ---------------------------------------------------------------- 出口 */

export function generateConfig(settings) {
  const warnings = [];
  const { outbounds, names } = buildOutbounds(settings);

  if (settings.nodes.length === 0) warnings.push('还没有节点：请先在「订阅」页添加订阅并刷新。');
  if (!settings.groups.some((g) => g.enabled)) warnings.push('没有启用的节点组：策略没有可用出口。');
  if (!settings.policies.some((p) => p.enabled)) warnings.push('没有启用的策略：所有流量都会走兜底直连。');

  const bypassSets = settings.network.directBypass ? directBypassRuleSets(settings) : [];

  const config = {
    log: { level: settings.kernel.logLevel || 'warn', timestamp: true },
    dns: buildDns(settings, names),
    inbounds: buildInbounds(settings, bypassSets),
    outbounds,
    route: buildRoute(settings, names),
    experimental: {
      clash_api: {
        external_controller: `${KERNEL.clashApiHost}:${KERNEL.clashApiPort}`,
        ...(settings.kernel.clashSecret ? { secret: settings.kernel.clashSecret } : {}),
        default_mode: 'rule',
      },
      cache_file: { enabled: true, path: path.join(DATA_DIR, 'cache.db') },
    },
  };

  return { config, warnings, bypassSets };
}
