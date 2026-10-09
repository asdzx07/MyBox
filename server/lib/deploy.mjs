import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_PATH, CONFIG_CANDIDATE_PATH, ROOT, DATA_DIR,
} from './paths.mjs';
import { createLogger } from './log.mjs';
import { loadSettings, mutateSettings } from './settings.mjs';
import { writeJsonAtomic, writeSmallFile, readJson } from './fsx.mjs';
import {
  generateConfig, buildNodeDirectRuleSet, nodeDirectRuleSetPath,
  buildDirectIpRuleSet, directIpRuleSetPath, ruleSetUrl,
} from './configgen.mjs';
import { setFlip, flipTag } from './flip.mjs';
import * as kernel from './kernel.mjs';
import * as netstack from './netstack.mjs';
import * as platform from './platform.mjs';

const log = createLogger('deploy');

const RULESET_CHECK_FILE = path.join(DATA_DIR, 'ruleset-check.json');
const RULESET_RECHECK_MS = 24 * 3600 * 1000;

let deploying = false;

/** 正在部署中。看门狗靠它避让——部署期间内核本来就会短暂停止。 */
export function isDeploying() {
  return deploying;
}

/**
 * 部署前确认每个规则集都能下载。
 *
 * 为什么必须做：sing-box 启动时某个 rule-set 拉不到（比如 tag 写错、官方仓库
 * 改名了）会直接 FATAL，内核起不来还被 procd 反复重启，日志里只有一行 404。
 * 在这里提前拦下来，报清楚是哪个 tag 有问题，旧配置还能继续跑。
 *
 * 结果缓存 24 小时，避免每次部署都打一遍网络。
 */
async function validateRuleSets(settings) {
  const tags = new Set();
  for (const p of settings.policies) {
    if (!p.enabled) continue;
    for (const t of p.rulesets || []) tags.add(t);
  }
  if (!tags.size) return { ok: true, checked: 0 };

  const cache = readJson(RULESET_CHECK_FILE, { at: 0, good: [], bad: {} });
  const fresh = Date.now() - (cache.at || 0) < RULESET_RECHECK_MS;
  const knownGood = new Set(fresh ? cache.good || [] : []);
  const knownBad = fresh ? cache.bad || {} : {};

  const todo = [...tags].filter((t) => !knownGood.has(t));
  const bad = { ...knownBad };

  await Promise.all(todo.map(async (tag) => {
    const url = ruleSetUrl(tag);
    if (!url) {
      bad[tag] = '规则集名不认识（只支持 geosite-* / geoip-* 前缀）';
      return;
    }
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        knownGood.add(tag);
        delete bad[tag];
      } else {
        bad[tag] = `HTTP ${res.status}`;
      }
    } catch (err) {
      // 网络不通不算「坏」，别因为一次超时就把用户的策略判死
      bad[tag] = `暂时探测不到（${err.message}）`;
    }
  }));

  writeJsonAtomic(RULESET_CHECK_FILE, { at: Date.now(), good: [...knownGood], bad });

  const failures = Object.entries(bad).filter(([t]) => tags.has(t));
  return { ok: failures.length === 0, checked: tags.size, failures };
}

/**
 * 把「设置」落成实际运行状态。顺序很重要：
 *
 *   1. 先把开关文件、规则集写齐 —— 内核启动时要能读到
 *   2. 生成配置写到 candidate，校验通过再原子替换正式配置
 *   3. 重启内核（这一步会短暂停一下内核，所以看门狗要避让）
 *   4. 最后动系统网络（dnsmasq / IP 转发）
 *
 * 第 3、4 步的顺序不能反：内核服务的 stop_service 不还原 dnsmasq 了，
 * 但 restart 本身会经历一次 stop，早期版本因此把刚写好的接管撤销掉过。
 *
 * 任何一步失败都尽量让系统回到「能上网」的状态，而不是半死不活。
 */
export async function deploy({ restart = true, skipNetwork = false } = {}) {
  deploying = true;
  try {
    return await deployInner({ restart, skipNetwork });
  } finally {
    deploying = false;
  }
}

async function deployInner({ restart = true, skipNetwork = false } = {}) {
  const settings = loadSettings({ force: true });
  const report = { steps: [], warnings: [], errors: [] };

  const step = (name, detail) => {
    report.steps.push({ name, detail, at: Date.now() });
    log.info('%s%s', name, detail ? ` — ${detail}` : '');
  };

  // ---- 0. 确保服务脚本已装（幂等；升级后新脚本能自动生效）
  try {
    const installedUnits = await platform.installServiceFiles(ROOT);
    if (installedUnits.length) step('安装服务脚本', installedUnits.join(', '));
  } catch (err) {
    report.warnings.push(`服务脚本安装失败（不影响本次部署）：${err.message}`);
  }

  // ---- 1. 开关文件 + 规则集
  const activePolicies = settings.policies.filter((p) => p.enabled);
  for (const p of activePolicies) setFlip(p.id, true);
  step('写入策略开关', `${activePolicies.length} 个策略`);

  const nodeDirect = buildNodeDirectRuleSet(settings.nodes);
  writeSmallFile(nodeDirectRuleSetPath(), `${JSON.stringify(nodeDirect)}\n`, { mode: 0o644 });
  step('写入节点直连规则集', `${(nodeDirect.rules[0].domain || []).length} 个域名`);

  if (settings.network.directBypass) {
    const directIp = buildDirectIpRuleSet(settings);
    writeSmallFile(directIpRuleSetPath(), `${JSON.stringify(directIp)}\n`, { mode: 0o644 });
    step('写入直连 IP 集合', `${(directIp.rules[0].ip_cidr || []).length} 条 CIDR（这些不进内核）`);
  }

  // ---- 2. 校验规则集能下载（内核拉不到会直接 FATAL）
  const rsCheck = await validateRuleSets(settings);
  if (!rsCheck.ok) {
    const detail = rsCheck.failures.map(([t, why]) => `${t}（${why}）`).join('；');
    const msg = `这些规则集拉不下来，内核会起不来，已中止部署：${detail}`;
    report.errors.push(msg);
    mutateSettings((s) => {
      s.meta.lastDeployError = msg;
    });
    throw new Error(msg);
  }
  step('校验规则集', `${rsCheck.checked} 个可下载`);

  // ---- 3. 生成配置
  const { config, warnings, bypassSets } = generateConfig(settings);
  report.warnings.push(...warnings);
  report.bypassSets = bypassSets;
  writeJsonAtomic(CONFIG_CANDIDATE_PATH, config, { mode: 0o600 });
  step('生成候选配置', `${config.outbounds.length} 个出站 / ${config.route.rules.length} 条路由规则`);

  // ---- 4. 校验
  const check = await kernel.checkConfig(CONFIG_CANDIDATE_PATH);
  if (!check.ok) {
    const msg = `配置校验失败：${check.error}`;
    report.errors.push(msg);
    mutateSettings((s) => {
      s.meta.lastDeployError = msg;
    });
    throw new Error(msg);
  }
  step('配置校验通过');

  const hadConfig = fs.existsSync(CONFIG_PATH);
  const previousConfig = hadConfig ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;

  // 原子替换：内核可能正好在读配置，不能让读到半截
  fs.renameSync(CONFIG_CANDIDATE_PATH, CONFIG_PATH);
  step('应用配置');

  // ---- 4. 内核
  //
  // 必须先重启内核、再动系统网络。反过来的话：内核服务的 stop_service 里
  // 会还原 dnsmasq（防止内核挂了整网无解析），而 restart 正好包含一次 stop——
  // 刚写好的接管会被自己撤销掉。
  if (restart) {
    try {
      await kernel.restart();
      step('重启内核', '已启动');
    } catch (err) {
      log.error('内核启动失败：%s', err.message);
      if (previousConfig) fs.writeFileSync(CONFIG_PATH, previousConfig);
      // 内核没起来，dnsmasq 却指着它的 DNS 端口 → 全 LAN 无解析。
      // 必须在这里还回去，不能等看门狗（那要几十秒，用户已经在骂了）。
      await netstack.restoreDnsmasq();
      report.errors.push(`内核启动失败：${err.message}`);
      mutateSettings((s) => {
        s.meta.lastDeployError = err.message;
      });
      throw new Error(`内核启动失败，配置已回滚、DNS 已还原：${err.message}`);
    }
  }

  // ---- 5. 系统网络（IP 转发 + dnsmasq 接管）
  if (!skipNetwork) {
    const netResult = await netstack.apply(settings);
    report.warnings.push(...netResult.warnings);
    step('系统网络', netResult.dnsmasq ? `dnsmasq 已接管（${netResult.dnsmasq.confDir}）` : `DNS 模式 ${settings.dns.mode}`);
  }

  mutateSettings((s) => {
    s.meta.lastDeployAt = Date.now();
    s.meta.lastDeployError = null;
  });

  report.ok = report.errors.length === 0;
  report.warnings = [...new Set(report.warnings)];
  return report;
}

/** 只切策略，不重新生成配置、不重启内核。 */
export function togglePolicy(policyId, enabled) {
  const settings = loadSettings({ force: true });
  const policy = settings.policies.find((p) => p.id === policyId);
  if (!policy) throw new Error('策略不存在');
  setFlip(policyId, enabled);
  return { id: policyId, tag: flipTag(policyId), enabled };
}

export async function teardown() {
  await kernel.stop();
  await netstack.cleanup();
  return { ok: true };
}
