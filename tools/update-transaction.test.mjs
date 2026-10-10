import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { applyUpdate, finalizeUpdate, rollbackUpdate } from '../scripts/update-transaction.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, '..');
const testArea = fs.mkdtempSync(path.join(projectRoot, 'runtime-tests-'));
after(() => fs.rmSync(testArea, { recursive: true, force: true }));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('update transaction swaps staged code, keeps data untouched, and finalizes backups', () => {
  const root = path.join(testArea, 'success-root');
  const stage = path.join(root, '.update-stage');
  const backup = path.join(root, '.backup');
  write(path.join(root, 'server', 'index.mjs'), 'old-server');
  write(path.join(root, 'data', 'settings.json'), 'user-data');
  write(path.join(stage, 'server', 'index.mjs'), 'new-server');
  write(path.join(stage, 'package.json'), '{"version":"2"}');

  applyUpdate({ root, stage, backup, items: ['server', 'package.json'] });
  assert.equal(fs.readFileSync(path.join(root, 'server', 'index.mjs'), 'utf8'), 'new-server');
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), '{"version":"2"}');
  assert.equal(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'), 'user-data');
  assert.equal(fs.readFileSync(path.join(backup, 'server', 'index.mjs'), 'utf8'), 'old-server');

  finalizeUpdate({ backup });
  assert.equal(fs.existsSync(path.join(backup, '.update-changed')), false);
  assert.equal(rollbackUpdate({ root, backup }), false);
});

test('update transaction rolls back partially moved code after a replacement failure', () => {
  const root = path.join(testArea, 'rollback-root');
  const stage = path.join(root, '.update-stage');
  const backup = path.join(root, '.backup');
  write(path.join(root, 'server', 'index.mjs'), 'old-server');
  write(path.join(root, 'panel', 'app.js'), 'old-panel');
  write(path.join(root, 'data', 'settings.json'), 'keep-settings');
  write(path.join(stage, 'server', 'index.mjs'), 'new-server');
  write(path.join(stage, 'panel', 'app.js'), 'new-panel');

  let renameCalls = 0;
  assert.throws(() => applyUpdate({
    root,
    stage,
    backup,
    items: ['server', 'panel'],
    renamePath(from, to) {
      renameCalls += 1;
      if (renameCalls === 4) throw new Error('simulated rename failure');
      fs.renameSync(from, to);
    },
  }), /simulated rename failure/);

  assert.equal(fs.readFileSync(path.join(root, 'server', 'index.mjs'), 'utf8'), 'old-server');
  assert.equal(fs.readFileSync(path.join(root, 'panel', 'app.js'), 'utf8'), 'old-panel');
  assert.equal(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'), 'keep-settings');
  assert.equal(fs.existsSync(path.join(backup, '.update-changed')), false);
});

test('update transaction removes newly introduced paths when rolling back', () => {
  const root = path.join(testArea, 'new-path-root');
  const stage = path.join(root, '.update-stage');
  const backup = path.join(root, '.backup');
  write(path.join(stage, 'tools', 'new-tool.mjs'), 'new-tool');

  applyUpdate({ root, stage, backup, items: ['tools'] });
  assert.equal(fs.readFileSync(path.join(root, 'tools', 'new-tool.mjs'), 'utf8'), 'new-tool');
  assert.equal(rollbackUpdate({ root, backup }), true);
  assert.equal(fs.existsSync(path.join(root, 'tools')), false);
});
