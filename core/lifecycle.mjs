import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
      const token = readToken(home);
      const challenge = randomBytes(24).toString('hex');
      const res = await fetch(`http://127.0.0.1:${port}/health?challenge=${challenge}`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      const value = await res.json();
      if (!value || value.ok !== true || !token || !Number.isSafeInteger(value.pid) || value.pid <= 0) continue;
      if (value.service === 'approve-here') {
        const expected = createHmac('sha256', token).update(challenge).digest();
        if (value.healthProtocol !== 1 || !/^[a-f0-9]{64}$/.test(value.proof ?? '') || !timingSafeEqual(expected, Buffer.from(value.proof, 'hex'))) continue;
      } else {
        // 0.5.2 이전 대기함은 서명이 없다. 이전 health 형식과 인증된 상태 응답을
        // 모두 확인해야 업그레이드 중 실행하던 대기함을 계속 사용할 수 있다.
        if (Object.hasOwn(value, 'service') || !Number.isSafeInteger(value.pending) || value.pending < 0 || typeof value.surfaceActive !== 'boolean' || !Object.hasOwn(value, 'codexAppServer')) continue;
        const unauthorized = await fetch(`http://127.0.0.1:${port}/codex`, {
          headers: { 'x-approve-here-token': randomBytes(24).toString('hex'), 'x-approve-here-client': 'hook' },
          signal: AbortSignal.timeout(1500),
        });
        await unauthorized.arrayBuffer();
        if (unauthorized.status !== 401) continue;
        const status = await fetch(`http://127.0.0.1:${port}/codex`, {
          headers: { 'x-approve-here-token': token, 'x-approve-here-client': 'hook' },
          signal: AbortSignal.timeout(1500),
        });
        if (!status.ok) continue;
        const body = await status.json();
        if (typeof body?.bridged !== 'boolean' || !Object.hasOwn(body, 'approvalsReviewer') || !(body.approvalsReviewer === null || typeof body.approvalsReviewer === 'string')) continue;
      }
      const pid = value.pid;
      // 기록 없이 살아 있는 데몬을 인정했으면 기록을 복구한다 — 표면(앱·TUI)은 daemon.json으로 데몬을 찾는다.
      if (info?.port !== port || info?.pid !== pid) writeDaemonInfo(home, { pid, port, startedAt: new Date().toISOString(), adopted: true });
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
  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, APPROVE_HERE_HOME: root },
    });
  } finally { closeSync(log); }
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

/** 오래된 pid 기록으로 다른 프로세스를 종료하지 않고 인증된 대기함에 종료를 요청한다. */
export async function stopDaemon(home = inboxHome()) {
  const health = await daemonHealth(home);
  if (!health) return false;
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
