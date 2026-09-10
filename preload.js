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
});
