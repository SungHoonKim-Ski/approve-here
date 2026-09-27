import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome, inboxHome, loadConfig, readDaemonInfo, readToken, writeDaemonInfo } from './config.mjs';

const BIN = fileURLToPath(new URL('../bin/approve-here.mjs', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 살아 있는 데몬의 health를, 없으면 null을 돌려준다. daemon.json이 가리키는 포트를 먼저 보고,
 * 기록이 없거나 죽었으면 설정 포트도 본다 — 기록 파일이 사라졌다고 멀쩡히 듣고 있는 데몬을 모른 척하면
 * 새 데몬이 EADDRINUSE로 죽고 아무도 못 붙는다.
 */
export async function daemonHealth(home = inboxHome()) {
  const info = readDaemonInfo(home);
  const candidates = [...new Set([info?.port, loadConfig(home).port].filter(Boolean))];
  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      const value = await res.json();
      if (!value.ok) continue;
      const pid = info?.port === port ? info.pid : value.pid ?? null;
      // 기록 없이 살아 있는 데몬을 인정했으면 기록을 복구한다 — 표면(앱·TUI)은 daemon.json으로 데몬을 찾는다.
      if (info?.port !== port) writeDaemonInfo(home, { pid, port, startedAt: new Date().toISOString(), adopted: true });
      return { ...value, port, pid };
    } catch {}
  }
  return null;
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
    // 우리가 띄운 자식이 EADDRINUSE로 죽었어도 그 포트에 다른 데몬이 살아 있으면 그것을 쓴다.
    if (health && child.exitCode !== null) return { started: false, port: health.port, pid: health.pid };
  }
  throw new Error(`데몬이 ${waitMs / 1000}초 안에 응답하지 않았습니다. ${join(root, 'daemon.log')}를 확인하세요.`);
}

/** pid 기록이 있으면 SIGTERM, 없으면 데몬 자신에게 /shutdown을 요청한다. */
export async function stopDaemon(home = inboxHome()) {
  const health = await daemonHealth(home);
  if (!health) return false;
  if (health.pid) {
    try {
      process.kill(health.pid, 'SIGTERM');
      return true;
    } catch {}
  }
  try {
    const res = await fetch(`http://127.0.0.1:${health.port}/shutdown`, {
      method: 'POST',
      headers: { 'x-approve-here-token': readToken(home) ?? '' },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
