#!/bin/sh
# SwiftPM만으로 메뉴바 앱을 빌드하고 .app 번들로 감싼다. Xcode는 필요 없다.
# 알림 액션(UNUserNotificationCenter)은 번들 ID가 있어야 하므로 실행 파일을 그대로 쓰지 않고 번들을 만든다.
set -eu
cd "$(dirname "$0")"
swift build -c release
APP=dist/AgentInbox.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp .build/release/AgentInbox "$APP/Contents/MacOS/AgentInbox"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.agent-inbox.menubar</string>
  <key>CFBundleName</key><string>AgentInbox</string>
  <key>CFBundleExecutable</key><string>AgentInbox</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# ad-hoc 서명: 알림 권한 대화상자가 번들 신원을 요구한다. 배포 서명이 아니므로 처음 열 때 우클릭 → 열기가 필요할 수 있다.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built: $PWD/$APP"
