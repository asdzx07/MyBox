import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, '..');
const windowsClientDir = path.join(projectRoot, 'windows-client');

test('Windows launcher project includes required runtime files and elevation manifest', () => {
  const project = fs.readFileSync(path.join(windowsClientDir, 'MyBox.csproj'), 'utf8');
  const buildScript = fs.readFileSync(path.join(windowsClientDir, 'build.cmd'), 'utf8');
  const manifest = fs.readFileSync(path.join(windowsClientDir, 'app.manifest'), 'utf8');

  assert.match(project, /<OutputType>WinExe<\/OutputType>/);
  assert.match(project, /<TargetFrameworkVersion>v4\.8<\/TargetFrameworkVersion>/);
  assert.match(project, /<ApplicationIcon>app\.ico<\/ApplicationIcon>/);
  assert.match(project, /<ApplicationManifest>app\.manifest<\/ApplicationManifest>/);
  assert.match(project, /<Compile Include="Launcher\.cs"\s*\/>/);
  assert.match(project, /<Content Include="core\\\*\*\\\*">/);
  assert.match(project, /<Content Include="ui\\\*\*\\\*">/);
  assert.match(project, /<Link>config\.json<\/Link>/);
  assert.match(buildScript, /MyBox\.csproj/);
  assert.match(manifest, /requestedExecutionLevel level="requireAdministrator"/);

  for (const required of [
    'Launcher.cs', 'app.ico', 'app.manifest', 'config.example.json',
    'core/server.mjs', 'core/network.mjs', 'ui/index.html', 'ui/app.js',
  ]) {
    assert.equal(fs.existsSync(path.join(windowsClientDir, required)), true, `${required} must exist`);
  }
});

test('tracked Windows configuration example contains no saved credentials', () => {
  const sample = JSON.parse(fs.readFileSync(path.join(windowsClientDir, 'config.example.json'), 'utf8'));
  assert.equal(sample.gatewayIp, '192.168.3.2');
  assert.equal(sample.gatewayPort, 3036);
  assert.equal(sample.password, '');
  assert.equal(sample.sessionCookie, '');
  assert.equal(sample.autoConnect, false);
  assert.equal(sample.minimizeToTray, true);

  const ignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
  assert.match(ignore, /^windows-client\/config\.json$/m);
  assert.match(ignore, /^windows-client\/build\/$/m);
});
