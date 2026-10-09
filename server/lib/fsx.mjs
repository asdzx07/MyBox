import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, BIN_DIR, ETC_DIR, DATA_DIR, FLIP_DIR, RULESET_DIR, GEO_DIR, PANEL_DIR,
} from './paths.mjs';

export function ensureDirs() {
  for (const dir of [ROOT, BIN_DIR, ETC_DIR, DATA_DIR, FLIP_DIR, RULESET_DIR, GEO_DIR, PANEL_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 原子写 JSON：先写临时文件，再 rename 覆盖。
 *
 * 为什么要这样：读取方可能正好在写入过程中读文件，直接覆盖会读到半截内容
 * 或拿到 ENOENT。rename 在同一文件系统内是原子的，读取方要么看到旧内容、
 * 要么看到新内容，不会看到中间态。
 */
export function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

/** 小文件直接写。给 flip 开关用——文件监听靠 inotify 的写事件，rename 有时不被识别。 */
export function writeSmallFile(file, content, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

export function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}
