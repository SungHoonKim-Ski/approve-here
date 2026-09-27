#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createStdioRelay, isStdioAppServer } from '../core/codex-stdio-relay.mjs';
import { inboxHome } from '../core/config.mjs';

const executable = process.env.APPROVE_HERE_CODEX_CLI;
if (!executable || executable === process.argv[1]) throw new Error('원래 Codex 실행 파일 경로가 필요합니다. 중계 실행기로 앱을 여세요.');
const args = process.argv.slice(2);
let relay;
if (isStdioAppServer(args)) {
  try { relay = await createStdioRelay({ home: inboxHome() }); }
  catch (error) { console.error(`Approve Here 중계 연결 없이 원래 Codex를 실행합니다: ${error.message}`); }
}
const env = { ...process.env };
delete env.APPROVE_HERE_CODEX_RELAY;
delete env.APPROVE_HERE_CODEX_RELAY_SOCKET;
if (relay) { env.APPROVE_HERE_CODEX_RELAY = '1'; env.APPROVE_HERE_CODEX_RELAY_SOCKET = relay.socketPath; }
const child = spawn(executable, args, { env, stdio: relay ? ['pipe', 'pipe', 'inherit'] : 'inherit' });
if (relay) {
  relay.attach({ clientInput: process.stdin, clientOutput: process.stdout, serverInput: child.stdin, serverOutput: child.stdout });
  child.stdin.on('error', () => {});
  process.stdout.on('error', () => child.kill('SIGTERM'));
  process.stdin.on('end', () => { child.stdin.end(); });
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', async error => { console.error(error.message); await relay?.close(); process.exit(1); });
child.on('close', async (code, signal) => {
  await relay?.close();
  const status = code ?? (signal === 'SIGINT' ? 130 : 1);
  process.stdin.pause();
  if (!relay || process.stdout.writableFinished) process.exit(status);
  else process.stdout.end(() => process.exit(status));
});
