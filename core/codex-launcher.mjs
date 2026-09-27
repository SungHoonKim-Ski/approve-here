import { existsSync, mkdirSync, writeFileSync, chmodSync, lstatSync, realpathSync, readFileSync, unlinkSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function launcherBinarySource({ appBinary, realCli, processName }) {
  const swift = value => JSON.stringify(value);
  return `import Foundation
import Darwin

let appBinary = ${swift(appBinary)}
let realCli = ${swift(realCli)}
let processName = ${swift(processName)}
let arguments = Array(CommandLine.arguments.dropFirst())

let guardProcess = Process()
guardProcess.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
guardProcess.arguments = ["-x", processName]
guardProcess.standardOutput = FileHandle.nullDevice
guardProcess.standardError = FileHandle.nullDevice
try? guardProcess.run()
guardProcess.waitUntilExit()
if guardProcess.terminationStatus == 0 {
  FileHandle.standardError.write(Data("Codex 앱을 완전히 종료한 뒤 이 중계 실행기를 여세요.\\n".utf8))
  exit(1)
}

let child = Process()
child.executableURL = URL(fileURLWithPath: appBinary)
child.arguments = arguments
var environment = ProcessInfo.processInfo.environment
environment["APPROVE_HERE_CODEX_CLI"] = realCli
environment["CODEX_CLI_PATH"] = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("codex-shim").path
child.environment = environment
do {
  try child.run()
  child.waitUntilExit()
  exit(child.terminationStatus)
} catch {
  FileHandle.standardError.write(Data("Codex 실행 실패: \\(error)\\n".utf8))
  exit(1)
}
`;
}

export function launcherScript({ appBinary, realCli, nodePath, relayPath }) {
  const processName = basename(appBinary).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `#!/bin/sh
set -eu
if /usr/bin/pgrep -x ${quote(processName)} >/dev/null; then
  echo 'Codex 앱을 완전히 종료한 뒤 이 중계 실행기를 여세요.' >&2
  exit 1
fi
export APPROVE_HERE_CODEX_CLI=${quote(realCli)}
export CODEX_CLI_PATH="$(dirname "$0")/codex-shim"
exec ${quote(appBinary)} "$@"
`;
}

/** Write an opt-in launcher; do not quit or launch the user's running desktop app. */
export function installCodexLauncher({ appPath, target, nodePath = process.execPath, relayPath = fileURLToPath(new URL('../bin/codex-relay.mjs', import.meta.url)), inspectExecutable } = {}) {
  if (process.platform !== 'darwin' && !inspectExecutable) throw new Error('Codex 앱 실행기는 macOS 전용입니다.');
  const app = appPath || ['/Applications/ChatGPT.app', '/Applications/Codex.app'].find(existsSync);
  if (!app || !existsSync(app)) throw new Error('Codex 앱을 찾지 못했습니다. --app /Applications/Codex.app처럼 지정하세요.');
  const name = inspectExecutable ? inspectExecutable(app) : execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  if (!name || name.includes('/') || name.includes('..')) throw new Error('앱 실행 파일 이름이 올바르지 않습니다.');
  const appBinary = join(app, 'Contents/MacOS', name);
  const processName = basename(appBinary);
  const resources = join(app, 'Contents/Resources');
  const realCli = ['codex-cli/CodexCLI.app/Contents/MacOS/codex', 'codex', 'bin/codex'].map(path => join(resources, path)).find(existsSync);
  if (!realCli || !existsSync(appBinary)) throw new Error('앱에 포함된 Codex 실행 파일을 찾지 못했습니다.');
  // A launcher created from a mounted DMG must not retain a /Volumes path.
  const installedRelay = '/Applications/ApproveHere.app/Contents/Resources/core/bin/codex-relay.mjs';
  const stableRelay = existsSync(installedRelay) ? installedRelay : relayPath;
  const destination = target || join(homedir(), 'Applications/Codex with Approve Here.app');
  if (!destination.endsWith('.app') || resolve(destination) === resolve(app)) throw new Error('별도의 .app 경로가 필요합니다.');
  if (existsSync(destination)) {
    if (lstatSync(destination).isSymbolicLink() || realpathSync(destination) === realpathSync(app)) throw new Error('원래 앱이나 심볼릭 링크를 덮어쓸 수 없습니다.');
    let own = false;
    try { own = readFileSync(join(destination, 'Contents/Info.plist'), 'utf8').includes('<string>dev.approve-here.codex-launcher</string>'); } catch {}
    if (!own) throw new Error('기존의 다른 앱을 덮어쓸 수 없습니다. 다른 --target을 지정하세요.');
  }
  const directory = join(destination, 'Contents/MacOS');
  mkdirSync(directory, { recursive: true });
  const launcher = join(directory, 'launcher');
  if (process.platform === 'darwin' && !inspectExecutable) {
    const source = join(directory, '.launcher.swift');
    writeFileSync(source, launcherBinarySource({ appBinary, realCli, processName }));
    const cache = '/private/tmp/approve-here-swift-modules';
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    try { execFileSync('/usr/bin/swiftc', ['-O', '-module-cache-path', cache, '-Xcc', '-fmodules-cache-path=' + cache, '-o', launcher, source], { stdio: 'inherit' }); }
    finally { try { unlinkSync(source); } catch {} }
  } else {
    writeFileSync(launcher, launcherScript({ appBinary, realCli, nodePath, relayPath }));
    chmodSync(launcher, 0o755);
  }
  writeFileSync(join(directory, 'codex-shim'), `#!/bin/sh\nexec ${quote(nodePath)} ${quote(stableRelay)} "$@"\n`);
  chmodSync(join(directory, 'codex-shim'), 0o755);
  writeFileSync(join(destination, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.approve-here.codex-launcher</string>
<key>CFBundleName</key><string>Codex with Approve Here</string>
<key>CFBundleExecutable</key><string>launcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.5.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>ApproveHereTarget</key><string>${xml(app)}</string>
</dict></plist>\n`);
  return destination;
}
