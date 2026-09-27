import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { install, installInto, uninstallFrom, hookCommand, codexHooksPath } from '../core/install.mjs';

test('빈 홈에 Claude·Codex 훅을 등록하고, 두 번 실행해도 항목은 하나', () => {
  const userHome = mkdtempSync(join(tmpdir(), 'inbox-user-'));
  const logs = [];
  install({ claude: true, codex: true, home: '/tmp/x', userHome, hookPath: '/opt/inbox/hook/permission-hook.mjs', log: m => logs.push(m) });
  install({ claude: true, codex: true, home: '/tmp/x', userHome, hookPath: '/opt/inbox/hook/permission-hook.mjs', log: () => {} });
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const settings = JSON.parse(readFileSync(join(userHome, file), 'utf8'));
    const groups = settings.hooks.PermissionRequest;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].hooks.length, 1);
    assert.equal(groups[0].hooks[0].type, 'command');
    assert.equal(groups[0].hooks[0].timeout, 600);
  }
  const claude = JSON.parse(readFileSync(join(userHome, '.claude/settings.json'), 'utf8'));
  assert.match(claude.hooks.PermissionRequest[0].hooks[0].command, /--provider claude$/);
  assert.equal(claude.hooks.PreToolUse.length, 1, 'Claude에는 AskUserQuestion용 PreToolUse 훅도 하나');
  assert.equal(claude.hooks.PreToolUse[0].matcher, 'AskUserQuestion');
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, claude.hooks.PermissionRequest[0].hooks[0].command, '같은 명령이 두 이벤트를 받는다');
  const codex = JSON.parse(readFileSync(join(userHome, '.codex/hooks.json'), 'utf8'));
  assert.match(codex.hooks.PermissionRequest[0].hooks[0].command, /--provider codex$/);
  assert.equal(codex.hooks.PreToolUse, undefined, 'Codex에는 AskUserQuestion이 없다');
  assert.equal(codex.hooks.PostToolUse[0].matcher, undefined, 'Codex의 파일·MCP 승인도 도구 종료 신호로 mirror 카드를 지운다');
  assert.equal(claude.hooks.PostToolUse[0].matcher, 'AskUserQuestion');
  assert.ok(logs.some(m => m.includes('Hooks need review')), 'Codex 신뢰 안내를 출력한다');
});

test('기존 훅·다른 설정은 보존하고 우리 항목만 추가·교체한다', () => {
  const userHome = mkdtempSync(join(tmpdir(), 'inbox-user-'));
  mkdirSync(join(userHome, '.claude'));
  const path = join(userHome, '.claude/settings.json');
  writeFileSync(
    path,
    JSON.stringify({
      permissions: { allow: ['Bash(node *)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }],
        PermissionRequest: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node permission-handler.mjs' }] },
          { hooks: [{ type: 'command', command: 'node /old/place/permission-hook.mjs --provider claude' }] },
        ],
      },
    }),
  );
  const result = installInto(path, 'claude', '/new/place/permission-hook.mjs');
  assert.equal(result.changed, true);
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(node *)'] });
  assert.equal(settings.hooks.PreToolUse.length, 2, '기존 Bash guard + 우리 AskUserQuestion');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'node guard.mjs');
  const groups = settings.hooks.PermissionRequest;
  assert.equal(groups.length, 2, '기존 permission-handler 그룹 + 우리 그룹');
  assert.equal(groups[0].hooks[0].command, 'node permission-handler.mjs');
  assert.equal(groups[1].hooks[0].command, hookCommand('claude', '/new/place/permission-hook.mjs'));
});

test('uninstall은 우리 항목만 걷어낸다', () => {
  const userHome = mkdtempSync(join(tmpdir(), 'inbox-user-'));
  const path = join(userHome, '.claude/settings.json');
  installInto(path, 'claude', '/opt/inbox/hook/permission-hook.mjs');
  const removed = uninstallFrom(path);
  assert.equal(removed.changed, true);
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(settings.hooks.PermissionRequest, undefined);
  assert.equal(settings.hooks.PreToolUse, undefined);
  assert.equal(settings.hooks.PostToolUse, undefined);
});

test('provider를 지정하지 않으면 거절한다', () => {
  assert.throws(() => install({ userHome: mkdtempSync(join(tmpdir(), 'inbox-user-')), log: () => {} }), /--claude, --codex/);
});

test('사용자 지정 Codex 홈에서 설치와 제거가 같은 훅 파일을 사용한다', () => {
  const userHome = mkdtempSync(join(tmpdir(), 'inbox-user-'));
  const codexHome = join(userHome, 'custom-codex');
  const [result] = install({ codex: true, userHome, codexHome, log: () => {} });
  const path = codexHooksPath(userHome, codexHome);
  assert.equal(result.path, path);
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).hooks.PermissionRequest);
  uninstallFrom(path);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hooks.PermissionRequest, undefined);
});
