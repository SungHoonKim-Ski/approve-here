import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { startDaemon } from '../core/daemon.mjs';

const HOOK = new URL('../hook/permission-hook.mjs', import.meta.url).pathname;
const input = JSON.stringify({ session_id: 'c1', tool_name: 'Bash', tool_input: { command: 'touch x' }, cwd: '/tmp/p' });

function runHook(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK, '--provider', 'codex'], { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', d => (stdout += d));
    child.on('close', code => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

test('health는 표면이 최근에 다녀갔는지(surfaceActive)를 알려준다. 훅의 호출은 표면으로 세지 않는다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0, presenceSeconds: 1 });
  t.after(() => daemon.close());
  const base = `http://127.0.0.1:${daemon.port}`;
  const token = daemon.token;
  const health = async () => (await fetch(`${base}/health`)).json();
  assert.equal((await health()).surfaceActive, false);
  await fetch(`${base}/requests`, { headers: { 'x-agent-inbox-token': token, 'x-agent-inbox-client': 'hook' } });
  assert.equal((await health()).surfaceActive, false, '훅의 조회는 표면 존재로 세지 않는다');
  await fetch(`${base}/requests`, { headers: { 'x-agent-inbox-token': token } });
  assert.equal((await health()).surfaceActive, true);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal((await health()).surfaceActive, false, 'presenceSeconds가 지나면 비활성');
});

test('표면이 없으면 훅은 데몬이 떠 있어도 기다리지 않고 즉시 후퇴한다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0 });
  t.after(() => daemon.close());
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: daemon.port, waitSeconds: 30 }));
  const t0 = Date.now();
  const r = await runHook({ AGENT_INBOX_HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
  assert.ok(Date.now() - t0 < 3000, '표면이 없으면 대기하지 않는다');
  const headers = { 'x-agent-inbox-token': daemon.token };
  const recent = await (await fetch(`http://127.0.0.1:${daemon.port}/requests?status=recent`, { headers })).json();
  assert.equal(recent[0]?.status, 'skipped', '표면 부재로 건너뛴 기록은 남긴다');
});

test('requireSurface=false면 표면이 없어도 기다린다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0 });
  t.after(() => daemon.close());
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: daemon.port, waitSeconds: 0.5, requireSurface: false }));
  const t0 = Date.now();
  const r = await runHook({ AGENT_INBOX_HOME: home });
  assert.equal(r.stdout.trim(), '');
  assert.ok(Date.now() - t0 >= 450, 'waitSeconds만큼 기다린 뒤 후퇴');
});
