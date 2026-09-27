import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installInto, uninstallFrom, hookCommand } from '../core/install.mjs';

for (const operation of ['install', 'uninstall']) {
  test(`CLI ${operation} 중 부분 쓰기가 실패해도 기존 에이전트 설정은 온전히 남는다`, t => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'hook-settings-write-failure-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'settings.json');
    const original = JSON.stringify({ permissions: { allow: ['Read'] }, hooks: {
      PermissionRequest: [{ hooks: [{ type: 'command', command: hookCommand('claude') }] }],
    } });
    fs.writeFileSync(path, original);
    const write = fs.writeFileSync;
    const injected = t.mock.method(fs, 'writeFileSync', (target, data, options) => {
      write(target, data.slice(0, 5), options);
      throw Object.assign(new Error('injected settings partial write failure'), { code: 'ENOSPC' });
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => operation === 'install' ? installInto(path, 'codex') : uninstallFrom(path), { code: 'ENOSPC' });
    } finally { injected.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(fs.readFileSync(path, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  });
}

test('새 CLI 설정은 사용자만 읽고 쓰도록 만든다', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hook-settings-permissions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, '.claude', 'settings.json');
  installInto(path, 'claude');
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
});

test('CLI 연결과 제거가 설정 링크와 기존 파일 권한을 유지한다', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hook-settings-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'shared.json');
  const path = join(dir, 'settings.json');
  fs.writeFileSync(target, JSON.stringify({ permissions: { allow: ['Read'] } }));
  fs.chmodSync(target, 0o640);
  const before = fs.statSync(target);
  fs.symlinkSync('shared.json', path);
  installInto(path, 'claude');
  assert.equal(fs.readlinkSync(path), 'shared.json');
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.equal(fs.statSync(target).uid, before.uid);
  assert.equal(fs.statSync(target).gid, before.gid);
  assert.equal(uninstallFrom(path).changed, true);
  assert.equal(fs.readlinkSync(path), 'shared.json');
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).permissions, { allow: ['Read'] });
});
