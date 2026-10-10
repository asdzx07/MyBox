import fs from 'node:fs';
import {
  DEFAULT_PANEL_PORT, PORT_FILE, RESERVED_PORTS,
} from './lib/paths.mjs';
import { createLogger } from './lib/log.mjs';
import { ensureDirs } from './lib/fsx.mjs';
import { loadSettings } from './lib/settings.mjs';
import { isPasswordSet } from './lib/auth.mjs';
import { startTrafficMonitor } from './lib/traffic.mjs';
import * as kernel from './lib/kernel.mjs';
import * as deploy from './lib/deploy.mjs';
import * as netstack from './lib/netstack.mjs';
import * as platform from './lib/platform.mjs';
import { createApp } from './app.mjs';

const log = createLogger('panel');

ensureDirs();
platform.logPlatform();

const app = createApp();

function resolvePort() {
  const envPort = Number.parseInt(process.env.MYBOX_PORT || '', 10);
  if (Number.isFinite(envPort)) return envPort;
  let saved = null;
  try {
    if (fs.existsSync(PORT_FILE)) saved = Number.parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
  } catch {}
  return Number.isFinite(saved) ? saved : DEFAULT_PANEL_PORT;
}

function portProblem(port) {
  if (RESERVED_PORTS.includes(port)) return `端口 ${port} 被内核或系统占用`;
  if (port < 1 || port > 65535) return '端口超出范围';
  return null;
}

const port = resolvePort();
const problem = portProblem(port);
if (problem) {
  log.error('%s（可用 MYBOX_PORT 指定其它端口）', problem);
  process.exit(1);
}

const server = app.listen(port, '0.0.0.0', () => {
  log.info('MyBox 面板已启动：http://0.0.0.0:%d', port);
  if (!isPasswordSet()) log.warn('还没有设置面板密码，请打开面板完成初始化');
  startTrafficMonitor();
});

/**
 * 内核看门狗。
 * dnsmasq 被接管后一直指着内核的 DNS 端口。内核一旦不在，整个局域网就查不到域名——
 * 这比「代理没生效」严重得多。所以内核连续一段时间没响应，就把 dnsmasq 还给系统。
 */
let kernelDownSince = null;
let lastReapplyAt = 0;
const WATCH_INTERVAL = 10000;
const DOWN_GRACE_MS = 20000;
const REAPPLY_COOLDOWN_MS = 60000;

const watchdog = setInterval(async () => {
  try {
    // 部署期间内核本来就会短暂停一下，别插手
    if (deploy.isDeploying()) {
      kernelDownSince = null;
      return;
    }

    if (await kernel.isResponding()) {
      kernelDownSince = null;
      // 内核活着，但 dnsmasq 没指过来（升级重启、别人改过配置等）→ 补上。
      // 冷却 60 秒，避免 dnsmasq 起不来时每 10 秒撞一次。
      const settings = loadSettings();
      if (settings.dns.mode === 'dnsmasq' && Date.now() - lastReapplyAt > REAPPLY_COOLDOWN_MS) {
        const dns = await netstack.dnsmasqStatus();
        if (!dns.takenOver) {
          lastReapplyAt = Date.now();
          try {
            await netstack.applyDnsmasq({ dnsPort: settings.dns.hijackPort });
            log.info('检测到 dnsmasq 未被接管，已自动接管');
          } catch (err) {
            log.warn('自动接管 dnsmasq 失败：%s', err.message);
          }
        }
      }
      return;
    }

    const status = await kernel.status();
    if (!status.installed) {
      kernelDownSince = null;
      return;
    }
    if (!kernelDownSince) {
      kernelDownSince = Date.now();
      return;
    }
    if (Date.now() - kernelDownSince < DOWN_GRACE_MS) return;

    const dns = await netstack.dnsmasqStatus();
    if (dns.takenOver) {
      log.warn('内核已停止超过 %d 秒，把 dnsmasq 还给系统，避免全 LAN 无法解析', DOWN_GRACE_MS / 1000);
      await netstack.restoreDnsmasq();
      lastReapplyAt = Date.now();
    }
    kernelDownSince = null;
  } catch (err) {
    log.debug('看门狗检查失败：%s', err.message);
  }
}, WATCH_INTERVAL);
watchdog.unref?.();

function shutdown(signal) {
  log.info('收到 %s，正在退出', signal);
  clearInterval(watchdog);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
