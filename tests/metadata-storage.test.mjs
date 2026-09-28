import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveConfig, writeDaemonInfo } from '../core/config.mjs';

for (const [name, file, update] of [
  ['사용자 설정', 'config.json', home => saveConfig(home, { port: 4401 })],
  ['대기함 시작 정보', 'daemon.json', home => writeDaemonInfo(home, { pid: 2, port: 4401 })],
]) {
  test(`${name} 쓰기가 일부만 진행된 뒤 실패해도 기존 파일을 보존한다`, t => {
    const home = fs.mkdtempSync(join(tmpdir(), 'approve-here-metadata-failure-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const path = join(home, file);
    const original = '{"port":4400,"custom":{"keep":true}}\n';
    fs.writeFileSync(path, original);
    const write = fs.writeFileSync;
    const injected = t.mock.method(fs, 'writeFileSync', (target, data, options) => {
      write(target, data.slice(0, 5), options);
      throw Object.assign(new Error('injected partial metadata write'), { code: 'ENOSPC' });
    });
    syncBuiltinESMExports();
    try { assert.throws(() => update(home), { code: 'ENOSPC' }); }
    finally { injected.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(fs.readFileSync(path, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(home), [file]);
  });
}

test('새 대기함 시작 정보는 사용자만 읽고 쓴다', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'approve-here-metadata-private-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeDaemonInfo(home, { pid: 1, port: 4400 });
  assert.equal(fs.statSync(join(home, 'daemon.json')).mode & 0o777, 0o600);
});
