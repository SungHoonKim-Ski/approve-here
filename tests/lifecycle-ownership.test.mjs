import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureToken, saveConfig, writeDaemonInfo } from '../core/config.mjs';
import { daemonHealth, ensureDaemon, stopDaemon } from '../core/lifecycle.mjs';
import { startDaemon } from '../core/daemon.mjs';

test('다른 프로그램의 ok:true health를 대기함으로 인정하거나 기록하지 않는다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-foreign-health-'));
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url, token: req.headers['x-approve-here-token'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  ensureToken(home);
  saveConfig(home, { port: server.address().port, codexAppServer: false });
  assert.equal(await daemonHealth(home), null);
  assert.equal(await stopDaemon(home), false);
  await assert.rejects(ensureDaemon({ home, waitMs: 400 }), /응답하지 않았습니다/);
  assert.equal(existsSync(join(home, 'daemon.json')), false);
  assert.ok(calls.every(call => call.path.startsWith('/health')), '상태 확인 외 요청은 보내지 않는다');
  assert.ok(calls.every(call => call.token === undefined), '다른 서버에 토큰을 전달하지 않는다');
});

test('다른 홈의 실제 대기함을 재사용하거나 종료하지 않는다', async t => {
  const owner = mkdtempSync(join(tmpdir(), 'inbox-owner-'));
  const other = mkdtempSync(join(tmpdir(), 'inbox-other-'));
  let shutdowns = 0;
  const daemon = await startDaemon({ home: owner, port: 0, onShutdown: () => shutdowns++ });
  t.after(async () => {
    await daemon.close();
    rmSync(owner, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
  ensureToken(other);
  saveConfig(other, { port: daemon.port });
  assert.equal(await daemonHealth(other), null);
  assert.equal(await stopDaemon(other), false);
  assert.equal(existsSync(join(other, 'daemon.json')), false);
  assert.equal(shutdowns, 0);
  assert.equal((await daemonHealth(owner))?.port, daemon.port);
});

test('이전 대기함은 기존 형식과 토큰 인증을 모두 확인한 뒤 재사용한다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-legacy-'));
  const token = ensureToken(home);
  let shutdowns = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/health')) {
      res.end(JSON.stringify({ ok: true, pid: process.pid, pending: 0, surfaceActive: false, codexAppServer: null }));
    } else if (req.headers['x-approve-here-token'] !== token) {
      res.writeHead(401); res.end('{}');
    } else if (req.url === '/codex') {
      res.end(JSON.stringify({ bridged: false, approvalsReviewer: null }));
    } else if (req.url === '/shutdown' && req.method === 'POST') {
      shutdowns++; res.end('{"ok":true}');
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  saveConfig(home, { port: server.address().port });
  const kill = t.mock.method(process, 'kill', () => { throw new Error('PID 신호를 보내면 안 됨'); });
  assert.equal((await daemonHealth(home))?.port, server.address().port);
  assert.equal((await ensureDaemon({ home })).started, false);
  assert.equal(await stopDaemon(home), true);
  assert.equal(shutdowns, 1);
  assert.equal(kill.mock.callCount(), 0);
  const other = mkdtempSync(join(tmpdir(), 'inbox-legacy-other-'));
  try {
    ensureToken(other);
    saveConfig(other, { port: server.address().port });
    assert.equal(await daemonHealth(other), null, '다른 홈 토큰은 이전 대기함에서도 거부한다');
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test('오래된 PID 기록을 상태 응답으로 복구하고 종료는 인증된 API로 요청한다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-stale-pid-'));
  let shutdowns = 0;
  const daemon = await startDaemon({ home, port: 0, onShutdown: () => shutdowns++ });
  t.after(async () => {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  });
  writeDaemonInfo(home, { pid: 2147483647, port: daemon.port });
  const kill = t.mock.method(process, 'kill', () => { throw new Error('PID 신호를 보내면 안 됨'); });
  assert.equal((await daemonHealth(home))?.pid, process.pid);
  assert.equal(JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).pid, process.pid);
  assert.equal(await stopDaemon(home), true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(shutdowns, 1);
  assert.equal(kill.mock.callCount(), 0);
});
