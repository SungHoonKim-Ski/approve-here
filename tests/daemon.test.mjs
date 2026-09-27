import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemon } from '../core/daemon.mjs';

async function boot(t) {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0, tmux: { jump: async () => ({ ok: true }) } });
  t.after(() => daemon.close());
  const base = `http://127.0.0.1:${daemon.port}`;
  const headers = { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' };
  const api = (path, init = {}) => fetch(base + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  return { home, daemon, api };
}

const sample = {
  provider: 'codex',
  sessionId: 's1',
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  cwd: '/tmp/proj',
  tmux: { pane: '%27' },
};

test('토큰 없는 요청은 401, health는 토큰 없이 200', async t => {
  const { daemon, api } = await boot(t);
  const anon = await fetch(`http://127.0.0.1:${daemon.port}/requests`);
  assert.equal(anon.status, 401);
  const health = await fetch(`http://127.0.0.1:${daemon.port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await api('/requests')).status, 200);
});

test('요청 등록 → 대기 목록 → 결정 → 대기 중인 훅이 결정을 받는다', async t => {
  const { daemon, api, home } = await boot(t);
  const created = await (await api('/requests', { method: 'POST', body: JSON.stringify(sample) })).json();
  assert.ok(created.id);
  const pending = await (await api('/requests?status=pending')).json();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].project, 'proj');

  const waiting = api(`/requests/${created.id}/wait?timeout=5`).then(r => r.json());
  await new Promise(r => setTimeout(r, 50));
  const decided = await api(`/requests/${created.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ behavior: 'allow', message: '확인함' }),
  });
  assert.equal(decided.status, 200);
  const result = await waiting;
  assert.equal(result.status, 'allowed');
  assert.deepEqual(result.decision, { behavior: 'allow', message: '확인함' });
  assert.equal((await (await api('/requests?status=pending')).json()).length, 0);

  const log = readFileSync(join(home, 'requests.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 2, '등록·결정 두 줄이 기록된다');
});

test('wait는 timeout까지 결정이 없으면 pending으로 돌아온다(long-poll)', async t => {
  const { daemon, api } = await boot(t);
  const created = await (await api('/requests', { method: 'POST', body: JSON.stringify(sample) })).json();
  const t0 = Date.now();
  const result = await (await api(`/requests/${created.id}/wait?timeout=0.2`)).json();
  assert.equal(result.status, 'pending');
  assert.ok(Date.now() - t0 >= 150);
});

test('훅이 포기(expire)하면 이후 결정은 409로 거절한다', async t => {
  const { daemon, api } = await boot(t);
  const created = await (await api('/requests', { method: 'POST', body: JSON.stringify(sample) })).json();
  assert.equal((await api(`/requests/${created.id}/expire`, { method: 'POST' })).status, 200);
  const late = await api(`/requests/${created.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ behavior: 'allow' }),
  });
  assert.equal(late.status, 409);
});

test('remember가 있는 allow는 allowlist에 규칙을 추가한다', async t => {
  const { daemon, api, home } = await boot(t);
  const created = await (await api('/requests', { method: 'POST', body: JSON.stringify(sample) })).json();
  await api(`/requests/${created.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ behavior: 'allow', remember: { commandPrefix: 'npm test' } }),
  });
  const rules = JSON.parse(readFileSync(join(home, 'allowlist.json'), 'utf8'));
  assert.deepEqual(rules, [{ tool: 'Bash', commandPrefix: 'npm test', provider: 'codex' }]);
  assert.deepEqual(await (await api('/allowlist')).json(), rules);
});

test('자동 승인 해제는 선택한 원문 규칙만 지우고 목록을 연 뒤 추가된 규칙도 보존한다', async t => {
  const { api, home } = await boot(t);
  const selected = { tool: 'Bash', commandPrefix: 'npm test', provider: 'codex', note: '기존 설정' };
  const other = { tool: 'Bash', commandPrefix: 'npm test', provider: 'claude' };
  await api('/allowlist', { method: 'PUT', body: JSON.stringify([selected, other]) });
  const snapshot = await (await api('/allowlist')).json();
  const created = await (await api('/requests', { method: 'POST', body: JSON.stringify(sample) })).json();
  await api(`/requests/${created.id}/decision`, { method: 'POST', body: JSON.stringify({ behavior: 'allow', remember: { commandPrefix: 'git status' } }) });
  const removed = await api('/allowlist', { method: 'DELETE', body: JSON.stringify({ rule: snapshot[0] }) });
  assert.equal(removed.status, 200);
  const expected = [other, { tool: 'Bash', commandPrefix: 'git status', provider: 'codex' }];
  assert.deepEqual(await removed.json(), expected);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'allowlist.json'), 'utf8')), expected);
  assert.equal((await api('/allowlist', { method: 'DELETE', body: JSON.stringify({ rule: selected }) })).status, 409);
  assert.deepEqual(await (await api('/allowlist')).json(), expected);
});

test('자동 승인 해제는 인증과 정확한 규칙을 요구하며 실패하면 파일을 바꾸지 않는다', async t => {
  const { api, home, daemon } = await boot(t);
  const rules = [{ tool: 'Bash', commandPrefix: 'npm test', provider: 'codex', note: '보존' }];
  await api('/allowlist', { method: 'PUT', body: JSON.stringify(rules) });
  const before = readFileSync(join(home, 'allowlist.json'), 'utf8');
  const anon = await fetch(`http://127.0.0.1:${daemon.port}/allowlist`, { method: 'DELETE', body: JSON.stringify({ rule: rules[0] }) });
  assert.equal(anon.status, 401);
  assert.equal((await api('/allowlist', { method: 'DELETE', body: '{}' })).status, 400);
  assert.equal((await api('/allowlist', { method: 'DELETE', body: JSON.stringify({ rule: { ...rules[0], note: '변경됨' } }) })).status, 409);
  assert.equal(readFileSync(join(home, 'allowlist.json'), 'utf8'), before);
  const reordered = { note: '보존', provider: 'codex', commandPrefix: 'npm test', tool: 'Bash' };
  assert.equal((await api('/allowlist', { method: 'DELETE', body: JSON.stringify({ rule: reordered }) })).status, 200);
  assert.deepEqual(await (await api('/allowlist')).json(), []);
});

test('잘못된 자동 승인 파일을 빈 목록으로 표시하거나 해제 중 덮어쓰지 않는다', async t => {
  const { api, home } = await boot(t);
  const invalid = '{"unexpected":"preserve me"}\n';
  writeFileSync(join(home, 'allowlist.json'), invalid);
  assert.equal((await api('/allowlist')).status, 500);
  assert.equal((await api('/allowlist', { method: 'DELETE', body: JSON.stringify({ rule: { tool: 'Bash', commandPrefix: 'npm test' } }) })).status, 500);
  assert.equal(readFileSync(join(home, 'allowlist.json'), 'utf8'), invalid);
});

test('자동 처리(policy) 기록은 pending에 오르지 않고 recent에 남는다', async t => {
  const { daemon, api } = await boot(t);
  const body = { ...sample, status: 'auto', decision: { behavior: 'allow', message: '읽기 전용' }, decidedBy: 'policy:permission-handler' };
  const created = await (await api('/requests', { method: 'POST', body: JSON.stringify(body) })).json();
  assert.ok(created.id);
  assert.equal((await (await api('/requests?status=pending')).json()).length, 0);
  const recent = await (await api('/requests?status=recent')).json();
  assert.equal(recent[0].status, 'auto');
});

test('등록 시 tmux 창 이름을 붙이고 context를 보존한다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0, tmux: { jump: async () => ({ ok: true }), describe: async ({ pane }) => (pane === '%27' ? '결제-환불' : null) } });
  t.after(() => daemon.close());
  const headers = { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' };
  const created = await (
    await fetch(`http://127.0.0.1:${daemon.port}/requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...sample, context: { task: '환불 API 추가', latest: '테스트도 돌려' } }),
    })
  ).json();
  const record = await (await fetch(`http://127.0.0.1:${daemon.port}/requests/${created.id}`, { headers })).json();
  assert.equal(record.tmux.title, '결제-환불');
  assert.equal(record.tmux.pane, '%27');
  assert.deepEqual(record.context, { task: '환불 API 추가', latest: '테스트도 돌려' });
});

test('jump는 tmux 어댑터를 부른다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const calls = [];
  const daemon = await startDaemon({ home, port: 0, tmux: { jump: async target => (calls.push(target), { ok: true }) } });
  t.after(() => daemon.close());
  const headers = { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' };
  const created = await (
    await fetch(`http://127.0.0.1:${daemon.port}/requests`, { method: 'POST', headers, body: JSON.stringify(sample) })
  ).json();
  const res = await fetch(`http://127.0.0.1:${daemon.port}/requests/${created.id}/jump`, { method: 'POST', headers });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ pane: '%27' }]);
  assert.ok(existsSync(join(home, 'daemon.json')));
});
