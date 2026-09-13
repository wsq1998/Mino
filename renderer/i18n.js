// Mio - 渲染层语言包（i18n）
// v2.0 ENG-2：中英键值对 + t() 取词；缺失键回退 zh；语言 settings.general.lang
// （'zh' | 'en' | 'auto'，auto 跟随系统 navigator.language）。
// 纯函数（无副作用），可被 node --test 单测；浏览器里挂 window.mioI18n。

const LANG = {
  zh: {
    // 常用页
    'nav.home': '常用',
    'nav.status': '状态',
    'nav.clean': '清理',
    'nav.settings': '设置',
    // 网络 IP 卡片
    'net.title': '网络 IP',
    'net.lan': '内网',
    'net.wan': '公网',
    'net.wanState': '状态',
    'net.copy': '复制',
    'net.copied': '已复制',
    'net.offline': '—',
    // 中转站
    'stash.title': '文件暂存区',
    'stash.empty': '暂无文件，拖入或粘贴路径',
    'stash.add': '加入',
    'stash.added': '已加入',
    'stash.remove': '移除',
    'stash.clear': '清空',
    'stash.missing': '文件不存在',
    'stash.confirmClear': '确定清空中转站？只移除引用，不删除任何文件',
    // 分屏
    'split.title': '窗口分屏',
    'split.left': '左半屏',
    'split.right': '右半屏',
    'split.top': '上半屏',
    'split.bottom': '下半屏',
    'split.undo': '还原',
    'split.needAccessibility': '需要辅助功能权限',
    'split.openSettings': '去开启',
    // 电量提醒
    'battery.title': '电量提醒',
    'battery.enabled': '启用',
    'battery.low': '低电量阈值',
    'battery.full': '满电阈值',
    // 蓝牙
    'bt.title': '蓝牙设备',
    'bt.empty': '暂无设备',
    'bt.battery': '电量',
    'bt.unknown': '—',
    // 隐私占用
    'privacy.title': '摄像头 / 麦克风占用',
    'privacy.none': '未检测到占用',
    'privacy.ignore': '忽略',
    'privacy.ignored': '已忽略',
    // 磁盘太阳图
    'sunburst.title': '磁盘空间',
    'sunburst.scan': '扫描',
    'sunburst.scanning': '扫描中…',
    'sunburst.cancel': '取消',
    'sunburst.empty': '暂无数据',
    // 应用卸载
    'uninstall.title': '应用卸载',
    'uninstall.scan': '扫描',
    'uninstall.running': '运行中',
    'uninstall.residuals': '残留',
    'uninstall.uninstall': '卸载',
    'uninstall.confirm': '将把 {name} 及 {n} 个残留移入废纸篓，可随时恢复。确定？',
    'uninstall.done': '已移入废纸篓 {n} 项',
    'uninstall.failed': '失败 {n} 项',
    // 设置页
    'settings.general': '通用',
    'settings.lang': '语言',
    'settings.lang.auto': '跟随系统',
    'settings.lang.zh': '简体中文',
    'settings.lang.en': 'English',
    'settings.battery': '电量提醒',
    'settings.privacy': '隐私占用监控',
    'settings.bluetooth': '蓝牙电量',
    'settings.network': '网络 IP',
    'settings.uninstall': '应用卸载',
    'settings.split': '窗口分屏',
    'settings.clipboard': '剪贴板',
    'settings.stash': '中转站',
    'settings.sunburst': '磁盘太阳图',
    'settings.backup': '备份',
    // 通用
    'common.confirm': '确定',
    'common.cancel': '取消',
    'common.close': '关闭',
    'common.save': '保存',
    'common.delete': '删除',
  },
  en: {
    'nav.fav': 'Home',
    'nav.status': 'Status',
    'nav.clean': 'Clean',
    'nav.settings': 'Settings',
    'net.title': 'Network IP',
    'net.lan': 'LAN',
    'net.wan': 'WAN',
    'net.wanState': 'Status',
    'net.copy': 'Copy',
    'net.copied': 'Copied',
    'net.offline': '—',
    'stash.title': 'Stash',
    'stash.empty': 'Drop files or paste a path',
    'stash.add': 'Add',
    'stash.added': 'Added',
    'stash.remove': 'Remove',
    'stash.clear': 'Clear',
    'stash.missing': 'File missing',
    'stash.confirmClear': 'Clear stash? Only references are removed, no files are deleted',
    'split.title': 'Window Split',
    'split.left': 'Left Half',
    'split.right': 'Right Half',
    'split.top': 'Top Half',
    'split.bottom': 'Bottom Half',
    'split.undo': 'Restore',
    'split.needAccess': 'Accessibility permission needed',
    'split.open': 'Open System Settings',
    'battery.title': 'Battery Alerts',
    'battery.enabled': 'Enabled',
    'battery.low': 'Low threshold',
    'battery.full': 'Full threshold',
    'bt.title': 'Bluetooth Devices',
    'bt.empty': 'No devices',
    'bt.battery': 'Battery',
    'bt.unknown': '—',
    'privacy.title': 'Camera / Mic in Use',
    'privacy.none': 'No activity detected',
    'privacy.ignore': 'Ignore',
    'privacy.ignored': 'Ignored',
    'sunburst.title': 'Disk Space',
    'sunburst.scan': 'Scan',
    'sunburst.scanning': 'Scanning…',
    'sunburst.cancel': 'Cancel',
    'sunburst.empty': 'No data',
    'uninstall.title': 'App Uninstaller',
    'uninstall.scan': 'Scan',
    'uninstall.running': 'Running',
    'uninstall.residuals': 'Residuals',
    'uninstall.uninstall': 'Uninstall',
    'uninstall.confirm': 'Move {name} and {n} residual items to Trash. You can restore anytime.',
    'uninstall.done': 'Moved {n} items to Trash',
    'uninstall.failed': '{n} failed',
    'settings.general': 'General',
    'settings.lang': 'Language',
    'settings.lang.zh': '简体中文',
    'settings.lang.en': 'English',
    'settings.battery': 'Battery Alerts',
    'settings.privacy': 'Privacy Monitor',
    'settings.bluetooth': 'Bluetooth Battery',
    'settings.network': 'Network IP',
    'settings.uninstall': 'App Uninstaller',
    'settings.split': 'Window Split',
    'settings.clipboard': 'Clipboard',
    'settings.stash': 'Stash',
    'settings.sunburst': 'Disk Sunburst',
    'settings.backup': 'Backup',
    'common.confirm': 'OK',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.save': 'Save',
    'common.delete': 'Delete',
  },
};

// 当前语言：'zh' | 'en'（auto → navigator.language）
function resolveLang(setting) {
  if (setting === 'zh' || setting === 'en') return setting;
  const sys = (typeof navigator !== 'undefined' && navigator.language) || '';
  return /^zh/i.test(sys) ? 'zh' : 'en';
}

// 取词：t(key, { lang }) → 当前语言；缺失键回退 zh；再缺回退 key。
function t(key, opts = {}) {
  const lang = resolveLang(opts && opts.lang);
  const table = LANG[lang] || LANG.zh;
  let s = table[key];
  if (s === undefined) s = LANG.zh[key];
  if (s === undefined) s = key;
  if (opts && opts.vars && typeof opts.vars === 'object') {
    for (const [k, v] of Object.entries(opts.vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}

// 供渲染层全局使用；同时支持 CommonJS（node --test 单测）
if (typeof window !== 'undefined') {
  window.MioI18n = { LANG, resolveLang, t };
}
module.exports = { LANG, resolveLang, t };