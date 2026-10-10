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

const { defaultSettings } = await import('../server/lib/settings.mjs');
const { generateConfig } = await import('../server/lib/configgen.mjs');
const { parseShareLink, parseSubscription } = await import('../server/lib/subscription.mjs');

test('config generation keeps node cleaning and dynamic group matching output stable', () => {
  const settings = defaultSettings();
  settings.subscriptions = [
    { id: 'sub-enabled', enabled: true },
    { id: 'sub-disabled', enabled: false },
  ];
  settings.nodes = [
    {
      type: 'vless',
      tag: 'Alpha-NY',
      server: 'alpha.example.net',
      server_port: 443,
      uuid: 'alpha-uuid',
      __subscriptionId: 'sub-enabled',
      __privateNote: 'drop-me',
      emptyList: [],
      emptyObject: {},
      nested: { keep: true, __hidden: 'drop-me', emptyList: [], emptyObject: {} },
    },
    {
      type: 'trojan',
      tag: 'Beta-EU',
      server: 'beta.example.net',
      server_port: 443,
      password: 'beta-password',
      __subscriptionId: 'sub-enabled',
    },
    {
      type: 'shadowsocks',
      tag: 'Disabled-Node',
      server: 'disabled.example.net',
      server_port: 8388,
      method: 'aes-128-gcm',
      password: 'unused',
      __subscriptionId: 'sub-disabled',
    },
  ];
  settings.groups.find((group) => group.id === 'all-manual').keywords = ['ny', 'EU', 'missing'];

  const { config } = generateConfig(settings);
  const alpha = config.outbounds.find((outbound) => outbound.tag === 'Alpha-NY');
  assert.deepEqual(alpha, {
    type: 'vless',
    tag: 'Alpha-NY',
    server: 'alpha.example.net',
    server_port: 443,
    uuid: 'alpha-uuid',
    nested: { keep: true },
  });
  assert.equal(config.outbounds.some((outbound) => outbound.tag === 'Disabled-Node'), false);
  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.tag === '所有-自动').outbounds,
    ['Alpha-NY', 'Beta-EU'],
  );
  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.tag === '所有-手动').outbounds,
    ['Alpha-NY', 'Beta-EU'],
  );
  assert.equal(JSON.stringify(config).includes('__subscriptionId'), false);
  assert.equal(JSON.stringify(config).includes('__privateNote'), false);
});

test('VLESS and VMess parsing preserves transport and TLS output', () => {
  const vlessLink = 'vless://11111111-2222-3333-4444-555555555555@vless.example.net:443?type=ws&path=%2Fws&host=cdn.example.net&security=tls&sni=front.example.net&alpn=h2%2Chttp%2F1.1&fp=chrome#vless-ws';
  const vmessPayload = Buffer.from(JSON.stringify({
    ps: 'vmess-grpc',
    add: 'vmess.example.net',
    port: '8443',
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    scy: 'auto',
    aid: '0',
    net: 'grpc',
    path: 'agent.Service',
    tls: 'tls',
    sni: 'front.vmess.example.net',
  })).toString('base64');
  const vmessLink = `vmess://${vmessPayload}`;

  const expectedVless = {
    type: 'vless',
    tag: 'vless-ws',
    server: 'vless.example.net',
    server_port: 443,
    uuid: '11111111-2222-3333-4444-555555555555',
    transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.net' } },
    tls: {
      enabled: true,
      server_name: 'front.example.net',
      alpn: ['h2', 'http/1.1'],
      utls: { enabled: true, fingerprint: 'chrome' },
    },
  };
  const expectedVmess = {
    type: 'vmess',
    tag: 'vmess-grpc',
    server: 'vmess.example.net',
    server_port: 8443,
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    security: 'auto',
    alter_id: 0,
    transport: { type: 'grpc', service_name: 'agent.Service' },
    tls: { enabled: true, server_name: 'front.vmess.example.net' },
  };

  assert.deepEqual(parseShareLink(vlessLink), expectedVless);
  assert.deepEqual(parseShareLink(vmessLink), expectedVmess);
  assert.deepEqual(parseSubscription(`${vlessLink}\n${vmessLink}`), {
    format: 'links',
    nodes: [expectedVless, expectedVmess],
  });
});
