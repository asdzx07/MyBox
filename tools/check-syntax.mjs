import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = new Set(['.js', '.mjs']);
const excludedDirectories = new Set(['.git', 'node_modules', 'runtime', 'data', 'bin']);

async function collectJavaScript(directory, files = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name) || entry.name.startsWith('runtime-tests-')) continue;
      await collectJavaScript(fullPath, files);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function checkSyntax(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.relative(projectRoot, file)}\n${output.trim()}`));
    });
  });
}

const files = (await collectJavaScript(projectRoot)).sort();
if (!files.length) {
  throw new Error('未找到可检查的 JavaScript 文件');
}

for (const file of files) await checkSyntax(file);
console.log(`语法检查通过：${files.length} 个 .js/.mjs 文件`);
