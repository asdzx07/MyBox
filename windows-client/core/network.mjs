import os from 'node:os';
import { execSync } from 'node:child_process';

/**
 * 获取当前活动的物理 IPv4 网卡信息
 */
export function getActiveInterface() {
  try {
    // 1. 获取物理接口 index
    let index = 19;
    try {
      const psIndex = execSync(`powershell -NoProfile -Command "& { Get-NetIPInterface -AddressFamily IPv4 | Where-Object { $_.ConnectionState -eq 'Connected' -and $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Virtual|tun|tap' } | Select-Object -ExpandProperty InterfaceIndex -First 1 }"`, { encoding: 'utf8' }).trim();
      if (psIndex && !isNaN(Number(psIndex))) {
        index = Number(psIndex);
      }
    } catch {}

    // 2. 利用 Node.js os.networkInterfaces 获取 IP 与网卡名
    const ifaces = os.networkInterfaces();
    let alias = '以太网';
    let ip = '192.168.3.25';

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
 * 检查当前是否已通过旁路由作为默认网关
 */
export function isConnectedToGateway(gatewayIp = '192.168.3.2') {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway }).IPv4DefaultGateway.NextHop"`, { encoding: 'utf8' });
    return out.includes(gatewayIp);
  } catch {
    return false;
  }
}

/**
 * 连接旁路由：自动读取当前 IP，将网卡默认网关直接指向 192.168.3.2，DNS 设为 192.168.3.2 与 223.5.5.5
 */
export function connectGateway(gatewayIp = '192.168.3.2') {
  const iface = getActiveInterface();
  const alias = iface.alias || '以太网';
  const ip = iface.ip || '192.168.3.25';

  try {
    // 1. 设置网卡静态网关为旁路由 (保留当前 IP 与子网掩码不变)
    execSync(`netsh interface ip set address name="${alias}" static ${ip} 255.255.255.0 ${gatewayIp} 1`, { stdio: 'pipe' });

    // 2. 设置首选 DNS 为旁路由，备选 DNS 为公共 DNS 223.5.5.5
    execSync(`netsh interface ip set dns name="${alias}" static ${gatewayIp}`, { stdio: 'pipe' });
    try {
      execSync(`netsh interface ip add dns name="${alias}" 223.5.5.5 index=2`, { stdio: 'ignore' });
    } catch {}

    // 3. 刷新系统 DNS 缓存
    execSync('ipconfig /flushdns', { stdio: 'ignore' });
  } catch (err) {
    throw new Error(`切换网关与 DNS 失败(请确保以管理员权限运行): ${err.message}`);
  }

  return { ok: true, connected: true, gateway: gatewayIp, interface: alias, ip };
}

/**
 * 断开旁路由：一键恢复网卡为 DHCP 自动获取 IP 与自动获取 DNS (完全恢复主路由 192.168.3.1)
 */
export function disconnectGateway(gatewayIp = '192.168.3.2') {
  const iface = getActiveInterface();
  const alias = iface.alias || '以太网';

  try {
    // 1. 恢复网卡 IP 与网关为 DHCP 自动获取
    execSync(`netsh interface ip set address name="${alias}" source=dhcp`, { stdio: 'pipe' });

    // 2. 恢复网卡 DNS 为 DHCP 自动获取
    execSync(`netsh interface ip set dns name="${alias}" source=dhcp`, { stdio: 'pipe' });

    // 3. 清理可能残留的临时路由与刷新 DNS
    try { execSync(`route delete 0.0.0.0 mask 128.0.0.0 ${gatewayIp}`, { stdio: 'ignore' }); } catch {}
    try { execSync(`route delete 128.0.0.0 mask 128.0.0.0 ${gatewayIp}`, { stdio: 'ignore' }); } catch {}
    try { execSync(`route delete 0.0.0.0 ${gatewayIp}`, { stdio: 'ignore' }); } catch {}
    execSync('ipconfig /flushdns', { stdio: 'ignore' });
  } catch (err) {
    console.warn('恢复 DHCP 警告:', err.message);
  }

  return { ok: true, connected: false, gateway: gatewayIp };
}

/**
 * 测试到旁路由的 Ping 延迟
 */
export function testPing(gatewayIp = '192.168.3.2') {
  try {
    const out = execSync(`ping -n 1 -w 800 ${gatewayIp}`, { encoding: 'utf8' });
    const match = out.match(/time[=<](\d+)ms/i) || out.match(/时间[=<](\d+)ms/i);
    return match ? Number(match[1]) : 1;
  } catch {
    return null;
  }
}
