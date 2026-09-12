// Mio - LLM 域：服务商预设 / 单价表 / 钥匙串常量（纯数据，无副作用）
// B4-4 拆分：从 main.js 抽出。零行为变化。
// 预设值硬编码于主进程（PRD §5.3 / §6.3）：渲染层只拿「选项名 + 选中值」，不落盘明文 Key。
// 全部 OpenAI 兼容 /v1/chat/completions；Ollama 用户直接在「自定义」填 http://localhost:11434。

const LLM_PRESETS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  zhipu:   { label: '智谱',     baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  qwen:    { label: '通义',     baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  openai:  { label: 'OpenAI',   baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom:  { label: '自定义',   baseUrl: '', model: '' },
};
// 单价表（元 / 千 token，估算口径）：仅三家预设 + OpenAI 有价；自定义按 0 估算（LLM-7 / Q4）
const LLM_PRICING = {
  deepseek: { in: 0.001, out: 0.002 },
  zhipu:    { in: 0.001, out: 0.002 },
  qwen:     { in: 0.001, out: 0.002 },
  openai:   { in: 0.005, out: 0.015 },
  custom:   { in: 0, out: 0 },
};
// 钥匙串条目：service=mio-llm，account=当前 macOS 用户名 —— 真 key 永不进 IPC 返回值
const KEYCHAIN_SERVICE = 'mio-llm';

module.exports = { LLM_PRESETS, LLM_PRICING, KEYCHAIN_SERVICE };