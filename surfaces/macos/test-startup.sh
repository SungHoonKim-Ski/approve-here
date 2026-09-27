#!/bin/sh
set -eu
cd "$(dirname "$0")"
[ -f dist/ApproveHere.app/Contents/Resources/core/bin/approve-here.mjs ] || { echo '먼저 APPROVE_HERE_SKIP_DMG=1 sh build.sh로 앱을 빌드하세요.' >&2; exit 1; }
TASK_TEST_DIR=$(mktemp -d /private/tmp/approve-here-startup-test.XXXXXX)
trap 'rm -rf "$TASK_TEST_DIR"' EXIT
TASK_FIXTURE_APP="$TASK_TEST_DIR/StartupTest.app"
mkdir -p "$TASK_FIXTURE_APP/Contents/MacOS" "$TASK_FIXTURE_APP/Contents/Resources"
ln -s "$PWD/dist/ApproveHere.app/Contents/Resources/core" "$TASK_FIXTURE_APP/Contents/Resources/core"
cat > "$TASK_FIXTURE_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.approve-here.startup-test</string>
<key>CFBundleExecutable</key><string>startup-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
swiftc Sources/ApproveHere/Runtime.swift Tests/StartupSmoke.swift -o "$TASK_FIXTURE_APP/Contents/MacOS/startup-test"
node Tests/startup-smoke.mjs "$TASK_FIXTURE_APP/Contents/MacOS/startup-test"
