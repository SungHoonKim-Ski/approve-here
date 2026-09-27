import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDecision, allowlistDecision, runPolicyHooks } from '../core/policy.mjs';

test('parseDecision: PermissionRequest allow/deny를 읽고 그 외는 null', () => {
  const allow = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', reason: '읽기 전용' } },
  });
  assert.deepEqual(parseDecision(allow), { behavior: 'allow', message: '읽기 전용' });
  const deny = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '금지' } },
  });
  assert.deepEqual(parseDecision(deny), { behavior: 'deny', message: '금지' });
  assert.equal(parseDecision(JSON.stringify({ continue: true })), null);
  assert.equal(parseDecision(''), null);
  assert.equal(parseDecision('not json'), null);
  assert.equal(parseDecision(JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'ask' } } })), null);
});

test('parseDecision: PreToolUse 모양(permissionDecision)도 allow/deny로 읽는다', () => {
  const out = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'secret' },
  });
  assert.deepEqual(parseDecision(out), { behavior: 'deny', message: 'secret' });
});

test('allowlistDecision: Bash 명령 접두 규칙이 맞으면 allow, 아니면 null', () => {
  const rules = [
    { tool: 'Bash', commandPrefix: 'npm test' },
    { tool: 'Bash', commandPrefix: 'git status', provider: 'claude' },
  ];
  const req = provider => ({ provider, toolName: 'Bash', toolInput: { command: 'npm test -- --watch' } });
  assert.equal(allowlistDecision(req('codex'), rules)?.behavior, 'allow');
  assert.equal(allowlistDecision({ ...req('codex'), toolInput: { command: 'git status' } }, rules), null);
  assert.equal(allowlistDecision({ ...req('claude'), toolInput: { command: 'git status -sb' } }, rules)?.behavior, 'allow');
  assert.equal(allowlistDecision({ provider: 'claude', toolName: 'Write', toolInput: {} }, rules), null);
});

test('패치 헤더를 명령 접두로 저장한 규칙은 파일 변경을 자동 승인하지 않는다', () => {
  const request = { provider: 'codex', toolName: 'apply_patch', toolInput: { command: '*** Begin Patch\n*** Delete File: important.txt\n*** End Patch' } };
  assert.equal(allowlistDecision(request, [{ provider: 'codex', tool: 'apply_patch', commandPrefix: '*** Begin' }]), null);
});

test('runPolicyHooks: 사용자 훅을 순서대로 실행하고 첫 결정을 돌려준다. 결정이 없으면 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-policy-'));
  const passThrough = join(dir, 'pass.sh');
  writeFileSync(passThrough, '#!/bin/sh\ncat >/dev/null; printf %s \'{"continue":true}\'\n');
  const denier = join(dir, 'deny.sh');
  writeFileSync(
    denier,
    '#!/bin/sh\ncat >/dev/null; printf %s \'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"by policy"}}}\'\n',
  );
  chmodSync(passThrough, 0o755);
  chmodSync(denier, 0o755);
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  const none = await runPolicyHooks([passThrough], input);
  assert.equal(none, null);
  const decided = await runPolicyHooks([passThrough, denier], input);
  assert.equal(decided.decision.behavior, 'deny');
  assert.equal(decided.policy, denier);
});

test('runPolicyHooks: 훅이 죽거나 시간을 넘기면 결정 없음으로 취급한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-policy-'));
  const crash = join(dir, 'crash.sh');
  writeFileSync(crash, '#!/bin/sh\ncat >/dev/null; echo boom >&2; exit 2\n');
  chmodSync(crash, 0o755);
  const slow = join(dir, 'slow.sh');
  writeFileSync(slow, '#!/bin/sh\ncat >/dev/null; sleep 5\n');
  chmodSync(slow, 0o755);
  assert.equal(await runPolicyHooks([crash], '{}'), null);
  assert.equal(await runPolicyHooks([slow], '{}', { timeoutMs: 200 }), null);
});
