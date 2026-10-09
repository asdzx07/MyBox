import path from 'node:path';
import { KERNEL, DATA_DIR, RULESET_DIR } from './paths.mjs';
import { flipTag } from './flip.mjs';


const GEOSITE_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set';
const GEOIP_BASE = 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set';

export const DIRECT_TAG = '直连';
export const BLOCK_TAG = '拒绝';

/**
 * 内置出站。
 *
 * 「直连」为什么带 `inet4_bind_address: 0.0.0.0`：
 * sing-box 的 detour 校验里，指向一个「字段全默认」的 direct 出站会直接 FATAL
 * （common/dialer/detour.go 的 "detour to an empty direct outbound makes no
 * sense"）。而直连 DNS 又必须显式 detour 到「直连」——不写 detour 的话它会用
 * 默认出站，也就是走代理；代理服务器的域名又要靠直连 DNS 解析，直接死锁
 * （表现为内核卡在下载规则集，全 LAN 断 DNS）。
 *
 * 绑定 0.0.0.0 对客户端 socket 来说等价于不绑（系统默认行为），语义上无副作用，
 * 但让这个出站不再是「空」的，detour 校验就能过。
 */
export const BUILTIN_OUTBOUND_LIST = [
  { tag: DIRECT_TAG, type: 'direct', inet4_bind_address: '0.0.0.0' },
  { tag: BLOCK_TAG, type: 'block' },
];
/**
 * 兜底出站。
 *
 * 为什么不能直接让 `route.final` 指向「直连」：sing-box 的 detour 校验里，
 * 如果解析到的默认出站是一个「空的 direct 出站」，会直接 FATAL——
 * 见 common/dialer/detour.go 的 "detour to an empty direct outbound makes no sense"。
 * DNS 服务器没写 detour 时会去取默认出站，于是整份配置起不来。
 *
 * 所以固定放一个 selector 当兜底：它本身不是 direct 出站，校验通过；
 * 默认成员是「直连」，行为上和 final=直连 一样。
 */
export const FALLBACK_TAG = '兜底';

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
    const target = resolveTarget(p.target, settings);
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
    const target = resolveTarget(p.target, settings);
    if (target !== DIRECT_TAG && target !== BLOCK_TAG) continue;
    for (const tag of p.rulesets || []) {
      if (tag.startsWith('geoip-')) tags.add(tag);
    }
  }
  return [...tags];
}

/**
 * 把策略的 target 解析成真实的出站 tag。
 *
 * 三个来源都要认：
 *   - 内置标记 builtin-direct / builtin-block
 *   - 分组的 id（默认策略里存的是 id，改名不会失效）
 *   - 分组的名称（老配置和面板手填的是名称）
 *
 * 这里踩过一次坑：默认策略写的是分组 id（all-auto），而出站是按分组名称
 * （所有-自动）注册的，names.has(target) 为 false，于是所有应用策略被静默
 * 跳过——表现就是「Google 打不开」但配置看起来一切正常。
 */
function resolveTarget(target, settings) {
  if (target === 'builtin-direct') return DIRECT_TAG;
  if (target === 'builtin-block') return BLOCK_TAG;
  const group = settings.groups.find((g) => g.id === target || g.name === target);
  return group ? group.name : target;
}

/* -------------------------------------------------------------- outbounds */

/**
 * 递归去掉 undefined 和内部字段（`__` 开头的）。
 *
 * 节点对象上带着面板自己的元数据（比如 `__subscriptionId` 标记它属于哪条订阅），
 * 直接写进配置会被内核以 unknown field 拒绝整份配置，所以生成前必须剥掉。
 */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || k.startsWith('__')) continue;
      const cv = clean(v);
      if (cv === undefined) continue;
      if (Array.isArray(cv) && cv.length === 0) continue;
      if (cv && typeof cv === 'object' && !Array.isArray(cv) && Object.keys(cv).length === 0) continue;
      out[k] = cv;
    }
    return out;
  }
  return value;
}

function buildOutbounds(settings) {
  const outbounds = [];
  const tags = new Set();

  // 停用的订阅，它的节点不进配置。
  // 节点上带 __subscriptionId 标记它属于哪条订阅；手工加的节点没这个标记，始终保留。
  const disabledSubs = new Set(
    settings.subscriptions.filter((s) => s.enabled === false).map((s) => s.id),
  );

  for (const n of settings.nodes) {
    if (!n?.tag || tags.has(n.tag)) continue;
    if (n.__subscriptionId && disabledSubs.has(n.__subscriptionId)) continue;
    tags.add(n.tag);
    outbounds.push(clean(n));
  }

  for (const b of BUILTIN_OUTBOUND_LIST) {
    if (!tags.has(b.tag)) {
      tags.add(b.tag);
      outbounds.push({ ...b });
    }
  }

  const nodeTags = [...tags].filter((t) => !BUILTIN_OUTBOUND_LIST.some((b) => b.tag === t));

  for (const g of settings.groups) {
    if (!g.enabled) continue;
    const isDynamic = g.type === 'selector' && g.mode === 'dynamic';
    const keywords = (g.keywords || []).filter(Boolean);

    // 动态组：按关键词自动收编节点；没配关键词就是收编全部
    let members = isDynamic
      ? (keywords.length
        ? nodeTags.filter((t) => keywords.some((k) => t.toLowerCase().includes(String(k).toLowerCase())))
        : [...nodeTags])
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

  // 兜底 selector：route.final 指向它。
  //
  // 默认成员必须是「走代理」的组，不能是直连。原因：按裸 IP 发起的连接
  // （App 硬编码 IP、客户端自带 DNS 拿到真实 IP、嗅探不出域名）没有任何
  // 域名可以匹配策略，只能落到兜底。如果兜底是直连，这些连接就直连出去——
  // 被墙的站点（Telegram、1.1.1.1 之类）必然超时。
  // 国内流量由 geosite-cn / geoip-cn 策略拦下来走直连，不会受影响。
  const enabledGroups = settings.groups.filter((g) => g.enabled).map((g) => g.name);
  const proxyDefault = settings.groups.find((g) => g.enabled && g.type === 'urltest')?.name
    || enabledGroups[0]
    || DIRECT_TAG;

  const fallbackMembers = [proxyDefault, ...enabledGroups, DIRECT_TAG, BLOCK_TAG]
    .filter((t, i, arr) => arr.indexOf(t) === i && tags.has(t));

  outbounds.push({
    type: 'selector',
    tag: FALLBACK_TAG,
    outbounds: fallbackMembers.length ? fallbackMembers : [DIRECT_TAG],
    default: fallbackMembers.includes(proxyDefault) ? proxyDefault : fallbackMembers[0],
  });
  tags.add(FALLBACK_TAG);

  return { outbounds, names: tags, nodeTags };
}

/* ------------------------------------------------------------------ DNS */

function buildDns(settings, names) {
  const { dns, network } = settings;

  // 代理 DNS 需要一个出口：优先第一个自动择优组，否则任意启用的组，最后兜底。
  // 不能落到「直连」——那是个空 direct 出站，detour 校验会 FATAL。
  const proxyDetour = settings.groups.find((g) => g.enabled && g.type === 'urltest')?.name
    || settings.groups.find((g) => g.enabled)?.name
    || FALLBACK_TAG;
  const effectiveProxyDetour = names.has(proxyDetour) ? proxyDetour : FALLBACK_TAG;

  const proxyServerTag = dns.fakeIp ? 'dns-fakeip' : 'dns-proxy';

  const servers = [
    {
      type: dns.directProtocol || 'udp',
      tag: 'dns-direct',
      server: dns.direct === 'wan' ? '223.5.5.5' : (dns.directAddress || '223.5.5.5'),
      server_port: Number(dns.directPort) || 53,
      // 必须显式 detour 到「直连」。
      //
      // 不写的话它会用默认出站——而 route.final 指向兜底（代理），于是「直连 DNS」
      // 实际走代理；代理服务器的域名又要靠这个 DNS 解析，形成死锁：内核卡在
      // 下载规则集，dnsmasq 指向的 DNS 端口一直没起来，全 LAN 断解析。
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

      // DNS 分流只按域名来。IP 型规则集（geoip-*）不能出现在 DNS 规则里：
      // sing-box 1.14 起把 DNS 规则里的地址匹配字段标记为弃用，用了会直接 FATAL。
      const conditions = [];
      const domainSets = (p.rulesets || []).filter((t) => t.startsWith('geosite-'));
      if (domainSets.length) conditions.push({ rule_set: domainSets });
      if (p.domain?.length) conditions.push({ domain: [...p.domain] });
      if (p.domainSuffix?.length) conditions.push({ domain_suffix: [...p.domainSuffix] });
      if (!conditions.length) continue;

      const target = resolveTarget(p.target, settings);
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
    // 兜底用代理 DNS，必须和 route.final（走代理）同边：路由兜底走代理、
    // DNS 兜底却用国内 DNS 的话，没命中策略的域名会被解析成被污染的 IP。
    //
    // 注意不能用 FakeIP 当默认——sing-box 会直接 FATAL：
    // "default server cannot be fakeip"。FakeIP 只能通过显式规则命中。
    final: 'dns-proxy',
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

  for (const p of policies) {
    if (!p.enabled) continue;
    const conditions = policyConditions(p);
    if (!conditions.length) continue;

    const target = resolveTarget(p.target, settings);
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
        // 不写 download_detour：1.14 起已弃用（会打 WARN），默认走兜底出站，
        // 而兜底是代理——从国内拉 GitHub 上的规则集走代理反而更稳。
      });
    }
  }

  return {
    rules,
    rule_set: ruleSets,
    // 兜底走 selector 而不是直接写「直连」——空的 direct 出站会让 DNS 的
    // detour 校验失败，整份配置起不来（见 FALLBACK_TAG 的注释）
    final: names.has(FALLBACK_TAG) ? FALLBACK_TAG : DIRECT_TAG,
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
      // stack/mtu 不写，完全由 sing-box 自己决定（1.15+ 已弃用手动指定）
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

  // 最后整体过一遍 clean()，兜住任何漏网的内部字段
  return { config: clean(config), warnings, bypassSets };
}
