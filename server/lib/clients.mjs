import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, KERNEL } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { loadSettings } from './settings.mjs';

const execAsync = promisify(exec);
export const CLIENTS_PATH = path.join(DATA_DIR, 'clients.json');

/**
 * 读取已保存的内网设备列表
 */
export function loadSavedClients() {
  const list = readJson(CLIENTS_PATH, null);
  if (Array.isArray(list)) return list;
  return [];
}

/**
 * 保存内网设备列表
 */
export function saveClients(list) {
  writeJsonAtomic(CLIENTS_PATH, Array.isArray(list) ? list : []);
}

/**
 * 判断是否属于合法的内网 IPv4
 */
function isPrivateIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  // 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12
  if (/^192\.168\.\d+\.\d+$/.test(ip)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ip)) return true;
  return false;
}

/**
 * 深度扫描当前局域网在线设备（DHCP 租约 + ARP 表 + ip neigh + 实时活动连接）
 */
export async function scanLocalNetworkClients() {
  const foundMap = new Map(); // ip -> { ip, mac, hostname, source }

  // 1. 扫描 OpenWrt / iStoreOS / Linux DHCP 租约文件
  const leaseFiles = [
    '/tmp/dhcp.leases',
    '/tmp/dnsmasq.leases',
    '/var/dhcp.leases',
    '/var/lib/misc/dnsmasq.leases',
    '/etc/dnsmasq.leases',
  ];
  for (const fp of leaseFiles) {
    try {
      if (fs.existsSync(fp)) {
        const text = fs.readFileSync(fp, 'utf8');
        for (const line of text.split('\n')) {
          const parts = line.trim().split(/\s+/);
          // 常见格式: <timestamp> <mac> <ip> <hostname> <client-id>
          if (parts.length >= 3) {
            const mac = parts[1]?.toLowerCase();
            const ip = parts[2];
            const host = parts[3] && parts[3] !== '*' ? parts[3] : '';
            if (isPrivateIpv4(ip)) {
              foundMap.set(ip, {
                ip,
                mac: mac || '',
                hostname: host || '',
                source: 'dhcp',
              });
            }
          }
        }
      }
    } catch {}
  }

  // 2. 扫描 /proc/net/arp 表
  try {
    if (fs.existsSync('/proc/net/arp')) {
      const arpText = fs.readFileSync('/proc/net/arp', 'utf8');
      const lines = arpText.split('\n');
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length >= 4) {
          const ip = parts[0];
          const flags = parts[2];
          const mac = parts[3]?.toLowerCase();
          // flags != '0x0' 表示设备在线活跃
          if (flags !== '0x0' && mac && mac !== '00:00:00:00:00:00') {
            if (isPrivateIpv4(ip)) {
              if (foundMap.has(ip)) {
                const item = foundMap.get(ip);
                if (!item.mac) item.mac = mac;
              } else {
                foundMap.set(ip, {
                  ip,
                  mac,
                  hostname: '',
                  source: 'arp',
                });
              }
            }
          }
        }
      }
    }
  } catch {}

  // 3. 执行 ip neigh show 辅助扫描
  try {
    const { stdout } = await execAsync('ip neigh show 2>/dev/null || true');
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const ip = parts[0];
        const macIdx = parts.indexOf('lladdr');
        const mac = macIdx !== -1 ? parts[macIdx + 1]?.toLowerCase() : '';
        const state = parts[parts.length - 1];
        if (state !== 'FAILED' && isPrivateIpv4(ip)) {
          if (foundMap.has(ip)) {
            const item = foundMap.get(ip);
            if (!item.mac && mac) item.mac = mac;
          } else {
            foundMap.set(ip, {
              ip,
              mac: mac || '',
              hostname: '',
              source: 'ip-neigh',
            });
          }
        }
      }
    }
  } catch {}

  // 4. 从 sing-box Clash 实时连接中查找源 IP
  try {
    const secret = loadSettings().kernel?.clashSecret || '';
    const res = await fetch(`http://${KERNEL.clashApiHost}:${KERNEL.clashApiPort}/connections`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const cData = await res.json();
      const conns = cData?.connections || [];
      for (const c of conns) {
        const src = c.metadata?.sourceIP;
        if (isPrivateIpv4(src) && src !== '127.0.0.1') {
          if (!foundMap.has(src)) {
            foundMap.set(src, {
              ip: src,
              mac: '',
              hostname: '',
              source: 'active-conn',
            });
          }
        }
      }
    }
  } catch {}

  // 合并到已保存的客户端规则列表
  const existing = loadSavedClients();
  const existingMap = new Map(existing.map((item) => [item.ip, item]));

  const result = [...existing];

  for (const [ip, info] of foundMap.entries()) {
    if (existingMap.has(ip)) {
      // 已存在：补充 MAC 或主机名，标记在线
      const item = existingMap.get(ip);
      if (!item.mac && info.mac) item.mac = info.mac;
      if (!item.name && info.hostname) item.name = info.hostname;
      item.online = true;
    } else {
      // 新发现设备：加入列表
      const newClient = {
        id: crypto.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: info.hostname || `设备 ${ip}`,
        ip,
        mac: info.mac || '',
        mode: 'rule', // 默认规则分流
        note: info.source === 'dhcp' ? 'DHCP 分配' : '局域网在线设备',
        online: true,
      };
      existingMap.set(ip, newClient);
      result.push(newClient);
    }
  }

  // 按 IP 末段升序排序
  result.sort((a, b) => {
    const aLast = Number(String(a.ip || '').split('.').pop()) || 0;
    const bLast = Number(String(b.ip || '').split('.').pop()) || 0;
    return aLast - bLast;
  });

  saveClients(result);
  return result;
}
