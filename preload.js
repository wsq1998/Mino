const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mio', {
  setInteractive: (v) => ipcRenderer.send('mouse-interactive', v),
  contextMenu: () => ipcRenderer.send('context-menu'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  getStats: () => ipcRenderer.invoke('system-stats'),
  getFullStats: () => ipcRenderer.invoke('system-full'),
  cleanScan: () => ipcRenderer.invoke('clean-scan'),
  cleanExecute: (ids, sizes) => ipcRenderer.invoke('clean-execute', ids, sizes),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  quit: () => ipcRenderer.send('quit'),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, pt) => cb(pt)),
  // ===== v1.2 新增 =====
  // 面板双档宽度（详情档 360px 时通知主进程加宽窗口）
  setPanelWidth: (expand) => ipcRenderer.send('panel-expand', expand),
  // S4 结束进程（仅 SIGTERM，主进程侧黑名单兜底）
  killProcess: (payload) => ipcRenderer.invoke('kill-process', payload),
  // S5 24h 采样历史 + 今日峰值
  getHistory: () => ipcRenderer.invoke('history-get'),
  // S6 消息中心
  getMessages: () => ipcRenderer.invoke('messages-get'),
  clearMessages: () => ipcRenderer.invoke('messages-clear'),
  logMessage: (title, body) => ipcRenderer.send('message-log', { title, body }),
  // C1 大文件猎人 / C2 缓存排行 / C3 应用残留 / C4 智能建议 / C5 清理历史
  scanBigFiles: () => ipcRenderer.invoke('bigfiles-scan'),
  getCacheRanking: () => ipcRenderer.invoke('cache-ranking'),
  scanLeftovers: () => ipcRenderer.invoke('leftovers-scan'),
  getAdvice: () => ipcRenderer.invoke('advice-get'),
  getCleanHistory: () => ipcRenderer.invoke('clean-history-get'),
  // 统一执行入口：用户勾选的具体路径移入废纸篓
  cleanPaths: (entries) => ipcRenderer.invoke('clean-paths', entries),
  // ===== v1.4 新增 =====
  // 设置读写（整点报时 / 健康提醒 / 隐身），主进程侧带默认值合并
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  // 开机自启（以系统登录项为唯一真相）
  setLoginItem: (enabled) => ipcRenderer.invoke('login-set', enabled),
  // ===== v1.5 新增 =====
  // 可选显示器清单（设置页「显示在哪块屏幕」）
  getDisplays: () => ipcRenderer.invoke('displays-list'),
  // 把最近一次识别到的非 Mio 前台应用加入隐身名单
  stealthCapture: () => ipcRenderer.invoke('stealth-capture'),
  // ===== v1.6 新增 =====
  // B2-1 剪贴板历史（只认文本 · 只在内存；渲染层只拿 preview）
  clipList: () => ipcRenderer.invoke('clip-list'),
  clipCopy: (id) => ipcRenderer.invoke('clip-copy', { id }),
  clipPin: (id) => ipcRenderer.invoke('clip-pin', { id }),
  clipUnpin: (id) => ipcRenderer.invoke('clip-unpin', { id }),
  clipDelete: (id) => ipcRenderer.invoke('clip-delete', { id }),
  clipClear: () => ipcRenderer.invoke('clip-clear'),
  clipPause: (paused) => ipcRenderer.invoke('clip-pause', { paused }),
  onClipChanged: (cb) => ipcRenderer.on('clip-changed', (_e, data) => cb(data)),
  onClipNotice: (cb) => ipcRenderer.on('clip-notice', (_e, data) => cb(data)),
  // B2-2 快捷操作三件套
  actLock: () => ipcRenderer.invoke('act-lock'),
  actScreenshot: (payload) => ipcRenderer.invoke('act-screenshot', payload || {}),
  trashSize: () => ipcRenderer.invoke('trash-size'),
  trashEmpty: () => ipcRenderer.invoke('trash-empty'),
  // 权限探测 / 申请 / 深链（只回状态枚举，绝不含明文）
  permStatus: () => ipcRenderer.invoke('perm-status'),
  permRequest: (which) => ipcRenderer.invoke('perm-request', { which }),
  permOpen: (which) => ipcRenderer.invoke('perm-open', { which }),
  // B2-3 召唤快捷键（原子注册 + 回滚）
  hotkeyRecord: (accelerator) => ipcRenderer.invoke('hotkey-record', { accelerator }),
  hotkeyReset: () => ipcRenderer.invoke('hotkey-reset'),
  // ===== v1.7 新增 =====
  // 天气（wttr.in 免 key，城市走 IP 定位或手动）
  getWeather: () => ipcRenderer.invoke('weather-get'),
  refreshWeather: () => ipcRenderer.invoke('weather-refresh'),
  // 数据与隐私：wipe 传 'preview' 只列出会被清除的文件，传 'run' 才移入废纸篓
  wipeData: (mode) => ipcRenderer.invoke('data-wipe', mode),
  showDataFolder: () => ipcRenderer.invoke('data-show'),
  // ===== v1.7.5 新增 =====
  // 定时清理计划：主进程静默执行完（只碰绿色梯队）推一次 auto-clean-done，
  // 渲染层出气泡 + 刷新清理记录（不弹窗、不弹系统通知）
  onAutoCleanDone: (cb) => ipcRenderer.on('auto-clean-done', (_e, data) => cb(data)),
  // 重复文件查重：三级漏斗后台扫描，进度走 dedupe-progress 事件，
  // 最终结果（含 groups / canceled / truncated）由 dedupe-start 的 Promise 返回
  dedupeStart: (payload) => ipcRenderer.invoke('dedupe-start', payload || {}),
  dedupeCancel: () => ipcRenderer.invoke('dedupe-cancel'),
  onDedupeProgress: (cb) => ipcRenderer.on('dedupe-progress', (_e, data) => cb(data)),
  // ===== v1.8 新增 =====
  // G 组 AI 助手（LLM 聊天）：Key 永不进 IPC 返回值，只拿脱敏串
  llmGetConfig: () => ipcRenderer.invoke('llm-get-config'),
  llmSaveKey: (key) => ipcRenderer.invoke('llm-save-key', { key }),
  llmDeleteKey: () => ipcRenderer.invoke('llm-delete-key'),
  llmTest: () => ipcRenderer.invoke('llm-test'),
  llmChat: (text) => ipcRenderer.invoke('llm-chat', { text }),
  // B4-2 首次启动引导
  onboardingGet: () => ipcRenderer.invoke('onboarding-get'),
  onboardingSet: (payload) => ipcRenderer.invoke('onboarding-set', payload || {}),
  // B4-3 自动更新（启动静默检查；渲染层只订阅 update-notice 事件）
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateCheckStatus: () => ipcRenderer.invoke('update-check-status'),
  onUpdateNotice: (cb) => ipcRenderer.on('update-notice', (_e, data) => cb(data)),
  // ===== v1.9 新增 =====
  // 番茄钟统计与周报：渲染层完成一个工作阶段上报，主进程持久化 + 聚合
  pomoLog: (work) => ipcRenderer.invoke('pomo-log', work),
  pomoStats: () => ipcRenderer.invoke('pomo-stats'),
  // 真正的闹钟/倒计时：主进程持久化，renderer 收起/重启不丢
  alarmStart: (minutes, label) => ipcRenderer.invoke('alarm-start', minutes, label),
  alarmCancel: () => ipcRenderer.invoke('alarm-cancel'),
  alarmState: () => ipcRenderer.invoke('alarm-state'),
  onAlarmFired: (cb) => ipcRenderer.on('alarm-fired', (_e, d) => cb(d)),
  // 快捷启动 App：open -a <name>
  appLaunch: (name) => ipcRenderer.invoke('app-launch', name),
  // ===== v2.0 新增（F1/F4/F6/F8/F9/F10/F11 常用页核心）=====
  v2: {
    // F1 电量提醒：探测电池信息（pct / charging / timeRemaining）
    batteryInfo: () => ipcRenderer.invoke('v2-battery-info'),
    // F4 循环提醒：CRUD（列表/新增/更新/删除）
    recurringList: () => ipcRenderer.invoke('v2-recurring-list'),
    recurringAdd: (payload) => ipcRenderer.invoke('v2-recurring-add', payload || {}),
    recurringSet: (payload) => ipcRenderer.invoke('v2-recurring-set', payload || {}),
    recurringRemove: (id) => ipcRenderer.invoke('v2-recurring-remove', { id }),
    onRecurringFired: (cb) => ipcRenderer.on('recurring-fired', (_e, d) => cb(d)),
    // F6 网络 IP：内网/公网 + 一键复制
    netInfo: () => ipcRenderer.invoke('v2-net-info'),
    netCopy: (ip) => ipcRenderer.invoke('v2-net-copy', { ip }),
    // F8 窗口分屏：四向
    split: (which) => ipcRenderer.invoke('v2-split', { which }),
    // F9 剪贴板图片历史（透传 v1.7.6 已采集的图片项）
    clipImageList: () => ipcRenderer.invoke('v2-clip-image-list'),
    // F10 文件暂存区：CRUD（只存路径引用）
    stashList: () => ipcRenderer.invoke('v2-stash-list'),
    stashAdd: (payload) => ipcRenderer.invoke('v2-stash-add', payload || {}),
    stashRemove: (id) => ipcRenderer.invoke('v2-stash-remove', id),
    stashClear: () => ipcRenderer.invoke('v2-stash-clear'),
    // F11 文本片段：CRUD + 插入剪贴板
    snippetList: () => ipcRenderer.invoke('v2-snippet-list'),
    snippetSave: (payload) => ipcRenderer.invoke('v2-snippet-save', payload || {}),
    snippetRemove: (id) => ipcRenderer.invoke('v2-snippet-remove', id),
    snippetInsert: (id) => ipcRenderer.invoke('v2-snippet-insert', id),
    // ===== v2.0 批次C：状态页 + 系统级（F2/F3/F5/F7/F12）=====
    // F2 隐私占用：拉取当前摄像头/麦克风占用 + 忽略名单
    privacyInfo: () => ipcRenderer.invoke('v2-privacy-info'),
    privacyIgnore: (name) => ipcRenderer.invoke('v2-privacy-ignore', { name }),
    // F3 蓝牙设备电量（60s 缓存 + 强制刷新）
    btList: () => ipcRenderer.invoke('v2-bt-list'),
    btRefresh: () => ipcRenderer.invoke('v2-bt-refresh'),
    // F5 开机启动项：列表 + 用户级启停（plist 移入/移出 Disabled，可逆）
    loginList: () => ipcRenderer.invoke('v2-login-list'),
    loginToggle: (name, enable) => ipcRenderer.invoke('v2-login-toggle', { name, enable }),
    // F7 应用卸载器：列表 + 残留扫描 + 卸载（safeTrash 唯一出口）
    uninstallList: () => ipcRenderer.invoke('v2-uninstall-list'),
    uninstallScan: (app) => ipcRenderer.invoke('v2-uninstall-scan', { app }),
    uninstallRun: (app, residuals) => ipcRenderer.invoke('v2-uninstall-run', { app, residuals }),
    // F12 磁盘太阳图：扫描 + 中止
    sunburstScan: () => ipcRenderer.invoke('v2-sunburst-scan'),
    sunburstCancel: () => ipcRenderer.invoke('v2-sunburst-cancel'),
    // F13 设置备份：导出 / 导入（JSON，deepMerge 合并恢复）
    backupExport: () => ipcRenderer.invoke('v2-backup-export'),
    backupImport: () => ipcRenderer.invoke('v2-backup-import'),
  },
});
