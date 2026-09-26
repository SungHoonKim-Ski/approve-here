import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemon } from '../core/daemon.mjs';
import { ensureDaemon, daemonHealth, stopDaemon } from '../core/lifecycle.mjs';

test('ensureDaemon: 데몬이 없으면 분리 실행으로 띄우고 health가 응답할 때까지 기다린다. 두 번째 호출은 재사용', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  t.after(() => stopDaemon(home));
  const first = await ensureDaemon({ home, port: 0 });
  assert.equal(first.started, true);
  assert.ok(first.port > 0);
  assert.ok(existsSync(join(home, 'daemon.log')));
  const health = await daemonHealth(home);
  assert.equal(health?.ok, true);
  const second = await ensureDaemon({ home });
  assert.equal(second.started, false, '이미 떠 있으면 새로 띄우지 않는다');
  assert.equal(second.port, first.port);
});

test('stopDaemon: daemon.json의 pid를 종료하고 health가 끊긴다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  await ensureDaemon({ home, port: 0 });
  assert.equal((await daemonHealth(home))?.ok, true);
  const stopped = await stopDaemon(home);
  assert.equal(stopped, true);
  for (let i = 0; i < 20 && (await daemonHealth(home)); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(await daemonHealth(home), null);
});

test('daemon: 표면도 대기 요청도 없이 idleExit 시간이 지나면 onIdle을 부른다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  let idle = 0;
  const daemon = await startDaemon({ home, port: 0, idleExitMs: 300, idleCheckMs: 50, onIdle: () => (idle += 1) });
  t.after(() => daemon.close());
  await new Promise(r => setTimeout(r, 600));
  assert.ok(idle >= 1, 'idle 콜백이 불린다');
});

test('daemon: 표면이 다녀가는 동안에는 idle로 보지 않는다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  let idle = 0;
  const daemon = await startDaemon({ home, port: 0, idleExitMs: 300, idleCheckMs: 50, presenceSeconds: 1, onIdle: () => (idle += 1) });
  t.after(() => daemon.close());
  const headers = { 'x-approve-here-token': daemon.token };
  for (let i = 0; i < 6; i++) {
    await fetch(`http://127.0.0.1:${daemon.port}/requests`, { headers });
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(idle, 0);
});
