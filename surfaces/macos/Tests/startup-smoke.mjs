import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig } from '../../../core/config.mjs';
import { stopDaemon } from '../../../core/lifecycle.mjs';

const home = mkdtempSync(join(tmpdir(), 'approve-here-startup-home-'));
const server = createServer((req, res) => { res.writeHead(503); res.end('occupied test port'); });
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  saveConfig(home, { port: 0, codexAppServer: false, idleExitSeconds: 0 });
  const child = spawn(process.argv[2], [process.execPath, String(server.address().port)], { env: { ...process.env, APPROVE_HERE_HOME: home }, stdio: 'inherit', timeout: 35000 });
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
} finally {
  saveConfig(home, { port: 0, codexAppServer: false, idleExitSeconds: 0 });
  try { await stopDaemon(home); } catch { }
  await new Promise(resolve => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}
