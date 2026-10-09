import fs from 'node:fs';
import {
  CONFIG_PATH, CONFIG_CANDIDATE_PATH, ROOT,
} from './paths.mjs';
import { createLogger } from './log.mjs';
import { loadSettings, mutateSettings } from './settings.mjs';
import { writeJsonAtomic, writeSmallFile } from './fsx.mjs';
import { generateConfig, buildNodeDirectRuleSet, nodeDirectRuleSetPath, buildDirectIpRuleSet, directIpRuleSetPath } from './configgen.mjs';
import { setFlip, flipTag } from './flip.mjs';
import * as kernel from './kernel.mjs';
import * as netstack from './netstack.mjs';
import * as platform from './platform.mjs';

const log = createLogger('deploy');

/**
 * 把「设置」落成实际运行状态。顺序很重要：
 *
 *   1. 先把开关文件、规则集写齐 —— 内核启动时要能读到
 *   2. 生成配置写到 candidate，校验通过再原子替换正式配置
 *   3. 配置没问题才动系统网络（dnsmasq / IP 转发）
 *   4. 最后重启内核；内核起不来就回滚 dnsmasq，避免整网无解析
 *
 * 任何一步失败都尽量让系统回到「能上网」的状态，而不是半死不活。
 */
export async function deploy({ restart = true, skipNetwork = false } = {}) {
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

  // ---- 2. 生成配置
  const { config, warnings, bypassSets } = generateConfig(settings);
  report.warnings.push(...warnings);
  report.bypassSets = bypassSets;
  writeJsonAtomic(CONFIG_CANDIDATE_PATH, config, { mode: 0o600 });
  step('生成候选配置', `${config.outbounds.length} 个出站 / ${config.route.rules.length} 条路由规则`);

  // ---- 3. 校验
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

  // ---- 4. 系统网络
  if (!skipNetwork) {
    const netResult = await netstack.apply(settings);
    report.warnings.push(...netResult.warnings);
    step('系统网络', netResult.dnsmasq ? `dnsmasq 已接管（${netResult.dnsmasq.confDir}）` : `DNS 模式 ${settings.dns.mode}`);
  }

  // ---- 5. 内核
  if (restart) {
    try {
      await kernel.restart();
      step('重启内核', '已启动');
    } catch (err) {
      // 内核起不来 = 代理没生效。此时必须把 dnsmasq 还给系统，
      // 否则 dnsmasq 一直指着一个死掉的 DNS 端口，全 LAN 无解析。
      log.error('内核启动失败：%s', err.message);
      if (previousConfig) fs.writeFileSync(CONFIG_PATH, previousConfig);
      await netstack.restoreDnsmasq();
      report.errors.push(`内核启动失败：${err.message}`);
      mutateSettings((s) => {
        s.meta.lastDeployError = err.message;
      });
      throw new Error(`内核启动失败，已回滚 DNS 接管：${err.message}`);
    }
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
