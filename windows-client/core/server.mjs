import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getActiveInterface, isConnectedToGateway, connectGateway, disconnectGateway, testPing
} from './network.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, '../ui');
const CONFIG_FILE = path.resolve(__dirname, '../config.json');

// 默认配置
let config = {
  gatewayIp: '192.168.3.2',
  gatewayPort: 3036,
  password: '',
  sessionCookie: '',
  autoConnect: true,
};

try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  }
} catch {}

function saveConfig(next) {
  config = { ...config, ...next };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch {}
}

async function loginRemoteGateway(password = config.password) {
  if (!password) return false;
  return new Promise((resolve) => {
    const postData = JSON.stringify({ password });
    const req = http.request(`http://${config.gatewayIp}:${config.gatewayPort}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 4000,
    }, (res) => {
      const setCookies = res.headers['set-cookie'];
      if (setCookies) {
        const found = setCookies.find(c => c.includes('mybox_session='));
        if (found) {
          const cookieVal = found.split(';')[0].trim();
          config.sessionCookie = cookieVal;
          saveConfig({ sessionCookie: cookieVal });
          console.log('[MyBox Windows Companion] 旁路由登录成功，已获取会话 Cookie');
          resolve(true);
          return;
        }
      }
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.write(postData);
    req.end();
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  // 1. 本地状态与控制 API
  if (pathname === '/api/local/status' && req.method === 'GET') {
    const iface = getActiveInterface();
    const connected = isConnectedToGateway(config.gatewayIp);
    const latency = testPing(config.gatewayIp);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      connected,
      gatewayIp: config.gatewayIp,
      gatewayPort: config.gatewayPort,
      autoConnect: config.autoConnect,
      hasPassword: Boolean(config.password),
      latency,
      interface: iface,
    }));
    return;
  }

  if (pathname === '/api/local/connect' && req.method === 'POST') {
    try {
      const result = connectGateway(config.gatewayIp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/local/disconnect' && req.method === 'POST') {
    try {
      const result = disconnectGateway(config.gatewayIp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/local/config' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        saveConfig(body);
        if (body.password) {
          await loginRemoteGateway(body.password);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, config }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/local/exit' && req.method === 'POST') {
    try {
      disconnectGateway(config.gatewayIp);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: '网络已还原，服务即将退出' }));
    setTimeout(() => {
      console.log('[MyBox Windows Companion] 收到退出请求，进程正在退出...');
      process.exit(0);
    }, 400);
    return;
  }

  // 2. 远程 API 代理转发 (到旁路由 192.168.3.2:3036)
  if (pathname.startsWith('/remote-api/')) {
    const targetPath = pathname.replace(/^\/remote-api/, '/api');
    const targetUrl = `http://${config.gatewayIp}:${config.gatewayPort}${targetPath}${urlObj.search}`;

    const proxyHeaders = { ...req.headers };
    delete proxyHeaders['host'];
    proxyHeaders['host'] = `${config.gatewayIp}:${config.gatewayPort}`;

    // 自动补齐已记录的旁路由 Session Cookie
    if (!proxyHeaders['cookie'] && config.sessionCookie) {
      proxyHeaders['cookie'] = config.sessionCookie;
    }

    const proxyReq = http.request(targetUrl, {
      method: req.method,
      headers: proxyHeaders,
      timeout: 8000,
    }, (proxyRes) => {
      // 记录旁路由返回的 Session Cookie
      const setCookies = proxyRes.headers['set-cookie'];
      if (setCookies) {
        const found = setCookies.find(c => c.includes('mybox_session='));
        if (found) {
          config.sessionCookie = found.split(';')[0].trim();
          saveConfig({ sessionCookie: config.sessionCookie });
        }
      }

      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `连接旁路由失败 (${err.message})` }));
    });

    req.pipe(proxyReq);
    return;
  }

  // 3. 静态 UI 文件
  let filePath = path.join(UI_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(UI_DIR, 'index.html');
  }

  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
});

const PORT = 3038;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[MyBox Windows Companion] 服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`[MyBox Windows Companion] 旁路由目标: http://${config.gatewayIp}:${config.gatewayPort}`);

  // 若配置了自动连接旁路由，在启动时自动生效
  if (config.autoConnect) {
    try {
      if (!isConnectedToGateway(config.gatewayIp)) {
        console.log(`[MyBox Windows Companion] 正在自动连接旁路由 (${config.gatewayIp})...`);
        connectGateway(config.gatewayIp);
        console.log(`[MyBox Windows Companion] 旁路由连接成功！Windows 流量已由 MyBox 接管。`);
      } else {
        console.log(`[MyBox Windows Companion] 当前已处于旁路由接管状态。`);
      }
    } catch (err) {
      console.warn(`[MyBox Windows Companion] 自动连接旁路由失败 (可能需要管理员权限):`, err.message);
    }
  }

  // 若已配置密码，自动登录并同步会话
  if (config.password) {
    loginRemoteGateway().catch(() => {});
  }
});

// 优雅关机清理
function cleanupAndExit() {
  console.log('\n[MyBox Windows Companion] 正在退出，清理临时路由并恢复网络...');
  try {
    disconnectGateway(config.gatewayIp);
  } catch {}
  process.exit(0);
}

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);
