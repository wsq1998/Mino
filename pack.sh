#!/bin/bash
# Mio 一键打包：组装 → 签名 → (可选)安装到 /Applications + 启动 → (可选)重建 DMG
# 用法: ./pack.sh [--install] [--dmg]
set -e
cd "$(dirname "$0")"

SRC="node_modules/electron/dist/Electron.app"
APP="dist/Mio.app"
TS=$(date +%s)

[ -d "$SRC" ] || { echo "缺少 Electron 二进制，先 npm install"; exit 1; }

# 1. 挪走旧包（避免 rm -rf 大批量删除）
[ -d "$APP" ] && mv "$APP" "/tmp/mio-app-prev-$TS"
mkdir -p dist

# 2. ditto 复制（⚠️ 不要用 cp -R，会损坏 bundle）
ditto "$SRC" "$APP"

# 3. 注入应用代码
mkdir -p "$APP/Contents/Resources/app/renderer"
cp main.js preload.js package.json "$APP/Contents/Resources/app/"
cp renderer/index.html renderer/style.css renderer/app.js "$APP/Contents/Resources/app/renderer/"

# 4. 元信息
PLIST="$APP/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 $2" "$PLIST"; }
pb "CFBundleName" "Mio"
pb "CFBundleDisplayName" "Mio"
pb "CFBundleIdentifier" "com.kaven.mio"
pb "CFBundleIconFile" "icon.icns"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null || true
cp build/icon.icns "$APP/Contents/Resources/icon.icns"

# 5. 重签（⚠️ 改动 bundle 后必须重签，否则 Gatekeeper 拒绝启动）
codesign --force --sign - "$APP" >/dev/null
codesign --verify "$APP" && echo "✅ 打包+签名完成: $APP"

# 6. 可选：安装并启动
if [[ "$*" == *--install* ]]; then
  pkill -f "/Applications/Mio.app" 2>/dev/null || true
  [ -d "/Applications/Mio.app" ] && mv "/Applications/Mio.app" "/tmp/mio-app-installed-prev-$TS"
  ditto "$APP" /Applications/Mio.app
  open /Applications/Mio.app
  echo "✅ 已安装到 /Applications 并启动"
fi

# 7. 可选：重建 DMG
if [[ "$*" == *--dmg* ]]; then
  STAGE="dist/dmg-staging"
  [ -d "$STAGE" ] && mv "$STAGE" "/tmp/mio-dmg-stage-prev-$TS"
  mkdir -p "$STAGE"
  ditto "$APP" "$STAGE/Mio.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "Mio" -srcfolder "$STAGE" -ov -format UDZO "dist/Mio-1.3.0-arm64.dmg" >/dev/null
  mv "$STAGE" "/tmp/mio-dmg-stage-done-$TS"
  echo "✅ DMG 已生成: dist/Mio-1.3.0-arm64.dmg"
fi
