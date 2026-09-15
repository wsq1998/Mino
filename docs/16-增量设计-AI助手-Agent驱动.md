# 16 · 增量设计：AI 助手重构（agent 驱动执行 · opencode serve 引擎）

> 状态：**待评审** · 类型：**架构级增量变更 + 旧功能下线**（不是从零新建）
> 目标项目：Mio（macOS 桌面陪伴机器人，Electron 33.4.11）
> 关联：`11-增量PRD-v1.8.md`（其 G 组「AI 助手 = 单轮 LLM 聊天」**被本设计整体取代并下线**）· `15-增量设计-中转站浮窗.md`（**复用**其「一个 BrowserWindow 两形态」范式）· `14-功能设计方案-中转站-磁盘总览-太阳图.md`
> 硬约束：`package.json` 的 `dependencies` 必须保持为空；全项目唯一删除通道为 `shell.trashItem`（绝不 `rm`/`unlink`）；TCC 权限集中引导；不破坏现有功能。

---

## 0. 一句话方案总览

**把「AI 助手」从「一个只会说话的聊天框」重做成「一个能动手的执行体」。**

下线 v1.8 的 G 组单轮 LLM 聊天（云端 API + 自己管 key + 只发一句话回一段字），改为**以本地 `opencode serve` 为执行引擎的 agent 会话**：Mio 主进程**零依赖**（Node 内置 `fetch` + `child_process.spawn` + 手写 SSE 解析）作为 opencode 的客户端，把「意图 → 计划 → 工具调用 → 结果 → 需人类确认」这条**执行流**作为一等公民可视化出来。交互上做到**「一个键唤起、打一行字、回车就执行」**：复用中转站浮窗的「屏幕边缘胶囊 ⇄ 抽屉」形态承载助手窗口，Enter 提交、执行中可 ⏹ 中止、敏感操作弹权限卡、改文件弹 diff 卡。**Mio 既有的中转站（文件）、清理中心（磁盘）、状态中心（系统指标）、权限中心（TCC）从「独立卡片」变成 agent 可以调度的器官** —— 这是别的聊天助手抄不走的护城河。

全景新增：`1 个助手窗口 aiWin`（复用「两形态」范式）+ `1 个零副作用纯函数模块 main/ai/*` + `1 个独立渲染页 renderer/ai.*`；**删掉** `main/llm/presets.js` 与全部 `llm-*` IPC。零第三方依赖。

---

## 1. 为什么重做：旧 AI 助手的三个死穴

先把话说重一点，否则不值得动它。

| # | 死穴 | 现状证据（已读码） |
|---|------|------------------|
| 1 | **它没有手** | `llmChat(userText)` 只做一件事：把「system 人设 + 这一句」POST 给 OpenAI 兼容接口，回一段文本（`main.js:1495-1524`）。**不能读文件、不能跑命令、不能碰系统**。它和搜索引擎的差别只有语气。 |
| 2 | **它记不住、也不会** | 明确「不携带历史」（`main.js:1446`、PRD LLM-9）。每次都从零开始，做不了任何多步任务。 |
| 3 | **它在和 Mio 抢地盘，而不是长在 Mio 身上** | 它是「常用页里的一张卡片」（`index.html:154-163`）+「设置里第 7 组」(`index.html:497-530`)。和清理、中转站、状态**零协作**。用户要清理磁盘得去清理页，要问 AI 得回常用页 —— 两个世界。 |

**结论**：旧 AI 助手是「给桌宠装了个搜索引擎」，不是助手。重做不是优化，是**换物种**。

---

## 2. 产品定位：从「会说话的桌宠」到「有手的桌面代理」

### 2.1 一句话定位

> **Mio 助手 = 一个住在你屏幕边缘、随叫随到、能动手干活的本地执行体。**

不是聊天机器人（chatbot），是 **Agent Console（执行控制台）**。

### 2.2 四条颠覆性论点

**① 从「对话框」到「执行流」—— 呈现范式变了**
传统 AI 助手给你一列**聊天气泡**（你说的、它说的）。Mio 助手给你一条**执行流**：意图 → 计划 → **工具调用时间线**（读了哪个文件、跑了哪条命令、grep 到什么）→ 结果 → 要不要改。用户看的不再是「它说了什么」，而是**「它正在做什么、做到哪一步了」**。这一步是从「玩具」到「工具」的分水岭。

**② 从「孤岛」到「经脉」—— Mio 的器官变成 Agent 的能力**
别的聊天助手只有一个文本框和一张嘴。Mio 助手直接接管：
- **中转站 = 递给 Agent 的手**：把文件拖到助手窗口 = `FilePartInput`，Agent 立刻能读它、改它、分析它（§9.1）。
- **清理中心 / 状态中心 / 截图 / 番茄钟 = Agent 可调度的工具**（§9.2，P4）。
→ **这是护城河**：友商要抄，得先有一个攒了两年的 macOS 工具矩阵。

**③ 从「云端黑盒」到「本地可审计」—— 信任基础变了**
引擎跑在**你本机**的 `opencode serve`（127.0.0.1 + 随机端口 + 随机密码）。工具调用、文件读写、命令执行**全部在本机发生、全部可见**；敏感操作**显式弹卡**等你点「允许」。这是桌面 Agent 能被信任的前提，也是云端 API 那套给不了的。

**④ 从「你要去打开它」到「它一直在」—— 唤醒成本趋近于零**
复用中转站已经验证过的「边缘胶囊 + 全局热键」范式，助手在屏边常驻；一个热键、一行字、一个回车，完事。**唤醒成本 = 0 是 Agent 成为肌肉记忆的前提。**

---

## 3. 现状核实（已读码到行号）

> 📌 **行号快照声明**：本章以下所有 `main.js` 行号，均为 **v2.15 快照（commit `052babf`）实测值**。本设计落地时 `main.js` 顶部插入了 `const { HOTKEYS: HOTKEY_REGISTRY } = require('./main/core/hotkeys.js')`（现第 26 行），并用 `HOTKEY_REGISTRY.*` 替换了 3 处热键常量，行号已整体下移：**快照第 27 行起 +1，快照第 2410 行起再 +1（累计 +2）**（例：`DEFAULT_HOTKEY` 2410 → 2412）。P1 删除 `main/llm/*` 与 `llm-*` IPC 后还会再次漂移。**因此这些行号仅供定位参考，一律以符号名（函数 / 常量 / IPC 名）为准。**

### 3.1 待下线清单（旧 AI 助手）

| 层 | 内容 | 位置（行号已核对） |
|---|------|------------------|
| 数据模块 | `LLM_PRESETS / LLM_PRICING / KEYCHAIN_SERVICE` 纯数据文件 | `main/llm/presets.js`（整文件） |
| 主进程 require | `const { LLM_PRESETS, LLM_PRICING, KEYCHAIN_SERVICE } = require('./main/llm/presets.js')` | `main.js:28`（快照 `:27`）**← 已校正：快照号现指向 i18n require** |
| 主进程 钥匙串 | `keychainGet/Save/Delete`（`execFileSync('/usr/bin/security', …)`，service=`mio-llm`） | `main.js:100-130` |
| 主进程 LLM 逻辑 | 月度花费文件 `LLM_MONTH_FILE`、`llmMonthSpent/Add`、`costEstimate`、`llmErrorKind`、`llmRequest`、`llmChat`、`llmTest`、`llmGetConfig` | `main.js:1405-1560` |
| 主进程 IPC | `llm-get-config` / `llm-save-key` / `llm-delete-key` / `llm-test` / `llm-chat`（5 条） | `main.js:1562-1578`（快照 `:1561-1577`）**← 已校正：`llm-chat` 现落在 1578** |
| 主进程 自测 | `V18_LLM` / `V18_LLM_OFF` 断言块 | `main.js:3131-3170` |
| 桥接 | `llmGetConfig/SaveKey/DeleteKey/Test/Chat`（5 条） | `preload.js:99-104` |
| 桥接 mock | 预览模式 api mock 5 条 | `renderer/app.js:205-218` |
| 渲染 状态与配置 | `llmState`、`LLM_PRESETS_MAP`、`LLM_PRICING_LABEL`、`refreshLlmConfig`、`renderLlmConfig`、save/delete key、test | `renderer/app.js:295-400` |
| 渲染 摘要 | 设置摘要里 `ai: …` 一行 | `renderer/app.js:576` |
| 渲染 对话 | `chatLog` 追加、`sendChat` 等 | `renderer/app.js:3552-3591`；`renderer/app.js:3785` |
| 渲染 结构 | 常用页「问 Mio」卡片 `#chatCard`(`chatLog/chatInput/chatSendBtn/chatFoot/chatModel`) | `renderer/index.html:154-163` |
| 渲染 设置组 | G 组 `details[data-group="ai"]`（开关/服务商/BaseUrl/模型/Key/测试/长度/上限/人设） | `renderer/index.html:497-530` |
| 渲染 隐私文案 | 「未来开启 AI 对话后（发送你输入的内容到你配置的服务商）」 | `renderer/index.html:556` |
| 样式 | `.chat-log/.chat-empty/.chat-msg/.chat-user/.chat-bot/.chat-input-row` | `renderer/style.css:1337-1370` |
| 设置 schema | `ai: { enabled, provider, baseUrl, model, monthlyCap, maxTokens, persona }` | `main/core/settings.js:62-72` |
| 设置 收口 | `sanitizeSettings` 中 ai 字段白名单 | `main/core/settings.js:159` |
| 文档 | v1.8 PRD / 测试报告中的 B4-1 章节 | `docs/11-增量PRD-v1.8.md`、`docs/03-测试报告.md` |

> ⚠️ **注意**：`main/llm/` 目录删除后，`pack.sh` 的 `cp -R main …` 无需改动（目录少一个子文件夹不影响）。但 **`pack.sh` 必须新增注入 `renderer/ai.html|ai.js|ai.css`**（现在只 `cp` 指定的 `index.html style.css app.js` 等）—— 否则打包后助手窗口白屏（与 v2.1 中转站浮窗踩过的同一个坑）。

### 3.2 复用资产（不重写）

| 项 | 结论 | 位置 |
|---|------|------|
| 「一个窗口两形态」范式 | 胶囊 ⇄ 抽屉靠 class + 主进程 `setBounds` 形变，**已被中转站验证** | `main/core/stashPanel.js` / `renderer/stash.{html,js,css}` |
| 主题令牌 | `--mi-*` 单一来源，主窗口与浮窗共用 | `renderer/theme.css` |
| 热键体系 | `applyHotkey/restoreHotkey`；主窗口 `DEFAULT_HOTKEY='Alt+Space'`、保留键 `Alt+H`；中转站键；**集中式注册表 `HOTKEYS` / `validate()`**（唯一来源，注册前查表） | `main.js:2412,2429-2474`；`main.js:4026-4046`；`main/core/hotkeys.js` |
| 窗口生命周期铁律 | 任一窗口 `close` **必须拦截为 hide**；`isQuitting` 由 `before-quit` 置位；`window-all-closed` 空实现 | `main.js:49-52,253,3695-3703,4424,4426` |
| 窗口创建/托盘 | `createWindow` / `createStashWindow` / `createTray`（Tray 已存在） | `main.js:192,3660,4115` |
| 纯函数单测范式 | 几何/状态机抽成零副作用模块 + `node --test` | `main/core/stashPanel.js` + `test/stashPanel.test.js`（46 例） |
| 打包/签名 | `./pack.sh --dmg` | `pack.sh` |

---

## 4. 引擎：opencode serve（本机实测基线）

> 以下全部为**本机实测**（opencode **1.17.9**，二进制 `~/.opencode/bin/opencode`，配置 `~/.config/opencode/opencode.json` 已配 MiniMax-M3），非文档臆测。

### 4.1 启动与健康

```bash
opencode serve --port <随机> --hostname 127.0.0.1      # 默认 port=0（系统随机）
# 实测：GET /global/health → {"healthy":true,"version":"1.17.9"}
# 未设 OPENCODE_SERVER_PASSWORD 时日志警告 "server is unsecured"
```

- **必须指定端口**：默认 `--port 0` 是随机端口，Mio 拿不到 → 需 Mio 自己选一个空闲端口（`net.createServer` 探活后释放）再传入。
- **必须打开密码**：`env.OPENCODE_SERVER_PASSWORD=<随机>` ；用户名默认 `opencode`（可 `OPENCODE_SERVER_USERNAME` 覆盖）。HTTP Basic Auth。

### 4.2 API 基线（OpenAPI 3.1，`GET /doc`，实测 **151 个 path**）

| 用途 | 方法与路径 | 说明 |
|---|---|---|
| 健康 | `GET /global/health` | `{ healthy, version }` |
| **事件流（SSE）** | `GET /global/event` | `text/event-stream`；实测帧形如 `data: {"payload":{"id":"evt_…","type":"server.connected","properties":{}}}` |
| 创建会话 | `POST /session` | body `{ title?, agent?, model?, permission?, … }` |
| 发消息（等结果） | `POST /session/:id/message` | body 见 §4.3；返回 `{ info, parts }` |
| **发消息（不等待）** | `POST /session/:id/prompt_async` | body 同上，**无返回** → 配 SSE 用，UI 才能「边跑边显示」 |
| 中止 | `POST /session/:id/abort` | 返回 `boolean` |
| 会话列表/详情 | `GET /session` · `GET /session/:id` | 含 `title/cost/tokens/summary` |
| 待批权限 | `GET /permission` · `POST /permission/:requestID/reply` | 人类在手环 |
| 待答提问 | `GET /question` · `POST /question/:requestID/reply` · `/reject` | Agent 反问 |
| 变更 diff | `GET /session/:id/diff` | 改了文件就看它 |
| Agent 列表 | `GET /agent` | 实测返回 `[{name:"build", mode:"primary", permission:[…]}]` |
| 命令 / 技能 | `GET /command` · `GET /skill` | 斜杠命令 |
| 文件/检索 | `GET /file` · `/file/content` · `/find` · `/find/file` | Agent 已自带，UI 可选复用 |
| 工具清单 | `GET /experimental/tool?provider=&model=` | 给 UI 显示「它有哪些能力」 |
| 终端 | `POST /pty` · `GET /pty/:id` | 可做「真实终端」下沉能力 |

### 4.3 发消息的精确 body（实测 schema）

```jsonc
POST /session/{sessionID}/prompt_async
{
  "parts": [                       // 必需
    { "type": "text", "text": "把这三个截图里的表格整理成 md" },
    { "type": "file", "mime": "image/png", "url": "file:///…/a.png", "filename": "a.png" }
  ],
  "agent": "build",                // 选 agent（角色扮演/权限档位都在这）
  "model": { "providerID": "minimax", "modelID": "MiniMax-M3" },
  "system": "你是 Mio…",           // 单次人设注入（不落盘）
  "tools": { "bash": false },      // 按需关某工具
  "noReply": false
}
```

**Part 输入类型（实测）**：`text` / `file`(mime+url) / `agent`(name) / `subtask`(子任务)。
**Part 输出类型（实测）**：`TextPart` / `ReasoningPart`(思维链) / **`ToolPart`(工具调用)** / `FilePart` / `StepStartPart` / `StepFinishPart` / `SnapshotPart` / `PatchPart` / `RetryPart` / `CompactionPart`。

### 4.4 SSE 事件词表（实测 **87** 种，取关键）

这套事件名直接决定 UI 能做到多细：

| 阶段 | 事件 |
|---|---|
| **正文流式** | `session.next.text.started` → `.text.delta` → `.text.ended` |
| **思维链** | `session.next.reasoning.started` → `.delta` → `.ended` |
| **工具调用** | `session.next.tool.input.started` → `.input.delta` → `.input.ended` → `.tool.called` → `.tool.progress` → `.tool.success` / `.tool.failed` |
| **步骤** | `session.next.step.started` → `.step.ended` / `.step.failed` |
| **权限** | `permission.asked` → `permission.replied`（另有 `permission.v2.*`） |
| **提问** | `question.asked` → `question.replied` / `.rejected` |
| **会话态** | `session.status` · `session.idle` · `session.error` · `session.diff` |
| **消息/part** | `message.updated` · `message.part.updated` · `message.part.delta` |

→ **结论**：`tool.called/progress/success/failed` 四态 + `text.delta` + `reasoning.delta` **足以支撑 §6 的执行流卡片做实时更新**，无需轮询。

### 4.5 Agent 与权限（实测）

`GET /agent` 实测返回默认 `build` agent，其权限规则是 **opencode 自己的一套 ruleset**：

```jsonc
"permission": [
  { "permission": "*", "pattern": "*", "action": "allow" },
  { "permission": "doom_loop", "pattern": "*", "action": "ask" },
  { "permission": "external_directory", "pattern": "*", "action": "ask" },
  { "permission": "question", "pattern": "*", "action": "deny" },   // ← 注意：默认禁问
  …
]
```

→ `action ∈ {allow, ask, deny}`。**这是 Mio 安全策略的着力点**：Mio 在 `POST /session` 时用 `permission` 传入自己的 ruleset（如：工作区内 allow、工作区外 ask、危险命令 ask），把「Agent 能干什么」收口在 Mio 手里。

---

## 5. 交互设计：唤醒 → 输入 → 执行

> 目标**一句话**：**「按一个键 → 打一行字 → 回车 → 它就开始干活」**，全程不超过 3 秒到达「已开始执行」。

### 5.1 唤醒（三条路径，成本递减）

| 路径 | 触发 | 行为 |
|---|---|---|
| **A. 全局热键**（主） | 默认 `⌥ A`（`Alt+A`，A = Assistant；与主窗口 `Alt+Space`、兜底 `Alt+H`、中转站 `Alt+Shift+Space` **始终错开**，可配） | 任意 App 下按下 → 助手窗口在**上次使用的屏边**以「输入条态」滑出，**输入框自动聚焦**，光标已就绪 |
| **B. 边缘胶囊**（常驻） | 点/悬停屏边细条 | 展开为「面板态」，焦点进输入框 |
| **C. 拖拽即问**（杀手级） | 把文件/文本拖到胶囊或面板 | 自动唤起并**把内容变成 `FilePartInput`**，输入框预填「这个文件 …」的提示，用户只需补一句 |
| D. 划词（P3） | 选中文本按热键 | 带选中内容唤起（「解释这段」「翻译」） |

**热键冲突防护（集中式注册表）**：新增 `main/core/hotkeys.js` 作为**全局热键唯一来源**（纯数据 + 纯函数，零依赖，可被 `node --test` 单测）。任何时候注册/修改热键，都先调 `validate(accel, forOwner)` **统一查表**：被其他 owner 占用 → `kind:'conflict'` 硬拒绝；命中 macOS 系统保留组合 → `kind:'reserved'` 提示；非法串 → `kind:'invalid'`。拒绝时**不落地、回滚旧值**并走 i18n 系统通知（沿用 `main.js:4026` / `4036-4054` 的既有回滚范式，但互斥判断收敛到注册表，不再散落在各注册函数里）。

> 旧写法把互斥靠各处硬编码 `next === DEFAULT_HOTKEY` 判断，新增一个热键就要在 N 处补 N 个 `if`，极易漏（本设计初稿把 AI 键写成 `⌥ Space` = `Alt+Space` 与主窗口撞车，正是这类漏网）。注册表把「谁占了哪个键」变成唯一表格 + 一次 `normalize` 归一化比较（`Shift+Alt+Space` 与 `Alt+Shift+Space` 判等），从机制上杜绝再撞车。

#### 5.1.1 全局热键冲突矩阵

`main/core/hotkeys.js` 的 `HOTKEYS` 为唯一来源；下表是它的可读镜像（改表必须同步此处）。「可配」= 用户可在设置里改；「自留」= 恒定占用、不可被任何功能覆盖。

**Mio 自有热键（4 个，两两互斥）**

| 归属 | owner key | 默认值 | 快捷键 | 自留 / 可配 | 说明 |
|---|---|---|---|---|---|
| 主窗口召唤 | `mainWindow` | `Alt+Space` | `⌥ Space` | **可配**（设置 → 召唤键） | `main.js` `DEFAULT_HOTKEY` |
| 手动隐藏兜底 | `reserved` | `Alt+H` | `⌥ H` | **自留**（不可覆盖） | `main.js` `RESERVED_HOTKEY`，恒定注册 |
| 中转站浮窗 | `stash` | `Alt+Shift+Space` | `⌥ ⇧ Space` | **可配**（设置 → 中转站热键） | `main.js` `DEFAULT_STASH_HOTKEY` |
| **AI 助手唤起** | `ai` | `Alt+A` | `⌥ A` | **可配**（设置 → AI 助手热键） | A = Assistant / Agent，左手单手可及 |

**需避开的 macOS 系统 / 高概率占用组合**（`MACOS_RESERVED`，注册前统一拦截）

| 组合 | 快捷键 | 占用方 |
|---|---|---|
| `Cmd+Space` | `⌘ Space` | Spotlight 聚焦搜索 |
| `Ctrl+Space` | `⌃ Space` | 输入法切换（几乎必冲突） |
| `Cmd+Option+Space` | `⌘ ⌥ Space` | Finder 搜索窗口 |
| `Cmd+Shift+Space` | `⌘ ⇧ Space` | 部分 App 全局搜索 / 字符检视 |
| `Cmd+Tab` | `⌘ ⇥` | 切换应用 |
| `Cmd+Shift+3` / `4` / `5` | `⌘ ⇧ 3/4/5` | 截图 / 录屏工具 |
| `Ctrl+↑` / `↓` / `←` / `→` | `⌃ ↑↓←→` | Mission Control / 切换全屏空间 |
| `Cmd+Option+Esc` | `⌘ ⌥ ⎋` | 强制退出应用 |
| `Ctrl+Cmd+Q` | `⌃ ⌘ Q` | 锁定屏幕 |
| `Cmd+H` / `M` / `W` / `Q` | `⌘ H/M/W/Q` | 隐藏 / 最小化 / 关闭 / 退出 |
| `Cmd+Option+H` / `D` | `⌘ ⌥ H/D` | 隐藏其他应用 / 显示隐藏 Dock |

**结论**：AI 助手默认取 `⌥ A`（`Alt+A`）—— 不与任一自有键、任一系统保留组合重叠；语义可记（Assistant / Agent）；`⌥` 与 `A` 都在左手位，比 `Alt+Space` 更顺手，且 macOS 上几乎无 App 占用 `⌥ A`。

### 5.2 输入与执行

```
┌─────────────────────────────────────────────────────────┐
│  ⌥A 唤起                                                 │
│  ┌───────────────────────────────────────────────────┐  │
│  │ ⟩ 把这三张截图整理成一个 markdown 表格        ⏎   │  │  ← 输入条（单行，1~5 行自适应）
│  └───────────────────────────────────────────────────┘  │
│    Enter 执行 · Shift+Enter 换行 · / 命令 · @ 引用文件   │
└─────────────────────────────────────────────────────────┘
```

| 键 | 行为 |
|---|---|
| **`Enter`** | **提交并执行**（核心）。空输入不发。 |
| `Shift+Enter` | 换行（输入条自动增高，上限 5 行） |
| `Esc` | 执行中 = 收起面板（**不停任务**）；空闲 = 收起 |
| `⌘.` / 点 ⏹ | **中止**当前执行 → `POST /session/:id/abort` |
| `/` | 弹出斜杠命令面板（`GET /command` → `POST /session/:id/command`） |
| `@` | 弹出引用选择器（中转站条目 / 工作区文件 → `FilePartInput`） |
| `↑` / `↓` | 浏览历史提交（本地最近 50 条，只存文本） |

**执行中的三种输入策略**（明确取舍）：
1. **默认排队（推荐）**：执行中再回车 → 输入进入「待发队列」，当前 turn 结束后自动发出。符合「我想到一句就补一句」的直觉。
2. `⌘Enter` = **插话打断**：中止当前，立刻带着新输入重开。
3. 队列可视：输入条上方显示小胶囊「1 条待发 · 点此取消」。

### 5.3 执行反馈（关键体验）

| 时刻 | 反馈 |
|---|---|
| 提交瞬间 | 输入条 → 收起为「运行中条」：`⏺ 正在思考…  ⏹` + 胶囊状态点转脉冲 |
| 工具开始 | 执行流里**立刻插入一张工具卡**（pending → running 转圈） |
| 工具结束 | 卡片变 ✅/❌，可点开看输入/输出 |
| 正文流式 | 逐字出现；底部「停止生成」 |
| 完成 | 状态点回呼吸；系统提示音（可关）；可选「发系统通知」（你切走了也能知道） |
| 需权限 | **执行流内联红色权限卡**（§6.4），不弹系统窗 |
| 出错 | 内联错误卡（401 / 超时 / 网络 / 工具失败），**不崩、不静默** |

### 5.4 交互时序（首轮）

```
用户            渲染层(ai.js)        主进程(main.js)        opencode serve
 │  按 ⌥A          │                     │                    │
 ├────────────────>│ 显示输入条(动画)     │                    │
 │  打字 + Enter   │                     │                    │
 ├────────────────>│ ai-send ───────────>│ 懒启动/复用引擎 ───>│ (GET /global/health)
 │                 │                     │ 确保 session ──────>│ POST /session
 │                 │                     │ prompt_async ──────>│ POST /session/:id/prompt_async
 │                 │<── ai-event(SSE) ───│<── /global/event ──│  session.next.text.delta
 │  看到逐字输出    │  (逐帧重绘执行流)    │   (SSE 解析→转发)   │  session.next.tool.called
 │ 点⏹ / 等完成    │                     │                    │  …tool.success
 │                 │                     │                    │  session.idle
```

---

## 6. UI 设计

### 6.1 形态：三态一体（一个窗口）

沿用中转站已验证的范式：**一个 `BrowserWindow`，靠 class + 主进程 `setBounds` 在三种形态间形变**（不拆窗口 —— 输入焦点、拖拽会话必须在同一 `webContents` 内）。

| 形态 | 尺寸（典型） | 用途 | 视觉 |
|---|---|---|---|
| **胶囊态** `ai--capsule` | 贴边细条 6px | 常驻、零打扰；状态点呼吸 | 与中转站胶囊同族，但**状态点**不同色 |
| **输入条态** `ai--bar` | 宽 ~560 / 高 ~64 | **唤醒后的默认态**；只干一件事：让你打字 | 单行输入 + 大 Enter 提示，专注到极致 |
| **面板态** `ai--open` | 侧抽屉 420×~640 / 货架 980×~360 | 看执行流、权限卡、历史 | 完整执行流 + 输入条固定在底部 |

**四向复用**：left/right（侧抽屉，纵向）、top/bottom（横向货架，宽度沿用 v2.15 的 980 上限）。设置项 `ai.edgeSide` 与中转站各自独立。

**状态点语义**（一眼看懂它现在能不能理你）：

| 态 | 视觉 |
|---|---|
| 空闲 | 呼吸微光（蓝） |
| 执行中 | 快速脉冲（蓝→亮） |
| **待你确认** | **常亮红**（有权限卡/提问卡等你） |
| 出错 | 常亮橙 |

### 6.2 核心组件：执行流（Execution Stream）

**这是和所有聊天助手的分水岭。** 一个 assistant turn 不是「一句回复」，而是一条**可展开的流**：

```
╭─────────────────────────────────────────────────────────────╮
│ ▸ 整理三张截图的表格            2.3s · ↑1.2k ↓380 tokens  ⌄ │  ← turn 头（意图摘要 + 耗时/用量）
├─────────────────────────────────────────────────────────────┤
│  🔧 读取 截屏 A.png                                    ✅ 0.2s │  ← 工具卡（ToolPart）
│  🔧 读取 截屏 B.png                                    ✅ 0.2s │
│  🔧 读取 截屏 C.png                                    ❌ 超时 │  ← 失败态可见、可重试
│  🔧 写入 表格.md                        +42 −0  ⤢ 看 diff ✅ 0.1s│
├─────────────────────────────────────────────────────────────┤
│  已整理 2 张（第 3 张读取超时，已跳过）。      [复制] [打开文件] │  ← 正文（Markdown 渲染）
│  表格如下： …                                                │
╰─────────────────────────────────────────────────────────────╯
```

**设计要点**
- **默认折叠工具卡**，只留一行「动作 + 状态 + 耗时」；点开才看输入/输出（避免长输出淹没有效信息）。
- **失败不隐藏**：❌ 与原因并列显示（超时/权限/401），并提供「重试这一步」。
- 写的文件带 `+42 −0` 与 **`⤢ 看 diff`**。
- 头部汇总**用量**（tokens/耗时）而非花钱（引擎本地，成本由 provider 侧管）。
- 正文与工具**视觉分层**：工具是「过程」，正文是「结论」。

### 6.3 组件清单

| 组件 | class | 说明 |
|---|---|---|
| 助手根 | `#aiRoot` | 三态 class 承载 |
| 胶囊 | `.ai-capsule` + `.ai-status-dot` | 常驻 + 状态点 |
| 输入条 | `.ai-bar` / `.ai-input` | 自适应 1~5 行 |
| 执行流 | `.ai-stream` | 滚动容器 |
| turn | `.ai-turn` / `.ai-turn-head` | 一轮执行 |
| 工具卡 | `.ai-tool`（`.is-running/.is-ok/.is-fail`） | ToolPart 渲染 |
| 正文 | `.ai-text`（Markdown） | TextPart 渲染 |
| 思维链 | `.ai-reasoning`（默认收起） | ReasoningPart |
| 权限卡 | `.ai-perm`（危险色） | §6.4 |
| 提问卡 | `.ai-question` | Agent 反问 |
| diff 卡 | `.ai-diff` | PatchPart / `GET /session/:id/diff` |
| 待发队列 | `.ai-queue` | §5.2 |
| 提示条 | `.ai-toast` | 复用中转站 toast |
| 空态 | `.ai-empty` | 引导「按 ⏎ 执行 / 拖文件进来」 |

### 6.4 权限卡（安全的关键 UI）

Agent 要干敏感操作（写工作区外、跑危险命令）时，**内联一张红色卡**，而不是弹系统窗：

```
╭──────────────────────────────────────────────────╮
│ ⚠️  Mio 想执行一条命令                            │
│                                                  │
│  rm -rf ~/Library/Caches/foo                     │
│  目录：~/Downloads   （工作区外 ⚠️）              │
│                                                  │
│  [ 允许一次 ]  [ 本会话总是允许 ]  [ 拒绝 ]        │
╰──────────────────────────────────────────────────╯
```

- 三个动作分别映射 `POST /permission/:requestID/reply` 的 **once / always / reject**。
- 「拒绝」要**回写一句人类可读的理由给 Agent**，避免它原地打转（映射到 opencode 的 reject 语义）。
- 硬约束呼应：**「拒绝」不等于 Mio 去删东西** —— Mio 从不自己删，只否决 Agent 的请求。若 Agent 请求的是删除，走的是 opencode 自己的 trash 策略 + Mio 的 ruleset，与 Mio 的 `shell.trashItem` 铁律不冲突（Mio 不实现删除工具）。

### 6.5 视觉语言

- **完全沿用** `renderer/theme.css` 的 `--mi-*` 令牌与主窗口液态玻璃语言（禁止另造色值）。
- 助手窗口是**独立页面** `renderer/ai.html`（与 `stash.html` 同构），共用 `theme.css` + 新增 `ai.css`。
- 复用 `--st-reduce-motion` 同款减弱动效开关。
- 工具卡图标用 Emoji/字符（零依赖），不用图标库。

---

## 7. 技术架构

### 7.1 进程与模块

```
┌──────────────────────── Electron 主进程 (Mio) ─────────────────────────┐
│                                                                       │
│  main/ai/engine.js   —— 引擎生命周期（零依赖）                          │
│    · discover(): 探测 opencode 可执行文件                              │
│       1) 设置 ai.enginePath  2) which/probe 常见路径                     │
│          ~/.opencode/bin/opencode · /opt/homebrew/bin · /usr/local/bin  │
│    · pickPort(): net.createServer(0) 取空闲端口后释放                    │
│    · start(): spawn(opencode, ['serve','--port',P,'--hostname','127.0.0.1']│
│               env: { OPENCODE_SERVER_PASSWORD: <随机32> })              │
│    · waitHealthy(): 轮询 GET /global/health（≤8s，间隔 300ms）           │
│    · stop(): SIGTERM → 3s 后 SIGKILL；App 退出必调                       │
│    · 复用策略：进程活着就复用；空闲不杀（保会话上下文）                    │
│                                                                       │
│  main/ai/client.js   —— HTTP/SSE 客户端（零依赖）                        │
│    · req(): 手写 fetch + Authorization: Basic                       │
│    · createSession / sendPromptAsync / abort / listAgents / …          │
│    · subscribeEvents(): fetch('/global/event') → ReadableStream 逐行解析 │
│        → 回调 onEvent(evt)  ──► webContents.send('ai-event', evt)      │
│                                                                       │
│  main/ai/ruleset.js  —— 纯函数：把 settings.ai 收口成 opencode permission │
│                         ruleset（工作区 allow / 外部 ask / 危险 ask）      │
│                                                                       │
│  main/ai/state.js    —— 纯函数：会话/窗口状态机（可 node --test）          │
│                                                                       │
│  IPC（main.js 注册，见 §7.3）                                          │
└───────────────────────────────────────────────────────────────────────┘
                    ▲ curl/fetch(127.0.0.1:P, Basic)   │ SSE
                    │                                   ▼
         ┌──────────────────────────────────────────────────────┐
         │  opencode serve (1.17.9) —— 本机子进程                 │
         │  · agent(build) + tools + permission + MCP + LSP      │
         │  · 会话/消息/工具/权限/提问/文件/VCS                   │
         └──────────────────────────────────────────────────────┘
```

### 7.2 硬约束对齐（零第三方依赖怎么落地）

| 能力 | 零依赖实现 |
|---|---|
| 起进程 | `child_process.spawn`（Node 内置） |
| HTTP | 全局 `fetch`（Node 18+/Electron 33 内置） |
| **SSE** | `fetch(url).body.getReader()` + 手写「按 `\n` 分行、取 `data:` 前缀、`JSON.parse`」；**不引 `eventsource` 包** |
| 找空闲端口 | `net.createServer().listen(0)` → 读 `.address().port` → `close()` |
| 密码 | `crypto.randomBytes(24).toString('base64url')`（Node 内置） |
| 探测可执行文件 | `fs.existsSync` + `fs.accessSync(X_OK)`（不 `which`） |
| 单测 | `node --test`，纯函数层可脱离 Electron 跑 |

> **为什么不用 `@opencode-ai/sdk`**：它会把 `dependencies` 撑破（硬约束 1）。手写客户端在这个 API 规模下是可控的（5 个方法 + 1 个 SSE 解析器）。

### 7.3 IPC 设计（草案）

| 通道 | 方向 | 载荷 | 返回 | 说明 |
|---|---|---|---|---|
| `ai-engine-status` | invoke | — | `{ available, version?, running, port?, error? }` | 给设置页/首启引导 |
| `ai-engine-start` | invoke | — | `{ ok, version?, error? }` | 手动拉起（首启） |
| `ai-engine-stop` | invoke | — | `{ ok }` | 手动停 |
| `ai-session-create` | invoke | `{ title?, agent?, model? }` | `{ ok, session }` | 惰性：首次发送时才建 |
| `ai-session-list` | invoke | — | `{ ok, sessions }` | 历史 |
| `ai-session-resume` | invoke | `{ sessionID }` | `{ ok, messages }` | 恢复历史 |
| **`ai-send`** | invoke | `{ sessionID?, text, parts? }` | `{ ok, sessionID, messageID }` | 走 `prompt_async`；sessionID 缺省则内部新建 |
| **`ai-abort`** | invoke | `{ sessionID }` | `{ ok }` | ⏹ |
| `ai-permission-list` | invoke | — | `{ ok, requests }` | 备用（主要靠 SSE） |
| **`ai-permission-reply`** | invoke | `{ requestID, reply }` | `{ ok }` | once/always/reject |
| `ai-question-reply` | invoke | `{ requestID, reply }` | `{ ok }` | Agent 反问 |
| `ai-diff` | invoke | `{ sessionID }` | `{ ok, diff }` | 变更预览 |
| `ai-agents` | invoke | — | `{ ok, agents }` | 角色选择 |
| `ai-commands` | invoke | — | `{ ok, commands }` | `/` 面板 |
| **`ai-event`** | 主→渲 | `{ type, payload }` | — | SSE 转发（唯一推送通道） |
| `ai-window-*` | send | — | — | 显示/收起/pin（镜像 `v2-stash-panel-*`） |

**安全铁律**：**端口与密码永不进渲染层**。渲染层只能通过 `ai-*` IPC 间接说话；渲染页设 CSP，禁止其直接 `fetch` 到引擎。

### 7.4 安全设计

| 面 | 措施 |
|---|---|
| 网络 | 只 `127.0.0.1`；随机端口；`OPENCODE_SERVER_PASSWORD` 随机；密码仅存主进程内存 |
| 目录 | Agent 的工作目录 = `settings.ai.workspace`（默认 `~/Mio Workspace`，不存在则创建）；**工作区外访问走 `ask`**（ruleset 收口，§4.5） |
| 危险操作 | 删除类/外部目录/`doom_loop` 一律 `ask` → 弹权限卡；**Mio 自身永不实现删除工具** |
| 数据 | 对话历史由 opencode 自己落盘（`~/.local/share/opencode`），Mio 不另存；Mio 侧只存最近 50 条提交文本（`ai.recent`），可一键清空 |
| 凭据 | Key 由 **opencode 自己管**（`~/.config/opencode/opencode.json` / `opencode auth`）；**Mio 不再碰钥匙串** → 净删 30 行钥匙串代码，攻击面缩小 |
| 生命周期 | App 退出 `before-quit` → `engine.stop()`（SIGTERM→SIGKILL），不留孤儿进程 |

### 7.5 引擎可用性策略（重要决策）

| 情况 | 行为 |
|---|---|
| 未装 opencode | 「AI 助手」设置组顶部显示 **未检测到引擎** + 「已探测路径」+ 安装指引（复制命令）。助手入口**隐藏**（不改用降级聊天）。 |
| 装了但启动失败 | 内联错误卡（端口占用/权限/超时）+ 「重试」+ 「查看日志」（`--print-logs`） |
| 运行中断开 | SSE 断开自动重连（指数退避）；重连后 `GET /session/:id` 补状态，UI 不丢 |
| 用户不想用 | `ai.enabled=false` → 胶囊/热键/入口全隐藏，引擎不启动（**零常驻开销**） |

> **明确取舍**：**不做「无引擎降级为单轮 LLM」**。理由：那会把「有手的代理」稀释回「聊天框」，破坏定位；且要重新引入 key 管理。宁可要求装引擎。

---

## 8. 设置项重构（替换 G 组）

```jsonc
// main/core/settings.js —— 替换原 ai 组（62-72 行）
ai: {
  enabled: false,              // 总开关；关 → 不启引擎、不显示入口
  enginePath: '',              // 空 = 自动探测
  autoStart: true,             // 首次需要时自动拉起引擎
  workspace: '',               // 空 = ~/Mio Workspace
  agent: 'build',              // 默认 agent（角色）
  model: '',                   // 空 = 用 opencode 配置里的默认模型
  edgeSide: 'right',           // top|bottom|left|right（独立于中转站）
  showCapsule: true,           // 常驻边缘胶囊
  hotkey: 'Alt+A',             // 见 §5.1 / §5.1.1：默认 ⌥A，与既有键及系统保留组合错开（实际存 accelerator 串，注册前经 main/core/hotkeys.js 校验）
  notifyOnDone: true,          // 完成后发系统通知（切走了也知道）
  recent: []                   // 最近提交文本（≤50，本地，可清空）
}
```
**移除**：`provider / baseUrl / model(旧语义) / monthlyCap / maxTokens / persona`（云端那套）→ 钥匙串相关代码一并删除。

**设置组 UI 重构**：G 组标题从「AI 助手（LLM 聊天）」改为「**AI 助手（本地 Agent）**」，字段替换为：启用 / 引擎状态卡（含版本、路径、测试按钮）/ 工作区（选择目录）/ 角色 / 模型 / 触发边 / 常驻胶囊 / 热键 / 完成通知 / 清除历史。**保留并在隐私说明里改写**：不再提「发送到你配置的服务商」，改为「**所有执行都在你本机的 opencode 引擎内完成，仅在你配置的模型服务商处调用大模型**」。

---

## 9. 与 Mio 既有能力的合流（护城河）

> 这一节是**颠覆性**的核心：让攒了两年的工具矩阵变成 Agent 的器官。

### 9.1 中转站 → Agent 的手（P3）

| 联动 | 实现 |
|---|---|
| 拖文件到助手窗口 | `drop` → `getPathForFile` → `FilePartInput{ mime, url: 'file://'+path }` → 直接进 `parts` |
| 助手引用中转站条目 | `@` 选择器列出 `stash.list()`（渲染层只传 `id`，主进程查表还原路径 —— **沿用中转站 ID-only 安全规则**） |
| Agent 产出 → 中转站 | 工具卡「存入中转站」按钮 → 复用 `stash.add` |

**体验**：拖三张图进去 + 一句「整理成表格」，Agent 直接开工。这是「有手」最直观的体现。

### 9.2 Mio 能力 → Agent 的工具（P4，真正的杀手锏）

把 Mio 的既有能力**注册成 opencode 的 MCP 工具**（opencode 支持 `POST /mcp` 动态添加，`pack.sh` 已有注入 `main/` 的基础）：

| Mio 能力 | 变成工具 | Agent 能干什么 |
|---|---|---|
| 清理中心（`main/clean/targets.js`） | `mio_clean_scan` / `mio_clean_plan` | 「帮我看看磁盘什么最能清」「清掉缓存但别动大文件」 |
| 状态中心（CPU/内存/磁盘/电池） | `mio_sys_status` | 「我现在电脑卡吗，为什么」 |
| 中转站 | `mio_stash_add/list` | 「把这三个文件收进中转站」 |
| 截图 / 番茄钟 / 闹钟 | `mio_screenshot` / `mio_pomodoro` | 「截个屏然后解释」「25 分钟后叫我」 |

→ **别的助手只有一张嘴；Mio 助手有一整间工具房。** 这一步做完，「桌宠 + 系统工具 + Agent」三合一，产品形态才算真正立住。

---

## 10. 分期实施

| 期 | 目标 | 交付物 | 判定 |
|---|---|---|---|
| **P1 · MVP** | 引擎跑起来 + 能「打字→回车→看到流式结果」 | `main/ai/{engine,client}.js`、`renderer/ai.{html,js,css}`、助手窗口（输入条+面板）、`ai-send/abort/engine-status` IPC、SSE 转发、文本流式、工具卡、五条 CSS 单测 | 一句话能让 Agent 读文件并回答；⏹ 能中止 |
| **P2 · 可信** | 人类在手环 | `ruleset.js`、权限卡、提问卡、diff 卡、`/` 命令、`@` 引用、错误卡 | 敏感操作必弹卡；拒绝后 Agent 不空转 |
| **P3 · 合流** | 与 Mio 器官打通 | 中转站拖入/引用/回存、划词唤起、多会话与历史恢复、完成通知 | 拖文件进去能直接干活 |
| **P4 · 颠覆** | Agent 反向驱动 Mio | MCP 工具注册（清理/状态/截图/番茄钟…）、托盘常驻、语音输入 | Agent 能「命令 Mio 做事」 |

**P1 即可交付价值**（已经是「有手」的雏形），后续每期都在加厚护城河。

---

## 11. 验收标准

**P1**
- [ ] 首次点助手 → 自动探测引擎、拉起、`/global/health` 通过；版本号显示正确
- [ ] `⌥A` 在**任意 App** 下能唤起输入条并**自动聚焦**；`Esc` 收起
- [ ] 输入 + `Enter` → 30s 内看到**逐字流式**输出；`⏹` 能在 2s 内中止（`session.idle`）
- [ ] 工具调用出现 `.ai-tool` 卡，四态（pending/running/ok/fail）由 SSE 实时驱动
- [ ] **关闭 App 后无残留 opencode 进程**（`osascript ... lsappinfo`/`lsof` 验证）
- [ ] 全量 `npm test` 绿；`pack.sh --dmg` 产物含 `renderer/ai.*`（防白屏）
- [ ] 硬约束：`dependencies` 仍为空；全仓 grep 无新增 `rm/unlink`

**P2**
- [ ] 请求工作区外/危险命令 → **内联权限卡**（不弹系统窗）；三个动作回写正确
- [ ] 拒绝后 Agent 收到理由且不重试同一动作
- [ ] 改文件 → 出现 diff 卡，`+n −m` 正确

**P3/P4**
- [ ] 拖文件到面板 → 自动成 `FilePartInput`，Agent 能读到内容
- [ ] P4：以「查一下我磁盘为什么满」触发 `mio_clean_scan` 工具调用

---

## 12. 风险与取舍

| 风险 | 影响 | 取舍 / 缓解 |
|---|---|---|
| **opencode API 处于演进中**（151 path 里有 `experimental/*`；SDK 文档标注 experimental） | 升级可能打破契约 | ① 只依赖 §4.2 的**稳定子集**（session/message/event/permission）；② 启动时校验 `/global/health` 的 version，不匹配给提示；③ 客户端层做**版本适配垫片** |
| 引擎是重进程（二进制 ~129MB，内存不低） | 常驻占用 | **懒启动 + 用时才起**；`ai.enabled=false` 绝不启动；空闲可选 30 分钟回收（默认不回收以保上下文） |
| 与现有热键撞车 | 快捷键失效 | 统一走 `main/core/hotkeys.js` 集中式注册表：注册前 `validate(accel, forOwner)` 查表，被其他 owner 占用（conflict）或命中 macOS 系统保留组合（reserved）即拒绝并回滚旧值 + 系统通知 |
| 打包漏注入 `renderer/ai.*` | 助手窗口白屏 | pack.sh 显式 cp + 验收项（§11）守卫 |
| 本地模型能力参差 | 体验波动 | 不绑定模型；用 opencode 既有配置；UI 不承诺能力，只承诺「可见可控」 |
| 权限卡被用户「总是允许」滥用 | 安全弱化 | `always` 只作用于**当前会话**，不落盘为永久规则；重启回到 `ask` |

---

## 13. 待决问题（评审时定）

| # | 问题 | 倾向 |
|---|---|---|
| Q1 | 助手窗口是**独立第三窗**，还是与中转站**共用一个窗口**（切 tab）？ | **独立窗**。理由：二者生命周期/热键/形态语义不同；共用会让状态机爆炸 |
| Q2 | 默认热键取什么？ | **`⌥ A`（`Alt+A`）** —— 与主窗口 `Alt+Space`、兜底 `Alt+H`、中转站 `Alt+Shift+Space` 全部错开，且不占用任何 macOS 系统保留组合（Spotlight `⌘Space`、输入法 `⌃Space` 等）；A = Assistant/Agent 语义可记、左手单手可及。已落地为 `main/core/hotkeys.js` 的 `HOTKEYS.ai`，最终以实机冲突检测为准 |
| Q3 | 输入条态与面板态的**切换手势**？ | 输入条态按 `↑` 或点「展开」→ 面板态；面板态 `Esc` 回到输入条态，再 `Esc` 收起 |
| Q4 | 是否保留「无引擎时降级为单轮 LLM」？ | **不保留**（§7.5）。会稀释定位并复活 key 管理 |
| Q5 | 会话粒度：一个全局会话 vs 一会话一任务？ | **默认单会话 + 可新建**（P3 加多会话）。频繁新建会丢上下文，对桌宠助手不划算 |
| Q6 | 是否在 P1 就做思维链（ReasoningPart）展示？ | P1 只**折叠显示**（默认收起），P2 再做「思考中…」的展开体验 |

---

## 附：本设计的“一句话电梯陈述”

> 旧助手是给桌宠装了个搜索引擎；新助手是**给桌宠装上了手脚，并把整间工具房交给它**。它住在屏边，一个键叫来，一行字交代，回车就干，边干边让你看见，危险处停下来问你 —— 全部跑在你自己电脑上。
