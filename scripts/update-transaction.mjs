import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestName = '.update-changed';
const allowedItems = new Set([
  'server', 'panel', 'system', 'tools', 'scripts',
  'package.json', 'VERSION', 'node_modules',
]);

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function remove(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function normalizeItems(items) {
  const list = [...new Set(items)];
  for (const item of list) {
    if (!allowedItems.has(item)) throw new Error(`不允许事务替换路径：${item}`);
  }
  return list;
}

export function applyUpdate({ root, stage, backup, items, renamePath = fs.renameSync }) {
  const rootPath = path.resolve(root);
  const stagePath = path.resolve(stage);
  const backupPath = path.resolve(backup);
  const manifest = path.join(backupPath, manifestName);
  const list = normalizeItems(items);
  fs.mkdirSync(backupPath, { recursive: true });
  fs.writeFileSync(manifest, '', { mode: 0o600 });

  try {
    for (const item of list) {
      const staged = path.join(stagePath, item);
      if (!exists(staged)) continue;

      const current = path.join(rootPath, item);
      const saved = path.join(backupPath, item);
      const hadOriginal = exists(current);
      if (hadOriginal && exists(saved)) throw new Error(`备份目标已存在：${saved}`);

      const manifestFd = fs.openSync(manifest, 'a', 0o600);
      try {
        fs.writeSync(manifestFd, `${item}\t${hadOriginal ? '1' : '0'}\n`);
        fs.fsyncSync(manifestFd);
      } finally {
        fs.closeSync(manifestFd);
      }
      if (hadOriginal) renamePath(current, saved);
      renamePath(staged, current);
    }
  } catch (err) {
    try {
      rollbackUpdate({ root: rootPath, backup: backupPath });
    } catch (rollbackError) {
      throw new Error(`更新失败且自动回滚未完成：${rollbackError.message}`, { cause: err });
    }
    throw err;
  }
}

export function rollbackUpdate({ root, backup }) {
  const rootPath = path.resolve(root);
  const backupPath = path.resolve(backup);
  const manifest = path.join(backupPath, manifestName);
  if (!exists(manifest)) return false;

  const records = fs.readFileSync(manifest, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const record of records.reverse()) {
    const separator = record.lastIndexOf('\t');
    if (separator < 0) throw new Error('更新事务日志格式无效');
    const item = record.slice(0, separator);
    const hadOriginal = record.slice(separator + 1) === '1';
    if (!allowedItems.has(item)) throw new Error(`更新事务日志包含非法路径：${item}`);

    const current = path.join(rootPath, item);
    const saved = path.join(backupPath, item);
    if (hadOriginal) {
      if (exists(saved)) {
        remove(current);
        fs.mkdirSync(path.dirname(current), { recursive: true });
        fs.renameSync(saved, current);
      }
    } else {
      remove(current);
    }
  }
  fs.rmSync(manifest, { force: true });
  return true;
}

export function finalizeUpdate({ backup }) {
  fs.rmSync(path.join(path.resolve(backup), manifestName), { force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  try {
    if (action === 'apply') {
      const [root, stage, backup, ...items] = args;
      applyUpdate({ root, stage, backup, items });
    } else if (action === 'rollback') {
      const [root, backup] = args;
      rollbackUpdate({ root, backup });
    } else if (action === 'finalize') {
      const [backup] = args;
      finalizeUpdate({ backup });
    } else {
      throw new Error('用法：update-transaction.mjs apply <root> <stage> <backup> <items...> | rollback <root> <backup> | finalize <backup>');
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
