import { KERNEL } from '../lib/paths.mjs';

export function createClashApi({ loadSettings, fetchImpl = (...args) => fetch(...args), kernel = KERNEL }) {
  return async function clashApi(pathname, options = {}) {
    const settings = loadSettings();
    const response = await fetchImpl(`http://${kernel.clashApiHost}:${kernel.clashApiPort}${pathname}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(settings.kernel.clashSecret ? { Authorization: `Bearer ${settings.kernel.clashSecret}` } : {}),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `内核返回 HTTP ${response.status}`);
    return text ? JSON.parse(text) : null;
  };
}
