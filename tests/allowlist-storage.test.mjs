import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAllowlist, writeAllowlist } from '../core/config.mjs';

test('자동 규칙 쓰기가 일부 기록 후 실패해도 기존 파일은 그대로 남는다', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'allowlist-write-failure-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'allowlist.json');
  const original = '[{"tool":"Bash","commandPrefix":"git status","metadata":{"keep":true}}]\n';
  fs.writeFileSync(path, original);
  const write = fs.writeFileSync;
  const injected = t.mock.method(fs, 'writeFileSync', (target, data, options) => {
    write(target, data.slice(0, 5), options);
    throw Object.assign(new Error('injected partial write failure'), { code: 'ENOSPC' });
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeAllowlist(home, [{ tool: 'Bash', commandPrefix: 'npm test' }]), { code: 'ENOSPC' });
  } finally { injected.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(path, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(home), ['allowlist.json'], '실패한 임시 파일도 정리한다');
});

for (const [method, code] of [['fsyncSync', 'EIO'], ['renameSync', 'EACCES']]) {
  test(`자동 규칙 ${method} 실패도 원본을 보존하고 임시 파일을 정리한다`, t => {
    const home = fs.mkdtempSync(join(tmpdir(), 'allowlist-commit-failure-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const path = join(home, 'allowlist.json');
    const original = '[{"tool":"Bash","commandPrefix":"git status"}]\n';
    fs.writeFileSync(path, original);
    const injected = t.mock.method(fs, method, () => { throw Object.assign(new Error('injected commit failure'), { code }); });
    syncBuiltinESMExports();
    try { assert.throws(() => writeAllowlist(home, [{ tool: 'Bash', commandPrefix: 'npm test' }]), { code }); }
    finally { injected.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(fs.readFileSync(path, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(home), ['allowlist.json']);
  });
}

test('새 자동 규칙 파일은 사용자만 읽고 쓰며 기존 파일의 권한과 소유자는 유지한다', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'allowlist-permissions-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'allowlist.json');
  const first = [{ tool: 'Bash', commandPrefix: 'npm test', note: '한글 규칙' }];
  writeAllowlist(home, first);
  assert.deepEqual(readAllowlist(home), first);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  fs.chmodSync(path, 0o640);
  const before = fs.statSync(path);
  const second = [...first, { tool: 'Bash', commandPrefix: 'git status' }];
  writeAllowlist(home, second);
  const after = fs.statSync(path);
  assert.deepEqual(readAllowlist(home), second);
  assert.equal(after.mode & 0o777, before.mode & 0o777);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.deepEqual(fs.readdirSync(home), ['allowlist.json']);
});

for (const exists of [true, false]) {
  test(`자동 규칙 링크를 유지하면서 ${exists ? '기존' : '새'} 참조 대상에 기록한다`, t => {
    const home = fs.mkdtempSync(join(tmpdir(), 'allowlist-symlink-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(join(home, 'shared'));
    const target = join(home, 'shared', 'rules.json');
    if (exists) fs.writeFileSync(target, '[]\n');
    const path = join(home, 'allowlist.json');
    fs.symlinkSync('shared/rules.json', path);
    const rules = [{ tool: 'Bash', commandPrefix: 'npm test' }];
    writeAllowlist(home, rules);
    assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path), 'shared/rules.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), rules);
    assert.deepEqual(readAllowlist(home), rules);
    assert.deepEqual(fs.readdirSync(join(home, 'shared')), ['rules.json']);
  });
}

test('읽기 전용 자동 규칙은 새 파일로 우회해 덮어쓰지 않는다', t => {
  if (process.getuid?.() === 0) return t.skip('파일 권한 검증은 일반 사용자로 실행한다');
  const home = fs.mkdtempSync(join(tmpdir(), 'allowlist-readonly-'));
  const path = join(home, 'allowlist.json');
  fs.writeFileSync(path, '[]\n');
  fs.chmodSync(path, 0o444);
  t.after(() => { fs.chmodSync(path, 0o600); fs.rmSync(home, { recursive: true, force: true }); });
  assert.throws(() => writeAllowlist(home, [{ tool: 'Bash', commandPrefix: 'npm test' }]), { code: 'EACCES' });
  assert.equal(fs.readFileSync(path, 'utf8'), '[]\n');
  assert.equal(fs.statSync(path).mode & 0o777, 0o444);
  assert.deepEqual(fs.readdirSync(home), ['allowlist.json']);
});

test('규칙 경로가 디렉터리면 다른 내용까지 교체하거나 지우지 않는다', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'allowlist-directory-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'allowlist.json');
  fs.mkdirSync(path);
  fs.writeFileSync(join(path, 'keep.txt'), 'preserve');
  assert.throws(() => writeAllowlist(home, []), { code: 'EINVAL' });
  assert.equal(fs.readFileSync(join(path, 'keep.txt'), 'utf8'), 'preserve');
});
