import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, KERNEL } from './paths.mjs';
import { createLogger } from './log.mjs';
import { fetchTextLimited } from './http-io.mjs';
import {
  loadSettings, saveSettings, mutateSettings, newId, DEFAULT_POLICIES,
  normalizeGroupInput, normalizePolicyInput,
} from './settings.mjs';
import {
  isPasswordSet, setPassword, verifyPassword, issueToken, clearSessionCookie,
  setSessionCookie, authMiddleware, isAuthed,
} from './auth.mjs';
import { parseSubscription, dedupeTags } from './subscription.mjs';
import * as kernel from './kernel.mjs';
import { getTraffic, resetTrafficTotals } from './traffic.mjs';
import * as deploy from './deploy.mjs';
import * as netstack from './netstack.mjs';
import * as platform from './platform.mjs';
import { flipTag, setFlip } from './flip.mjs';
import { loadSavedClients, saveClients, scanLocalNetworkClients } from './clients.mjs';
import { createRefreshSubscription } from '../services/subscriptions.mjs';
import { createClashApi } from '../services/clash-api.mjs';

export function createServerDeps(overrides = {}) {
  const log = overrides.log || createLogger('panel');
  const deps = {
    ROOT,
    DATA_DIR,
    KERNEL,
    log,
    fetchImpl: (...args) => fetch(...args),
    fs,
    path,
    spawn,
    loadSettings,
    saveSettings,
    mutateSettings,
    newId,
    DEFAULT_POLICIES,
    normalizeGroupInput,
    normalizePolicyInput,
    isPasswordSet,
    setPassword,
    verifyPassword,
    issueToken,
    clearSessionCookie,
    setSessionCookie,
    authMiddleware,
    isAuthed,
    fetchTextLimited,
    parseSubscription,
    dedupeTags,
    kernel,
    getTraffic,
    resetTrafficTotals,
    deploy,
    netstack,
    platform,
    flipTag,
    setFlip,
    loadSavedClients,
    saveClients,
    scanLocalNetworkClients,
  };
  Object.assign(deps, overrides);
  deps.refreshSubscription = overrides.refreshSubscription || createRefreshSubscription(deps);
  deps.clashApi = overrides.clashApi || createClashApi({
    loadSettings: deps.loadSettings,
    fetchImpl: deps.fetchImpl,
    kernel: deps.KERNEL,
  });
  return deps;
}
