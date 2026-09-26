import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const HOOK_PATH = new URL('../hook/permission-hook.mjs', import.meta.url).pathname;
const MARKER = 'permission-hook.mjs';

export function hookCommand(provider, hookPath = HOOK_PATH) {
  return `node "${hookPath}" --provider ${provider}`;
}

/**
 * Claude Code(~/.claude/settings.json)와 Codex(~/.codex/hooks.json)에 PermissionRequest 훅을 등록한다.
 * 두 CLI의 hooks 설정 모양이 같아 한 함수로 처리한다. 이미 있는 다른 훅은 그대로 두고, 우리 항목은 하나만 유지한다.
 */
export function install({ claude = false, codex = false, home, userHome = homedir(), hookPath = HOOK_PATH, log = console.log } = {}) {
  if (!claude && !codex) throw new Error('--claude, --codex 중 하나 이상을 지정하세요.');
  const results = [];
  if (claude) results.push(installInto(join(userHome, '.claude', 'settings.json'), 'claude', hookPath));
  if (codex) results.push(installInto(join(userHome, '.codex', 'hooks.json'), 'codex', hookPath));
  for (const r of results) log(`${r.changed ? '등록' : '이미 등록됨'}: ${r.path}`);
  if (codex)
    log(
      '\nCodex는 새 훅을 처음 만나면 신뢰 확인을 요구합니다. `codex`를 실행하고 "Hooks need review"에서 검토·신뢰하거나 `/hooks`에서 처리하세요.\n훅 명령이 바뀌면(경로 변경 등) 다시 신뢰해야 합니다.',
    );
  log(`\n데이터 폴더: ${home}\n데몬 실행: approve-here start`);
  return results;
}

export function installInto(path, provider, hookPath = HOOK_PATH) {
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const hooks = current.hooks && typeof current.hooks === 'object' ? current.hooks : {};
  const groups = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : [];
  const ours = { hooks: [{ type: 'command', command: hookCommand(provider, hookPath), timeout: 600 }] };
  const kept = groups
    .map(group => ({ ...group, hooks: (group.hooks || []).filter(h => !String(h.command || '').includes(MARKER)) }))
    .filter(group => group.hooks.length > 0);
  const already = groups.some(group => (group.hooks || []).some(h => h.command === ours.hooks[0].command));
  const next = { ...current, hooks: { ...hooks, PermissionRequest: [...kept, ours] } };
  const changed = !already || kept.length !== groups.length;
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  }
  return { path, provider, changed };
}

export function uninstallFrom(path) {
  if (!existsSync(path)) return { path, changed: false };
  const current = JSON.parse(readFileSync(path, 'utf8'));
  const groups = current.hooks?.PermissionRequest;
  if (!Array.isArray(groups)) return { path, changed: false };
  const kept = groups
    .map(group => ({ ...group, hooks: (group.hooks || []).filter(h => !String(h.command || '').includes(MARKER)) }))
    .filter(group => group.hooks.length > 0);
  const hooks = { ...current.hooks };
  if (kept.length) hooks.PermissionRequest = kept;
  else delete hooks.PermissionRequest;
  writeFileSync(path, JSON.stringify({ ...current, hooks }, null, 2) + '\n');
  return { path, changed: kept.length !== groups.length };
}
