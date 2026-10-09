import crypto from 'node:crypto';
import path from 'node:path';
import { FLIP_DIR } from './paths.mjs';
import { writeSmallFile } from './fsx.mjs';

/**
 * 策略热切换开关。
 *
 * 原理：sing-box 的本地 rule-set（type: local）由 fswatch 监听，文件一变内核
 * 立即重载规则集并触发回调——进程不动、已有连接不断。见上游
 * route/rule/rule_set_local.go。
 *
 * 所以每个可切换的策略对应一个极小的 rule-set 源文件，内容只有两种：
 *   开 → 匹配一切      { "version": 3, "rules": [{ "network": ["tcp","udp"] }] }
 *   关 → 匹配不了任何东西 { "version": 3, "rules": [{ "domain": ["obflip-off.invalid"] }] }
 *
 * 策略的路由规则写成「逻辑与(真实条件, 开关规则集)」。改写文件即切换，不用重写
 * config.json、不用重启内核。
 */

const ON_RULES = { version: 3, rules: [{ network: ['tcp', 'udp'] }] };
const OFF_RULES = { version: 3, rules: [{ domain: ['obflip-off.invalid'] }] };

/** 用 id 的短哈希做文件名，这样改名字不会换文件、也不会让内核重新加载。 */
export function flipTag(id) {
  const h = crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12);
  return `flip-${h}`;
}

export function flipPath(id) {
  return path.join(FLIP_DIR, `${flipTag(id)}.json`);
}

/** 写入开关状态。直接写（不 rename）——inotify 的写事件最可靠。 */
export function setFlip(id, enabled) {
  const body = enabled ? ON_RULES : OFF_RULES;
  writeSmallFile(flipPath(id), `${JSON.stringify(body)}\n`);
}

export function ensureFlip(id, enabled = true) {
  setFlip(id, enabled);
}

/** 生成 config.json 里对应的 rule_set 条目。 */
export function flipRuleSetEntry(id) {
  return {
    type: 'local',
    tag: flipTag(id),
    format: 'source',
    path: flipPath(id),
  };
}
