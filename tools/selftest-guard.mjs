import fs from 'node:fs';
import path from 'node:path';

function samePath(a, b, platform) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Validate the runtime target before selftest removes its etc/ and data/ directories. */
export function validateSelftestRoot({
  projectRoot,
  configuredRoot,
  allowExternalRoot = false,
  platform = process.platform,
}) {
  const defaultRuntime = path.join(path.resolve(projectRoot), 'runtime');
  const root = path.resolve(configuredRoot || defaultRuntime);
  const isDefault = samePath(root, defaultRuntime, platform);

  if (!isDefault && !allowExternalRoot) {
    throw new Error(`拒绝清理非默认运行目录：${root}；确认是独立测试目录后，添加 --allow-external-root 再运行。`);
  }

  if (platform === 'linux') {
    const productionRoot = path.resolve('/opt/mybox');
    if (samePath(root, productionRoot, platform) || root.startsWith(`${productionRoot}${path.sep}`)) {
      throw new Error(`拒绝将自检运行目录指向生产安装目录：${root}`);
    }
  }

  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink()) {
      throw new Error(`拒绝使用符号链接作为自检运行目录：${root}`);
    }
    const realRoot = fs.realpathSync(root);
    if (!samePath(root, realRoot, platform)) {
      throw new Error(`拒绝使用经符号链接解析的自检运行目录：${root}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  for (const dir of ['etc', 'data']) {
    const target = path.join(root, dir);
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        throw new Error(`拒绝清理符号链接目录：${target}`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  return { root, defaultRuntime, isExternal: !isDefault };
}
