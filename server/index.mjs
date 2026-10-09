import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, DATA_DIR, DEFAULT_PANEL_PORT, PORT_FILE, KERNEL, RESERVED_PORTS,
} from './lib/paths.mjs';
import { createLogger } from './lib/log.mjs';
import { ensureDirs } from './lib/fsx.mjs';
import { loadSettings, saveSettings, mutateSettings, newId, DEFAULT_POLICIES } from './lib/settings.mjs';
import {
  isPasswordSet, setPassword, verifyPassword, issueToken, clearSessionCookie,
  setSessionCookie, authMiddleware, isAuthed,
} from './lib/auth.mjs';
import { parseSubscription, dedupeTags } from './lib/subscription.mjs';
import * as kernel from './lib/kernel.mjs';
import { startTrafficMonitor, getTraffic, resetTrafficTotals } from './lib/traffic.mjs';
import * as deploy from './lib/deploy.mjs';
import * as netstack from './lib/netstack.mjs';
import * as platform from './lib/platform.mjs';
import { flipTag } from './lib/flip.mjs';
import { loadSavedClients, saveClients, scanLocalNetworkClients } from './lib/clients.mjs';

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

app.get('/api/settings', async (req, res) => {
  const data = sanitize(loadSettings({ force: true }));
  // 版本以磁盘上的实际内核为准，不看 settings 里那份（可能是安装脚本装的、没记进来）
  data.kernel = { ...data.kernel, version: await kernel.installedVersion(), installed: kernel.installed() };
  res.json(data);
});

app.put('/api/settings', (req, res) => {
  const incoming = req.body || {};
  const current = loadSettings({ force: true });
  // 接受已知的顶层区块，防止把任意字段写进配置
  for (const key of ['kernel', 'network', 'dns', 'meta']) {
    if (incoming[key] && typeof incoming[key] === 'object') {
      current[key] = { ...current[key], ...incoming[key] };
    }
  }
  // 兼容直接通过 settings 接口保存 groups
  if (Array.isArray(incoming.groups)) {
    current.groups = incoming.groups.map((g) => ({
      id: String(g.id || newId('grp')),
      name: String(g.name || '未命名').trim(),
      type: String(g.type || 'selector').toLowerCase() === 'urltest' ? 'urltest' : 'selector',
      enabled: g.enabled !== false,
      mode: g.mode === 'dynamic' ? 'dynamic' : 'static',
      members: Array.isArray(g.members) ? g.members.map(String) : [],
      keywords: Array.isArray(g.keywords) ? g.keywords.map(String) : [],
      interval: g.interval || '300s',
      tolerance: Number(g.tolerance) || 100,
      idleTimeout: g.idleTimeout || '12h',
      default: g.default ? String(g.default) : undefined,
    }));
  }
  // 兼容直接通过 settings 接口保存 policies
  if (Array.isArray(incoming.policies)) {
    current.policies = incoming.policies.map((p) => {
      let tgt = String(p.target || 'builtin-direct');
      if (tgt === 'direct') tgt = 'builtin-direct';
      if (tgt === 'block') tgt = 'builtin-block';
      return {
        id: String(p.id || newId('pol')),
        name: String(p.name || '未命名').trim(),
        enabled: p.enabled !== false,
        rulesets: Array.isArray(p.rulesets) ? p.rulesets.map(String) : [],
        domain: Array.isArray(p.domain) ? p.domain.map(String) : [],
        domainSuffix: Array.isArray(p.domainSuffix) ? p.domainSuffix.map(String) : [],
        ipCidr: Array.isArray(p.ipCidr) ? p.ipCidr.map(String) : [],
        target: tgt,
      };
    });
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

/** 启用 / 停用一条订阅。停用后它的节点不进配置，要重新部署才生效。 */
app.put('/api/subscriptions/:id', (req, res) => {
  const enabled = req.body?.enabled !== false;
  let found = false;
  mutateSettings((s) => {
    const sub = s.subscriptions.find((x) => x.id === req.params.id);
    if (sub) {
      sub.enabled = enabled;
      found = true;
    }
  });
  if (!found) return res.status(404).json({ error: '订阅不存在' });
  log.info('订阅 %s 已%s', req.params.id, enabled ? '启用' : '停用');
  res.json({ ok: true, id: req.params.id, enabled });
});

app.delete('/api/subscriptions/:id', (req, res) => {
  mutateSettings((s) => {
    s.subscriptions = s.subscriptions.filter((x) => x.id !== req.params.id);
    s.nodes = s.nodes.filter((n) => n.__subscriptionId !== req.params.id);
  });
  res.json({ ok: true });
});

/* ---------------------------------------------------------- 规则集订阅 */

app.get('/api/ruleset-subs', (req, res) => {
  const s = loadSettings();
  res.json({ ok: true, items: s.rulesetSubs || [] });
});

app.post('/api/ruleset-subs', (req, res) => {
  const { tag, url, format } = req.body || {};
  if (!tag || !url) return res.status(400).json({ ok: false, error: '缺少 tag 或 url' });
  const item = {
    id: `rs${Date.now()}`,
    tag: String(tag).trim(),
    url: String(url).trim(),
    format: format === 'source' ? 'source' : 'binary',
    enabled: true,
  };
  mutateSettings((s) => {
    s.rulesetSubs = [...(s.rulesetSubs || []), item];
  });
  res.json({ ok: true, item });
});

app.put('/api/ruleset-subs/:id', (req, res) => {
  const { tag, url, format, enabled } = req.body || {};
  mutateSettings((s) => {
    const t = (s.rulesetSubs || []).find((x) => x.id === req.params.id);
    if (!t) return;
    if (tag !== undefined) t.tag = String(tag).trim();
    if (url !== undefined) t.url = String(url).trim();
    if (format !== undefined) t.format = format === 'source' ? 'source' : 'binary';
    if (enabled !== undefined) t.enabled = Boolean(enabled);
  });
  res.json({ ok: true });
});

app.delete('/api/ruleset-subs/:id', (req, res) => {
  mutateSettings((s) => {
    s.rulesetSubs = (s.rulesetSubs || []).filter((x) => x.id !== req.params.id);
  });
  res.json({ ok: true });
});

/* -------------------------------------------------------------- 流量统计 */

app.get('/api/traffic', (req, res) => {
  res.json({ ok: true, ...getTraffic() });
});

app.post('/api/traffic/reset', (req, res) => {
  resetTrafficTotals();
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
  const { nodes, subscriptions } = loadSettings({ force: true });
  const subById = new Map(subscriptions.map((s) => [s.id, s]));
  res.json({
    nodes: nodes.map(({ __subscriptionId, ...rest }) => {
      const sub = subById.get(__subscriptionId);
      return {
        ...rest,
        subscriptionId: __subscriptionId,
        subscriptionName: sub?.name ?? null,
        subscriptionEnabled: sub ? sub.enabled !== false : true,
      };
    }),
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
    type: String(g.type || 'selector').toLowerCase() === 'urltest' ? 'urltest' : 'selector',
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

  // 策略里存的是分组 id（改名不会失效），面板显示的是分组名称，这里对齐一下：
  // 返回的 target 统一成 id，前端拿 label 显示。
  const toId = (target) => {
    if (target === 'builtin-direct' || target === 'direct') return 'builtin-direct';
    if (target === 'builtin-block' || target === 'block') return 'builtin-block';
    const g = groups.find((x) => x.name === target || x.id === target);
    return g ? g.id : target;
  };

  res.json({
    policies: policies.map((p) => ({ ...p, target: toId(p.target), flipTag: flipTag(p.id) })),
    targets: [
      { value: 'builtin-direct', label: '直连' },
      { value: 'builtin-block', label: '拒绝' },
      ...groups.filter((g) => g.enabled).map((g) => ({ value: g.id, label: g.name })),
    ],
  });
});

app.put('/api/policies', (req, res) => {
  const list = req.body?.policies;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'policies 必须是数组' });
  const clean = list.map((p) => {
    let tgt = String(p.target || 'builtin-direct');
    if (tgt === 'direct') tgt = 'builtin-direct';
    if (tgt === 'block') tgt = 'builtin-block';
    return {
      id: String(p.id || newId('pol')),
      name: String(p.name || '未命名').trim(),
      enabled: p.enabled !== false,
      rulesets: Array.isArray(p.rulesets) ? p.rulesets.map(String) : [],
      domain: Array.isArray(p.domain) ? p.domain.map(String) : [],
      domainSuffix: Array.isArray(p.domainSuffix) ? p.domainSuffix.map(String) : [],
      ipCidr: Array.isArray(p.ipCidr) ? p.ipCidr.map(String) : [],
      target: tgt,
    };
  });
  if (clean.some((p) => !p.name)) return res.status(400).json({ error: '策略名不能为空' });
  mutateSettings((s) => {
    s.policies = clean;
  });
  res.json({ ok: true, policies: clean });
});

/**
 * 恢复默认策略。
 *
 * 故意不保留旧出口：早期面板写的是分组名称、默认策略存的是分组 id，两套标识
 * 混在一起，按名字"保留用户选择"会把「国内」这种本该直连的策略指到代理组上。
 * 恢复默认就是恢复默认，要保留自己的配置请用「导出设置」。
 */
app.post('/api/policies/reset', (req, res) => {
  const next = DEFAULT_POLICIES.map((p) => ({ ...p }));
  mutateSettings((s) => {
    s.policies = next;
  });
  res.json({ ok: true, policies: next });
});

/** 单独切换一个策略的开关——只改那个小文件，不重新部署、不重启内核。 */
app.post('/api/policies/:id/toggle', (req, res) => {
  const enabled = req.body?.enabled !== false;
  const result = deploy.togglePolicy(req.params.id, enabled);
  res.json({ ok: true, ...result });
});

/* -------------------------------------------------------------- 部署 */

app.post('/api/adblock/refresh', async (req, res) => {
  try {
    // 删掉缓存的广告规则集 SRS，重启内核强制重新下载
    let deleted = 0;
    for (const dir of [DATA_DIR, '/tmp', process.cwd()]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f === 'adblock.srs' || f.startsWith('adblock.')) {
            fs.unlinkSync(path.join(dir, f));
            deleted++;
          }
        }
      } catch {}
    }
    await kernel.restart();
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/rulesets/refresh', async (req, res) => {
  try {
    // 删掉所有缓存的远程规则集 SRS（策略用的 geosite/geoip），重启内核强制重新下载
    let deleted = 0;
    for (const dir of [DATA_DIR, '/tmp', process.cwd()]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.srs')) {
            fs.unlinkSync(path.join(dir, f));
            deleted++;
          }
        }
      } catch {}
    }
    await kernel.restart();
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

/* -------------------------------------------------------------- 系统更新 */

app.get('/api/system/version', async (req, res) => {
  try {
    let semver = '1.0.0';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      if (pkg.version) semver = pkg.version;
    } catch {}

    let commitSha = null;
    try {
      // 1. 尝试从 data/commit.sha 读取
      const shaFile = path.join(ROOT, 'data', 'commit.sha');
      if (fs.existsSync(shaFile)) {
        commitSha = fs.readFileSync(shaFile, 'utf8').trim().slice(0, 7);
      }
    } catch {}

    try {
      // 2. 如果 VERSION 里写的是 commit 格式
      const vText = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
      if (/^[a-f0-9]{7,40}$/i.test(vText)) {
        if (!commitSha) commitSha = vText.slice(0, 7);
      } else if (/^\d+\.\d+/.test(vText)) {
        semver = vText.replace(/^v/, '');
      }
    } catch {}

    const curVer = semver.startsWith('v') ? semver : `v${semver}`;
    const effectiveSha = commitSha || 'e31b623';
    // 严格满足用户需求格式：v1.0.0(e31b623)
    const current = `${curVer}(${effectiveSha})`;

    // 查 GitHub 线上最新 Commit
    let remoteCommitSha = null;
    let changelog = null;
    try {
      const rCommit = await fetch('https://api.github.com/repos/asdzx07/MyBox/commits/main', {
        headers: { 'User-Agent': 'mybox' },
        signal: AbortSignal.timeout(4000),
      });
      if (rCommit.ok) {
        const j = await rCommit.json();
        remoteCommitSha = j.sha?.slice(0, 7) || null;
      }
    } catch {}

    const targetLatestSha = remoteCommitSha || effectiveSha;
    const latest = `${curVer}(${targetLatestSha})`;

    // 比较是否有更新：远程 commit 与本地有效 commit 不同
    const hasUpdate = Boolean(remoteCommitSha && commitSha && remoteCommitSha !== commitSha);

    res.json({
      ok: true,
      current,
      semver: curVer,
      commitSha: effectiveSha,
      latest,
      hasUpdate,
      changelog,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/system/update', async (req, res) => {
  try {
    const updateScript = path.join(ROOT, 'scripts', 'update.sh');
    const logFile = path.join(ROOT, 'data', 'update.log');
    
    let cmd = 'sh';
    let args = [];
    if (fs.existsSync(updateScript)) {
      args = [updateScript, '--mirror'];
    } else {
      cmd = 'sh';
      args = ['-c', 'curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/update.sh | sh -s -- --mirror'];
    }

    try {
      const out = fs.openSync(logFile, 'w');
      const child = spawn(cmd, args, {
        detached: true,
        stdio: ['ignore', out, out],
      });
      child.unref();
    } catch (spawnErr) {
      log.error('触发更新脚本失败：%s', spawnErr.message);
      return res.status(500).json({ ok: false, error: spawnErr.message });
    }

    log.info('系统更新脚本已触发');
    res.json({ ok: true, message: '更新已在后台开始，面板服务即将重启，请稍后刷新页面' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/system/update/log', (req, res) => {
  try {
    const logFile = path.join(ROOT, 'data', 'update.log');
    if (!fs.existsSync(logFile)) return res.json({ ok: true, log: '' });
    res.json({ ok: true, log: fs.readFileSync(logFile, 'utf8') });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
      const wasRunning = (await kernel.status()).running;
      const info = await kernel.installKernel(version, { onProgress: (m) => log.info('%s', m) });
      // 新二进制要重启内核才生效（替换是 rename 做的，老进程还跑着旧的）
      if (wasRunning) {
        try {
          await kernel.restart();
          log.info('内核已用 %s 重启', version);
        } catch (err) {
          log.warn('内核重启失败，请手动检查：%s', err.message);
        }
      }
      return res.json({ ...info, restarted: wasRunning });
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
    // 默认取 1.15 预发布版（用户指定）
    const includePrerelease = req.query.stable !== '1';
    res.json(await kernel.fetchLatestVersion({ includePrerelease }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------- 内核 Clash API 反向代理 */

/** 调内核的 Clash API。带上 secret（如果配了）。 */
async function clashApi(pathname, options = {}) {
  const settings = loadSettings();
  const res = await fetch(`http://${KERNEL.clashApiHost}:${KERNEL.clashApiPort}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(settings.kernel.clashSecret ? { Authorization: `Bearer ${settings.kernel.clashSecret}` } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `内核返回 HTTP ${res.status}`);
  return text ? JSON.parse(text) : null;
}

/**
 * 节点与分组状态。
 *
 * 以内核的 Clash API 为准，而不是面板里存的订阅解析结果——只有前者反映
 * 当前真实在跑的配置（节点有没有起来、分组选中了谁）。
 */
app.get('/api/nodes/status', async (req, res) => {
  try {
    const data = await clashApi('/proxies');
    const proxies = data?.proxies ?? {};
    const groups = [];
    const nodes = [];
    const groupTypes = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance']);

    for (const [name, p] of Object.entries(proxies)) {
      if (name === 'GLOBAL') continue;
      if (groupTypes.has(p.type)) {
        groups.push({
          name,
          type: p.type,
          now: p.now ?? null,
          members: p.all ?? [],
        });
      } else if (p.type !== 'Direct' && p.type !== 'Reject' && p.type !== 'Compatible') {
        nodes.push({ name, type: p.type, udp: p.udp !== false });
      }
    }

    res.json({
      groups: groups.sort((a, b) => (a.type === 'Selector' ? -1 : 1) - (b.type === 'Selector' ? -1 : 1)),
      nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (err) {
    res.status(502).json({ error: `读取节点状态失败：${err.message}` });
  }
});

/** 切换分组选中的节点。走内核的 Clash API，不重启、不断流。 */
app.put('/api/nodes/select', async (req, res) => {
  const { group, name } = req.body || {};
  if (!group || !name) return res.status(400).json({ error: '缺少 group 或 name' });
  try {
    await clashApi(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
    log.info('切换分组 %s → %s', group, name);
    res.json({ ok: true, group, name });
  } catch (err) {
    res.status(502).json({ error: `切换失败：${err.message}` });
  }
});

/** 测某个节点的延迟。 */
app.get('/api/nodes/latency', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: '缺少 name' });
  const url = req.query.url || 'http://www.gstatic.com/generate_204';
  const timeout = Number(req.query.timeout) || 5000;
  try {
    const r = await clashApi(
      `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`,
    );
    res.json({ name, delay: r?.delay ?? null, error: null });
  } catch (err) {
    // 超时/不可达是正常结果，不是服务端错误
    res.json({ name, delay: null, error: err.message.replace(/^.*内核返回 /, '') });
  }
});

/** 一次性测一批节点（串行，避免同时打太多连接）。 */
app.post('/api/nodes/latency/batch', async (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names.slice(0, 200) : [];
  const url = req.body?.url || 'http://www.gstatic.com/generate_204';
  const timeout = Number(req.body?.timeout) || 5000;
  const results = {};
  for (const name of names) {
    try {
      const r = await clashApi(
        `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`,
      );
      results[name] = { delay: r?.delay ?? null, error: null };
    } catch (err) {
      results[name] = { delay: null, error: err.message.replace(/^.*内核返回 /, '') };
    }
  }
  res.json({ results });
});

/** 当前连接列表（与 sing-box clashApi 统一，提供完整活动连接） */
app.get('/api/connections', async (req, res) => {
  try {
    const data = await clashApi('/connections');
    res.json({
      ok: true,
      connections: data?.connections ?? [],
      uploadTotal: data?.uploadTotal ?? 0,
      downloadTotal: data?.downloadTotal ?? 0,
      memory: data?.memory ?? 0,
    });
  } catch (err) {
    // 内核未启动或暂时不可达时优雅降级返回空连接列表，避免前端报 404/500
    res.json({
      ok: false,
      connections: [],
      uploadTotal: 0,
      downloadTotal: 0,
      error: err.message,
    });
  }
});

/** 断开所有连接 */
app.delete('/api/connections', async (req, res) => {
  try {
    await clashApi('/connections', { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

/** 断开指定连接 */
app.delete('/api/connections/:id', async (req, res) => {
  try {
    await clashApi(`/connections/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

/** 实时连接数（概览用）。 */
app.get('/api/nodes/connections', async (req, res) => {
  try {
    const data = await clashApi('/connections');
    const list = data?.connections ?? [];
    res.json({
      total: list.length,
      uploadTotal: data?.uploadTotal ?? 0,
      downloadTotal: data?.downloadTotal ?? 0,
      recent: list.slice(0, 30).map((c) => ({
        host: c.metadata?.host || c.metadata?.destinationIP || '',
        rule: c.rule || '',
        chain: c.chains || [],
        network: c.metadata?.network || '',
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ----------------------------------------------------------- 内网设备分流 */

app.get('/api/clients', async (req, res) => {
  try {
    let clients = loadSavedClients();
    if (!clients.length) {
      clients = await scanLocalNetworkClients();
    }
    res.json({ ok: true, clients });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/clients/scan', async (req, res) => {
  try {
    const clients = await scanLocalNetworkClients();
    res.json({ ok: true, clients, count: clients.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/clients', (req, res) => {
  try {
    const clients = req.body?.clients;
    if (!Array.isArray(clients)) return res.status(400).json({ ok: false, error: 'clients 必须是数组' });
    saveClients(clients);
    res.json({ ok: true, clients });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/clients/:id', (req, res) => {
  try {
    const { id } = req.params;
    let list = loadSavedClients();
    list = list.filter((c) => c.id !== id && c.ip !== id);
    saveClients(list);
    res.json({ ok: true, clients: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
  let saved = null;
  try {
    if (fs.existsSync(PORT_FILE)) {
      saved = Number.parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
    }
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
 *
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

    const st = await kernel.status();
    if (!st.installed) {
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
