import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BIN_DIR, SINGBOX_BIN, CONFIG_PATH, DATA_DIR, VERSION_FILE, KERNEL,
} from './paths.mjs';
import { readJson, writeJsonAtomic, ensureDirs } from './fsx.mjs';
import { createLogger } from './log.mjs';
import * as platform from './platform.mjs';

const execFileAsync = promisify(execFile);
const log = createLogger('kernel');

const REPO = 'SagerNet/sing-box';
const MIRRORS = ['', 'https://ghfast.top', 'https://gh-proxy.com'];
const PID_FILE = path.join(DATA_DIR, 'kernel.pid');
const LOG_FILE = path.join(DATA_DIR, 'kernel.log');

export function currentVersion() {
  return readJson(VERSION_FILE, null)?.version ?? null;
}

export function installed() {
  return fs.existsSync(SINGBOX_BIN);
}

/* --------------------------------------------------------- 版本与下载 */

function archSuffix() {
  const arch = process.arch;
  const map = { x64: 'amd64', arm64: 'arm64', arm: 'armv7', ia32: '386' };
  const a = map[arch];
  if (!a) throw new Error(`不支持的架构：${arch}`);
  // OpenWrt 用 musl，Debian/Ubuntu 用 glibc
  const libc = process.env.MYBOX_LIBC || (fs.existsSync('/etc/openwrt_release') ? 'musl' : 'glibc');
  return `linux-${a}-${libc}`;
}

export async function fetchLatestVersion() {
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const res = await fetch(url, { headers: { 'User-Agent': 'mybox' } });
  if (!res.ok) throw new Error(`查询最新版本失败：HTTP ${res.status}`);
  const json = await res.json();
  return { version: json.tag_name, publishedAt: json.published_at };
}

function assetName(version, suffix) {
  return `sing-box-${version.replace(/^v/, '')}-${suffix}.tar.gz`;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'mybox' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/**
 * 下载并安装官方内核。不修改、不重新编译——直接用官方 Release。
 * 下载走 HTTPS，并记录 SHA256 到 VERSION.json，重装同版本时校验复用。
 */
export async function installKernel(version, { onProgress = () => {} } = {}) {
  ensureDirs();
  const suffix = archSuffix();
  const asset = assetName(version, suffix);
  const tmpDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tarball = path.join(tmpDir, asset);

  let lastError;
  for (const mirror of MIRRORS) {
    const url = `${mirror}/https://github.com/${REPO}/releases/download/${version}/${asset}`;
    try {
      onProgress(`下载 ${asset}${mirror ? `（镜像 ${mirror}）` : ''}`);
      const size = await download(url, tarball);
      lastError = null;
      onProgress(`下载完成 ${(size / 1048576).toFixed(1)} MB`);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw new Error(`下载内核失败：${lastError.message}`);

  onProgress('解包');
  await execFileAsync('tar', ['-xzf', tarball, '-C', tmpDir]);
  const extracted = fs.readdirSync(tmpDir).find((n) => n.startsWith(`sing-box-${version.replace(/^v/, '')}`) && n.includes(suffix));
  if (!extracted) throw new Error('解包后找不到内核文件');

  const src = path.join(tmpDir, extracted, 'sing-box');
  if (!fs.existsSync(src)) throw new Error('解包结果里没有 sing-box 可执行文件');

  const { createHash } = await import('node:crypto');
  const buf = fs.readFileSync(src);
  const sha256 = createHash('sha256').update(buf).digest('hex');

  fs.copyFileSync(src, SINGBOX_BIN);
  fs.chmodSync(SINGBOX_BIN, 0o755);
  fs.rmSync(tarball, { force: true });
  fs.rmSync(path.join(tmpDir, extracted), { recursive: true, force: true });

  const info = { version, asset, sha256, installedAt: new Date().toISOString() };
  writeJsonAtomic(VERSION_FILE, info, { mode: 0o644 });
  onProgress(`已安装 ${version}`);
  return info;
}

/* ------------------------------------------------------------ 配置校验 */

/** sing-box 的错误输出带 ANSI 颜色码，去掉再返回，前端好显示。 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

export async function checkConfig(configPath = CONFIG_PATH) {
  if (!installed()) return { ok: false, error: '内核未安装' };
  try {
    const { stderr } = await execFileAsync(SINGBOX_BIN, ['check', '-c', configPath], { timeout: 60000 });
    return { ok: true, output: stripAnsi(stderr || '').trim() };
  } catch (err) {
    const detail = stripAnsi([err.stdout, err.stderr].filter(Boolean).join('\n').trim() || err.message);
    return { ok: false, error: detail };
  }
}

export async function versionOutput() {
  if (!installed()) return null;
  try {
    const { stdout } = await execFileAsync(SINGBOX_BIN, ['version'], { timeout: 10000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- 进程管理 */

function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 有服务管理器就交给它（procd / systemd）；没有（开发机）就直接拉进程。 */
function supervised() {
  const p = platform.detect();
  return (p.id === 'openwrt' || p.id === 'systemd') && platform.hasService(platform.SERVICES.kernel);
}

export async function status() {
  const plat = platform.detect();
  if (supervised()) {
    const running = await platform.serviceActive(platform.SERVICES.kernel);
    return {
      running,
      pid: null,
      version: currentVersion(),
      installed: installed(),
      supervisor: plat.supervisor,
      platform: plat.id,
    };
  }
  const pid = readPid();
  const running = alive(pid);
  return {
    running,
    pid: running ? pid : null,
    version: currentVersion(),
    installed: installed(),
    supervisor: 'direct',
    platform: plat.id,
  };
}

export async function start() {
  if (!installed()) throw new Error('内核未安装，请先安装内核');
  const check = await checkConfig();
  if (!check.ok) throw new Error(`配置校验失败：${check.error}`);

  if (supervised()) {
    const r = await platform.serviceControl(platform.SERVICES.kernel, 'start');
    if (!r.ok) throw new Error(r.out || '服务启动失败');
    // 第一次成功启动后设为开机自启——配置已经校验过了，不会开机崩循环
    await platform.serviceEnable(platform.SERVICES.kernel, true);
    await waitForResponding();
    return status();
  }

  if (alive(readPid())) return status();

  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(SINGBOX_BIN, ['run', '-c', CONFIG_PATH, '-D', DATA_DIR], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  log.info('内核已启动 pid=%d', child.pid);
  return status();
}

/**
 * 内核是否真的活了。
 *
 * 不能只看 procd / systemd 的 status 文本：配置有问题时内核每 5 秒崩一次被重新拉起，
 * 两次崩溃之间 status 照样报 running。必须问内核自己要答案——
 * Clash API 能响应才算起来了。
 */
export async function isResponding(timeoutMs = 2500) {
  try {
    const { loadSettings } = await import('./settings.mjs');
    const secret = loadSettings().kernel?.clashSecret;
    const res = await fetch(`http://${KERNEL.clashApiHost}:${KERNEL.clashApiPort}/version`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 轮询等内核真的起来。 */
async function waitForResponding(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isResponding()) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

export async function stop() {
  if (supervised()) {
    const r = await platform.serviceControl(platform.SERVICES.kernel, 'stop');
    if (!r.ok) log.warn('停止内核：%s', r.out);
    return status();
  }

  const pid = readPid();
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      // 给内核时间收尾（删 nft 表、关 tun），最多等 10 秒
      for (let i = 0; i < 20 && alive(pid); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    } catch (err) {
      log.warn('停止内核失败：%s', err.message);
    }
  }
  fs.rmSync(PID_FILE, { force: true });
  return status();
}

export async function restart() {
  if (supervised()) {
    const check = await checkConfig();
    if (!check.ok) throw new Error(`配置校验失败：${check.error}`);
    const r = await platform.serviceControl(platform.SERVICES.kernel, 'restart');
    if (!r.ok) throw new Error(r.out || '服务重启失败');
    await platform.serviceEnable(platform.SERVICES.kernel, true);
    if (!(await waitForResponding())) {
      const tail = tailLog(30);
      throw new Error(`内核启动后没能保持在运行状态${tail ? `\n日志尾部：\n${tail}` : ''}`);
    }
    return status();
  }

  await stop();
  return start();
}

export function tailLog(lines = 200) {
  const plat = platform.detect();
  if (supervised() && plat.id === 'systemd') {
    try {
      return execFileSync('journalctl', ['-u', platform.SERVICES.kernel, '-n', String(lines), '--no-pager'], { timeout: 10000 }).toString();
    } catch {
      return '';
    }
  }
  if (supervised() && plat.id === 'openwrt') {
    try {
      return execFileSync('logread', ['-e', 'sing-box'], { timeout: 10000 }).toString();
    } catch {
      return '';
    }
  }
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    return content.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}
