/**
 * 流量统计：保持一条到 sing-box Clash API /traffic 的 WebSocket，
 * 缓存最新上下行速率，面板轮询 /api/traffic 拿数据。
 */
import WebSocket from 'ws';
import { KERNEL } from './paths.mjs';
import { loadSettings } from './settings.mjs';

let ws = null;
let last = { up: 0, down: 0, at: 0 };
let totalUp = 0;
let totalDown = 0;
let lastSampleAt = 0;
let reconnectTimer = null;

function connect() {
  if (ws) return;
  try {
    const secret = loadSettings().kernel?.clashSecret;
    const url = `ws://${KERNEL.clashApiHost}:${KERNEL.clashApiPort}/traffic`;
    ws = new WebSocket(url, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    ws.on('message', (data) => {
      try {
        const j = JSON.parse(data.toString());
        const now = Date.now();
        // 累计总量：速率 × 时间间隔
        if (lastSampleAt) {
          const dt = (now - lastSampleAt) / 1000;
          totalUp += (j.up || 0) * dt;
          totalDown += (j.down || 0) * dt;
        }
        last = { up: j.up || 0, down: j.down || 0, at: now };
        lastSampleAt = now;
      } catch {}
    });
    ws.on('close', () => {
      ws = null;
      lastSampleAt = 0;
      scheduleReconnect();
    });
    ws.on('error', () => {
      try { ws.close(); } catch {}
    });
  } catch {
    ws = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

export function startTrafficMonitor() {
  connect();
}

export function getTraffic() {
  // 超过 10 秒没数据，认为断开了
  const stale = Date.now() - last.at > 10000;
  return {
    up: stale ? 0 : last.up,
    down: stale ? 0 : last.down,
    totalUp: Math.round(totalUp),
    totalDown: Math.round(totalDown),
    connected: !stale && !!ws,
  };
}

export function resetTrafficTotals() {
  totalUp = 0;
  totalDown = 0;
}
