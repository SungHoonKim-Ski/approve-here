#!/bin/sh
# SwiftPM만으로 메뉴바 앱을 빌드하고, Node 코어(훅·데몬)를 번들에 담아 .app·zip·dmg를 만든다. Xcode는 필요 없다.
# 앱이 제품의 전부라서 사용자는 이 번들 하나만 받는다. 훅 등록·데몬 기동은 앱이 번들 안의 코어로 한다.
set -eu
cd "$(dirname "$0")"
ROOT=../..
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
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# ad-hoc 서명: 알림 권한 대화상자가 번들 신원을 요구한다. 배포 서명이 아니라 처음 열 때 우클릭 → 열기가 필요할 수 있다.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
ditto -c -k --keepParent "$APP" dist/ApproveHere.app.zip
mkdir -p dist/dmg-stage && cp -R "$APP" dist/dmg-stage/ && ln -s /Applications dist/dmg-stage/Applications
hdiutil create -quiet -volname "Approve Here" -srcfolder dist/dmg-stage -ov -format UDZO dist/ApproveHere.dmg
rm -rf dist/dmg-stage
echo "built: $PWD/$APP ($VERSION)"
ls -la dist/ApproveHere.app.zip dist/ApproveHere.dmg | awk '{print "  "$5" "$9}'
