import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MIB = 1024 * 1024;

function validateLimits(timeoutMs, maxBytes) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs 必须是正数');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes 必须是正整数');
  }
}

function sizeLimitError(maxBytes) {
  return new Error(`响应超过大小限制（${(maxBytes / MIB).toFixed(1)} MiB）`);
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {}
}

function checkDeclaredSize(response, maxBytes) {
  const raw = response.headers?.get?.('content-length');
  if (!raw || !/^\d+$/.test(raw)) return;
  const declared = Number(raw);
  if (Number.isSafeInteger(declared) && declared > maxBytes) throw sizeLimitError(maxBytes);
}

async function fetchResponse(url, { timeoutMs, headers, redirect }) {
  return fetch(url, {
    headers,
    redirect,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function fetchTextLimited(url, {
  timeoutMs = 30000,
  maxBytes = 10 * MIB,
  headers = {},
  redirect = 'follow',
} = {}) {
  validateLimits(timeoutMs, maxBytes);
  const response = await fetchResponse(url, { timeoutMs, headers, redirect });
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`HTTP ${response.status}`);
  }

  try {
    checkDeclaredSize(response, maxBytes);
  } catch (err) {
    await cancelBody(response);
    throw err;
  }

  const chunks = [];
  let size = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) throw sizeLimitError(maxBytes);
        chunks.push(buffer);
      }
    }
  } catch (err) {
    await cancelBody(response);
    throw err;
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export async function downloadToFile(url, dest, {
  timeoutMs = 90000,
  maxBytes = 128 * MIB,
  headers = {},
  redirect = 'follow',
  onProgress = () => {},
} = {}) {
  validateLimits(timeoutMs, maxBytes);
  const response = await fetchResponse(url, { timeoutMs, headers, redirect });
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`HTTP ${response.status}`);
  }

  try {
    checkDeclaredSize(response, maxBytes);
    if (!response.body) throw new Error('响应体为空');

    let size = 0;
    const countBytes = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(sizeLimitError(maxBytes));
          return;
        }
        try {
          onProgress(size);
          callback(null, chunk);
        } catch (err) {
          callback(err);
        }
      },
    });

    await pipeline(
      Readable.fromWeb(response.body),
      countBytes,
      fs.createWriteStream(dest),
    );
    return size;
  } catch (err) {
    await cancelBody(response);
    await fs.promises.rm(dest, { force: true }).catch(() => {});
    throw err;
  }
}
