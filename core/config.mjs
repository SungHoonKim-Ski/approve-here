import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULTS = Object.freeze({
  port: 4400,
  // 훅이 사용자 결정을 기다리는 상한(초). 넘기면 결정 없이 끝내 CLI의 원래 프롬프트로 후퇴한다.
  waitSeconds: 300,
  // CLI가 자기 프롬프트를 숨기는 요청(질문, Codex 승인)은 이 시간(초) 안에 답이 없으면 물러나 CLI에 원래
  // 프롬프트가 뜨게 한다 — 카드를 놓친 사람도 터미널에서 답할 수 있어야 한다. Claude 승인은 터미널에도 함께 뜨므로 해당 없음.
  handoffSeconds: 20,
  // tmux 안의 세션이면 질문·Codex 승인을 터미널과 카드 양쏙에 띄우고 먼저 답한 쪽이 이긴다(카드 결정은 tmux 키로 전달).
  mirror: true,
  // Codex app·공유 App Server CLI의 승인과 질문을 로컬 소켓으로 전달한다(tmux 불필요).
  codexAppServer: true,
  // 사용자 정책 훅 하나에 허용하는 실행 시간(초).
  policyTimeoutSeconds: 60,
  // provider별 사용자 정책 훅 명령. 훅 프로세스 안에서 순서대로 실행하고 첫 결정을 따른다.
  policyHooks: { claude: [], codex: [] },
  // 내장 allowlist 정책 사용 여부.
  allowlist: true,
  // 표면(메뉴바·TUI·웹)이 하나도 안 떠 있으면 훅은 기다리지 않고 바로 후퇴한다.
  // Codex는 훅이 기다리는 동안 자기 프롬프트를 숨기므로, 볼 사람이 없는 대기는 사용자를 막는 것과 같다.
  requireSurface: true,
  // 표면이 마지막으로 다녀간 뒤 이 시간(초) 안이면 활성으로 본다.
  presenceSeconds: 10,
  // 표면도 대기 요청도 없이 이 시간(초)이 지나면 데몬이 스스로 종료한다. 0이면 끄지 않는다.
  idleExitSeconds: 600,
});

export function inboxHome() {
  return process.env.APPROVE_HERE_HOME || join(homedir(), '.approve-here');
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
  if (!Array.isArray(rules)) throw new Error('자동 승인 규칙 파일은 배열이어야 합니다. 기존 파일을 확인해 주세요.');
  return rules;
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
