import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('이 검증은 macOS에서 실행해 주세요.');
const bundle = resolve(process.argv[2] ?? fileURLToPath(new URL('../dist/ApproveHere.app', import.meta.url)));
const core = join(bundle, 'Contents/Resources/core');
const template = join(core, 'core/codex-launcher-template');
assert.match(execFileSync('/usr/bin/file', [template], { encoding: 'utf8' }), /Mach-O/);
const root = mkdtempSync(join(tmpdir(), "approve-here-native-launcher '한글 "));
try {
  const app = join(root, 'Fixture.app');
  const name = `ApproveHereFixture-${randomUUID().slice(0, 8)}`;
  const appBinary = join(app, 'Contents/MacOS', name);
  const cli = join(app, 'Contents/Resources/codex');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`);
  writeFileSync(appBinary, '#!/bin/sh\nprintf "%s\\n" "$APPROVE_HERE_CODEX_CLI" "$CODEX_CLI_PATH" "$@"\n');
  writeFileSync(cli, '#!/bin/sh\nprintf "fixture-cli-version\\n"\n');
  chmodSync(appBinary, 0o755);
  chmodSync(cli, 0o755);
  const originalApp = readFileSync(appBinary);
  const originalCli = readFileSync(cli);
  const target = join(root, 'Codex with Approve Here.app');
  const env = {
    ...process.env,
    PATH: '/usr/bin:/bin',
    APPROVE_HERE_HOME: join(root, 'inbox'),
    APPROVE_HERE_LAUNCHER_NO_ALERT: '1',
    // If the installer tries to compile on the user's machine, this path makes it fail.
    DEVELOPER_DIR: join(root, 'no-developer-tools'),
  };
  execFileSync(process.execPath, [join(core, 'bin/approve-here.mjs'), 'install-codex-launcher', '--prebuilt', '--app', app, '--target', target], { env, timeout: 10000 });
  const launcher = join(target, 'Contents/MacOS/launcher');
  const shim = join(target, 'Contents/MacOS/codex-shim');
  assert.deepEqual(readFileSync(launcher), readFileSync(template));
  const args = ['--fixture', 'with spaces', "quote'", '한국어'];
  const output = execFileSync(launcher, args, { env, encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(output.trimEnd().split('\n'), [cli, shim, ...args]);
  const isolated = execFileSync(shim, ['--version'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(isolated.trim(), 'fixture-cli-version');
  assert.deepEqual(readFileSync(appBinary), originalApp);
  assert.deepEqual(readFileSync(cli), originalCli);
  writeFileSync(join(target, 'Contents/Resources/launcher.json'), '{broken');
  assert.throws(() => execFileSync(launcher, [], { env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 1 && error.stderr.includes('실행기 설정을 읽을 수 없습니다'));
  console.log('PASS: packaged native launcher installs without developer tools, forwards paths and arguments, keeps isolated shim working, preserves original app and reports invalid configuration');
} finally {
  rmSync(root, { recursive: true, force: true });
}
