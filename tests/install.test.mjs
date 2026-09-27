import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

test('읽을 수 없는 설정 형식은 설치·제거 모두 원본을 보존한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-invalid-settings-'));
  const path = join(dir, 'settings.json');
  const values = [{ hooks: [] }, null, [], 'settings', { hooks: null }, { hooks: 'hooks' },
    { hooks: { PermissionRequest: {} } }, { hooks: { PreToolUse: [null] } },
    { hooks: { PermissionRequest: [{ hooks: {} }] } },
    { hooks: { Stop: [{ hooks: [null] }] } }];
  try {
    for (const raw of [...values.map(value => JSON.stringify(value)), '{broken']) {
      writeFileSync(path, raw);
      for (const edit of [() => installInto(path, 'claude'), () => uninstallFrom(path)]) {
        assert.throws(edit, /기존 설정을 보존/);
        assert.equal(readFileSync(path, 'utf8'), raw);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('다른 훅과 같은 그룹에 있는 우리 훅도 제거하고 그룹 메타데이터를 보존한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-mixed-hooks-'));
  const path = join(dir, 'settings.json');
  const other = { type: 'command', command: 'node guard.mjs', timeout: 10 };
  const group = { matcher: 'Bash', custom: { retained: true }, hooks: [other, { type: 'command', command: hookCommand('claude') }] };
  try {
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { PermissionRequest: [group] } }));
    assert.equal(uninstallFrom(path).changed, true);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Read'] });
    assert.deepEqual(settings.hooks.PermissionRequest, [{ ...group, hooks: [other] }]);
    const raw = readFileSync(path, 'utf8');
    assert.equal(uninstallFrom(path).changed, false);
    assert.equal(readFileSync(path, 'utf8'), raw);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('이미 같은 훅이 등록돼 있으면 설치가 파일을 다시 쓰지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-stable-hooks-'));
  const path = join(dir, 'settings.json');
  try {
    assert.equal(installInto(path, 'claude').changed, true);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    const raw = JSON.stringify(settings); // 다른 들여쓰기도 재설치로 바뀌지 않는다.
    writeFileSync(path, raw);
    assert.equal(installInto(path, 'claude').changed, false);
    assert.equal(readFileSync(path, 'utf8'), raw);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
