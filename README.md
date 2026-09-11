# Mio · macOS 桌面陪伴机器人

对标蔚来 NOMI 的桌面端小机器人：一颗有生命感的深色玻璃球，常驻屏幕角落。

![idle](docs/shots/robot-idle.png)
![panel](docs/shots/panel-open.png)

## 快速开始

### 方式一：安装为 macOS 应用（推荐）

打开 `dist/Mio-1.5.0-arm64.dmg`，把 Mio 拖进 Applications 即可。
（本机已预装至 `/Applications/Mio.app`，启动台搜索 "Mio" 即可打开）

### 方式二：源码运行

```bash
cd mio
npm install        # 如 Electron 二进制下载失败，见下方"国内镜像"
npm start
```

国内镜像安装 Electron：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install
```

不想装 Electron 也可以直接用浏览器预览 `renderer/index.html`（自动降级为模拟数据）。

### 重新打包

Mio 无第三方运行时依赖，打包为纯系统工具手工流程（见下方"手工打包"），
不依赖 electron-builder。

## 功能

面板分四档标签：**常用 / 状态 / 清理 / 设置**。

**形象与桌面行为**

| 功能 | 交互 |
|------|------|
| 视线跟随 | 眼睛实时盯着全屏光标（可在设置里关掉） |
| 眨眼 / 呼吸 / 打瞌睡 | 自动，5 分钟无交互进入困倦（受「减弱动效」控制） |
| 开心 / 惊讶 / 好奇 | 单击（弯月眼 + 弹跳）/ 双击 / 悬停 |
| 大汗淋漓 | CPU ≥ 90% 自动触发，额头冒汗动画 |
| 拖拽移动 | 按住球体拖动，位置自动记忆（**按显示器分别记忆**） |
| 右键菜单 | 置顶开关 / 透明度 / 退出（与设置页写同一份配置） |
| 召唤 / 隐藏 | 全局快捷键 `⌥ + Space` |
| 看视频 / 演示时自动隐身 | 前台是播放器 / 演示 / 会议类应用时自动淡化，**名单可在设置里增删** |
| 手动隐藏 | 全局快捷键 `⌥ + H`，为全屏游戏等无法枚举的场景兜底 |
| 番茄钟 | 25 分钟专注 + 5 分钟休息，到时系统通知 |
| 健康提醒 | 久坐 / 喝水 / 护眼，统一调度 + 免打扰时段 |
| 整点报时 | 整点气泡报时，可设时段 |
| 开机自启动 | 设置里一键开关 |
| 深色 / 浅色主题 | 手动切换或跟随系统；**球体保持深色玻璃身份，只有面板换肤** |

**状态中心（常用标签）**

| 功能 | 交互 |
|------|------|
| CPU / 内存 / 磁盘 | 进度条 + 阈值配色（≥70% 橙、≥90% 红） |
| 实时趋势 | Canvas sparkline，CPU 与内存双线 |
| 内存细分与压力 | active / wired / compressed + 压力等级 |
| 网络 | 实时上下行速率 + 连接数 |
| 电池 | 电量、充电状态、预计续航 |
| 电池健康 | 健康度 · 循环次数 · 状态 · 适配器功率（可钻入） |
| 开机时长 | 来自 `kern.boottime` |
| Top 进程 | 支持按 CPU / 内存排序，可结束进程（多重保护） |
| 24 h 历史 | 采样曲线 + 今日峰值 |
| 消息中心 | 最多 200 条，可清空 |

**清理中心**

| 功能 | 交互 |
|------|------|
| 系统清理 | 六类白名单目录扫描，红/黄/绿分级，支持全选 |
| 大文件猎人 | `mdfind` 找 > 500 MB 文件，带最后使用时间 |
| 应用缓存排行 | `du` 统计 `~/Library/Caches/*` 体积排行 |
| 应用残留检测 | 对比已装应用，找出孤儿目录 |
| 智能建议引擎 | 磁盘告警、30 天未动的 `node_modules`、内存压力持续等 |
| 清理历史 | 累计释放空间与逐次记录 |
| 安全兜底 | 一律移入废纸篓、二次确认、路径白名单校验 |

**设置中心（独立标签，40+ 项）**

顶部有搜索框，按行匹配、命中组自动展开；分组用原生 `<details>` 折叠，折叠标题带状态摘要。

| 分组 | 内容 |
|------|------|
| 通用 | 开机自启动 · 启动后自动展开面板 |
| 外观与主题 | 主题（深色 / 浅色 / 跟随系统）· 球体尺寸（小 / 中 / 大）· 不透明度 · 始终置顶 · 视线跟随 · 点击穿透 · 减弱动效 · 显示在哪块屏幕 |
| 提醒与通知 | 整点报时 + 时段 + 是否发系统通知 · 健康提醒（久坐 / 喝水 / 护眼）· 免打扰时段 |
| 隐身 | 自动隐身开关 · 隐身不透明度 · **应用名单增删** · 添加当前前台应用 · 恢复默认 · `⌥H` 说明 |
| 关于 | 版本 · 数据存放位置 · 联网说明 · 隐私声明 |

> 后续版本会加入：剪贴板、天气、AI 助手（API 配置）、权限。见 `docs/07-设置中心-功能梳理.md`。

## 技术栈

| 层次 | 选型 | 说明 |
|------|------|------|
| 桌面运行时 | **Electron 33.4.11** | `electron@^33.0.0`，主进程即 Node.js，CommonJS 模块 |
| 渲染层 | **原生 HTML + CSS + JavaScript** | 无 React / Vue / TypeScript，**无构建工具**（没有 webpack / vite / babel，改完刷新生效） |
| 进程通信 | `ipcRenderer.invoke` / `.send` + `contextBridge` | `contextIsolation: true`、`nodeIntegration: false` |
| 图表 | **原生 Canvas 2D** | 两块 sparkline（实时趋势 216×36、24h 历史 216×40），无 ECharts / Chart.js |
| 动效 | **纯 CSS** | `transform` / `opacity` / `@keyframes`，走 GPU 合成 |
| 视觉 | `backdrop-filter: blur() saturate()` | 液态玻璃质感，**零图片素材**（球体、表情全部 CSS 绘制） |
| 应用图标 | 离屏渲染 `build/icon.html` → `sips` 多尺寸 → `iconutil` | 见「手工打包」 |
| 打包分发 | `ditto` + `PlistBuddy` + `codesign` + `hdiutil` | 纯系统工具链，**不用 electron-builder** |
| 第三方运行时依赖 | **0 个** | `dependencies` 为空；只用 `path` / `fs` / `os` / `child_process` 四个 Node 内置模块 |

代码规模约 **3,150 行**：`main.js` 977（主进程）、`renderer/app.js` 1,157（交互与状态机）、`renderer/style.css` 767（视觉）、`renderer/index.html` 212（结构）、`preload.js` 35（安全桥）。

## 架构

```
mio/
├── main.js            # 主进程：窗口、全局快捷键、右键菜单、IPC、系统采集、清理执行、通知
├── preload.js         # contextBridge 安全桥（24 个白名单方法，无任意 IPC 能力）
├── renderer/
│   ├── index.html     # 球体 + 三标签页面板（常用 / 状态 / 清理）+ 钻入式详情页
│   ├── style.css      # 液态玻璃样式 + 八种表情状态机 + 生命感动画
│   └── app.js         # 状态机 / 眨眼 / 视线跟随 / 番茄钟 / 提醒 / 清理与状态渲染
├── build/             # 图标源（icon.html 离屏渲染 → make-icon.js → icon.icns）
├── pack.sh            # 一键打包（组装 → 签名 → 安装 → 出 DMG）
├── dist/              # 产出物（Mio.app / Mio-1.3.0-arm64.dmg）
└── docs/              # 需求分析 / UI 设计 / 测试报告 / 增量 PRD / 截图
```

## 实现细节

### 窗口与交互

| 参数 | 值 | 作用 |
|------|-----|------|
| 尺寸 | `320 × 560`（详情档 `440 × 560`） | 双档对应面板 240 px / 360 px |
| `transparent` + `backgroundColor` | `true` + `#00000000` | 无背景的悬浮玻璃球 |
| `frame` / `resizable` / `fullscreenable` | 全 `false` | 无标题栏、尺寸锁定 |
| `alwaysOnTop` | `'floating'` + `setVisibleOnAllWorkspaces` | 浮于全屏应用之上 |
| `skipTaskbar` + `LSUIElement` | `true` | 不占 Dock、不进 ⌘Tab |
| `hasShadow` | `false` | 避免透明窗出现方形阴影 |

- **点击穿透**：窗口默认 `setIgnoreMouseEvents(true, { forward: true })`，
  渲染层监听 `mousemove`，指针进入可交互元素时经 IPC `mouse-interactive` 临时关闭穿透，
  离开后恢复——所以「球体以外整块透明区域」不会挡住底下的窗口
- **全局视线跟随**：主进程 80 ms 轮询 `screen.getCursorScreenPoint()`，
  经 `cursor` 事件广播给渲染层换算成瞳孔偏移（不依赖鼠标是否在窗口内）
- **双档过渡（v1.3 修复）**：`panel-expand` → 主进程 `setBounds({...}, false)`
  **瞬时改窗**，视觉过渡完全交给 CSS（`width .26s cubic-bezier(.22,1,.36,1)`）；
  过渡期间加 `.animating` 把 `backdrop-filter` 从 24 px 降到 10 px，
  避免每帧重算模糊导致的掉帧
- **钻入式详情页（v1.3 修复）**：卡片内容**不内联展开**，
  而是把 `.detail` 节点搬到 `#detailView` 覆盖整个面板（`translateX` 滑入 + `‹` 返回），
  从根上消除「展开后内容溢出视口」与「面板硬裁切」的问题
- **多显示器位置记忆（v1.4）**：位置按 `display.id` **分屏存储**；启动时按「光标所在屏」选址，
  记录越界（不在任何屏幕内）自动回退到该屏右下角；旧版单组 `x/y` 自动迁移，升级不跳位
- **智能隐身（v1.4）**：每 2 s 轮询前台应用 bundleid，命中播放器 / 演示 / 会议名单时
  把窗口透明度降到 12%——**淡出而非隐藏**，保留一丝存在感，鼠标移上去即可唤回
- **健康提醒统一调度（v1.4）**：久坐 / 喝水 / 护眼共用一个 1 分钟 tick，
  任意两次提醒间隔 ≥ 3 分钟，同时到点只发一条、其余顺延，避免通知轰炸

### 表情状态机

单个 class 切换：`mio--{idle|happy|curious|sleepy|surprised|thinking}`；
再叠加 `mio--hot`（CPU ≥ 90% 额头冒汗）、`mio--working`（番茄钟绿色轮廓）。
临时表情由 `setState(name, ms)` 计时后自动回落 `idle`；5 分钟无交互进入 `sleepy` 打瞌睡。

### IPC 通道

| 分组 | 通道 |
|------|------|
| 窗口与交互 | `mouse-interactive`、`context-menu`、`panel-expand`、`drag-start` / `drag-move` / `drag-end`、`cursor`（主→渲染） |
| 系统状态 | `system-stats`、`system-full`、`kill-process`、`history-get`、`messages-get` / `messages-clear` / `message-log`、`notify`、`quit` |
| 清理中心 | `clean-scan`、`clean-execute`、`clean-paths`、`clean-history-get`、`bigfiles-scan`、`cache-ranking`、`leftovers-scan`、`advice-get` |
| 设置（v1.4） | `settings-get`、`settings-set`、`login-set` |

### 系统数据采集

全部通过 `execSync` / `exec` 调用 macOS 系统命令，**不引入任何采集库**：

| 指标 | 命令 | 超时 |
|------|------|------|
| 内存占用 | `/usr/bin/vm_stat`（`active + wired + compressor`） | 3 s |
| 内存压力等级 | `/usr/bin/memory_pressure` | 3 s |
| 磁盘容量 | `/bin/df -k /` | 3 s |
| 电池 | `/usr/bin/pmset -g batt` | 3 s |
| 实时网速 | `/usr/sbin/netstat -ibn`（en0 链路层字节差分） | 3 s |
| 网络连接数 | `/usr/sbin/netstat -an \| /usr/bin/wc -l` | 3 s |
| 进程 Top10 | `/bin/ps -Ao pcpu,pmem,pid,comm -r` | 3 s |
| 开机时长 | `/usr/sbin/sysctl kern.boottime` | 3 s |
| 大文件 > 500 MB | `/usr/bin/mdfind -onlyin "$HOME" 'kMDItemFSSize > 524288000'` | 20 s |
| 文件元数据 | `/usr/bin/mdls -name kMDItemLastUsedDate -name kMDItemIsDownloaded` | 5 s |
| 目录体积 | `/usr/bin/du -sk` | 8 s 预算（超时即返回已统计部分） |
| 电池健康 | `/usr/sbin/system_profiler SPPowerDataType` | 8 s（**30 分钟缓存**，`ioreg` 在 AS 芯片上口径对不上） |
| 前台应用 | `/usr/bin/lsappinfo front` + `info -only bundleid` | 1.5 s（实测 8.5 ms/次，2 s 轮询） |

> ⚠️ **内存口径**：macOS 的 `os.freemem()` 把文件缓存也算作「已占用」，常年显示 99%。
> Mio 改用 `vm_stat` 的 `active + wired + compressor`，与「活动监视器」读数对齐。

### 数据持久化

全部落在 `app.getPath('userData')`（即
`~/Library/Application Support/mio-desktop-pet/`），**不写任何其他位置**：

| 文件 | 内容 | 容量控制 |
|------|------|----------|
| `mio-state.json` | 球体位置（**按显示器 id 分别记忆**）、置顶开关、透明度、设置项 | 单条覆盖写 |
| `mio-history.json` | 24 h 采样点（30 s 一次） | 超 950 KB 滚动裁剪，保底留 100 点 |
| `mio-messages.json` | 消息中心 | 最多 200 条 |
| `mio-clean-history.json` | 清理历史与累计释放统计 | 按条追加 |

### 安全模型

删除类操作是这个项目最大的风险面，共设了 6 道闸：

1. **进程隔离**：`contextIsolation: true` + `nodeIntegration: false`，
   渲染层零 Node 权限，只能调 `window.mio` 的 24 个白名单方法
2. **只进废纸篓**：一律 `shell.trashItem()`，**永不 `rm` / `rm -rf`**，误删可恢复
3. **路径白名单** `isBlacklistedPath()`：必须是 `$HOME/` 之下，
   且排除 `/System`、`/usr`、`/Library`、`~/Library/Containers`、
   `~/Library/Group Containers`、`~/Library/Keychains`、`~/Library/Mail`、
   `*Photos Library*` —— 展示与执行共用同一套校验
4. **扫描白名单** `SCAN_TARGETS`：只扫 6 个固定目录（用户缓存 / 日志 / npm 缓存 /
   pip 缓存 / Xcode DerivedData / 废纸篓），并分**红 / 黄 / 绿三级梯队**，绿色默认勾选
5. **结束进程三重限制**：`pid ≥ 200` + 16 个系统进程黑名单
   （`WindowServer`、`launchd`、`Finder`、`Dock`、`mds`、`mio`…）+ **只发 `SIGTERM`**，永不 `SIGKILL`
6. **二次确认**：清理按钮必须连点两次（文案变为「确认清理 N 项？」）才真正执行

### 开发自检

```bash
MIO_AUTOTEST=1 npm start
```

启动后自动走查核心交互并断言，日志输出 `V13_DETAIL` / `V13_DETAIL_BACK` /
`V13_SELECTALL` 等结果，结束时打印 `AUTOTEST_DONE`，截图落在 `docs/shots/`（打包版写在
`Mio.app/Contents/Resources/app/docs/shots/`）。

## 手工打包（无 electron-builder）

Mio 不依赖 electron-builder，`pack.sh` 用纯系统工具走完 7 步：

| 步骤 | 做法 | 关键点 |
|------|------|--------|
| 1. 挪旧包 | `mv dist/Mio.app /tmp/mio-app-prev-$TS` | 用 `mv` 替 `rm -rf`，留退路 |
| 2. 组装 | `ditto node_modules/electron/dist/Electron.app dist/Mio.app` | ⚠️ **必须用 ditto**：`cp -R` 会产出损坏 bundle，进程启动即秒退 |
| 3. 注入代码 | `cp main.js preload.js package.json` → `Contents/Resources/app/` | 进包的只有 5 个文件 |
| 4. 元信息 | `PlistBuddy` 写 `CFBundleName` / `CFBundleDisplayName` / `CFBundleIdentifier` / `CFBundleIconFile` / `CFBundleShortVersionString` / `CFBundleVersion` + `LSUIElement=true` | 版本号从 `package.json` 读取，**必须显式写入**，否则 plist 会残留 Electron 自带的 `33.x`；`LSUIElement` 是「不占 Dock」的关键 |
| 5. 重签 | `codesign --force --sign - dist/Mio.app` | ⚠️ adhoc 签名在改动 bundle 后失效，不重签会被 Gatekeeper 拒绝双击 |
| 6. 安装 | `ditto` 到 `/Applications` + `open` | 可选，`--install` |
| 7. 出 DMG | `hdiutil create -volname Mio -srcfolder <app + Applications 软链> -ov -format UDZO` | 可选，`--dmg` |

```bash
./pack.sh                # 只组装 + 签名
./pack.sh --install      # 组装 + 安装到 /Applications 并启动
./pack.sh --dmg          # 组装 + 重新生成 dist/Mio-<version>-arm64.dmg
```

图标单独生成：`build/icon.html` 离屏渲染 1024 px → `sips` 出多尺寸 → `iconutil` 打 `.icns`。

> **版本号唯一来源是 `package.json`。** `pack.sh` 会读它并同时写入
> `CFBundleShortVersionString` / `CFBundleVersion`，并据此生成 DMG 文件名。
> 发版时**只改 `package.json` 一处**即可。

## 已知问题与限制

| 问题 | 现象 | 说明 |
|------|------|------|
| `npm start` 带 `--no-sandbox` | 开发启动参数含 `--no-sandbox` | 仅为适配受限开发环境；**打包后的正式版不走这条路径** |
| ⚠️ **受限环境须先清空 `NODE_OPTIONS`** | 启动即报 `Cannot read properties of undefined (reading 'getPath')`，即主进程里 `require('electron')` 拿不到 `app` | 某些宿主会给所有 node 进程注入 `--require` 形式的 shim，它会污染**入口模块**的模块解析（同一份代码换个文件名就正常，极难定位）。启动前 `env -u NODE_OPTIONS` 即可。正式版从 Finder 双击启动不受影响 |
| 受限环境下进程列表为空 | 在沙箱/受限进程树中启动，「Top 进程」一片空白 | 宿主机禁用了 `ps`；从 Finder 正常双击启动无此问题 |
| 自动清理未实现 | 所有清理都需手动触发 | 已列入 v1.3 候选：仅放行绿色梯队 + 静默模式 + 可回溯 |
| 尚未签名公证 | 别人下载 DMG 会看到「无法验证开发者」 | 当前为 adhoc 签名。要分发给别人必须走 Developer ID 签名 + 公证（需 Apple 开发者账号），已提到路线图批次 3 |
| 设置中心尚未覆盖 | 剪贴板 / 天气 / AI / 权限四组还没有 | 随批次 2/3/4 加入，见 `docs/07-设置中心-功能梳理.md` |
