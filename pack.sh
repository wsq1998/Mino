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

# 5. 重签（⚠️ 改动 bundle 后必须重签，否则 Gatekeeper 拒绝启动）
codesign --force --sign - "$APP" >/dev/null
codesign --verify "$APP" && echo "✅ 打包+签名完成: $APP (v$VERSION)"

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
