#!/bin/bash
# Mio 一键打包：组装 → 签名 → (可选)安装到 /Applications + 启动 → (可选)重建 DMG
# 用法: ./pack.sh [--install] [--dmg]
set -e
cd "$(dirname "$0")"

SRC="node_modules/electron/dist/Electron.app"
APP="dist/Mio.app"
TS=$(date +%s)

# 版本号唯一来源：package.json
# ⚠️ 不要改回硬编码 —— 否则 package.json / Info.plist / DMG 文件名会三处打架
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)
[ -n "$VERSION" ] || { echo "❌ 无法从 package.json 解析 version 字段"; exit 1; }
DMG="dist/Mio-${VERSION}-$(uname -m).dmg"

[ -d "$SRC" ] || { echo "缺少 Electron 二进制，先 npm install"; exit 1; }

# 1. 挪走旧包（避免 rm -rf 大批量删除）
[ -d "$APP" ] && mv "$APP" "/tmp/mio-app-prev-$TS"
mkdir -p dist

# 2. ditto 复制（⚠️ 不要用 cp -R，会损坏 bundle）
ditto "$SRC" "$APP"

# 3. 注入应用代码
# B4-4：main.js 已拆出 main/ 子模块（core/llm/weather/clean/system），必须整目录注入，
# 否则打包后 require('./main/...') 找不到模块，app 启动即崩。
mkdir -p "$APP/Contents/Resources/app/renderer"
cp main.js preload.js package.json "$APP/Contents/Resources/app/"
cp -R main "$APP/Contents/Resources/app/main"
cp renderer/index.html renderer/style.css renderer/app.js "$APP/Contents/Resources/app/renderer/"
# v2.1 中转站浮窗资源：漏改会导致打包后浮窗白屏
cp renderer/stash.html renderer/stash.js renderer/stash.css renderer/theme.css "$APP/Contents/Resources/app/renderer/"
# v2.16 AI 助手窗口资源：与浮窗同一个坑 —— 漏注入则打包后助手窗口白屏（test/aiCss.test.js 有守卫）
cp renderer/ai.html renderer/ai.js renderer/aiEventMap.js renderer/ai.css "$APP/Contents/Resources/app/renderer/"

# 4. 元信息
# ⚠️ 版本号必须显式写入：否则 plist 会残留 Electron.app 自带的版本号（如 33.4.11）
PLIST="$APP/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 $2" "$PLIST"; }
pb "CFBundleName" "Mio"
pb "CFBundleDisplayName" "Mio"
pb "CFBundleIdentifier" "com.kaven.mio"
pb "CFBundleIconFile" "icon.icns"
pb "CFBundleShortVersionString" "$VERSION"
pb "CFBundleVersion" "$VERSION"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null || true
cp build/icon.icns "$APP/Contents/Resources/icon.icns"
# v2.1：菜单栏模板图（Tray + 拖出兜底图标用）；缺失时运行时用内存模板图兜底，不影响功能
mkdir -p "$APP/Contents/Resources/app/build"
cp build/trayTemplate.png build/trayTemplate@2x.png "$APP/Contents/Resources/app/build/" 2>/dev/null || true
# v2.7：编译原生 AirDrop helper（clang + Cocoa）并随包分发。
# ⚠️ 为什么不用 osascript/applet：它们没有常驻 NSApplication run loop，分享面板会被立即销毁、弹不出来。
clang -fobjc-arc -framework Cocoa -O2 -o build/airdrop-helper main/airdrop.m
chmod +x build/airdrop-helper
cp build/airdrop-helper "$APP/Contents/Resources/app/build/airdrop-helper"
# 嵌套二进制必须先 ad-hoc 签名，否则外层 `codesign --verify --deep --strict` 会失败
codesign --force --sign - build/airdrop-helper >/dev/null
codesign --force --sign - "$APP/Contents/Resources/app/build/airdrop-helper" >/dev/null

# 5. 重签（⚠️ 改动 bundle 后必须重签，否则 Gatekeeper 拒绝启动）
# ⚠️ 外层必须用 --deep：Electron 自带的嵌套 Helper(.app) 是 linker-signed，不加 --deep 时
#    `codesign --verify --deep --strict` 会报 "code has no resources but signature indicates they must be present"。
codesign --force --deep --sign - "$APP" >/dev/null
codesign --verify --deep --strict "$APP" && echo "✅ 打包+签名完成: $APP (v$VERSION)"

# 6. 可选：安装并启动
# ⚠️ 受限环境下写入 /Applications 会被拒绝，此时只提示不中断，保证 --dmg 仍能跑完
if [[ "$*" == *--install* ]]; then
  pkill -f "/Applications/Mio.app" 2>/dev/null || true
  if [ -d "/Applications/Mio.app" ]; then
    mv "/Applications/Mio.app" "/tmp/mio-app-installed-prev-$TS" || true
  fi
  if ditto "$APP" /Applications/Mio.app 2>/dev/null; then
    open /Applications/Mio.app
    echo "✅ 已安装到 /Applications 并启动 (v$VERSION)"
  else
    echo "⚠️ 写入 /Applications 被拒绝（受限环境）。请在本机「终端.app」手动执行："
    echo "   ditto \"$PWD/$APP\" /Applications/Mio.app && open /Applications/Mio.app"
  fi
fi

# 7. 可选：重建 DMG
if [[ "$*" == *--dmg* ]]; then
  STAGE="dist/dmg-staging"
  [ -d "$STAGE" ] && mv "$STAGE" "/tmp/mio-dmg-stage-prev-$TS"
  mkdir -p "$STAGE"
  ditto "$APP" "$STAGE/Mio.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "Mio" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
  mv "$STAGE" "/tmp/mio-dmg-stage-done-$TS"
  echo "✅ DMG 已生成: $DMG"
fi
