import YAML from 'yaml';

/**
 * 订阅解析：把三种常见订阅格式统一成 sing-box 的 outbound 数组。
 *
 *   1. sing-box JSON   { "outbounds": [...] }
 *   2. base64 分享链接  每行一条 vless:// / vmess:// / trojan:// / ss:// / hysteria2:// / tuic://
 *   3. Clash YAML      proxies: [...]
 *
 * 只做「解析 + 转成 outbound」，不做重命名、不做过滤——那些属于上层策略。
 */

const NODE_TYPES = new Set([
  'vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic', 'hysteria', 'anytls', 'socks', 'http',
]);

/* ------------------------------------------------------------------ 工具 */

function b64decode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function looksBase64(text) {
  const s = text.trim();
  if (s.length < 16 || /\s/.test(s)) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(s);
}

function toBool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function toInt(v, fallback = 0) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 主机名若被方括号包住（IPv6），去掉括号。 */
function cleanHost(host) {
  return String(host || '').replace(/^\[|\]$/g, '');
}

/* ------------------------------------------------- 传输层（transport） */

function buildTransport(params, netRaw) {
  const net = (netRaw || params.get('type') || '').toLowerCase();
  const path = params.get('path') || '';
  const host = params.get('host') || params.get('sni') || '';
  switch (net) {
    case 'ws': {
      const headers = host ? { Host: host } : undefined;
      const early = params.get('ed');
      return {
        type: 'ws',
        path: path || '/',
        ...(headers ? { headers } : {}),
        ...(early ? { max_early_data: toInt(early, 0), early_data_header_name: params.get('eh') || 'Sec-WebSocket-Protocol' } : {}),
      };
    }
    case 'grpc':
      return { type: 'grpc', service_name: params.get('serviceName') || params.get('servicename') || path || '' };
    case 'h2':
    case 'http':
      return {
        type: 'http',
        ...(host ? { host: host.split(',').map((s) => s.trim()) } : {}),
        ...(path ? { path } : {}),
      };
    case 'httpupgrade':
      return { type: 'httpupgrade', ...(host ? { host } : {}), ...(path ? { path } : {}) };
    case 'quic':
      return { type: 'quic' };
    default:
      return null;
  }
}

function buildTLS(params, { defaultSni = '', reality = false } = {}) {
  const security = (params.get('security') || '').toLowerCase();
  if (!reality && security !== 'tls' && security !== 'reality' && !params.get('tls')) return undefined;

  const sni = params.get('sni') || params.get('peer') || defaultSni || '';
  const fp = params.get('fp') || '';
  const alpn = params.get('alpn');

  const tls = {
    enabled: true,
    ...(sni ? { server_name: sni } : {}),
    ...(toBool(params.get('allowInsecure') || params.get('insecure'), false) ? { insecure: true } : {}),
    ...(alpn ? { alpn: alpn.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    ...(fp ? { utls: { enabled: true, fingerprint: fp } } : {}),
  };

  if (reality || security === 'reality') {
    const pbk = params.get('pbk') || params.get('public_key') || '';
    const sid = params.get('sid') || params.get('short_id') || '';
    if (pbk) tls.reality = { enabled: true, public_key: pbk, ...(sid ? { short_id: sid } : {}) };
  }
  return tls;
}

/* -------------------------------------------------------- 分享链接解析 */

function parseVless(url) {
  const u = new URL(url);
  const p = u.searchParams;
  const flow = p.get('flow') || '';
  const security = (p.get('security') || '').toLowerCase();
  return {
    type: 'vless',
    tag: decodeURIComponent(u.hash.slice(1)) || `${cleanHost(u.hostname)}:${u.port}`,
    server: cleanHost(u.hostname),
    server_port: toInt(u.port, 443),
    uuid: decodeURIComponent(u.username),
    ...(flow ? { flow } : {}),
    ...(buildTransport(p, p.get('type')) ? { transport: buildTransport(p, p.get('type')) } : {}),
    ...(buildTLS(p, { defaultSni: cleanHost(u.hostname), reality: security === 'reality' }) ? { tls: buildTLS(p, { defaultSni: cleanHost(u.hostname), reality: security === 'reality' }) } : {}),
  };
}

function parseVmess(url) {
  const raw = url.slice('vmess://'.length);
  const j = JSON.parse(b64decode(raw));
  const p = new URLSearchParams({
    type: j.net || 'tcp',
    path: j.path || '',
    host: j.host || '',
    security: j.tls || '',
    sni: j.sni || j.host || '',
    alpn: j.alpn || '',
    fp: j.fp || '',
  });
  const transport = buildTransport(p, j.net);
  return {
    type: 'vmess',
    tag: j.ps || `${j.add}:${j.port}`,
    server: cleanHost(j.add),
    server_port: toInt(j.port, 443),
    uuid: j.id,
    security: j.scy || 'auto',
    alter_id: toInt(j.aid, 0),
    ...(transport ? { transport } : {}),
    ...(buildTLS(p, { defaultSni: j.host || j.add }) ? { tls: buildTLS(p, { defaultSni: j.host || j.add }) } : {}),
  };
}

function parseTrojan(url) {
  const u = new URL(url);
  const p = u.searchParams;
  const transport = buildTransport(p, p.get('type'));
  const tls = buildTLS(p, { defaultSni: p.get('sni') || cleanHost(u.hostname) }) ?? { enabled: true };
  return {
    type: 'trojan',
    tag: decodeURIComponent(u.hash.slice(1)) || `${cleanHost(u.hostname)}:${u.port}`,
    server: cleanHost(u.hostname),
    server_port: toInt(u.port, 443),
    password: decodeURIComponent(u.username),
    tls,
    ...(transport ? { transport } : {}),
  };
}

function parseShadowsocks(url) {
  // 两种写法：ss://base64(method:password)@host:port#tag  和  ss://base64(method:password@host:port)#tag
  const body = url.slice('ss://'.length);
  const hashIdx = body.indexOf('#');
  const tag = hashIdx >= 0 ? decodeURIComponent(body.slice(hashIdx + 1)) : '';
  let main = hashIdx >= 0 ? body.slice(0, hashIdx) : body;

  let method; let password; let host; let port;
  const at = main.lastIndexOf('@');
  if (at >= 0) {
    const credPart = main.slice(0, at);
    const hostPart = main.slice(at + 1);
    const cred = credPart.includes(':') && !looksBase64(credPart) ? credPart : b64decode(credPart);
    [method, password] = cred.split(':');
    [host, port] = hostPart.split(':');
  } else {
    const decoded = b64decode(main);
    const at2 = decoded.lastIndexOf('@');
    const cred = decoded.slice(0, at2);
    const hostPart = decoded.slice(at2 + 1);
    [method, password] = cred.split(':');
    [host, port] = hostPart.split(':');
  }
  return {
    type: 'shadowsocks',
    tag: tag || `${cleanHost(host)}:${port}`,
    server: cleanHost(host),
    server_port: toInt(port, 8388),
    method,
    password,
  };
}

function parseHysteria2(url) {
  const u = new URL(url.replace(/^hy2:\/\//, 'hysteria2://'));
  const p = u.searchParams;
  const obfs = p.get('obfs');
  const obfsPassword = p.get('obfs-password') || p.get('obfspassword') || '';
  return {
    type: 'hysteria2',
    tag: decodeURIComponent(u.hash.slice(1)) || `${cleanHost(u.hostname)}:${u.port}`,
    server: cleanHost(u.hostname),
    server_port: toInt(u.port, 443),
    password: decodeURIComponent(u.username || p.get('password') || ''),
    ...(obfs ? { obfs: { type: obfs, password: obfsPassword } } : {}),
    tls: {
      enabled: true,
      server_name: p.get('sni') || cleanHost(u.hostname),
      ...(toBool(p.get('insecure'), false) ? { insecure: true } : {}),
    },
  };
}

function parseTuic(url) {
  const u = new URL(url);
  const p = u.searchParams;
  return {
    type: 'tuic',
    tag: decodeURIComponent(u.hash.slice(1)) || `${cleanHost(u.hostname)}:${u.port}`,
    server: cleanHost(u.hostname),
    server_port: toInt(u.port, 443),
    uuid: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password || ''),
    ...(p.get('congestion_control') ? { congestion_control: p.get('congestion_control') } : {}),
    ...(p.get('udp_relay_mode') ? { udp_relay_mode: p.get('udp_relay_mode') } : {}),
    tls: {
      enabled: true,
      server_name: p.get('sni') || cleanHost(u.hostname),
      ...(p.get('alpn') ? { alpn: p.get('alpn').split(',') } : {}),
      ...(toBool(p.get('allow_insecure') || p.get('insecure'), false) ? { insecure: true } : {}),
    },
  };
}

const LINK_PARSERS = [
  [/^vless:\/\//i, parseVless],
  [/^vmess:\/\//i, parseVmess],
  [/^trojan:\/\//i, parseTrojan],
  [/^ss:\/\//i, parseShadowsocks],
  [/^hysteria2:\/\//i, parseHysteria2],
  [/^hy2:\/\//i, parseHysteria2],
  [/^tuic:\/\//i, parseTuic],
];

export function parseShareLink(line) {
  const text = line.trim();
  for (const [re, fn] of LINK_PARSERS) {
    if (!re.test(text)) continue;
    try {
      return fn(text);
    } catch {
      return null;
    }
  }
  return null;
}

/* ----------------------------------------------------------- Clash YAML */

function clashProxyToOutbound(px) {
  const base = {
    tag: px.name,
    server: cleanHost(px.server),
    server_port: toInt(px.port, 443),
  };
  const net = (px.network || 'tcp').toLowerCase();
  const p = new URLSearchParams();
  if (px['ws-opts']?.path) p.set('path', px['ws-opts'].path);
  if (px['ws-opts']?.headers?.Host) p.set('host', px['ws-opts'].headers.Host);
  if (px['grpc-opts']?.['grpc-service-name']) p.set('serviceName', px['grpc-opts']['grpc-service-name']);
  const transport = buildTransport(p, net === 'tcp' ? '' : net);

  const tlsOn = toBool(px.tls, false);
  const tls = tlsOn
    ? {
        enabled: true,
        server_name: px.servername || px.sni || px.server,
        ...(toBool(px['skip-cert-verify'], false) ? { insecure: true } : {}),
        ...(px['client-fingerprint'] ? { utls: { enabled: true, fingerprint: px['client-fingerprint'] } } : {}),
      }
    : undefined;

  switch (String(px.type).toLowerCase()) {
    case 'vless':
      return {
        ...base, type: 'vless', uuid: px.uuid,
        ...(px.flow ? { flow: px.flow } : {}),
        ...(transport ? { transport } : {}),
        ...(tls || px['reality-opts'] ? {
          tls: {
            ...(tls || { enabled: true, server_name: px.servername || px.server }),
            ...(px['reality-opts']?.['public-key'] ? { reality: { enabled: true, public_key: px['reality-opts']['public-key'], short_id: px['reality-opts']['short-id'] || '' } } : {}),
          },
        } : {}),
      };
    case 'vmess':
      return {
        ...base, type: 'vmess', uuid: px.uuid,
        security: px.cipher || 'auto',
        alter_id: toInt(px.alterId, 0),
        ...(transport ? { transport } : {}),
        ...(tls ? { tls } : {}),
      };
    case 'trojan':
      return { ...base, type: 'trojan', password: px.password, tls: tls || { enabled: true, server_name: px.sni || px.server }, ...(transport ? { transport } : {}) };
    case 'ss':
    case 'shadowsocks':
      return { ...base, type: 'shadowsocks', method: px.cipher, password: px.password };
    case 'hysteria2':
      return {
        ...base, type: 'hysteria2', password: px.password,
        ...(px.obfs ? { obfs: { type: px.obfs, password: px['obfs-password'] || '' } } : {}),
        tls: { enabled: true, server_name: px.sni || px.server, ...(toBool(px['skip-cert-verify'], false) ? { insecure: true } : {}) },
      };
    case 'tuic':
      return {
        ...base, type: 'tuic', uuid: px.uuid, password: px.password,
        ...(px['congestion-controller'] ? { congestion_control: px['congestion-controller'] } : {}),
        tls: { enabled: true, server_name: px.sni || px.server, ...(px.alpn ? { alpn: px.alpn } : {}), ...(toBool(px['skip-cert-verify'], false) ? { insecure: true } : {}) },
      };
    default:
      return null;
  }
}

/* -------------------------------------------------------------- 入口 */

/**
 * @returns {{ format: string, nodes: object[] }}
 */
export function parseSubscription(text) {
  const body = String(text || '').trim();
  if (!body) return { format: 'empty', nodes: [] };

  // 1) sing-box JSON
  if (body.startsWith('{')) {
    try {
      const json = JSON.parse(body);
      if (Array.isArray(json.outbounds)) {
        const nodes = json.outbounds.filter((o) => NODE_TYPES.has(o.type));
        if (nodes.length) return { format: 'singbox', nodes };
      }
    } catch {
      /* 继续往下试 */
    }
  }

  // 2) Clash YAML
  if (/^\s*proxies\s*:/m.test(body) || /^\s*proxy-providers\s*:/m.test(body)) {
    try {
      const doc = YAML.parse(body);
      const nodes = (doc?.proxies || []).map(clashProxyToOutbound).filter(Boolean);
      if (nodes.length) return { format: 'clash', nodes };
    } catch {
      /* 继续 */
    }
  }

  // 3) base64 / 明文分享链接
  let lines = body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 1 && looksBase64(body)) {
    try {
      lines = b64decode(body).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch {
      /* 保持原样 */
    }
  }
  const nodes = lines.map(parseShareLink).filter(Boolean);
  if (nodes.length) return { format: 'links', nodes };

  throw new Error('无法识别的订阅格式（支持 sing-box JSON / Clash YAML / base64 分享链接）');
}

/** 去掉重名，保证 tag 唯一。 */
export function dedupeTags(nodes) {
  const seen = new Map();
  return nodes.map((n) => {
    const base = n.tag || `${n.server}:${n.server_port}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? { ...n, tag: base } : { ...n, tag: `${base} #${count + 1}` };
  });
}
