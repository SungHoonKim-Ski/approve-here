import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { startDaemon } from '../core/daemon.mjs';

const HOOK = new URL('../hook/permission-hook.mjs', import.meta.url).pathname;

function runHook(input, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK, '--provider', 'claude'], { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', d => (stdout += d));
    child.on('close', code => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

async function bootDaemon(t, config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0 });
  t.after(() => daemon.close());
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: daemon.port, waitSeconds: 5, ...config }));
  const headers = { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' };
  const api = (path, init = {}) => fetch(`http://127.0.0.1:${daemon.port}${path}`, { ...init, headers });
  await api('/requests'); // 표면이 보고 있는 상태
  return { home, daemon, api };
}

const askInput = {
  session_id: 'c1',
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_use_id: 'toolu_q',
  cwd: '/tmp/proj',
  tool_input: {
    questions: [
      { question: '어느 DB?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite', description: '가벼움' }], multiSelect: false },
    ],
  },
};

async function waitPending(api) {
  let pending = [];
  for (let i = 0; i < 40 && pending.length === 0; i++) {
    await new Promise(r => setTimeout(r, 50));
    pending = await (await api('/requests?status=pending')).json();
  }
  return pending;
}

test('AskUserQuestion은 질문 카드로 올라오고, 답을 고르면 answers를 채운 updatedInput으로 allow한다', async t => {
  const { home, api } = await bootDaemon(t);
  const running = runHook(JSON.stringify(askInput), { APPROVE_HERE_HOME: home });
  const [card] = await waitPending(api);
  assert.equal(card.kind, 'question');
  assert.equal(card.toolName, 'AskUserQuestion');
  assert.equal(card.questions[0].question, '어느 DB?');
  assert.equal(card.questions[0].options[1].label, 'SQLite');
  const res = await api(`/requests/${card.id}/decision`, { method: 'POST', body: JSON.stringify({ answers: { '어느 DB?': 'SQLite' } }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'answered');
  const r = await running;
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'allow');
  assert.deepEqual(out.updatedInput.answers, { '어느 DB?': 'SQLite' });
  assert.deepEqual(out.updatedInput.questions, askInput.tool_input.questions, '질문 원문은 그대로 둔다');
});

test('"터미널에서 답하기"(passthrough)를 고르면 훅은 아무 출력 없이 끝나 원래 다이얼로그가 뜬다', async t => {
  const { home, api } = await bootDaemon(t);
  const running = runHook(JSON.stringify(askInput), { APPROVE_HERE_HOME: home });
  const [card] = await waitPending(api);
  const res = await api(`/requests/${card.id}/decision`, { method: 'POST', body: JSON.stringify({ passthrough: true }) });
  assert.equal((await res.json()).status, 'passed');
  const r = await running;
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('질문 카드에는 allow/deny를 보낼 수 없고, 권한 카드에는 answers를 보낼 수 없다', async t => {
  const { api } = await bootDaemon(t);
  const question = await (await api('/requests', { method: 'POST', body: JSON.stringify({ provider: 'claude', kind: 'question', toolName: 'AskUserQuestion', questions: askInput.tool_input.questions, toolInput: askInput.tool_input }) })).json();
  assert.equal((await api(`/requests/${question.id}/decision`, { method: 'POST', body: JSON.stringify({ behavior: 'allow' }) })).status, 400);
  assert.equal((await api(`/requests/${question.id}/decision`, { method: 'POST', body: JSON.stringify({ answers: { x: 1 } }) })).status, 400, 'answers 값은 문자열');
  const permission = await (await api('/requests', { method: 'POST', body: JSON.stringify({ provider: 'claude', toolName: 'Bash', toolInput: { command: 'ls' } }) })).json();
  assert.equal((await api(`/requests/${permission.id}/decision`, { method: 'POST', body: JSON.stringify({ answers: { q: 'a' } }) })).status, 400);
});

test('AskUserQuestion이 아닌 PreToolUse는 우리 일이 아니다 — 즉시 조용히 끝난다', async t => {
  const { home, api } = await bootDaemon(t);
  const r = await runHook(JSON.stringify({ ...askInput, tool_name: 'Bash', tool_input: { command: 'ls' } }), { APPROVE_HERE_HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
  assert.equal((await (await api('/requests?status=pending')).json()).length, 0);
});

test('질문 카드는 정책 훅·allowlist를 거치지 않는다', async t => {
  const { home, api } = await bootDaemon(t);
  writeFileSync(join(home, 'allowlist.json'), JSON.stringify([{ tool: 'AskUserQuestion', commandPrefix: '' }]));
  const running = runHook(JSON.stringify(askInput), { APPROVE_HERE_HOME: home });
  const [card] = await waitPending(api);
  assert.ok(card, '질문은 항상 사용자에게 간다');
  await api(`/requests/${card.id}/decision`, { method: 'POST', body: JSON.stringify({ passthrough: true }) });
  await running;
});
