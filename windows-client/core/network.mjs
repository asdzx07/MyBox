import os from 'node:os';
import { exec, execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GATEWAY_STATUS_TTL_MS = 1000;
let cachedLatency = 1;
let lastPingTime = 0;

/**
 * 0 毫秒纯内存获取物理网卡信息
 */
export function getActiveInterface() {
  try {
    const ifaces = os.networkInterfaces();
    let alias = '以太网';
    let ip = '192.168.3.25';
    let index = 19;

    for (const [name, addrs] of Object.entries(ifaces)) {
      if (/Loopback|vEthernet|Virtual|tun|tap/i.test(name)) continue;
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) {
          alias = name;
          ip = a.address;
          break;
        }
      }
    }

    return {
      index,
      alias,
      ip,
    };
  } catch (err) {
    console.error('获取网卡信息失败:', err.message);
    return { index: 19, alias: '以太网', ip: '192.168.3.25' };
  }
}

function queryDefaultRouteTable() {
  return execFileAsync('route', ['print', '0.0.0.0'], { encoding: 'utf8', timeout: 1500 })
    .then(({ stdout }) => stdout);
}

/** 从 Windows 路由表文本中精确判断默认网关，避免误判本机 IP。 */
export function parseGatewayRouteTable(output, gatewayIp = '192.168.3.2') {
  for (const line of String(output || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5 && parts[0] === '0.0.0.0' && parts[1] === '0.0.0.0' && parts[2] === gatewayIp) {
      return true;
    }
  }
  return false;
}

/**
 * 创建可测的异步网关状态缓存。缓存过期时异步执行一次路由查询；并发调用共享同一查询。
 */
export function createGatewayStatusCache({ query = queryDefaultRouteTable, ttlMs = GATEWAY_STATUS_TTL_MS, now = Date.now } = {}) {
  const states = new Map();
  const pending = new Map();
  const revisions = new Map();

  async function refresh(gatewayIp) {
    const key = String(gatewayIp || '');
    if (pending.has(key)) return pending.get(key);

    const revision = revisions.get(key) || 0;
    const request = (async () => {
      let connected = false;
      try {
        connected = parseGatewayRouteTable(await query(key), key);
      } catch {}
      if ((revisions.get(key) || 0) === revision) {
        states.set(key, { connected, checkedAt: now() });
      }
      return states.get(key)?.connected ?? connected;
    })();
    pending.set(key, request);
    try {
      return await request;
    } finally {
      if (pending.get(key) === request) pending.delete(key);
    }
  }

  async function get(gatewayIp) {
    const key = String(gatewayIp || '');
    const state = states.get(key);
    if (state && now() - state.checkedAt < ttlMs) return state.connected;
    return refresh(key);
  }

  function set(gatewayIp, connected) {
    const key = String(gatewayIp || '');
    revisions.set(key, (revisions.get(key) || 0) + 1);
    states.set(key, { connected: Boolean(connected), checkedAt: now() });
  }

  return { get, refresh, set };
}

const gatewayStatusCache = createGatewayStatusCache();

/** 异步缓存读取供本地状态 API 使用；同步检查仍保留给启动自动连接兼容路径。 */
export function getGatewayStatus(gatewayIp = '192.168.3.2') {
  return gatewayStatusCache.get(gatewayIp);
}

/**
 * 毫秒级精确检查当前是否已通过旁路由作为默认网关 (精确匹配路由表网关列，杜绝误判本机 IP)
 */
export function isConnectedToGateway(gatewayIp = '192.168.3.2') {
  try {
    const out = execSync('route print 0.0.0.0', { encoding: 'utf8', timeout: 1500 });
    return parseGatewayRouteTable(out, gatewayIp);
  } catch {
    return false;
  }
}

/**
 * 连接旁路由：自动读取当前 IP，将网卡默认网关直接指向旁路由，DNS 设为唯一旁路由 DNS
 */
export function connectGateway(gatewayIp = '192.168.3.2') {
  const iface = getActiveInterface();
  const alias = iface.alias || '以太网';
  const ip = iface.ip || '192.168.3.25';

  try {
    // 1. 设置网卡静态网关为旁路由 (保留当前 IP 与子网掩码不变)
    execSync(`netsh interface ip set address name="${alias}" static ${ip} 255.255.255.0 ${gatewayIp} 1`, { stdio: 'pipe', timeout: 3000 });

    // 2. 设置唯一 DNS 为旁路由（绝对不能加国内备用 DNS，否则 Windows 并发查询会导致 DNS 污染）
    execSync(`netsh interface ip set dns name="${alias}" static ${gatewayIp}`, { stdio: 'pipe', timeout: 3000 });

    // 3. 刷新系统 DNS 缓存
    execSync('ipconfig /flushdns', { stdio: 'ignore', timeout: 2000 });
  } catch (err) {
    throw new Error(`切换网关与 DNS 失败(请确保以管理员权限运行): ${err.message}`);
  }

  gatewayStatusCache.set(gatewayIp, true);
  return { ok: true, connected: true, gateway: gatewayIp, interface: alias, ip };
}

/**
 * 断开旁路由：一键恢复网卡为 DHCP 自动获取 IP 与自动获取 DNS (完全恢复主路由)
 */
export function disconnectGateway(gatewayIp = '192.168.3.2') {
  const iface = getActiveInterface();
  const alias = iface.alias || '以太网';

  const ifacesToReset = Array.from(new Set([alias, '以太网', 'WLAN', 'Wi-Fi', 'Ethernet']));

  for (const name of ifacesToReset) {
    try {
      execSync(`netsh interface ip set address name="${name}" source=dhcp`, { stdio: 'ignore', timeout: 3000 });
      execSync(`netsh interface ip set dns name="${name}" source=dhcp`, { stdio: 'ignore', timeout: 3000 });
    } catch {}
  }

  // 清理可能残留的临时路由与刷新 DNS
  try { execSync(`route delete 0.0.0.0 mask 128.0.0.0 ${gatewayIp}`, { stdio: 'ignore', timeout: 1500 }); } catch {}
  try { execSync(`route delete 128.0.0.0 mask 128.0.0.0 ${gatewayIp}`, { stdio: 'ignore', timeout: 1500 }); } catch {}
  try { execSync(`route delete 0.0.0.0 ${gatewayIp}`, { stdio: 'ignore', timeout: 1500 }); } catch {}
  try { execSync('ipconfig /flushdns', { stdio: 'ignore', timeout: 1500 }); } catch {}

  gatewayStatusCache.set(gatewayIp, false);
  return { ok: true, connected: false, gateway: gatewayIp };
}

/**
 * 非阻塞异步测试到旁路由的 Ping 延迟
 */
export function testPing(gatewayIp = '192.168.3.2') {
  const now = Date.now();
  if (now - lastPingTime > 3000) {
    lastPingTime = now;
    exec(`ping -n 1 -w 600 ${gatewayIp}`, (err, stdout) => {
      if (!err && stdout) {
        const match = stdout.match(/time[=<](\d+)ms/i) || stdout.match(/时间[=<](\d+)ms/i);
        cachedLatency = match ? Number(match[1]) : 1;
      } else {
        cachedLatency = null;
      }
    });
  }
  return cachedLatency;
}
