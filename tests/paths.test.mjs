import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('공백·한글·URL 예약 문자가 있는 앱 경로에서도 훅·데몬·웹을 실행한다', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), 'inbox-path-'));
  const bundle = join(temp, 'Approve Here 한글 #100%');
  mkdirSync(bundle);
  for (const path of ['core', 'bin', 'hook', 'surfaces/web', 'package.json']) cpSync(join(root, path), join(bundle, path), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(bundle, 'node_modules'));
  const { HOOK_PATH } = await import(pathToFileURL(join(bundle, 'core/install.mjs')).href);
  assert.equal(HOOK_PATH, realpathSync(join(bundle, 'hook/permission-hook.mjs')));
  const { ensureDaemon, daemonHealth, stopDaemon } = await import(pathToFileURL(join(bundle, 'core/lifecycle.mjs')).href);
  const home = join(temp, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 0 }));
  t.after(() => stopDaemon(home));
  const started = await ensureDaemon({ home, port: 0 });
  assert.equal((await daemonHealth(home))?.ok, true);
  const page = await fetch(`http://127.0.0.1:${started.port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Approve Here/);
});
