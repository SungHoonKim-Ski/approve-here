import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
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

for (const invalid of ['{"unexpected":"preserve me"}\n', '{broken\n']) {
  test(`자동 규칙을 읽지 못하면 허용을 처리하기 전에 실패하며 이번만 허용은 가능하다: ${invalid.trim()}`, async t => {
    const { api, home } = await boot(t);
    writeFileSync(join(home, 'allowlist.json'), invalid);
    const created = await (await api('/requests', { method: 'POST', body: JSON.stringify(sample) })).json();
    const remembered = await api(`/requests/${created.id}/decision`, {
      method: 'POST', body: JSON.stringify({ behavior: 'allow', remember: { commandPrefix: 'npm test' } }),
    });
    assert.equal(remembered.status, 500);
    assert.match((await remembered.json()).error, /요청을 허용하지 않았습니다.*이번만 허용/);
    assert.equal((await (await api(`/requests/${created.id}`)).json()).status, 'pending', '실패한 카드의 요청은 아직 허용되지 않아야 한다');
    assert.equal(readFileSync(join(home, 'allowlist.json'), 'utf8'), invalid);
    const once = await api(`/requests/${created.id}/decision`, { method: 'POST', body: JSON.stringify({ behavior: 'allow' }) });
    assert.equal(once.status, 200);
    assert.equal((await once.json()).status, 'allowed');
    assert.equal(readFileSync(join(home, 'allowlist.json'), 'utf8'), invalid);
  });
}

test('손상된 자동 규칙은 터미널에 허용 키를 전달하기 전 검출한다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  let deliveries = 0;
  const daemon = await startDaemon({ home, port: 0, tmux: { drive: async () => { deliveries++; return { ok: true }; } } });
  t.after(() => daemon.close());
  const api = (path, body) => fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  writeFileSync(join(home, 'allowlist.json'), '{broken\n');
  const created = await (await api('/requests', { ...sample, mode: 'mirror' })).json();
  assert.equal((await api(`/requests/${created.id}/decision`, { behavior: 'allow', remember: { commandPrefix: 'npm test' } })).status, 500);
  assert.equal(deliveries, 0);
  assert.equal((await (await api(`/requests/${created.id}`)).json()).status, 'pending');
  assert.equal((await api(`/requests/${created.id}/decision`, { behavior: 'allow' })).status, 200);
  assert.equal(deliveries, 1);
});

test('자동 규칙 사전 확인 뒤 승인 전달 중 추가된 규칙도 저장 때 보존한다', async t => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  let finishDelivery, signalDelivery;
  const delivery = new Promise(resolve => { signalDelivery = resolve; });
  const finished = new Promise(resolve => { finishDelivery = resolve; });
  const daemon = await startDaemon({ home, port: 0, tmux: { drive: async () => { signalDelivery(); await finished; return { ok: true }; } } });
  t.after(() => daemon.close());
  const api = (path, body) => fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method: 'POST', headers: { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const created = await (await api('/requests', { ...sample, mode: 'mirror' })).json();
  const response = api(`/requests/${created.id}/decision`, { behavior: 'allow', remember: { commandPrefix: 'npm test' } });
  try {
    await delivery;
    const concurrent = { tool: 'Bash', commandPrefix: 'git status', provider: 'claude' };
    writeFileSync(join(home, 'allowlist.json'), JSON.stringify([concurrent]));
    finishDelivery();
    assert.equal((await response).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'allowlist.json'), 'utf8')), [concurrent, { tool: 'Bash', commandPrefix: 'npm test', provider: 'codex' }]);
  } finally { finishDelivery(); await response; }
});

test('승인 전달 뒤 규칙 쓰기에 실패하면 실제 허용 결과와 저장 실패를 함께 돌려준다', async t => {
  if (process.getuid?.() === 0) return t.skip('권한 거부 검증은 일반 사용자로 실행한다');
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const rulesPath = join(home, 'allowlist.json');
  const original = '[{"tool":"Bash","commandPrefix":"git status"}]\n';
  writeFileSync(rulesPath, original);
  let deliveries = 0;
  const daemon = await startDaemon({ home, port: 0, tmux: { drive: async () => {
    deliveries++;
    chmodSync(rulesPath, 0o444);
    chmodSync(home, 0o500);
    return { ok: true };
  } } });
  t.after(async () => { chmodSync(home, 0o700); chmodSync(rulesPath, 0o600); await daemon.close(); });
  const api = (path, body) => fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const created = await (await api('/requests', { ...sample, mode: 'mirror' })).json();
  const response = await api(`/requests/${created.id}/decision`, { behavior: 'allow', remember: { commandPrefix: 'npm test' } });
  assert.equal(response.status, 200, '이미 전달한 승인을 실패했다고 응답하면 안 된다');
  const result = await response.json();
  assert.equal(result.status, 'allowed');
  assert.match(result.rememberError, /이번 요청은 허용.*자동 승인 규칙.*저장하지 못/);
  assert.equal(deliveries, 1);
  assert.equal(readFileSync(rulesPath, 'utf8'), original);
  const saved = await (await api(`/requests/${created.id}`)).json();
  assert.equal(saved.rememberError, result.rememberError, '저장 실패는 처리 이력에도 남긴다');
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
