import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemon } from '../core/daemon.mjs';
import { ensureDaemon, daemonHealth, stopDaemon } from '../core/lifecycle.mjs';

test('daemon.json이 사라져도 설정 포트에 데몬이 살아 있으면 그것을 인정한다 (새로 띄우지 않음)', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0 });
  t.after(() => daemon.close());
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: daemon.port }));
  rmSync(join(home, 'daemon.json'));
  const health = await daemonHealth(home);
  assert.equal(health?.ok, true);
  assert.equal(health.port, daemon.port);
  assert.equal(health.pid, process.pid, '/health가 pid를 알려준다');
  const result = await ensureDaemon({ home });
  assert.equal(result.started, false);
  assert.equal(result.port, daemon.port);
  const restored = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
  assert.equal(restored.port, daemon.port, '인정하면서 daemon.json을 복구한다 — 표면이 이 파일로 데몬을 찾는다');
  assert.equal(restored.adopted, true);
});

test('/shutdown은 토큰이 있어야 하고, 받으면 onShutdown을 부른다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  let called = 0;
  const daemon = await startDaemon({ home, port: 0, onShutdown: () => (called += 1) });
  t.after(() => daemon.close());
  const anon = await fetch(`http://127.0.0.1:${daemon.port}/shutdown`, { method: 'POST' });
  assert.equal(anon.status, 401);
  const res = await fetch(`http://127.0.0.1:${daemon.port}/shutdown`, { method: 'POST', headers: { 'x-approve-here-token': daemon.token } });
  assert.equal(res.status, 200);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(called, 1);
});

test('stopDaemon은 pid 기록이 없어도 /shutdown으로 데몬을 내린다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 0 }));
  const started = await ensureDaemon({ home, port: 0 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: started.port }));
  rmSync(join(home, 'daemon.json'));
  assert.equal(await stopDaemon(home), true);
  for (let i = 0; i < 30 && (await daemonHealth(home)); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(await daemonHealth(home), null);
});
