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
});
