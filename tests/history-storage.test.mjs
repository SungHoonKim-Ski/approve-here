import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemon } from '../core/daemon.mjs';

async function boot(t, tmux) {
  const home = mkdtempSync(join(tmpdir(), 'inbox-history-storage-'));
  const path = join(home, 'requests.jsonl');
  const daemon = await startDaemon({ home, port: 0, tmux });
  t.after(async () => {
    if (existsSync(path)) chmodSync(path, 0o600);
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  });
  const api = (route, body) => fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method: body ? 'POST' : 'GET', headers: { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { home, path, daemon, api };
}
const sample = { provider: 'codex', toolName: 'Bash', toolInput: { command: 'npm test' } };

test('이력 기록 실패로 등록을 거절하면 처리할 수 없는 유령 요청도 남기지 않는다', async t => {
  if (process.getuid?.() === 0) return t.skip('권한 거부 검증은 일반 사용자로 실행한다');
  const { path, api } = await boot(t);
  writeFileSync(path, 'existing history\n');
  chmodSync(path, 0o444);
  assert.equal((await api('/requests', sample)).status, 500);
  assert.deepEqual(await (await api('/requests')).json(), []);
  assert.equal(readFileSync(path, 'utf8'), 'existing history\n');
});

test('터미널에 이미 전달된 답변은 이력 기록 실패와 별도로 성공을 응답한다', async t => {
  if (process.getuid?.() === 0) return t.skip('권한 거부 검증은 일반 사용자로 실행한다');
  let path, deliveries = 0;
  const fixture = await boot(t, { drive: async () => { deliveries++; chmodSync(path, 0o444); return { ok: true }; } });
  path = fixture.path;
  const { api } = fixture;
  const created = await (await api('/requests', { ...sample, mode: 'mirror' })).json();
  const before = readFileSync(path, 'utf8');
  const response = await api(`/requests/${created.id}/decision`, { behavior: 'allow' });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.status, 'allowed');
  assert.match(receipt.historyError, /답변.*전달.*이력.*저장하지 못/);
  assert.equal(deliveries, 1);
  assert.deepEqual(await (await api('/requests')).json(), []);
  assert.equal((await (await api(`/requests/${created.id}`)).json()).historyError, receipt.historyError);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('대기 중인 훅에도 실제 결정과 이력 기록 실패를 일관되게 돌려준다', async t => {
  if (process.getuid?.() === 0) return t.skip('권한 거부 검증은 일반 사용자로 실행한다');
  const { path, api } = await boot(t);
  const created = await (await api('/requests', sample)).json();
  chmodSync(path, 0o444);
  const waiting = api(`/requests/${created.id}/wait?timeout=0.5`).then(res => res.json());
  const response = await api(`/requests/${created.id}/decision`, { behavior: 'deny' });
  const receipt = await response.json();
  const observed = await waiting;
  assert.equal(response.status, 200);
  assert.equal(receipt.status, 'denied');
  assert.match(receipt.historyError, /답변.*전달.*이력.*저장하지 못/);
  assert.equal(observed.status, receipt.status);
  assert.deepEqual(observed.decision, { behavior: 'deny' });
  assert.equal(observed.historyError, receipt.historyError);
});

for (const [decision, status] of [[{ answers: { selection: '확인' } }, 'answered'], [{ passthrough: true }, 'passed']]) {
  test(`질문의 ${status} 결과도 이력 기록 실패와 구분한다`, async t => {
    if (process.getuid?.() === 0) return t.skip('권한 거부 검증은 일반 사용자로 실행한다');
    const { path, api } = await boot(t);
    const created = await (await api('/requests', { ...sample, provider: 'claude', toolName: 'AskUserQuestion', kind: 'question', questions: [{ id: 'selection', question: '검증 질문' }] })).json();
    chmodSync(path, 0o444);
    const response = await api(`/requests/${created.id}/decision`, decision);
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.status, status);
    assert.deepEqual(receipt.decision, decision);
    assert.match(receipt.historyError, /답변.*전달.*이력.*저장하지 못/);
    assert.deepEqual(await (await api('/requests')).json(), []);
  });
}
