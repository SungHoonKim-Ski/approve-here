import { existsSync, mkdirSync, writeFileSync, chmodSync, lstatSync, realpathSync, readFileSync, copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

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
export function installCodexLauncher({ appPath, target, nodePath = process.execPath, relayPath = fileURLToPath(new URL('../bin/codex-relay.mjs', import.meta.url)), launcherTemplate = fileURLToPath(new URL('./codex-launcher-template', import.meta.url)), requirePrebuilt = false, inspectExecutable } = {}) {
  if (process.platform !== 'darwin' && !inspectExecutable) throw new Error('Codex 앱 실행기는 macOS 전용입니다.');
  if (requirePrebuilt && !existsSync(launcherTemplate)) throw new Error('앱에 포함된 실행기 파일이 없습니다. Approve Here를 다시 내려받아 Applications에 설치해 주세요.');
  const foundApp = appPath || ['/Applications/ChatGPT.app', '/Applications/Codex.app'].find(existsSync);
  if (!foundApp || !existsSync(foundApp)) throw new Error('Codex 앱을 찾지 못했습니다. --app /Applications/Codex.app처럼 지정하세요.');
  const app = resolve(foundApp);
  const name = inspectExecutable ? inspectExecutable(app) : execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  if (!name || name.includes('/') || name.includes('..')) throw new Error('앱 실행 파일 이름이 올바르지 않습니다.');
  const appBinary = join(app, 'Contents/MacOS', name);
  const processName = basename(appBinary).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const resources = join(app, 'Contents/Resources');
  const realCli = ['codex-cli/CodexCLI.app/Contents/MacOS/codex', 'codex', 'bin/codex'].map(path => join(resources, path)).find(existsSync);
  if (!realCli || !existsSync(appBinary)) throw new Error('앱에 포함된 Codex 실행 파일을 찾지 못했습니다.');
  // A launcher created from a mounted DMG must not retain a /Volumes path.
  const installedRelay = '/Applications/ApproveHere.app/Contents/Resources/core/bin/codex-relay.mjs';
  const stableRelay = existsSync(installedRelay) ? installedRelay : relayPath;
  const destination = resolve(target || join(homedir(), 'Applications/Codex with Approve Here.app'));
  if (!destination.endsWith('.app') || resolve(destination) === resolve(app)) throw new Error('별도의 .app 경로가 필요합니다.');
  const checkDestination = () => {
    const existing = lstatSync(destination, { throwIfNoEntry: false });
    if (!existing) return false;
    if (existing.isSymbolicLink() || realpathSync(destination) === realpathSync(app)) throw new Error('원래 앱이나 심볼릭 링크를 덮어쓸 수 없습니다.');
    let own = false;
    try { own = readFileSync(join(destination, 'Contents/Info.plist'), 'utf8').includes('<string>dev.approve-here.codex-launcher</string>'); } catch {}
    if (!own) throw new Error('기존의 다른 앱을 덮어쓸 수 없습니다. 다른 --target을 지정하세요.');
    return true;
  };
  checkDestination();
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.approve-here-launcher-'));
  const stagedApp = join(staging, 'launcher.app');
  const backup = join(staging, 'previous.app');
  let backedUp = false;
  let installed = false;
  try {
    const directory = join(stagedApp, 'Contents/MacOS');
    mkdirSync(directory, { recursive: true });
    const launcher = join(directory, 'launcher');
    if (existsSync(launcherTemplate)) {
      copyFileSync(launcherTemplate, launcher);
      chmodSync(launcher, 0o755);
    } else if (process.platform === 'darwin' && !inspectExecutable) {
      const source = fileURLToPath(new URL('./codex-launcher.swift', import.meta.url));
      const cache = join(staging, 'swift-modules');
      mkdirSync(cache, { recursive: true, mode: 0o700 });
      const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
      execFileSync('/usr/bin/swiftc', ['-O', '-target', `${architecture}-apple-macosx13.0`, '-module-cache-path', cache, '-Xcc', '-fmodules-cache-path=' + cache, '-o', launcher, source], { stdio: 'inherit' });
    } else {
      writeFileSync(launcher, launcherScript({ appBinary, realCli, nodePath, relayPath }));
      chmodSync(launcher, 0o755);
    }
    // App tools may forward CODEX_CLI_PATH without the launcher's private environment.
    // Keep the original executable with the shim so those invocations also work.
    writeFileSync(join(directory, 'codex-shim'), `#!/bin/sh\nexport APPROVE_HERE_CODEX_CLI=${quote(realCli)}\nif [ -x ${quote(nodePath)} ] && [ -f ${quote(stableRelay)} ]; then\n  exec ${quote(nodePath)} ${quote(stableRelay)} "$@"\nfi\nexec ${quote(realCli)} "$@"\n`);
    chmodSync(join(directory, 'codex-shim'), 0o755);
    mkdirSync(join(stagedApp, 'Contents/Resources'), { recursive: true });
    writeFileSync(join(stagedApp, 'Contents/Resources/launcher.json'), JSON.stringify({ appBinary, realCli, processName }, null, 2) + '\n');
    writeFileSync(join(stagedApp, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.approve-here.codex-launcher</string>
  <key>CFBundleName</key><string>Codex with Approve Here</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.5.2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>ApproveHereTarget</key><string>${xml(app)}</string>
  </dict></plist>\n`);
    if (checkDestination()) {
      renameSync(destination, backup);
      backedUp = true;
    }
    try {
      renameSync(stagedApp, destination);
      installed = true;
    } catch (error) {
      if (backedUp) {
        try { renameSync(backup, destination); backedUp = false; }
        catch { throw new Error(`실행기 교체에 실패했습니다. 이전 실행기는 ${backup}에 보존했습니다.`, { cause: error }); }
      }
      throw error;
    }
    return destination;
  } finally {
    if (!backedUp || installed) rmSync(staging, { recursive: true, force: true });
  }
}
