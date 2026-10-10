import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGroupInput, normalizePolicyInput } from '../server/lib/settings.mjs';

test('group normalization preserves defaults, aliases, and array conversion', () => {
  assert.deepEqual(normalizeGroupInput({
    id: 'group-1',
    name: '  手动出口  ',
    type: 'URLTEST',
    enabled: false,
    mode: 'dynamic',
    members: [1, 'node-a'],
    keywords: ['NY', 7],
    interval: '',
    tolerance: '0',
    idleTimeout: '',
    default: 42,
    ignored: 'field',
  }), {
    id: 'group-1',
    name: '手动出口',
    type: 'urltest',
    enabled: false,
    mode: 'dynamic',
    members: ['1', 'node-a'],
    keywords: ['NY', '7'],
    interval: '300s',
    tolerance: 100,
    idleTimeout: '12h',
    default: '42',
  });

  const generated = normalizeGroupInput({});
  assert.match(generated.id, /^grp-[a-f0-9]{12}$/);
  assert.equal(generated.type, 'selector');
  assert.equal(generated.mode, 'static');
  assert.equal(generated.enabled, true);
  assert.deepEqual(generated.members, []);
  assert.deepEqual(generated.keywords, []);
  assert.equal(generated.default, undefined);
});

test('policy normalization canonicalizes direct/block targets and fills arrays', () => {
  assert.deepEqual(normalizePolicyInput({
    id: 'policy-1',
    name: '  自定义策略 ',
    enabled: false,
    rulesets: [1, 'geosite-cn'],
    domain: ['example.com'],
    domainSuffix: null,
    ipCidr: ['192.0.2.0/24'],
    target: 'direct',
    ignored: 'field',
  }), {
    id: 'policy-1',
    name: '自定义策略',
    enabled: false,
    rulesets: ['1', 'geosite-cn'],
    domain: ['example.com'],
    domainSuffix: [],
    ipCidr: ['192.0.2.0/24'],
    target: 'builtin-direct',
  });
  assert.equal(normalizePolicyInput({ target: 'block' }).target, 'builtin-block');

  const generated = normalizePolicyInput({});
  assert.match(generated.id, /^pol-[a-f0-9]{12}$/);
  assert.equal(generated.name, '未命名');
  assert.equal(generated.enabled, true);
  assert.deepEqual(generated.rulesets, []);
  assert.deepEqual(generated.domain, []);
  assert.deepEqual(generated.domainSuffix, []);
  assert.deepEqual(generated.ipCidr, []);
  assert.equal(generated.target, 'builtin-direct');
});
