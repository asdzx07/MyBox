import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, '..');
const testArea = fs.mkdtempSync(path.join(projectRoot, 'runtime-tests-'));
const runtime = path.join(testArea, 'runtime');
process.env.MYBOX_ROOT = runtime;

after(() => fs.rmSync(testArea, { recursive: true, force: true }));

const { fetchTextLimited, downloadToFile } = await import('../server/lib/http-io.mjs');
const kernel = await import('../server/lib/kernel.mjs');
const { DATA_DIR } = await import('../server/lib/paths.mjs');

async function withMockFetch(mockFetch, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('bounded text fetch enforces Content-Length and streamed byte caps', async () => {
  await withMockFetch(async () => new Response('oversized', {
    headers: { 'content-length': '9' },
  }), async () => {
    await assert.rejects(
      fetchTextLimited('https://example.invalid/sub', { timeoutMs: 1000, maxBytes: 8 }),
      /超过大小限制/,
    );
  });

  await withMockFetch(async () => new Response('123456789'), async () => {
    await assert.rejects(
      fetchTextLimited('https://example.invalid/sub', { timeoutMs: 1000, maxBytes: 8 }),
      /超过大小限制/,
    );
  });
});

test('bounded fetch passes an abort deadline and returns allowed text', async () => {
  await withMockFetch(async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return new Response('small subscription');
  }, async () => {
    assert.equal(
      await fetchTextLimited('https://example.invalid/sub', { timeoutMs: 1000, maxBytes: 64 }),
      'small subscription',
    );
  });

  await withMockFetch((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }), async () => {
    const keepAlive = setTimeout(() => {}, 100);
    try {
      await assert.rejects(
        fetchTextLimited('https://example.invalid/slow', { timeoutMs: 10, maxBytes: 64 }),
        /timeout|aborted/i,
      );
    } finally {
      clearTimeout(keepAlive);
    }
  });
});

test('kernel download streams to disk and removes partial files on size failure', async () => {
  const downloadDir = path.join(testArea, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  const successPath = path.join(downloadDir, 'kernel.tar.gz');
  const progress = [];

  await withMockFetch(async () => new Response('streamed-kernel'), async () => {
    const size = await downloadToFile('https://example.invalid/kernel', successPath, {
      timeoutMs: 1000,
      maxBytes: 64,
      onProgress: (bytes) => progress.push(bytes),
    });
    assert.equal(size, Buffer.byteLength('streamed-kernel'));
    assert.equal(fs.readFileSync(successPath, 'utf8'), 'streamed-kernel');
    assert.ok(progress.length > 0);
  });

  const partialPath = path.join(downloadDir, 'partial.tar.gz');
  await withMockFetch(async () => new Response('this payload is over the limit'), async () => {
    await assert.rejects(
      downloadToFile('https://example.invalid/kernel', partialPath, {
        timeoutMs: 1000,
        maxBytes: 8,
      }),
      /超过大小限制/,
    );
  });
  assert.equal(fs.existsSync(partialPath), false);
});

test('kernel log tail is async, bounded to requested lines and capped at 1000 lines', async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const entries = Array.from({ length: 1200 }, (_, index) => `line-${index + 1}`);
  fs.writeFileSync(path.join(DATA_DIR, 'kernel.log'), `${entries.join('\n')}\n`);

  const bounded = await kernel.tailLogAsync(5000);
  const lines = bounded.split('\n');
  assert.equal(lines.length, 1000);
  assert.equal(lines[0], 'line-201');
  assert.equal(lines.at(-1), 'line-1200');
  assert.equal(await kernel.tailLogAsync(-1), 'line-1200');

  const legacyResult = kernel.tailLog(2);
  assert.equal(typeof legacyResult, 'string');
  assert.deepEqual(legacyResult.split('\n'), ['line-1199', 'line-1200']);
});
