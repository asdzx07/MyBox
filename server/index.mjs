import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT, PANEL_DIR, DATA_DIR, DEFAULT_PANEL_PORT, PORT_FILE, KERNEL, RESERVED_PORTS,
} from './lib/paths.mjs';
import { createLogger } from './lib/log.mjs';
import { ensureDirs } from './lib/fsx.mjs';
import { loadSettings, saveSettings, mutateSettings, newId } from './lib/settings.mjs';
import {
  isPasswordSet, setPassword, verifyPassword, issueToken, clearSessionCookie,
  setSessionCookie, authMiddleware, isAuthed,
} from './lib/auth.mjs';
import { parseSubscription, dedupeTags } from './lib/subscription.mjs';
import * as kernel from './lib/kernel.mjs';
import * as deploy from './lib/deploy.mjs';
import * as netstack from './lib/netstack.mjs';
import * as platform from './lib/platform.mjs';
import { flipTag } from './lib/flip.mjs';

const log = createLogger('panel');
const here = path.dirname(fileURLToPath(import.meta.url));

ensureDirs();
platform.logPlatform();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

/* ------------------------------------------------------------ 静态资源 */

app.use(express.static(path.join(here, '..', 'panel'), { index: 'index.html' }));

/* --------------------------------------------------------------- 公开 */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, root: ROOT, dbPath: path.join(DATA_DIR, 'settings.json') });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ enabled: true, authenticated: isAuthed(req), passwordSet: isPasswordSet() });
});

app.post('/api/auth/setup', (req, res) => {
  if (isPasswordSet()) return res.status(409).json({ error: '面板密码已设置' });
  try {
    setPassword(req.body?.password);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  setSessionCookie(res, issueToken());
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  if (!isPasswordSet()) return res.status(409).json({ error: '还没有设置面板密码' });
  if (!verifyPassword(req.body?.password)) {
    log.warn('登录失败，来自 %s', req.ip);
    return res.status(401).json({ error: '密码错误' });
  }
  setSessionCookie(res, issueToken());
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* --------------------------------------------------------------- 鉴权 */

app.use(authMiddleware);

app.get('/api/auth/me', (req, res) => res.json({ authenticated: true }));

app.post('/api/auth/change-password', (req, res) => {
  if (!verifyPassword(req.body?.current)) return res.status(401).json({ error: '当前密码错误' });
  try {
    setPassword(req.body?.next);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ ok: true });
});

/* -------------------------------------------------------------- 概览 */

app.get('/api/overview', async (req, res) => {
  const settings = loadSettings();
  const k = await kernel.status();
  res.json({
    kernel: { ...k, versionOutput: await kernel.versionOutput() },
    dnsmasq: await netstack.dnsmasqStatus(),
    platform: platform.describe(),
    counts: {
      subscriptions: settings.subscriptions.length,
      nodes: settings.nodes.length,
      groups: settings.groups.filter((g) => g.enabled).length,
      policies: settings.policies.length,
      policiesEnabled: settings.policies.filter((p) => p.enabled).length,
    },
    meta: settings.meta,
    node: process.version,
  });
});

/* ------------------------------------------------------------ 设置读写 */

function sanitize(settings) {
  const { panel, ...rest } = settings;
  return { ...rest, panel: { passwordSet: Boolean(panel.passwordHash) } };
}

app.get('/api/settings', (req, res) => res.json(sanitize(loadSettings({ force: true }))));

app.put('/api/settings', (req, res) => {
  const incoming = req.body || {};
  const current = loadSettings({ force: true });
  // 只接受已知的顶层区块，防止把任意字段写进配置
  for (const key of ['kernel', 'network', 'dns', 'meta']) {
    if (incoming[key] && typeof incoming[key] === 'object') {
      current[key] = { ...current[key], ...incoming[key] };
    }
  }
  saveSettings(current);
  res.json(sanitize(current));
});

/* --------------------------------------------------------------- 订阅 */

app.get('/api/subscriptions', (req, res) => {
  const { subscriptions, nodes } = loadSettings({ force: true });
  res.json({
    subscriptions: subscriptions.map((s) => ({
      ...s,
      nodeCount: nodes.filter((n) => n.__subscriptionId === s.id).length,
    })),
    totalNodes: nodes.length,
  });
});

app.post('/api/subscriptions', async (req, res) => {
  const { name, url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: '请填写 http(s) 订阅地址' });

  const id = newId('sub');
  mutateSettings((s) => {
    s.subscriptions.push({ id, name: name || `订阅 ${s.subscriptions.length + 1}`, url, enabled: true, addedAt: Date.now() });
  });
  try {
    const result = await refreshSubscription(id);
    res.json({ id, ...result });
  } catch (err) {
    res.status(502).json({ id, error: `订阅已保存，但拉取失败：${err.message}` });
  }
});

app.delete('/api/subscriptions/:id', (req, res) => {
  mutateSettings((s) => {
    s.subscriptions = s.subscriptions.filter((x) => x.id !== req.params.id);
    s.nodes = s.nodes.filter((n) => n.__subscriptionId !== req.params.id);
  });
  res.json({ ok: true });
});

app.post('/api/subscriptions/:id/refresh', async (req, res) => {
  try {
    res.json(await refreshSubscription(req.params.id));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

async function refreshSubscription(id) {
  const settings = loadSettings({ force: true });
  const sub = settings.subscriptions.find((s) => s.id === id);
  if (!sub) throw new Error('订阅不存在');

  const res = await fetch(sub.url, { headers: { 'User-Agent': 'mybox/0.1' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();

  const { format, nodes } = parseSubscription(text);
  const tagged = dedupeTags(nodes.map((n) => ({ ...n, __subscriptionId: id })));

  mutateSettings((s) => {
    s.nodes = [...s.nodes.filter((n) => n.__subscriptionId !== id), ...tagged];
    const target = s.subscriptions.find((x) => x.id === id);
    if (target) {
      target.format = format;
      target.nodeCount = tagged.length;
      target.updatedAt = Date.now();
    }
  });

  return { format, nodeCount: tagged.length, sample: tagged.slice(0, 8).map((n) => n.tag) };
}

app.get('/api/nodes', (req, res) => {
  const { nodes } = loadSettings({ force: true });
  res.json({
    nodes: nodes.map(({ __subscriptionId, ...rest }) => ({ ...rest, subscriptionId: __subscriptionId })),
  });
});

/* --------------------------------------------------------------- 分组 */

app.get('/api/groups', (req, res) => {
  const { groups, nodes } = loadSettings({ force: true });
  res.json({ groups, availableNodes: nodes.map((n) => n.tag) });
});

app.put('/api/groups', (req, res) => {
  const list = req.body?.groups;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'groups 必须是数组' });
  const clean = list.map((g) => ({
    id: String(g.id || newId('grp')),
    name: String(g.name || '未命名').trim(),
    type: g.type === 'urltest' ? 'urltest' : 'selector',
    enabled: g.enabled !== false,
    mode: g.mode === 'dynamic' ? 'dynamic' : 'static',
    members: Array.isArray(g.members) ? g.members.map(String) : [],
    keywords: Array.isArray(g.keywords) ? g.keywords.map(String) : [],
    interval: g.interval || '300s',
    tolerance: Number(g.tolerance) || 100,
    idleTimeout: g.idleTimeout || '12h',
    default: g.default ? String(g.default) : undefined,
  }));
  if (clean.some((g) => !g.name)) return res.status(400).json({ error: '分组名不能为空' });
  mutateSettings((s) => {
    s.groups = clean;
  });
  res.json({ ok: true, groups: clean });
});

/* --------------------------------------------------------------- 策略 */

app.get('/api/policies', (req, res) => {
  const { policies, groups } = loadSettings({ force: true });
  res.json({
    policies: policies.map((p) => ({ ...p, flipTag: flipTag(p.id) })),
    targets: [
      { value: 'builtin-direct', label: '直连' },
      { value: 'builtin-block', label: '拒绝' },
      ...groups.filter((g) => g.enabled).map((g) => ({ value: g.name, label: g.name })),
    ],
  });
});

app.put('/api/policies', (req, res) => {
  const list = req.body?.policies;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'policies 必须是数组' });
  const clean = list.map((p) => ({
    id: String(p.id || newId('pol')),
    name: String(p.name || '未命名').trim(),
    enabled: p.enabled !== false,
    rulesets: Array.isArray(p.rulesets) ? p.rulesets.map(String) : [],
    domain: Array.isArray(p.domain) ? p.domain.map(String) : [],
    domainSuffix: Array.isArray(p.domainSuffix) ? p.domainSuffix.map(String) : [],
    ipCidr: Array.isArray(p.ipCidr) ? p.ipCidr.map(String) : [],
    target: String(p.target || 'builtin-direct'),
  }));
  if (clean.some((p) => !p.name)) return res.status(400).json({ error: '策略名不能为空' });
  mutateSettings((s) => {
    s.policies = clean;
  });
  res.json({ ok: true, policies: clean });
});

/** 单独切换一个策略的开关——只改那个小文件，不重新部署、不重启内核。 */
app.post('/api/policies/:id/toggle', (req, res) => {
  const enabled = req.body?.enabled !== false;
  const result = deploy.togglePolicy(req.params.id, enabled);
  res.json({ ok: true, ...result });
});

/* -------------------------------------------------------------- 部署 */

app.post('/api/deploy', async (req, res) => {
  try {
    const report = await deploy.deploy({ restart: req.body?.restart !== false });
    res.json(report);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/teardown', async (req, res) => {
  try {
    res.json(await deploy.teardown());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------------- 内核 */

app.post('/api/kernel/:action', async (req, res) => {
  const { action } = req.params;
  try {
    if (action === 'start') return res.json(await kernel.start());
    if (action === 'stop') return res.json(await kernel.stop());
    if (action === 'restart') return res.json(await kernel.restart());
    if (action === 'install') {
      const version = req.body?.version;
      if (!version) return res.status(400).json({ error: '缺少 version' });
      const info = await kernel.installKernel(version, { onProgress: (m) => log.info('%s', m) });
      return res.json(info);
    }
    return res.status(400).json({ error: '未知操作' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/kernel/log', (req, res) => {
  res.json({ log: kernel.tailLog(Number(req.query.lines) || 200) });
});

app.get('/api/kernel/latest', async (req, res) => {
  try {
    res.json(await kernel.fetchLatestVersion());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------- 内核 Clash API 反向代理 */

app.use('/api/controller', async (req, res) => {
  const settings = loadSettings();
  const suffix = req.url && req.url !== '/' ? req.url : '/';
  const url = `http://${KERNEL.clashApiHost}:${KERNEL.clashApiPort}${suffix}`;
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(settings.kernel.clashSecret ? { Authorization: `Bearer ${settings.kernel.clashSecret}` } : {}),
      },
      ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: JSON.stringify(req.body ?? {}) }),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text || '{}');
  } catch (err) {
    res.status(502).json({ error: `内核未运行或不可达：${err.message}` });
  }
});

/* ------------------------------------------------------------ 错误兜底 */

app.use((err, req, res, _next) => {
  log.error('%s', err.message);
  res.status(500).json({ error: err.message });
});

/* -------------------------------------------------------------- 启动 */

function resolvePort() {
  const envPort = Number.parseInt(process.env.MYBOX_PORT || '', 10);
  if (Number.isFinite(envPort)) return envPort;
  const saved = Number.parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
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
});

function shutdown(signal) {
  log.info('收到 %s，正在退出', signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
