import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../../core/daemon.mjs';

assert.notEqual(process.getuid?.(), 0, 'run the permission-failure smoke as a normal user');
const home = mkdtempSync(join(tmpdir(), 'approve-here-decision-test-'));
const rulePath = join(home, 'allowlist.json');
const original = '[{"tool":"Bash","commandPrefix":"git status"}]\n';
let daemon, deliveries = 0;
try {
  writeFileSync(rulePath, original);
  daemon = await startDaemon({ home, port: 0, tmux: { drive: async () => {
    deliveries++;
    chmodSync(rulePath, 0o444); chmodSync(home, 0o500);
    return { ok: true };
  } } });
  const ids = [];
  for (const sessionId of ['warning', 'plain']) {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/requests`, {
      method: 'POST', headers: { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, provider: 'codex', mode: 'mirror', toolName: 'Bash', toolInput: { command: 'npm test' } }),
    });
    assert.equal(res.status, 201);
    ids.push((await res.json()).id);
  }
  const child = spawn(process.argv[2], ids, { env: { ...process.env, APPROVE_HERE_HOME: home }, stdio: 'inherit', timeout: 15000 });
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.equal(deliveries, 2);
  assert.equal(daemon.store.get(ids[0]).status, 'allowed');
  assert.ok(daemon.store.get(ids[0]).rememberError);
  assert.equal(daemon.store.get(ids[1]).status, 'allowed');
  assert.equal(readFileSync(rulePath, 'utf8'), original);
} finally {
  chmodSync(home, 0o700); chmodSync(rulePath, 0o600);
  if (daemon) await daemon.close();
  rmSync(home, { recursive: true, force: true });
}
