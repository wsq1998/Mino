// Mio - 主进程通知文案语言包（i18n）
// v2.0 ENG-2：通知由主进程发，需主进程取词。中英两套 + t() 取词，缺失键回退 zh。
// 语言：settings.general.lang = 'zh' | 'en' | 'auto'（auto 跟随系统，见 resolveLang）。
// 纯函数（无副作用），可单测。

const LANG = {
  zh: {
    // 通用
    'app.name': 'Mio',
    // F1 电量提醒
    'battery.low.title': 'Mio · 电量偏低',
    'battery.low.body': '当前电量 {level}%，记得充电哦',
    'battery.full.title': 'Mio · 电量已满',
    'battery.full.body': '已充满 {level}%，可以拔掉电源了',
    'battery.charged.title': 'Mio · 充电完成',
    'battery.charged.body': '电池已充满，保护电池建议拔掉电源',
    // F2 隐私占用
    'privacy.camera.title': 'Mio · 摄像头占用',
    'privacy.camera.body': '{app} 可能仍在占用摄像头',
    'privacy.mic.title': 'Mio · 麦克风占用',
    'privacy.mic.body': '{app} 可能仍在占用麦克风',
    // 清理
    'clean.done.title': 'Mio · 清理完成',
    'clean.done.body': '已移入废纸篓 {n} 项',
    'clean.rejected': '路径不在安全范围，已拒绝',
    // 卸载
    'uninstall.done.title': 'Mio · 卸载完成',
    'uninstall.done.body': '已移入废纸篓 {n} 项',
    'uninstall.failed.title': 'Mio · 卸载部分失败',
    'uninstall.failed.body': '失败 {n} 项，请手动处理',
    // F5 开机启动项
    'login.toggle.title': 'Mio · 启动项变更',
    'login.toggle.body': '{name} 已{state}',
    // F13 设置备份
    'backup.imported.title': 'Mio · 设置已导入',
    'backup.imported.body': '设置已合并恢复',
    // 中转站
    'stash.added.title': 'Mio · 已加入中转站',
    'stash.added.body': '{name}',
    // 通用错误
    'error.generic': '操作失败，请重试',
  },
  en: {
    'app.name': 'Mio',
    'battery.low.title': 'Mio · Low Battery',
    'battery.low.body': 'Battery at {p}%, time to charge',
    'battery.full.title': 'Mio · Fully Charged',
    'battery.full.body': 'Charged to {p}%, you can unplug now',
    'battery.charged.title': 'Mio · Charging Complete',
    'battery.charged.body': 'Battery full. Consider unplugging',
    'privacy.camera.title': 'Mio · Camera in Use',
    'privacy.camera.body': '{app} may be using the camera',
    'privacy.mic.title': 'Mio · Microphone in Use',
    'privacy.mic.body': '{app} may be using the microphone',
    'clean.done.title': 'Mio · Cleanup Done',
    'clean.done.body': '{n} items moved to Trash',
    'clean.rejected': 'Path outside safe scope, rejected',
    'uninstall.done.title': 'Mio · Uninstall Done',
    'uninstall.done.body': '{n} items moved to Trash',
    'uninstall.failed.title': 'Mio · Uninstall Partially Failed',
    'uninstall.failed.body': '{n} failed, please handle manually',
    'login.toggle.title': 'Mio · Login Item Changed',
    'login.toggle.body': '{name} {state}',
    'backup.imported.title': 'Mio · Settings Imported',
    'backup.imported.body': 'Settings merged & restored',
    'stash.added.title': 'Mio · Added to Stash',
    'stash.added.body': '{path}',
    'error.generic': 'Operation failed, please retry',
  },
};

// 系统语言 → 简写（zh-* → zh，其余非 zh 一律 en）
function resolveLang(setting) {
  if (setting === 'zh' || setting === 'en') return setting;
  const sys = (typeof navigator !== 'undefined' && navigator.language) || (typeof process !== 'undefined' && process.env.LANG) || '';
  if (/^zh/i.test(sys)) return 'zh';
  return 'en';
}

// 取词：t(key, { lang, vars }) → 当前语言；缺键回退 zh；再缺回退 key 本身。
// vars 可选：{ p: 80 } 会替换文案里的 {p} 占位符。
function t(key, opts = {}) {
  const lang = resolveLang(opts.lang);
  const table = LANG[lang] || LANG.zh;
  let s = table[key];
  if (s === undefined) s = LANG.zh[key];
  if (s === undefined) s = key;
  if (opts.vars && typeof opts.vars === 'object') {
    for (const [k, v] of Object.entries(opts.vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}

module.exports = { LANG, resolveLang, t };