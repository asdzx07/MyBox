import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatewayStatusCache, parseGatewayRouteTable } from '../windows-client/core/network.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const connectedRoutes = [
  'IPv4 Route Table',
  'Network Destination        Netmask          Gateway       Interface  Metric',
  '0.0.0.0                    0.0.0.0          192.168.3.2   192.168.3.25    25',
].join('\n');

const disconnectedRoutes = [
  'IPv4 Route Table',
  'Network Destination        Netmask          Gateway       Interface  Metric',
  '0.0.0.0                    0.0.0.0          192.168.3.1   192.168.3.25    25',
].join('\n');

test('default gateway parser matches only the route gateway column', () => {
  assert.equal(parseGatewayRouteTable(connectedRoutes, '192.168.3.2'), true);
  assert.equal(parseGatewayRouteTable(disconnectedRoutes, '192.168.3.2'), false);
  assert.equal(
    parseGatewayRouteTable('0.0.0.0 0.0.0.0 192.168.3.1 192.168.3.2 25', '192.168.3.2'),
    false,
  );
  assert.equal(parseGatewayRouteTable('', '192.168.3.2'), false);
});

test('gateway status cache shares concurrent probes and reuses fresh results', async () => {
  let calls = 0;
  let now = 1000;
  const pendingQueries = [];
  const cache = createGatewayStatusCache({
    ttlMs: 5000,
    now: () => now,
    query: () => {
      calls += 1;
      const request = deferred();
      pendingQueries.push(request);
      return request.promise;
    },
  });

  const first = cache.get('192.168.3.2');
  const duplicate = cache.get('192.168.3.2');
  assert.equal(calls, 1);
  pendingQueries[0].resolve(connectedRoutes);
  assert.deepEqual(await Promise.all([first, duplicate]), [true, true]);
  assert.equal(await cache.get('192.168.3.2'), true);
  assert.equal(calls, 1);
});

test('expired gateway probes refresh asynchronously and explicit state wins races', async () => {
  let now = 1000;
  const pendingQueries = [];
  const cache = createGatewayStatusCache({
    ttlMs: 1000,
    now: () => now,
    query: () => {
      const request = deferred();
      pendingQueries.push(request);
      return request.promise;
    },
  });

  const initial = cache.get('192.168.3.2');
  pendingQueries[0].resolve(connectedRoutes);
  assert.equal(await initial, true);

  now += 1001;
  const refreshed = cache.get('192.168.3.2');
  assert.equal(pendingQueries.length, 2);
  cache.set('192.168.3.2', true);
  pendingQueries[1].resolve(disconnectedRoutes);
  assert.equal(await refreshed, true);
  assert.equal(await cache.get('192.168.3.2'), true);
});

test('failed gateway probes preserve the existing false-on-error behavior', async () => {
  const cache = createGatewayStatusCache({ query: async () => { throw new Error('route command failed'); } });
  assert.equal(await cache.get('192.168.3.2'), false);
  assert.equal(await cache.get('192.168.3.2'), false);
});
