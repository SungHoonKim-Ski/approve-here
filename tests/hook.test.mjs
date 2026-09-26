import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { startDaemon } from '../core/daemon.mjs';

const HOOK = new URL('../hook/permission-hook.mjs', import.meta.url).pathname;

function runHook(args, input, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK, ...args], { env: { ...process.env, ...env } });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const claudeInput = JSON.stringify({
  session_id: 'c1',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  tool_use_id: 'toolu_1',
  cwd: '/tmp/proj',
  permission_mode: 'default',
});

test('데몬이 없으면 아무 결정도 내지 않고 exit 0 (터미널 프롬프트로 후퇴)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 1, waitSeconds: 1 }));
  const r = await runHook(['--provider', 'claude'], claudeInput, { AGENT_INBOX_HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('입력이 JSON이 아니어도 exit 0, 결정 없음', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const r = await runHook(['--provider', 'codex'], 'garbage', { AGENT_INBOX_HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('정책 훅이 결정하면 데몬을 기다리지 않고 그 결정을 그대로 낸다 (기록은 auto로 남김)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0 });
  const policy = join(home, 'policy.sh');
  writeFileSync(
    policy,
    '#!/bin/sh\ncat >/dev/null; printf %s \'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","reason":"read-only"}}}\'\n',
  );
  chmodSync(policy, 0o755);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ port: daemon.port, waitSeconds: 5, policyHooks: { claude: [policy] } }),
  );
  const r = await runHook(['--provider', 'claude'], claudeInput, { AGENT_INBOX_HOME: home });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(out.hookSpecificOutput.decision.behavior, 'allow');
  await new Promise(r => setTimeout(r, 100));
  const headers = { 'x-agent-inbox-token': daemon.token };
  const recent = await (await fetch(`http://127.0.0.1:${daemon.port}/requests?status=recent`, { headers })).json();
  assert.equal(recent[0].status, 'auto');
  assert.equal(recent[0].decidedBy, `policy:${policy}`);
  await daemon.close();
});

test('정책이 통과시키면 데몬에 등록하고 사용자 결정을 받아 낸다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: daemon.port, waitSeconds: 5 }));
  const headers = { 'x-agent-inbox-token': daemon.token, 'content-type': 'application/json' };
  const running = runHook(['--provider', 'codex'], claudeInput, { AGENT_INBOX_HOME: home, TMUX_PANE: '%9' });
  let pending = [];
  for (let i = 0; i < 40 && pending.length === 0; i++) {
    await new Promise(r => setTimeout(r, 50));
    pending = await (await fetch(`http://127.0.0.1:${daemon.port}/requests?status=pending`, { headers })).json();
  }
  assert.equal(pending.length, 1);
  assert.equal(pending[0].provider, 'codex');
  assert.equal(pending[0].tmux.pane, '%9');
  await fetch(`http://127.0.0.1:${daemon.port}/requests/${pending[0].id}/decision`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ behavior: 'deny', message: '지금은 안 됨' }),
  });
  const r = await running;
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.hookSpecificOutput.decision, { behavior: 'deny', message: '지금은 안 됨' });
  await daemon.close();
});

test('waitSeconds를 넘기면 expire 처리하고 결정 없이 exit 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: daemon.port, waitSeconds: 0.3 }));
  const r = await runHook(['--provider', 'claude'], claudeInput, { AGENT_INBOX_HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
  const headers = { 'x-agent-inbox-token': daemon.token };
  const recent = await (await fetch(`http://127.0.0.1:${daemon.port}/requests?status=recent`, { headers })).json();
  assert.equal(recent[0].status, 'expired');
  await daemon.close();
});

test('allowlist 규칙에 맞으면 사용자에게 묻지 않고 allow', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inbox-home-'));
  const daemon = await startDaemon({ home, port: 0 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: daemon.port, waitSeconds: 5 }));
  writeFileSync(join(home, 'allowlist.json'), JSON.stringify([{ tool: 'Bash', commandPrefix: 'npm test' }]));
  const r = await runHook(['--provider', 'claude'], claudeInput, { AGENT_INBOX_HOME: home });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior, 'allow');
  await daemon.close();
});
