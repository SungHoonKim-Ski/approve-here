import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { replaceFile } from './atomic-file.mjs';

export const HOOK_PATH = fileURLToPath(new URL('../hook/permission-hook.mjs', import.meta.url));
const MARKER = 'permission-hook.mjs';

export function hookCommand(provider, hookPath = HOOK_PATH) {
  return `node "${hookPath}" --provider ${provider}`;
}

/**
 * provider별로 우리 훅이 서는 이벤트. 훅 하나가 stdin의 hook_event_name으로 둘을 가른다.
 * Claude 질문은 PreToolUse로 받는다. Codex의 request_user_input은 로컬 App Server 연결로 받는다.
 */
export function hookEvents(provider) {
  // PostToolUse는 "터미널에서 답했다"는 신호다 — 양쪽에 떠 있던 카드를 지운다.
  return provider === 'claude'
    ? [{ event: 'PermissionRequest' }, { event: 'PreToolUse', matcher: 'AskUserQuestion' }, { event: 'PostToolUse', matcher: 'AskUserQuestion' }]
    : [{ event: 'PermissionRequest' }, { event: 'PostToolUse' }];
}

/**
 * Claude Code(~/.claude/settings.json)와 Codex(~/.codex/hooks.json)에 훅을 등록한다.
 * 두 CLI의 hooks 설정 모양이 같아 한 함수로 처리한다. 이미 있는 다른 훅은 그대로 두고, 우리 항목은 이벤트마다 하나만 유지한다.
 */
export function codexHooksPath(userHome = homedir(), codexHome = process.env.CODEX_HOME) {
  return join(codexHome || join(userHome, '.codex'), 'hooks.json');
}

export function install({ claude = false, codex = false, home, userHome = homedir(), codexHome = process.env.CODEX_HOME, hookPath = HOOK_PATH, log = console.log } = {}) {
  if (!claude && !codex) throw new Error('--claude, --codex 중 하나 이상을 지정하세요.');
  const results = [];
  if (claude) results.push(installInto(join(userHome, '.claude', 'settings.json'), 'claude', hookPath));
  if (codex) results.push(installInto(codexHooksPath(userHome, codexHome), 'codex', hookPath));
  for (const r of results) log(`${r.changed ? '등록' : '이미 등록됨'}: ${r.path}`);
  if (codex)
    log(
      '\nCodex는 새 훅을 처음 만나면 신뢰 확인을 요구합니다. `codex`를 실행하고 "Hooks need review"에서 검토·신뢰하거나 `/hooks`에서 처리하세요.\n훅 명령이 바뀌면(경로 변경 등) 다시 신뢰해야 합니다.',
    );
  log(`\n데이터 폴더: ${home}\n대기함 열기: approve-here (tmux pane) · approve-here app (메뉴바) · approve-here open (브라우저)`);
  return results;
}

export function installInto(path, provider, hookPath = HOOK_PATH) {
  const current = readForEdit(path);
  const hooks = { ...current.hooks };
  const command = hookCommand(provider, hookPath);
  for (const { event, matcher } of hookEvents(provider)) {
    const groups = hooks[event] ?? [];
    const ours = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 600 }] };
    const kept = withoutOurs(groups);
    hooks[event] = [...kept, ours];
  }
  const changed = !isDeepStrictEqual(current.hooks, hooks);
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    replaceFile(path, JSON.stringify({ ...current, hooks }, null, 2) + '\n');
  }
  return { path, provider, changed };
}

export function uninstallFrom(path) {
  if (!existsSync(path)) return { path, changed: false };
  const current = readForEdit(path);
  if (!current.hooks) return { path, changed: false };
  const hooks = { ...current.hooks };
  let changed = false;
  for (const event of ['PermissionRequest', 'PreToolUse', 'PostToolUse']) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = withoutOurs(groups);
    if (!isDeepStrictEqual(kept, groups)) changed = true;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (changed) replaceFile(path, JSON.stringify({ ...current, hooks }, null, 2) + '\n');
  return { path, changed };
}

function readForEdit(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  let root;
  try { root = JSON.parse(raw); }
  catch (cause) { throw invalidSettings(path, cause); }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(root)) throw invalidSettings(path);
  if (Object.hasOwn(root, 'hooks')) {
    if (!object(root.hooks)) throw invalidSettings(path);
    for (const groups of Object.values(root.hooks)) {
      if (!Array.isArray(groups) || !groups.every(group => object(group) && Array.isArray(group.hooks) && group.hooks.every(object))) {
        throw invalidSettings(path);
      }
    }
  }
  return root;
}

function invalidSettings(path, cause) {
  return new Error(`${path}의 내용을 읽을 수 없어 기존 설정을 보존했습니다. 설정 파일을 확인한 뒤 다시 연결해 주세요.`, { cause });
}

function withoutOurs(groups) {
  return groups
    .map(group => ({ ...group, hooks: (group.hooks || []).filter(h => !String(h.command || '').includes(MARKER)) }))
    .filter(group => group.hooks.length > 0);
}
