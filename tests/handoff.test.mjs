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

async function boot(t, config) {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0 });
  t.after(() => daemon.close());
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: daemon.port, waitSeconds: 10, mirror: false, ...config }));
  const headers = { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' };
  const api = (path, init = {}) => fetch(`http://127.0.0.1:${daemon.port}${path}`, { ...init, headers }).then(r => r.json());
  await api('/requests'); // 표면이 보고 있다
  return { home, api };
}

const question = {
  session_id: 'c', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 't', cwd: '/tmp/p',
  tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] },
};
const codexPermission = { session_id: 'x', turn_id: 'u', model: 'gpt', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'touch x' }, cwd: '/tmp/p' };
const claudePermission = { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'touch x' }, cwd: '/tmp/p' };

test('질문: handoffSeconds 안에 답이 없으면 훅이 물러나 CLI가 원래 다이얼로그를 띄운다 (handed_off)', async t => {
  const { home, api } = await boot(t, { handoffSeconds: 0.4 });
  const t0 = Date.now();
  const r = await runHook('claude', question, { APPROVE_HERE_HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '', '결정 없이 끝난다');
  assert.ok(Date.now() - t0 < 5000, 'waitSeconds(10)가 아니라 handoff(0.4)에 끝난다');
  const recent = await api('/requests?status=recent');
  assert.equal(recent[0].status, 'handed_off');
  assert.ok(recent[0].handoffAt, '카드가 남은 시간을 보일 수 있게 인계 시각을 싣는다');
});

test('Codex 승인: 프롬프트를 숨기는 쪽이라 같은 인계를 적용한다', async t => {
  const { home, api } = await boot(t, { handoffSeconds: 0.4 });
  const r = await runHook('codex', codexPermission, { APPROVE_HERE_HOME: home });
  assert.equal(r.stdout.trim(), '');
  assert.equal((await api('/requests?status=recent'))[0].status, 'handed_off');
});

test('Claude 승인: 터미널에도 함께 뜨므로 인계하지 않고 waitSeconds까지 기다린다', async t => {
  const { home, api } = await boot(t, { handoffSeconds: 0.3, waitSeconds: 1 });
  const t0 = Date.now();
  const r = await runHook('claude', claudePermission, { APPROVE_HERE_HOME: home });
  assert.equal(r.stdout.trim(), '');
  assert.ok(Date.now() - t0 >= 900, 'handoff가 아니라 waitSeconds에 끝난다');
  assert.equal((await api('/requests?status=recent'))[0].status, 'expired');
  const pending = await api('/requests?status=pending');
  assert.equal(pending.length, 0);
});

test('인계 전에 답하면 그대로 전달된다', async t => {
  const { home, api } = await boot(t, { handoffSeconds: 5 });
  const running = runHook('claude', question, { APPROVE_HERE_HOME: home });
  let pending = [];
  for (let i = 0; i < 40 && pending.length === 0; i++) {
    await new Promise(r => setTimeout(r, 50));
    pending = await api('/requests?status=pending');
  }
  assert.ok(pending[0].handoffAt, '대기 중인 카드도 인계 시각을 안다');
  await api(`/requests/${pending[0].id}/decision`, { method: 'POST', body: JSON.stringify({ answers: { 'Q?': 'B' } }) });
  const r = await running;
  assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.answers, { 'Q?': 'B' });
});
