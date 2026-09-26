import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULTS = Object.freeze({
  port: 4400,
  // 훅이 사용자 결정을 기다리는 상한(초). 넘기면 결정 없이 끝내 CLI의 원래 프롬프트로 후퇴한다.
  waitSeconds: 300,
  // 사용자 정책 훅 하나에 허용하는 실행 시간(초).
  policyTimeoutSeconds: 60,
  // provider별 사용자 정책 훅 명령. 훅 프로세스 안에서 순서대로 실행하고 첫 결정을 따른다.
  policyHooks: { claude: [], codex: [] },
  // 내장 allowlist 정책 사용 여부.
  allowlist: true,
});

export function inboxHome() {
  return process.env.AGENT_INBOX_HOME || join(homedir(), '.agent-inbox');
}

export function ensureHome(home = inboxHome()) {
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}을 읽을 수 없습니다: ${error.message}`);
  }
}

export function loadConfig(home = inboxHome()) {
  const user = readJson(join(home, 'config.json'), {});
  return {
    ...DEFAULTS,
    ...user,
    policyHooks: { ...DEFAULTS.policyHooks, ...(user.policyHooks || {}) },
  };
}

export function saveConfig(home, config) {
  ensureHome(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function readToken(home = inboxHome()) {
  const path = join(home, 'token');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
}

export function ensureToken(home = inboxHome()) {
  ensureHome(home);
  const existing = readToken(home);
  if (existing) return existing;
  const token = randomBytes(24).toString('hex');
  writeFileSync(join(home, 'token'), token, { mode: 0o600 });
  chmodSync(join(home, 'token'), 0o600);
  return token;
}

export function readAllowlist(home = inboxHome()) {
  const rules = readJson(join(home, 'allowlist.json'), []);
  return Array.isArray(rules) ? rules : [];
}

export function writeAllowlist(home, rules) {
  ensureHome(home);
  writeFileSync(join(home, 'allowlist.json'), JSON.stringify(rules, null, 2) + '\n', { mode: 0o600 });
}

export function readDaemonInfo(home = inboxHome()) {
  return readJson(join(home, 'daemon.json'), null);
}

export function writeDaemonInfo(home, info) {
  ensureHome(home);
  writeFileSync(join(home, 'daemon.json'), JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
}
