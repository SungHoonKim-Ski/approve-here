import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../../core/daemon.mjs';
import { readAllowlist, writeAllowlist, writeDaemonInfo } from '../../../core/config.mjs';

const home = mkdtempSync(join(tmpdir(), 'approve-here-rules-test-'));
const kept = { tool: 'Bash', commandPrefix: 'npm test', provider: 'claude', metadata: { keep: true } };
let daemon;
try {
  writeAllowlist(home, [{ tool: 'Bash', commandPrefix: 'npm test', provider: 'codex', metadata: { keep: false, count: 3 } }, kept]);
  daemon = await startDaemon({ home, port: 0, codexBridge: { enabled: () => false } });
  writeDaemonInfo(home, { port: daemon.port });
  const child = spawn(process.argv[2], [], { env: { ...process.env, APPROVE_HERE_HOME: home }, stdio: 'inherit', timeout: 15000 });
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.deepEqual(readAllowlist(home), [kept]);
} finally {
  if (daemon) await daemon.close();
  rmSync(home, { recursive: true, force: true });
}
