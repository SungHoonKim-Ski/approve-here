#!/bin/sh
# SwiftPM만으로 메뉴바 앱을 빌드하고, Node 코어(훅·데몬)를 번들에 담아 .app·zip·dmg를 만든다. Xcode는 필요 없다.
# 앱이 제품의 전부라서 사용자는 이 번들 하나만 받는다. 훅 등록·데몬 기동은 앱이 번들 안의 코어로 한다.
set -eu
cd "$(dirname "$0")"
ROOT=../..
npm ci --omit=dev --prefix "$ROOT"
VERSION=$(node -p "require('$ROOT/package.json').version")
swift build -c release
APP=dist/ApproveHere.app
rm -rf "$APP" dist/ApproveHere.app.zip dist/ApproveHere.dmg dist/dmg-stage
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/core"
cp .build/release/ApproveHere "$APP/Contents/MacOS/ApproveHere"
# Node 코어: 저장소의 bin·core·hook·surfaces(tui·web)·package.json. 훅 경로는 Contents/Resources/core/hook/permission-hook.mjs
for d in bin core hook; do cp -R "$ROOT/$d" "$APP/Contents/Resources/core/"; done
mkdir -p "$APP/Contents/Resources/core/surfaces"
cp -R "$ROOT/surfaces/tui" "$ROOT/surfaces/web" "$APP/Contents/Resources/core/surfaces/"
cp "$ROOT/package.json" "$APP/Contents/Resources/core/"
# WebSocket transport for the local Codex App Server.
cp -R "$ROOT/node_modules" "$APP/Contents/Resources/core/"
# 사용자 Mac에는 Swift 컴파일러가 없어도 된다. 실행기는 빌드할 때 만들고 설치 시 경로 설정만 쓴다.
swiftc -O -target "$(uname -m)-apple-macosx13.0" "$ROOT/core/codex-launcher.swift" -o "$APP/Contents/Resources/core/core/codex-launcher-template"
# 앱 아이콘(icon/make-icon.swift로 만든 icns)
[ -f icon/AppIcon.icns ] || { swift icon/make-icon.swift icon/AppIcon.iconset >/dev/null && iconutil -c icns icon/AppIcon.iconset -o icon/AppIcon.icns; }
cp icon/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.approve-here.menubar</string>
  <key>CFBundleName</key><string>Approve Here</string>
  <key>CFBundleDisplayName</key><string>Approve Here</string>
  <key>CFBundleExecutable</key><string>ApproveHere</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# ad-hoc 서명: 알림 권한 대화상자가 번들 신원을 요구한다. 배포 서명·공증이 아니라 처음 열 때 Gatekeeper가 한 번 막는다(README "처음 열기").
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
ditto -c -k --keepParent "$APP" dist/ApproveHere.app.zip
if [ "${APPROVE_HERE_SKIP_DMG:-0}" = 1 ]; then
  echo "built app and zip: $PWD/$APP ($VERSION)"
  exit 0
fi
# dmg: 앱 + Applications 링크 + "설치 안내.html". 창 배경에 끌어 넣기 그림과 막혔을 때 누를 곳을 그려 넣는다(dmg/make-background.swift).
STAGE=dist/dmg-stage
rm -rf "$STAGE" dist/rw.dmg && mkdir -p "$STAGE/.background"
cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
cp "dmg/설치 안내.html" "$STAGE/"
cp "$ROOT/docs/guide/gatekeeper-dialog.png" "$ROOT/docs/guide/gatekeeper-settings.png" "$STAGE/.background/"
swift dmg/make-background.swift "$STAGE/.background/background.png" >/dev/null
# 작업 중엔 고유한 볼륨 이름을 쓴다. 같은 이름의 dmg가 이미 마운트돼 있으면 Finder가 다른 볼륨을 잡는다.
hdiutil create -quiet -volname "ApproveHereBuild" -srcfolder "$STAGE" -ov -format UDRW -fs HFS+ dist/rw.dmg
ATTACHED=$(hdiutil attach -readwrite -noverify -noautoopen dist/rw.dmg | grep '/Volumes/')
DEVICE=$(printf '%s' "$ATTACHED" | awk -F'\t' '{print $1}' | tr -d ' ')
MOUNT=$(printf '%s' "$ATTACHED" | awk -F'\t' '{print $NF}')
# Finder로 아이콘 위치·배경을 볼륨의 .DS_Store에 적는다(dmg/layout.applescript). Finder 자동화 권한이 없으면 배치 없는 dmg로 넘어간다.
osascript dmg/layout.applescript "$MOUNT" >/dev/null 2>&1 || echo "  (dmg 창 배치를 건너뜀 — 터미널의 Finder 자동화 권한을 확인하세요)"
# 이름을 되돌리면 마운트 경로도 바뀌므로 장치 노드로 분리한다.
diskutil quiet rename "$MOUNT" "Approve Here"
sync
hdiutil detach -quiet "$DEVICE" || hdiutil detach -quiet -force "$DEVICE"
hdiutil convert -quiet -format UDZO -o dist/ApproveHere.dmg dist/rw.dmg
rm -rf "$STAGE" dist/rw.dmg
echo "built: $PWD/$APP ($VERSION)"
ls -la dist/ApproveHere.app.zip dist/ApproveHere.dmg | awk '{print "  "$5" "$9}'
