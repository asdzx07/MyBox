import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, '..');
const testArea = fs.mkdtempSync(path.join(projectRoot, 'runtime-tests-'));
process.env.MYBOX_ROOT = path.join(testArea, 'runtime');

after(() => fs.rmSync(testArea, { recursive: true, force: true }));

const { createApp } = await import('../server/app.mjs');

function makeSettings() {
  return {
    panel: { passwordHash: null, passwordSalt: null, sessionSecret: 'test-secret' },
    kernel: { version: null, autoStart: true, logLevel: 'warn', clashSecret: null },
    network: { directBypass: false, ipv6: false, rejectQuic: false, tun: {} },
    dns: { mode: 'system', hijackPort: 7853 },
    meta: {},
    subscriptions: [{ id: 'sub-1', name: 'Subscription one', url: 'https://example.invalid/sub', enabled: true }],
    rulesetSubs: [],
    nodes: [{ tag: 'node-a', type: 'direct', __subscriptionId: 'sub-1' }],
    groups: [{ id: 'group-1', name: 'Group one', type: 'selector', enabled: true, members: ['node-a'] }],
    policies: [{ id: 'policy-1', name: 'Policy one', enabled: true, rulesets: [], domain: [], domainSuffix: [], ipCidr: [], target: 'group-1' }],
  };
}

async function withServer(overrides, run) {
  const panelDir = path.join(testArea, `panel-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(panelDir, { recursive: true });
  fs.writeFileSync(path.join(panelDir, 'index.html'), 'panel-static');

  const settings = makeSettings();
  const logEntries = [];
  const calls = { deploy: [], flips: [], fetch: [] };
  const baseDeps = {
    ROOT: '/isolated/mybox',
    DATA_DIR: '/isolated/mybox/data',
    KERNEL: { clashApiHost: '127.0.0.1', clashApiPort: 9095 },
    log: {
      info: (...args) => logEntries.push(['info', ...args]),
      warn: (...args) => logEntries.push(['warn', ...args]),
      error: (...args) => logEntries.push(['error', ...args]),
      debug: (...args) => logEntries.push(['debug', ...args]),
    },
    loadSettings: () => settings,
    saveSettings: (value) => Object.assign(settings, value),
    mutateSettings: (mutator) => mutator(settings),
    newId: (prefix) => `${prefix}-generated`,
    DEFAULT_POLICIES: [{ id: 'default-policy', name: 'Default', enabled: true }],
    normalizeGroupInput: (group) => ({ ...group, id: String(group.id || 'group-generated'), name: String(group.name || '').trim() }),
    normalizePolicyInput: (policy) => ({
      id: String(policy.id || 'policy-generated'),
      name: String(policy.name || '').trim(),
      enabled: policy.enabled !== false,
      rulesets: Array.isArray(policy.rulesets) ? policy.rulesets.map(String) : [],
      domain: Array.isArray(policy.domain) ? policy.domain.map(String) : [],
      domainSuffix: Array.isArray(policy.domainSuffix) ? policy.domainSuffix.map(String) : [],
      ipCidr: Array.isArray(policy.ipCidr) ? policy.ipCidr.map(String) : [],
      target: policy.target === 'direct' ? 'builtin-direct' : policy.target,
    }),
    isPasswordSet: () => false,
    isAuthed: () => false,
    setPassword: () => {},
    verifyPassword: () => false,
    rotateSessionSecret: () => 'rotated-secret',
    issueToken: () => 'test-token',
    clearSessionCookie: () => {},
    setSessionCookie: () => {},
    authMiddleware: (req, res, next) => {
      if (req.path.startsWith('/api/auth/')) return next();
      if (req.headers.authorization === 'Bearer test') return next();
      return res.status(401).json({ error: 'unauthorized' });
    },
    refreshSubscription: async (id) => ({ format: 'links', nodeCount: 1, sample: [`${id}-node`] }),
    fetchTextLimited: async () => '',
    parseSubscription: () => ({ format: 'links', nodes: [] }),
    dedupeTags: (nodes) => nodes,
    kernel: {
      status: async () => ({ running: false, installed: false }),
      versionOutput: async () => null,
      installedVersion: async () => null,
      installed: () => false,
      start: async () => ({ running: true }),
      stop: async () => ({ running: false }),
      restart: async () => ({ running: true }),
      installKernel: async (version) => ({ version, asset: 'test', sha256: 'abc', installedAt: 'now' }),
      tailLogAsync: async () => 'test-log',
      fetchLatestVersion: async () => ({ version: 'v1.15.0' }),
      isResponding: async () => false,
    },
    netstack: { dnsmasqStatus: async () => ({ takenOver: false }), restoreDnsmasq: async () => {}, applyDnsmasq: async () => {} },
    platform: { describe: () => ({ id: 'test', label: 'test' }) },
    getTraffic: () => ({ up: 1, down: 2 }),
    resetTrafficTotals: () => {},
    deploy: {
      deploy: async (options) => { calls.deploy.push(options); return { ok: true }; },
      teardown: async () => ({ ok: true }),
      togglePolicy: (id, enabled) => ({ id, enabled }),
    },
    flipTag: (id) => `flip-${id}`,
    setFlip: (id, enabled) => calls.flips.push([id, enabled]),
    loadSavedClients: () => [],
    saveClients: () => {},
    scanLocalNetworkClients: async () => [],
    fetchImpl: async (url, options) => {
      calls.fetch.push([url, options]);
      return new Response('proxied-response', { status: 202 });
    },
    fs,
    path,
    spawn: () => ({ unref() {} }),
  };
  const app = createApp({ deps: { ...baseDeps, ...overrides }, panelDir });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ baseUrl, settings, calls, logEntries });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function request(baseUrl, route, options = {}, authorized = true) {
  const headers = new Headers(options.headers || {});
  if (authorized) headers.set('Authorization', 'Bearer test');
  return fetch(new URL(route, baseUrl), { ...options, headers });
}

test('application preserves static/public-before-auth and protected route contracts', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const staticResponse = await fetch(new URL('/', baseUrl));
    assert.equal(staticResponse.status, 200);
    assert.equal(await staticResponse.text(), 'panel-static');

    const health = await request(baseUrl, '/api/health', {}, false);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, root: '/isolated/mybox', dbPath: path.join('/isolated/mybox/data', 'settings.json') });

    const denied = await request(baseUrl, '/api/overview', {}, false);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: 'unauthorized' });

    const overview = await request(baseUrl, '/api/overview');
    assert.equal(overview.status, 200);
    const data = await overview.json();
    assert.equal(data.counts.subscriptions, 1);
    assert.equal(data.platform.id, 'test');
  });
});

test('subscription, ruleset, group and policy route response shapes remain stable', async () => {
  await withServer({}, async ({ baseUrl, settings, calls }) => {
    const subscriptions = await request(baseUrl, '/api/subscriptions');
    assert.deepEqual(await subscriptions.json(), {
      subscriptions: [{ ...settings.subscriptions[0], nodeCount: 1, sampleNodes: ['node-a'] }],
      totalNodes: 1,
    });

    const rulesets = await request(baseUrl, '/api/ruleset-subs');
    assert.deepEqual(await rulesets.json(), { ok: true, items: [] });
    const addRuleset = await request(baseUrl, '/api/ruleset-subs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'custom', url: 'https://rules.invalid', format: 'source' }),
    });
    const added = await addRuleset.json();
    assert.equal(added.ok, true);
    assert.equal(added.item.tag, 'custom');
    assert.equal(added.item.format, 'source');

    const refresh = await request(baseUrl, '/api/subscriptions/sub-1/refresh', { method: 'POST' });
    assert.deepEqual(await refresh.json(), { format: 'links', nodeCount: 1, sample: ['sub-1-node'] });

    const groupSave = await request(baseUrl, '/api/groups', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: [{ id: 'g-new', name: 'New group' }] }),
    });
    const groupBody = await groupSave.json();
    assert.equal(groupBody.ok, true);
    assert.equal(groupBody.groups[0].id, 'g-new');
    assert.equal(calls.deploy.length, 1);

    const policySave = await request(baseUrl, '/api/policies', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policies: [{ id: 'p-new', name: 'New policy', target: 'direct' }] }),
    });
    const policyBody = await policySave.json();
    assert.equal(policyBody.ok, true);
    assert.equal(policyBody.policies[0].target, 'builtin-direct');
    assert.deepEqual(calls.flips, [['p-new', true]]);
  });
});

test('Clash route catch-all remains after resource routes and preserves upstream status/body', async () => {
  await withServer({}, async ({ baseUrl, calls }) => {
    const response = await request(baseUrl, '/api/controller/proxies?source=test', {
      method: 'GET',
    });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), 'proxied-response');
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.fetch[0][0], 'http://127.0.0.1:9095/proxies?source=test');
  });
});

test('global error handler retains 500 JSON response and adds route context to logs', async () => {
  await withServer({
    kernel: {
      status: async () => { throw new Error('stub kernel failure'); },
      versionOutput: async () => null,
      installedVersion: async () => null,
      installed: () => false,
    },
  }, async ({ baseUrl, logEntries }) => {
    const response = await request(baseUrl, '/api/overview');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'stub kernel failure' });
    assert.equal(logEntries.some((entry) => entry[0] === 'error' && entry.includes('GET') && entry.includes('/api/overview')), true);
  });
});

test('change-password route verifies current password, rotates session secret, and sets new session cookie', async () => {
  let savedPassword = 'initial-password';
  let secretRotated = false;
  let issuedToken = null;

  await withServer({
    verifyPassword: (pwd) => pwd === savedPassword,
    setPassword: (next) => {
      if (!next || next.length < 6) throw new Error('密码至少 6 位');
      savedPassword = next;
    },
    rotateSessionSecret: () => {
      secretRotated = true;
      return 'new-secret';
    },
    issueToken: () => 'token-after-rotation',
    setSessionCookie: (_res, token) => {
      issuedToken = token;
    },
  }, async ({ baseUrl }) => {
    // 1. 错误密码拒绝
    const badRes = await request(baseUrl, '/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: 'wrong-pass', next: 'new-pass-123' }),
    });
    assert.equal(badRes.status, 401);

    // 2. 密码太短拒绝
    const shortRes = await request(baseUrl, '/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: 'initial-password', next: '123' }),
    });
    assert.equal(shortRes.status, 400);

    // 3. 密码正确，轮换密钥并下发新 cookie
    const okRes = await request(baseUrl, '/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: 'initial-password', next: 'new-valid-pass' }),
    });
    assert.equal(okRes.status, 200);
    assert.deepEqual(await okRes.json(), { ok: true });
    assert.equal(savedPassword, 'new-valid-pass');
    assert.equal(secretRotated, true);
    assert.equal(issuedToken, 'token-after-rotation');
  });
});

