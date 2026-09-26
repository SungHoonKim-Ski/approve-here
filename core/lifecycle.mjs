import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHome, inboxHome, readDaemonInfo } from './config.mjs';

const BIN = new URL('../bin/approve-here.mjs', import.meta.url).pathname;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** daemon.json이 가리키는 데몬이 실제로 응답하면 health를, 아니면 null을 돌려준다. 기록만 남은 죽은 데몬은 null이다. */
export async function daemonHealth(home = inboxHome()) {
  const info = readDaemonInfo(home);
  if (!info?.port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const value = await res.json();
    return value.ok ? { ...value, port: info.port, pid: info.pid } : null;
  } catch {
    return null;
  }
}

/**
 * 표면이 데몬을 데리고 다닌다. 데몬이 없으면 이 프로세스와 분리된 자식으로 띄우고 응답할 때까지 기다린다.
 * 표면을 닫아도 데몬은 남지만, 표면도 대기 요청도 없이 idleExitSeconds가 지나면 스스로 물러난다.
 */
export async function ensureDaemon({ home = inboxHome(), port, waitMs = 8000 } = {}) {
  const root = ensureHome(home);
  const existing = await daemonHealth(root);
  if (existing) return { started: false, port: existing.port, pid: existing.pid };
  const log = openSync(join(root, 'daemon.log'), 'a');
  const args = [BIN, 'daemon'];
  if (port !== undefined) args.push('--port', String(port));
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, APPROVE_HERE_HOME: root },
  });
  child.unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(100);
    const health = await daemonHealth(root);
    if (health && health.pid === child.pid) return { started: true, port: health.port, pid: child.pid };
  }
  throw new Error(`데몬이 ${waitMs / 1000}초 안에 응답하지 않았습니다. ${join(root, 'daemon.log')}를 확인하세요.`);
}

export async function stopDaemon(home = inboxHome()) {
  const info = readDaemonInfo(home);
  if (!info?.pid) return false;
  try {
    process.kill(info.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
