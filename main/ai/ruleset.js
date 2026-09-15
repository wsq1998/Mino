// Mio - AI 助手：把 settings.ai 收口成 opencode 的 permission ruleset（纯函数，零依赖）
//
// 为什么要有这一层（docs/16 §4.5 / §7.4）
//   「Agent 能干什么」必须收口在 Mio 手里，而不是交给引擎默认值。opencode 的 agent 自带一套
//   ruleset（`GET /agent` 实测返回 build agent 的 permission 数组），我们在 `POST /session` 时
//   传入自己的规则覆盖它 —— 这是 Mio 安全策略**唯一的着力点**。
//
// 规则形状（实测）：{ permission, pattern, action }，action ∈ 'allow' | 'ask' | 'deny'
//   判定语义（按数组顺序，越靠前越优先 —— 与 opencode 的默认表一致）：
//     · 先给一条通配放行，再用更具体的条目把危险面收回来
//     · 'ask' → 引擎发 permission.asked 事件 → Mio 弹内联权限卡（§6.4）
//
// ⚠️ 待验证（P2 验收项，docs/16 §11）
//   `pattern` 的具体匹配语义（glob 还是正则、匹配的是命令串还是路径）**本设计尚未实测**。
//   因此本模块采取「宁可多问一次」的保守取向；P2 会用真实引擎请求逐条校准，校准前不要
//   把任何条目改成 'allow'。
//
// 依赖：无（仅内置 RegExp / Array / String）。可被 node --test 直接加载。

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 1. 危险命令的本地识别（与引擎 ruleset 双保险）
//    为什么还要本地判一遍：引擎的 pattern 语义未实测；本地判断可以**先于**请求发生就
//    在输入条上给出警示，体验上不依赖引擎行为。
// ─────────────────────────────────────────────────────────────────────────────
const DANGEROUS_PATTERNS = [
  { re: /(^|[;&|]\s*)rm\s+(-[a-z]*[rf][a-z]*\s+)+/i, label: '递归/强制删除' },
  { re: /(^|[;&|]\s*)sudo\b/i, label: '提权执行' },
  { re: /(^|[;&|]\s*)dd\s+/i, label: '裸设备写入' },
  { re: /(^|[;&|]\s*)mkfs/i, label: '格式化文件系统' },
  { re: /(^|[;&|]\s*)diskutil\s+(erase|partition|reformat)/i, label: '磁盘操作' },
  { re: /(^|[;&|]\s*)(shutdown|reboot|halt)\b/i, label: '关机/重启' },
  { re: /(^|[;&|]\s*)launchctl\s+(load|unload|bootstrap|bootout)/i, label: '系统服务变更' },
  { re: /(^|[;&|]\s*)chmod\s+-R\b/i, label: '递归改权限' },
  { re: /(^|[;&|]\s*)chown\s+-R\b/i, label: '递归改属主' },
  { re: /\|\s*(sudo\s+)?(ba|z|k)?sh\b/i, label: '管道直灌 shell' },
  { re: /(^|[;&|]\s*)pkill\s+-9/i, label: '强杀进程' },
  { re: />\s*\/dev\/(disk|rdisk)/i, label: '写裸设备' },
  { re: /(^|[;&|]\s*)mv\s+[^\s]+\s+\/(\s|$)/i, label: '移动到根目录' },
];

/**
 * 判断一条命令是否命中危险模式（本地启发式，供 UI 预警）。
 * @param {string} cmd
 * @returns {{dangerous:boolean, labels:string[]}}
 */
function isDangerousCommand(cmd) {
  const s = typeof cmd === 'string' ? cmd : '';
  if (!s.trim()) return { dangerous: false, labels: [] };
  const labels = [];
  for (const p of DANGEROUS_PATTERNS) {
    if (p.re.test(s)) labels.push(p.label);
  }
  return { dangerous: labels.length > 0, labels };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ruleset 构建
// ─────────────────────────────────────────────────────────────────────────────
/** 默认工作区目录名（settings.ai.workspace 为空时用）。 */
const DEFAULT_WORKSPACE_NAME = 'Mio Workspace';

const RULE = (permission, pattern, action) => ({ permission, pattern, action });

/**
 * 构建 opencode permission ruleset。
 *
 * 顺序即优先级，四条决策：
 *   ① 开工区（通配 allow）—— 「回车就干」的前提，不能每步都问
 *   ② 工作区外目录 → ask   —— 越界必须让你知道
 *   ③ doom_loop → ask      —— 引擎自己的死循环护栏，保留
 *   ④ bash 危险模式 → ask   —— 见 DANGEROUS_PATTERNS
 *   ⑤ question → allow     —— Mio 有提问卡（§6.3 .ai-question），默认的 deny 会让 Agent 变哑巴
 *
 * @param {object} [settings] 整个 settings（只读 settings.ai）
 * @returns {Array<{permission:string, pattern:string, action:string}>}
 */
function buildRuleset(settings) {
  const ai = (settings && typeof settings.ai === 'object' && settings.ai) || {};
  const rules = [
    RULE('*', '*', 'allow'),
    RULE('external_directory', '*', 'ask'),
    RULE('doom_loop', '*', 'ask'),
  ];

  // bash 危险模式：把本地识别到的危险命令形态同步成引擎侧规则
  for (const p of DANGEROUS_PATTERNS) {
    rules.push(RULE('bash', p.re.source, 'ask'));
  }

  // 让 Agent 能反问（Mio 有专门的提问卡来接）
  rules.push(RULE('question', '*', 'allow'));

  // 预留：settings 将来若有更细的开关，在此追加分支，保持「顺序即优先级」不变
  void ai;
  return rules;
}

/**
 * 工作区路径收口：空 → ~/<DEFAULT_WORKSPACE_NAME>。
 * 传 homeDir 而不是自己取 os.homedir()，保持纯函数可单测。
 * @param {string} workspace settings.ai.workspace
 * @param {string} homeDir
 * @returns {string} 绝对路径
 */
function resolveWorkspace(workspace, homeDir) {
  const home = typeof homeDir === 'string' && homeDir ? homeDir.replace(/\/+$/, '') : '';
  const w = typeof workspace === 'string' ? workspace.trim() : '';
  if (w) return w.replace(/\/+$/, '');
  if (!home) return '';
  return `${home}/${DEFAULT_WORKSPACE_NAME}`;
}

/**
 * 解析 settings.ai.model 字符串 → 引擎要的 { providerID, modelID }。
 *
 * 输入形态（用户手填，宽松）：
 *   ''                        → null（用引擎配置里的默认模型）
 *   'providerID/modelID'      → 拆开
 *   'modelID'                 → 只给 modelID（providerID 交给引擎自己定）
 *
 * @param {string} spec
 * @returns {{providerID:string, modelID:string}|null}
 */
function parseModel(spec) {
  const s = typeof spec === 'string' ? spec.trim() : '';
  if (!s) return null;
  const slash = s.indexOf('/');
  if (slash > 0 && slash < s.length - 1) {
    return { providerID: s.slice(0, slash).trim(), modelID: s.slice(slash + 1).trim() };
  }
  return { providerID: '', modelID: s };
}

module.exports = {
  DANGEROUS_PATTERNS,
  DEFAULT_WORKSPACE_NAME,
  isDangerousCommand,
  buildRuleset,
  resolveWorkspace,
  parseModel,
};
