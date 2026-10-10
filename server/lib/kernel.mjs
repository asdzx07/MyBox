import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BIN_DIR, SINGBOX_BIN, CONFIG_PATH, DATA_DIR, VERSION_FILE, KERNEL,
} from './paths.mjs';
import { readJson, writeJsonAtomic, ensureDirs } from './fsx.mjs';
import { createLogger } from './log.mjs';
import { downloadToFile, fetchTextLimited } from './http-io.mjs';
import * as platform from './platform.mjs';

const execFileAsync = promisify(execFile);
const log = createLogger('kernel');

const REPO = 'SagerNet/sing-box';
const MIRRORS = ['', 'https://ghfast.top', 'https://gh-proxy.com'];
const RELEASE_METADATA_MAX_BYTES = 2 * 1024 * 1024;
const KERNEL_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const KERNEL_DOWNLOAD_TOTAL_TIMEOUT_MS = 180000;
const KERNEL_BINARY_MAX_BYTES = 256 * 1024 * 1024;
const LOG_MAX_LINES = 1000;
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_READ_TIMEOUT_MS = 5000;
const PID_FILE = path.join(DATA_DIR, 'kernel.pid');
const LOG_FILE = path.join(DATA_DIR, 'kernel.log');

export function currentVersion() {
  return readJson(VERSION_FILE, null)?.version ?? null;
}

/**
 * 内核版本。
 * VERSION.json 只有通过面板安装内核时才会写；安装脚本直接下的内核没有这个文件，
 * 所以拿不到就现场问内核自己。
 */
export async function installedVersion() {
  const fromFile = currentVersion();
  if (fromFile) return fromFile;
  const out = await versionOutput();
  const m = out?.match(/sing-box version (\S+)/);
  return m ? m[1] : null;
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

export async function fetchLatestVersion({ includePrerelease = false } = {}) {
  if (!includePrerelease) {
    const url = `https://api.github.com/repos/${REPO}/releases/latest`;
    const text = await fetchTextLimited(url, {
      timeoutMs: 10000,
      maxBytes: RELEASE_METADATA_MAX_BYTES,
      headers: { 'User-Agent': 'mybox' },
    });
    const json = JSON.parse(text);
    return { version: json.tag_name, publishedAt: json.published_at };
  }
  // 取最新的 1.15 预发布版
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
  const text = await fetchTextLimited(url, {
    timeoutMs: 10000,
    maxBytes: RELEASE_METADATA_MAX_BYTES,
    headers: { 'User-Agent': 'mybox' },
  });
  const list = JSON.parse(text);
  const hit = list.find((r) => /^v1\.15\./.test(r.tag_name));
  if (!hit) throw new Error('没找到 1.15 版本');
  return { version: hit.tag_name, publishedAt: hit.published_at, prerelease: true };
}

function assetName(version, suffix) {
  return `sing-box-${version.replace(/^v/, '')}-${suffix}.tar.gz`;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
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
  const workDir = fs.mkdtempSync(path.join(tmpDir, 'kernel-install-'));
  const tarball = path.join(workDir, asset);
  let staged;

  try {
    let lastError;
    const downloadDeadline = Date.now() + KERNEL_DOWNLOAD_TOTAL_TIMEOUT_MS;
    for (const mirror of MIRRORS) {
      const remainingMs = downloadDeadline - Date.now();
      if (remainingMs <= 0) {
        lastError = new Error('下载超时（已达到总时限）');
        break;
      }
      const base = `https://github.com/${REPO}/releases/download/${version}/${asset}`;
      // mirror 为空表示直连，不能拼成 "/https://..." —— 那是个非法 URL，fetch 直接抛
      const url = mirror ? `${mirror}/${base}` : base;
      try {
        onProgress(`下载 ${asset}${mirror ? `（镜像 ${mirror}）` : ''}`);
        const size = await downloadToFile(url, tarball, {
          timeoutMs: Math.min(90000, remainingMs),
          maxBytes: KERNEL_ARCHIVE_MAX_BYTES,
          headers: { 'User-Agent': 'mybox' },
          onProgress: () => {},
        });
        lastError = null;
        onProgress(`下载完成 ${(size / 1048576).toFixed(1)} MB`);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw new Error(`下载内核失败（直连和镜像都试过了）：${lastError.message}`);

    onProgress('解包');
    await execFileAsync('tar', ['-xzf', tarball, '-C', workDir], { timeout: 120000 });
    const entries = await fs.promises.readdir(workDir);
    const extracted = entries.find((n) => n.startsWith(`sing-box-${version.replace(/^v/, '')}`) && n.includes(suffix));
    if (!extracted) throw new Error('解包后找不到内核文件');

    const src = path.join(workDir, extracted, 'sing-box');
    const stat = await fs.promises.stat(src).catch(() => null);
    if (!stat?.isFile()) throw new Error('解包结果里没有 sing-box 可执行文件');
    if (stat.size > KERNEL_BINARY_MAX_BYTES) throw new Error('解包后的内核超过大小限制');
    const sha256 = await sha256File(src);

    // 不能直接覆盖正在运行的内核——Linux 会报 ETXTBSY（text file busy）。
    // 先写到同目录的唯一临时文件，再 rename 原子替换：运行中的进程保留旧 inode。
    staged = path.join(BIN_DIR, `.sing-box-${process.pid}-${randomUUID()}.new`);
    await fs.promises.copyFile(src, staged);
    await fs.promises.chmod(staged, 0o755);
    await fs.promises.rename(staged, SINGBOX_BIN);
    staged = null;

    const info = { version, asset, sha256, installedAt: new Date().toISOString() };
    writeJsonAtomic(VERSION_FILE, info, { mode: 0o644 });
    onProgress(`已安装 ${version}`);
    return info;
  } finally {
    if (staged) await fs.promises.rm(staged, { force: true }).catch(() => {});
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
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

async function detectPid() {
  const p = readPid();
  if (p && alive(p)) return p;
  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('pidof', ['sing-box'], { timeout: 1500 });
      const first = Number.parseInt(stdout.trim().split(/\s+/)[0], 10);
      if (Number.isFinite(first) && alive(first)) return first;
    } catch {}
  }
  return null;
}

function getUptime(pid) {
  if (!pid) return null;
  try {
    const stat = fs.statSync(`/proc/${pid}`);
    const sec = Math.max(1, Math.floor((Date.now() - stat.mtimeMs) / 1000));
    if (sec < 60) return `${sec} 秒`;
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
    if (sec < 86400) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return `${h} 小时 ${m} 分`;
    }
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    return `${d} 天 ${h} 小时`;
  } catch {
    return null;
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
    const pid = running ? await detectPid() : null;
    return {
      running,
      pid,
      uptime: getUptime(pid),
      version: await installedVersion(),
      installed: installed(),
      supervisor: plat.supervisor,
      platform: plat.id,
    };
  }
  const pid = await detectPid();
  const running = alive(pid);
  return {
    running,
    pid: running ? pid : null,
    uptime: getUptime(pid),
    version: await installedVersion(),
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
async function waitForResponding(timeoutMs = 90000) {
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
      const tail = await tailLogAsync(30);
      throw new Error(`内核启动后没能保持在运行状态${tail ? `\n日志尾部：\n${tail}` : ''}`);
    }
    return status();
  }

  await stop();
  return start();
}

function normalizeLogLines(lines) {
  const value = Number(lines);
  if (!Number.isFinite(value)) return 200;
  return Math.min(LOG_MAX_LINES, Math.max(1, Math.trunc(value)));
}

function sliceLogTail(text, lines, discardPartialFirstLine = false) {
  let content = text;
  if (discardPartialFirstLine) {
    const newline = content.indexOf('\n');
    content = newline < 0 ? '' : content.slice(newline + 1);
  }
  const entries = content.split('\n');
  if (entries.at(-1) === '') entries.pop();
  return entries.slice(-lines).join('\n');
}

function fileTailReadSize(fileSize, lines) {
  return Math.min(fileSize, LOG_MAX_BYTES, Math.max(64 * 1024, lines * 4096));
}

async function readLogFileTail(file, lines) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const stat = await handle.stat();
    const size = fileTailReadSize(stat.size, lines);
    if (!size) return '';
    const start = stat.size - size;
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    return sliceLogTail(buffer.toString('utf8', 0, bytesRead), lines, start > 0);
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function tailLogAsync(lines = 200) {
  const limit = normalizeLogLines(lines);
  const plat = platform.detect();
  if (supervised() && plat.id === 'systemd') {
    try {
      const { stdout } = await execFileAsync(
        'journalctl',
        ['-u', platform.SERVICES.kernel, '-n', String(limit), '--no-pager'],
        { timeout: LOG_READ_TIMEOUT_MS, maxBuffer: LOG_MAX_BYTES, encoding: 'utf8' },
      );
      return sliceLogTail(stdout, limit);
    } catch {
      return '';
    }
  }
  if (supervised() && plat.id === 'openwrt') {
    try {
      const { stdout } = await execFileAsync(
        'logread',
        ['-e', 'sing-box', '-l', String(limit)],
        { timeout: LOG_READ_TIMEOUT_MS, maxBuffer: LOG_MAX_BYTES, encoding: 'utf8' },
      );
      return sliceLogTail(stdout, limit);
    } catch {
      return '';
    }
  }
  return readLogFileTail(LOG_FILE, limit);
}

/** 同步兼容入口；服务端路由应使用 tailLogAsync 避免阻塞事件循环。 */
export function tailLog(lines = 200) {
  const limit = normalizeLogLines(lines);
  const plat = platform.detect();
  if (supervised() && plat.id === 'systemd') {
    try {
      return execFileSync(
        'journalctl',
        ['-u', platform.SERVICES.kernel, '-n', String(limit), '--no-pager'],
        { timeout: LOG_READ_TIMEOUT_MS, maxBuffer: LOG_MAX_BYTES, encoding: 'utf8' },
      );
    } catch {
      return '';
    }
  }
  if (supervised() && plat.id === 'openwrt') {
    try {
      return execFileSync(
        'logread',
        ['-e', 'sing-box', '-l', String(limit)],
        { timeout: LOG_READ_TIMEOUT_MS, maxBuffer: LOG_MAX_BYTES, encoding: 'utf8' },
      );
    } catch {
      return '';
    }
  }
  let fd;
  try {
    fd = fs.openSync(LOG_FILE, 'r');
    const fileSize = fs.fstatSync(fd).size;
    const size = fileTailReadSize(fileSize, limit);
    if (!size) return '';
    const start = fileSize - size;
    const buffer = Buffer.allocUnsafe(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, start);
    return sliceLogTail(buffer.toString('utf8', 0, bytesRead), limit, start > 0);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
