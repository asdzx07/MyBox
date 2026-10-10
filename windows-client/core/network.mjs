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
 * 检查当前是否已通过旁路由接管路由
 */
export function isConnectedToGateway(gatewayIp = '192.168.3.2') {
  try {
    const out = execSync(`route print 0.0.0.0`, { encoding: 'utf8' });
    return out.includes(gatewayIp);
  } catch {
    return false;
  }
}

/**
 * 连接旁路由：使用工业级双 /1 路由(0.0.0.0/1 + 128.0.0.0/1)最长前缀匹配接管全量流量，并将 DNS 指向旁路由
 */
export function connectGateway(gatewayIp = '192.168.3.2') {
  const iface = getActiveInterface();
  const ifIndex = iface.index || 19;

  // 1. 先安全清理旧的可能存在的该网关路由
  try { execSync(`route delete 0.0.0.0 mask 128.0.0.0 ${gatewayIp}`, { stdio: 'ignore' }); } catch {}
  try { execSync(`route delete 128.0.0.0 mask 128.0.0.0 ${gatewayIp}`, { stdio: 'ignore' }); } catch {}
  try { execSync(`route delete 0.0.0.0 ${gatewayIp}`, { stdio: 'ignore' }); } catch {}

  // 2. 添加最长前缀匹配的双 /1 路由，严格且必定优先于主路由 0.0.0.0/0
  try {
    execSync(`route add 0.0.0.0 mask 128.0.0.0 ${gatewayIp} metric 1 if ${ifIndex}`, { stdio: 'pipe' });
    execSync(`route add 128.0.0.0 mask 128.0.0.0 ${gatewayIp} metric 1 if ${ifIndex}`, { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`添加接管路由失败(请确保以管理员身份运行): ${err.message}`);
  }

  // 3. 将 DNS 切换为旁路由 IP 并清空缓存
  try {
    const dnsCmd = `Set-DnsClientServerAddress -InterfaceIndex ${ifIndex} -ServerAddresses ("${gatewayIp}")`;
    execSync(`powershell -NoProfile -Command "${dnsCmd}"`, { stdio: 'pipe' });
    execSync('ipconfig /flushdns', { stdio: 'ignore' });
  } catch (err) {
    console.warn('DNS 设置警告:', err.message);
  }

  return { ok: true, connected: true, gateway: gatewayIp, interface: iface.alias || ifIndex };
}

/**
 * 断开旁路由：删除双 /1 路由并将 DNS 恢复为 DHCP 自动获取
 */
export function disconnectGateway(gatewayIp = '192.168.3.2') {
  const iface = getActiveInterface();
  const ifIndex = iface.index || 19;

  // 1. 删除双 /1 临时路由及 /0 路由
  try { execSync(`route delete 0.0.0.0 mask 128.0.0.0 ${gatewayIp}`, { stdio: 'ignore' }); } catch {}
  try { execSync(`route delete 128.0.0.0 mask 128.0.0.0 ${gatewayIp}`, { stdio: 'ignore' }); } catch {}
  try { execSync(`route delete 0.0.0.0 ${gatewayIp}`, { stdio: 'ignore' }); } catch {}

  // 2. 恢复 DNS 为自动获取 (DHCP)
  try {
    const dnsCmd = `Set-DnsClientServerAddress -InterfaceIndex ${ifIndex} -ResetServerAddresses`;
    execSync(`powershell -NoProfile -Command "${dnsCmd}"`, { stdio: 'pipe' });
    execSync('ipconfig /flushdns', { stdio: 'ignore' });
  } catch (err) {
    console.warn('恢复 DNS 警告:', err.message);
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
