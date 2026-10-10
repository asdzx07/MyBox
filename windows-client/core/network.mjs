import os from 'node:os';
import { exec, execSync } from 'node:child_process';

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

/**
 * 毫秒级精确检查当前是否已通过旁路由作为默认网关 (精确匹配路由表网关列，杜绝误判本机 IP)
 */
export function isConnectedToGateway(gatewayIp = '192.168.3.2') {
  try {
    const out = execSync('route print 0.0.0.0', { encoding: 'utf8', timeout: 1500 });
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[0] === '0.0.0.0' && parts[1] === '0.0.0.0') {
        const gw = parts[2];
        if (gw === gatewayIp) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 连接旁路由：自动读取当前 IP，将网卡默认网关直接指向旁路由，DNS 设为 旁路由 与 223.5.5.5
 */
export function connectGateway(gatewayIp = '192.168.3.2') {
  const iface = getActiveInterface();
  const alias = iface.alias || '以太网';
  const ip = iface.ip || '192.168.3.25';

  try {
    // 1. 设置网卡静态网关为旁路由 (保留当前 IP 与子网掩码不变)
    execSync(`netsh interface ip set address name="${alias}" static ${ip} 255.255.255.0 ${gatewayIp} 1`, { stdio: 'pipe', timeout: 3000 });

    // 2. 设置首选 DNS 为旁路由，备选 DNS 为公共 DNS 223.5.5.5
    execSync(`netsh interface ip set dns name="${alias}" static ${gatewayIp}`, { stdio: 'pipe', timeout: 3000 });
    try {
      execSync(`netsh interface ip add dns name="${alias}" 223.5.5.5 index=2`, { stdio: 'ignore', timeout: 2000 });
    } catch {}

    // 3. 刷新系统 DNS 缓存
    execSync('ipconfig /flushdns', { stdio: 'ignore', timeout: 2000 });
  } catch (err) {
    throw new Error(`切换网关与 DNS 失败(请确保以管理员权限运行): ${err.message}`);
  }

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
