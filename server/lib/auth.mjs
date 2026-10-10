import crypto from 'node:crypto';
import { loadSettings, mutateSettings } from './settings.mjs';

const COOKIE = 'mybox_session';
const TTL_MS = 7 * 24 * 3600 * 1000;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function isPasswordSet() {
  return Boolean(loadSettings().panel.passwordHash);
}

export function setPassword(password) {
  if (typeof password !== 'string' || password.length < 6) {
    throw new Error('密码至少 6 位');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  mutateSettings((s) => {
    s.panel.passwordSalt = salt;
    s.panel.passwordHash = hashPassword(password, salt);
  });
}

export function verifyPassword(password) {
  const settings = loadSettings();
  const panel = settings.panel;
  if (!panel || !panel.passwordHash || !panel.passwordSalt) return false;
  try {
    const candidate = hashPassword(String(password ?? ''), panel.passwordSalt);
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(panel.passwordHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function getSessionSecret() {
  const s = loadSettings();
  if (s.panel?.sessionSecret) return s.panel.sessionSecret;
  return rotateSessionSecret();
}

export function rotateSessionSecret() {
  const gen = crypto.randomBytes(32).toString('hex');
  try {
    mutateSettings((sett) => {
      sett.panel = sett.panel || {};
      sett.panel.sessionSecret = gen;
    });
  } catch {}
  return gen;
}

function sign(payload) {
  const secret = getSessionSecret();
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function issueToken() {
  const payload = String(Date.now() + TTL_MS);
  return `${payload}.${sign(payload)}`;
}

export function tokenValid(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, mac] = token.split('.');
  const expected = sign(payload);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  return Number(payload) > Date.now();
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function isAuthed(req) {
  if (!isPasswordSet()) return false;
  return tokenValid(parseCookies(req.headers.cookie)[COOKIE]);
}

export function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}`,
  );
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * 认证中间件。放行：健康检查、认证接口本身、面板静态资源。
 * 其余一律 401，前端据此跳登录。
 */
export function authMiddleware(req, res, next) {
  const p = req.path;
  if (p === '/api/health' || p.startsWith('/api/auth/')) return next();
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}
