// Mio - 系统域：进程黑名单 / 隐身名单 / 权限深链（纯数据，无副作用）
// B4-4 拆分：从 main.js 抽出。零行为变化。

const PROC_BLACKLIST = new Set([
  'windowserver', 'loginwindow', 'kernel_task', 'launchd', 'cfprefsd',
  'finder', 'dock', 'systemuiserver', 'spotlight', 'mds', 'distnoted',
  'opendirectoryd', 'syslogd', 'configd', 'powerd', 'mio', 'electron',
  // v2.0 F2：摄像头/麦克风系统进程 —— 占用检测里永远不提示（系统自持有，非用户 App）
  'vdc', 'vdcapture', 'cmio', 'cmioextension', 'cmioalternate',
  'corecaptured', 'coremediaio', 'coreaudiod', 'audioserverd',
]);

const STEALTH_APPS = [
  { id: 'com.colliderli.iina', name: 'IINA' },
  { id: 'org.videolan.vlc', name: 'VLC' },
  { id: 'com.apple.QuickTimePlayerX', name: 'QuickTime' },
  { id: 'com.apple.TV', name: '视频' },
  { id: 'com.apple.iWork.Keynote', name: 'Keynote' },
  { id: 'com.microsoft.Powerpoint', name: 'PowerPoint' },
  { id: 'com.kingsoft.wpsoffice.mac', name: 'WPS' },
  { id: 'com.tencent.meeting', name: '腾讯会议' },
  { id: 'com.tencent.tencentmeeting', name: '腾讯会议' },
  { id: 'us.zoom.xos', name: 'Zoom' },
  { id: 'com.electron.lark', name: '飞书' },
  { id: 'com.alibaba.dingtalk.mac', name: '钉钉' },
];

const DEEP_LINKS = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  // v2.0 F8 分屏：复用「辅助功能」权限（设计 §1.1 F8，不新增 TCC 类型）
  split: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

module.exports = { PROC_BLACKLIST, STEALTH_APPS, DEEP_LINKS };