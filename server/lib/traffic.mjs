/**
 * 流量统计：
 * 1. 优先通过 sing-box Clash API /traffic 的 WebSocket 获取实时速率；
 * 2. 支持 Node 20+ 原生 globalThis.WebSocket 与 ws 模块降级；
 * 3. 若 WebSocket 断开或无数据，自动启用 HTTP /connections 轮询及 Linux tun 网卡统计兜底；
 * 确保流量统计永不断流、永不失效。
 */
import fs from 'node:fs';
import { KERNEL } from './paths.mjs';
import { loadSettings } from './settings.mjs';

let WebSocket = globalThis.WebSocket || null;
if (!WebSocket) {
  try {
    const m = await import('ws');
    WebSocket = m.default || m.WebSocket;
  } catch {}
}

let ws = null;
let last = { up: 0, down: 0, at: 0 };
let totalUp = 0;
let totalDown = 0;
let lastSampleAt = 0;
let reconnectTimer = null;
let fallbackTimer = null;

// HTTP /connections 轮询记录
let lastConnTotals = null;
// Linux tun 网卡轮询记录
let lastTunTotals = null;

function connectWs() {
  if (ws || !WebSocket) return;
  try {
    const secret = loadSettings().kernel?.clashSecret || '';
    const query = secret ? `?token=${encodeURIComponent(secret)}` : '';
    const url = `ws://${KERNEL.clashApiHost}:${KERNEL.clashApiPort}/traffic${query}`;

    // Node 20 原生 WebSocket 和 ws 库传参稍有差异，做兼容
    const options = secret ? { headers: { Authorization: `Bearer ${secret}` } } : {};
    ws = new WebSocket(url, options);

    ws.onmessage = (event) => {
      handleWsData(event.data);
    };
    // 兼容 ws 库事件
    if (typeof ws.on === 'function') {
      ws.on('message', (data) => handleWsData(data));
      ws.on('close', () => onWsClose());
      ws.on('error', () => onWsError());
    } else {
      ws.onclose = () => onWsClose();
      ws.onerror = () => onWsError();
    }
  } catch {
    ws = null;
    scheduleReconnect();
  }
}

function handleWsData(raw) {
  try {
    const j = JSON.parse(raw.toString ? raw.toString() : raw);
    const now = Date.now();
    const up = Number(j.up) || 0;
    const down = Number(j.down) || 0;
    if (lastSampleAt) {
      const dt = (now - lastSampleAt) / 1000;
      if (dt > 0 && dt < 10) {
        totalUp += up * dt;
        totalDown += down * dt;
      }
    }
    last = { up, down, at: now };
    lastSampleAt = now;
  } catch {}
}

function onWsClose() {
  ws = null;
  lastSampleAt = 0;
  scheduleReconnect();
}

function onWsError() {
  try {
    if (ws) ws.close();
  } catch {}
  ws = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, 4000);
}

/**
 * 轮询兜底逻辑：
 * 当 WebSocket 超过 2.5 秒未收到消息时，通过 HTTP /connections 接口或 tun 网卡提取速率。
 */
async function pollFallback() {
  const now = Date.now();
  // 如果 WebSocket 正在活跃推送，不需要兜底
  if (last.at && (now - last.at) < 2500) return;

  const settings = loadSettings();
  const secret = settings.kernel?.clashSecret || '';

  // 1. 尝试从 Clash API /connections 读取累计上传/下载
  try {
    const res = await fetch(`http://${KERNEL.clashApiHost}:${KERNEL.clashApiPort}/connections`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(1200),
    });
    if (res.ok) {
      const data = await res.json();
      const upTot = Number(data?.uploadTotal) || 0;
      const downTot = Number(data?.downloadTotal) || 0;

      if (lastConnTotals) {
        const dt = (now - lastConnTotals.at) / 1000;
        if (dt > 0) {
          const calcUp = Math.max(0, (upTot - lastConnTotals.up) / dt);
          const calcDown = Math.max(0, (downTot - lastConnTotals.down) / dt);
          totalUp = upTot;
          totalDown = downTot;
          last = { up: Math.round(calcUp), down: Math.round(calcDown), at: now };
          return;
        }
      }
      lastConnTotals = { up: upTot, down: downTot, at: now };
      if (!totalUp && upTot) totalUp = upTot;
      if (!totalDown && downTot) totalDown = downTot;
      return;
    }
  } catch {}

  // 2. 尝试从 Linux tun 网卡 /proc/net/dev 读取
  if (process.platform === 'linux') {
    try {
      const devContent = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = devContent.split('\n');
      for (const line of lines) {
        if (line.includes(KERNEL.tunName) || line.includes('tun') || line.includes('mybox')) {
          const parts = line.trim().split(/\s+/);
          const rxBytes = Number(parts[1]) || 0;
          const txBytes = Number(parts[9]) || 0;
          if (lastTunTotals && Number.isFinite(lastTunTotals.rx) && Number.isFinite(lastTunTotals.tx)) {
            const dt = (now - lastTunTotals.at) / 1000;
            if (dt > 0) {
              const diffDown = Math.max(0, rxBytes - lastTunTotals.rx);
              const diffUp = Math.max(0, txBytes - lastTunTotals.tx);
              const calcDown = diffDown / dt;
              const calcUp = diffUp / dt;
              totalDown += diffDown;
              totalUp += diffUp;
              last = { up: Math.round(calcUp), down: Math.round(calcDown), at: now };
            }
          }
          lastTunTotals = { rx: rxBytes, tx: txBytes, at: now };
          return;
        }
      }
    } catch {}
  }
}

export function startTrafficMonitor() {
  connectWs();
  if (!fallbackTimer) {
    fallbackTimer = setInterval(pollFallback, 1500);
  }
}

export function getTraffic() {
  const stale = Date.now() - last.at > 6000;
  return {
    up: stale ? 0 : last.up,
    down: stale ? 0 : last.down,
    totalUp: Number.isFinite(totalUp) ? Math.round(totalUp) : 0,
    totalDown: Number.isFinite(totalDown) ? Math.round(totalDown) : 0,
    connected: !stale,
  };
}

export function resetTrafficTotals() {
  totalUp = 0;
  totalDown = 0;
  lastConnTotals = null;
  lastTunTotals = null;
}
