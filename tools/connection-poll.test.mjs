import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, '..');

function sourceBlock(file, startMarker, endMarker) {
  const source = fs.readFileSync(path.join(projectRoot, file), 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing start marker in ${file}`);
  assert.notEqual(end, -1, `missing end marker in ${file}`);
  return source.slice(start, end);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeHarness({ visibleId, containerId, source, loadName, stopName, extraSources = [] }) {
  let visible = true;
  let hidden = false;
  let renderCount = 0;
  let requestCount = 0;
  const pending = [];
  const container = { innerHTML: '' };
  const elements = {
    [visibleId]: { classList: { contains: () => visible } },
    [containerId]: container,
  };
  const context = {
    document: { get hidden() { return hidden; } },
    window: {},
    remoteData: { connections: [] },
    $: (id) => elements[id],
    api: () => {
      requestCount += 1;
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
    fetchRemote: () => {
      requestCount += 1;
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
    renderConnections: () => { renderCount += 1; },
    escapeHtml: (value) => String(value),
    toast: () => {},
    confirm: () => true,
    setInterval: () => 1,
    clearInterval: () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}\n${extraSources.join('\n')}\nglobalThis.testLoad = ${loadName};\nglobalThis.testStop = ${stopName};`,
    context,
  );

  return {
    context,
    pending,
    container,
    get requestCount() { return requestCount; },
    get renderCount() { return renderCount; },
    setVisible(value) { visible = value; },
    setHidden(value) { hidden = value; },
  };
}

const panelSource = sourceBlock(
  'panel/app.js',
  'let connAutoPollTimer = null;',
  '/* --------------------------------------------------------------- 内网分流 */',
);
const windowsLoadSource = sourceBlock(
  'windows-client/ui/app.js',
  'let connLoadPromise = null;',
  'let localIgnoredConnIds = new Set();',
);
const windowsPollSource = sourceBlock(
  'windows-client/ui/app.js',
  'let localConnPollTimer = null;',
  'function switchTab(name) {',
);

test('panel connection loader coalesces concurrent calls and ignores stale views', async () => {
  const harness = makeHarness({
    visibleId: 'page-connections',
    containerId: 'connsList',
    source: panelSource,
    loadName: 'loadConnectionsPage',
    stopName: 'stopConnAutoPoll',
  });

  const first = harness.context.testLoad();
  const duplicate = harness.context.testLoad();
  assert.equal(harness.requestCount, 1);
  harness.pending[0].resolve({ connections: [{ id: 'conn-1' }] });
  await Promise.all([first, duplicate]);
  assert.equal(harness.renderCount, 1);

  const stale = harness.context.testLoad();
  harness.context.testStop();
  harness.pending[1].resolve({ connections: [{ id: 'stale' }] });
  await stale;
  assert.equal(harness.renderCount, 1);

  harness.setHidden(true);
  await harness.context.testLoad();
  assert.equal(harness.requestCount, 2);
});

test('Windows companion connection loader coalesces concurrent calls and ignores stale views', async () => {
  const harness = makeHarness({
    visibleId: 'sec-conns',
    containerId: 'connsListContainer',
    source: windowsLoadSource,
    extraSources: [windowsPollSource],
    loadName: 'loadConnections',
    stopName: 'stopLocalConnPoll',
  });

  const first = harness.context.testLoad();
  const duplicate = harness.context.testLoad();
  assert.equal(harness.requestCount, 1);
  harness.pending[0].resolve({ connections: [{ id: 'conn-1' }] });
  await Promise.all([first, duplicate]);
  assert.equal(harness.renderCount, 1);

  const stale = harness.context.testLoad();
  harness.context.testStop();
  harness.pending[1].resolve({ connections: [{ id: 'stale' }] });
  await stale;
  assert.equal(harness.renderCount, 1);

  harness.setHidden(true);
  await harness.context.testLoad();
  assert.equal(harness.requestCount, 2);
});
