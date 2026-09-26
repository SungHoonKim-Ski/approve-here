import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { startDaemon } from '../core/daemon.mjs';

const HOOK = new URL('../hook/permission-hook.mjs', import.meta.url).pathname;

function runHook(provider, input, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK, '--provider', provider], { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', d => (stdout += d));
    child.on('close', code => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function boot(t, tmux) {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0, tmux });
  t.after(() => daemon.close());
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: daemon.port, waitSeconds: 10, handoffSeconds: 5 }));
  const headers = { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' };
  const api = (path, init = {}) => fetch(`http://127.0.0.1:${daemon.port}${path}`, { ...init, headers }).then(r => r.json());
  await api('/requests');
  return { home, api };
}

const question = {
  session_id: 'c1', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'tu1', cwd: '/tmp/p',
  tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] },
};

const fakeTmux = () => {
  const calls = [];
  return {
    calls,
    jump: async () => ({ ok: true }),
    describe: async () => '작업창',
    drive: async (record, decision) => (calls.push({ id: record.id, decision }), { ok: true }),
  };
};

test('tmux 안의 질문: 훅은 즉시 물러나고(터미널에 다이얼로그가 뜸) 요청은 mirror로 등록된다', async t => {
  const tmux = fakeTmux();
  const { home, api } = await boot(t, tmux);
  const t0 = Date.now();
  const r = await runHook('claude', question, { APPROVE_HERE_HOME: home, TMUX_PANE: '%5' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '', '결정 없이 끝나 CLI가 다이얼로그를 띄운다');
  assert.ok(Date.now() - t0 < 3000, '기다리지 않는다');
  const [pending] = await api('/requests?status=pending');
  assert.equal(pending.mode, 'mirror');
  assert.equal(pending.handoffAt, null);
});

test('mirror 요청에 카드가 답하면 데몬이 tmux 다이얼로그에 키를 넣고 answered로 마감한다', async t => {
  const tmux = fakeTmux();
  const { home, api } = await boot(t, tmux);
  await runHook('claude', question, { APPROVE_HERE_HOME: home, TMUX_PANE: '%5' });
  const [pending] = await api('/requests?status=pending');
  const res = await api(`/requests/${pending.id}/decision`, { method: 'POST', body: JSON.stringify({ answers: { 'Q?': 'B' } }) });
  assert.equal(res.status, 'answered');
  assert.equal(res.decidedBy, 'user:tmux');
  assert.equal(tmux.calls.length, 1);
  assert.deepEqual(tmux.calls[0].decision.answers, { 'Q?': 'B' });
});

test('다이얼로그가 이미 사라졌으면(터미널에서 답함) 카드 결정은 409로 거절하고 요청을 외부 처리로 마감한다', async t => {
  const tmux = { ...fakeTmux(), drive: async () => ({ ok: false, reason: 'no-dialog' }) };
  const { home, api } = await boot(t, tmux);
  await runHook('claude', question, { APPROVE_HERE_HOME: home, TMUX_PANE: '%5' });
  const [pending] = await api('/requests?status=pending');
  const res = await api(`/requests/${pending.id}/decision`, { method: 'POST', body: JSON.stringify({ answers: { 'Q?': 'B' } }) });
  assert.match(res.error, /터미널/);
  const recent = await api('/requests?status=recent');
  assert.equal(recent[0].status, 'answered_externally');
});

test('PostToolUse(AskUserQuestion)가 오면 같은 세션의 mirror 요청을 외부 처리로 마감한다 — 터미널에서 답한 경우', async t => {
  const { home, api } = await boot(t, fakeTmux());
  await runHook('claude', question, { APPROVE_HERE_HOME: home, TMUX_PANE: '%5' });
  assert.equal((await api('/requests?status=pending')).length, 1);
  const post = { session_id: 'c1', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'tu1', tool_input: question.tool_input, tool_response: { answers: { 'Q?': 'A' } } };
  const r = await runHook('claude', post, { APPROVE_HERE_HOME: home, TMUX_PANE: '%5' });
  assert.equal(r.stdout.trim(), '');
  assert.equal((await api('/requests?status=pending')).length, 0);
  assert.equal((await api('/requests?status=recent'))[0].status, 'answered_externally');
});

test('같은 세션에서 새 요청이 오면 남아 있던 mirror 요청은 외부 처리로 밀린다 (Esc로 닫은 경우 등)', async t => {
  const { home, api } = await boot(t, fakeTmux());
  await runHook('claude', question, { APPROVE_HERE_HOME: home, TMUX_PANE: '%5' });
  await runHook('claude', { ...question, tool_use_id: 'tu2' }, { APPROVE_HERE_HOME: home, TMUX_PANE: '%5' });
  const pending = await api('/requests?status=pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].toolUseId, 'tu2');
});

test('질문 직후 오는 AskUserQuestion의 PermissionRequest(자동 허용 기록)는 mirror 카드를 밀어내지 않는다', async t => {
  const { home, api } = await boot(t, fakeTmux());
  await runHook('claude', question, { APPROVE_HERE_HOME: home, TMUX_PANE: '%5' });
  const permission = { session_id: 'c1', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: question.tool_input, cwd: '/tmp/p' };
  const r = await runHook('claude', permission, { APPROVE_HERE_HOME: home, TMUX_PANE: '%5' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior, 'allow');
  await new Promise(r => setTimeout(r, 100));
  const pending = await api('/requests?status=pending');
  assert.equal(pending.length, 1, '질문 카드는 그대로 남는다');
  assert.equal(pending[0].mode, 'mirror');
});

test('tmux 밖의 질문은 mirror가 아니라 handoff로 간다', async t => {
  const { home, api } = await boot(t, fakeTmux());
  const env = { APPROVE_HERE_HOME: home };
  delete process.env.TMUX_PANE;
  const running = runHook('claude', question, { ...env, TMUX_PANE: '' });
  let pending = [];
  for (let i = 0; i < 40 && pending.length === 0; i++) {
    await new Promise(r => setTimeout(r, 50));
    pending = await api('/requests?status=pending');
  }
  assert.equal(pending[0].mode, 'wait');
  assert.ok(pending[0].handoffAt);
  await api(`/requests/${pending[0].id}/decision`, { method: 'POST', body: JSON.stringify({ passthrough: true }) });
  await running;
});
