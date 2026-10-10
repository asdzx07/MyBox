import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { validateSelftestRoot } from './selftest-guard.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, '..');
const testArea = fs.mkdtempSync(path.join(projectRoot, 'runtime-tests-'));
const runtime = path.join(testArea, 'runtime');
process.env.MYBOX_ROOT = runtime;

after(() => fs.rmSync(testArea, { recursive: true, force: true }));

const { loadSettings, mutateSettings } = await import('../server/lib/settings.mjs');
const deployModule = await import('../server/lib/deploy.mjs');

test('selftest runtime guard requires opt-in for external roots', () => {
  const defaultResult = validateSelftestRoot({ projectRoot });
  assert.equal(defaultResult.root, path.join(projectRoot, 'runtime'));
  assert.equal(defaultResult.isExternal, false);

  const externalRoot = path.join(testArea, 'external-runtime');
  assert.throws(
    () => validateSelftestRoot({ projectRoot, configuredRoot: externalRoot }),
    /拒绝清理非默认运行目录/,
  );
  const optedIn = validateSelftestRoot({
    projectRoot,
    configuredRoot: externalRoot,
    allowExternalRoot: true,
  });
  assert.equal(optedIn.root, externalRoot);
  assert.equal(optedIn.isExternal, true);
});

test('selftest runtime guard rejects production root and symlink targets', (t) => {
  if (process.platform === 'win32') {
    t.skip('当前 Windows 临时文件系统未提供可识别的目录符号链接语义');
    return;
  }

  if (process.platform === 'linux') {
    assert.throws(
      () => validateSelftestRoot({
        projectRoot,
        configuredRoot: '/opt/mybox',
        allowExternalRoot: true,
      }),
      /生产安装目录/,
    );
  }

  const target = path.join(testArea, 'symlink-target');
  const link = path.join(testArea, 'symlink-runtime');
  fs.mkdirSync(path.join(target, 'data'), { recursive: true });
  try {
    fs.symlinkSync(target, link, 'dir');
  } catch (err) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(err.code)) {
      t.skip('Windows 当前权限不允许创建目录符号链接');
      return;
    }
    throw err;
  }

  assert.throws(
    () => validateSelftestRoot({ projectRoot, configuredRoot: link, allowExternalRoot: true }),
    /符号链接/,
  );
});

test('invalid settings JSON is preserved and reported instead of overwritten', () => {
  const settingsPath = path.join(runtime, 'data', 'settings.json');
  const original = '{ invalid-json-do-not-overwrite\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, original);

  assert.throws(() => loadSettings({ force: true }), /原文件已保留/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);

  fs.writeFileSync(settingsPath, '{}\n');
  assert.ok(loadSettings({ force: true }).policies.length > 0);
});

test('deploy calls are serialized and the queue recovers after failure', async () => {
  mutateSettings((settings) => {
    for (const policy of settings.policies) policy.rulesets = ['geosite-cn'];
  });

  let active = 0;
  let maxActive = 0;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
    return { ok: true, status: 200 };
  };

  const options = { restart: false, skipNetwork: true };
  const pending = Array.from({ length: 3 }, () => deployModule.deploy(options));
  assert.equal(deployModule.isDeploying(), true);
  const results = await Promise.allSettled(pending);
  assert.equal(results.every((result) => result.status === 'rejected'), true);
  assert.equal(maxActive, 1);
  assert.equal(fetchCount, 1);
  assert.equal(deployModule.isDeploying(), false);

  const retry = await Promise.allSettled([deployModule.deploy(options)]);
  assert.equal(retry[0].status, 'rejected');
  assert.equal(fetchCount, 1);
  assert.equal(deployModule.isDeploying(), false);
});
