#!/usr/bin/env node
/**
 * PermissionRequest 훅 — Claude Code와 Codex가 같은 계약을 쓴다.
 *
 * 순서: 사용자 정책(allowlist → config.policyHooks[provider]) → 결정이 없으면 대기함에 올리고 사용자 결정을 기다린다.
 * 어떤 실패에서도 결정 없이 exit 0으로 끝낸다 — 그러면 CLI가 원래 승인 프롬프트를 띄운다(두 CLI 공통 계약).
 * 판단은 여기서 하지 않는다. 판단은 사용자 정책이 하고, 이 훅은 그 자리와 대기함을 잇는다.
 */
import { inboxHome, loadConfig, readToken, readAllowlist } from '../core/config.mjs';
import { allowlistDecision, runPolicyHooks } from '../core/policy.mjs';

const CONNECT_TIMEOUT_MS = 2000;
const POLL_SECONDS = 25;

main().catch(() => process.exit(0));

async function main() {
  const raw = await readStdin();
  const input = parse(raw);
  if (!input) return;
  const home = inboxHome();
  const config = loadConfig(home);
  const provider = argument('--provider') || detectProvider(input);
  const request = toRequest(input, provider);

  const policy = await decideByPolicy(request, raw, config, home);
  if (policy) {
    emit(policy.decision);
    await record(home, config, { ...request, status: 'auto', decision: policy.decision, decidedBy: policy.decidedBy });
    return;
  }

  const client = apiClient(home, config);
  if (!client) return;
  if (config.requireSurface !== false) {
    const health = await client.get('/health');
    if (!health?.ok) return;
    if (!health.surfaceActive) {
      // 볼 사람이 없으면 기다리지 않는다. 건너뛴 사실만 남겨 나중에 "왜 대기함에 안 왔나"를 답할 수 있게 한다.
      await client.post('/requests', { ...request, status: 'skipped', decidedBy: 'no-surface' });
      return;
    }
  }
  const created = await client.post('/requests', request);
  if (!created?.id) return;
  const deadline = Date.now() + config.waitSeconds * 1000;
  while (Date.now() < deadline) {
    const remaining = Math.max(0.05, (deadline - Date.now()) / 1000);
    const state = await client.get(`/requests/${created.id}/wait?timeout=${Math.min(POLL_SECONDS, remaining)}`);
    if (!state) return;
    if (state.status !== 'pending') {
      if (state.decision) emit(state.decision);
      return;
    }
  }
  await client.post(`/requests/${created.id}/expire`, {});
}

async function decideByPolicy(request, raw, config, home) {
  if (config.allowlist !== false) {
    const decision = allowlistDecision(request, readAllowlist(home));
    if (decision) return { decision, decidedBy: 'allowlist' };
  }
  const hooks = config.policyHooks?.[request.provider] || [];
  const result = await runPolicyHooks(hooks, raw, { timeoutMs: config.policyTimeoutSeconds * 1000 });
  return result ? { decision: result.decision, decidedBy: `policy:${result.policy}` } : null;
}

function toRequest(input, provider) {
  return {
    provider,
    sessionId: input.session_id ?? null,
    turnId: input.turn_id ?? null,
    toolUseId: input.tool_use_id ?? null,
    toolName: input.tool_name,
    toolInput: input.tool_input ?? {},
    description: input.tool_input?.description ?? null,
    cwd: input.cwd ?? process.cwd(),
    permissionMode: input.permission_mode ?? null,
    model: input.model ?? null,
    tmux: process.env.TMUX_PANE ? { pane: process.env.TMUX_PANE, socket: process.env.TMUX ?? null } : null,
  };
}

/** Codex 입력에는 turn_id·model이 있고 tool_use_id가 없다. 설치기가 --provider를 박으므로 이 추정은 보조다. */
function detectProvider(input) {
  return input.turn_id && !input.tool_use_id ? 'codex' : 'claude';
}

function emit(decision) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
}

async function record(home, config, payload) {
  const client = apiClient(home, config);
  if (client) await client.post('/requests', payload);
}

function apiClient(home, config) {
  const token = readToken(home);
  if (!token) return null;
  const base = `http://127.0.0.1:${config.port}`;
  // 훅의 호출은 "표면이 보고 있다"는 신호로 세지 않도록 자신을 밝힌다.
  const headers = { 'x-approve-here-token': token, 'content-type': 'application/json', 'x-approve-here-client': 'hook' };
  const call = async (path, init, timeoutMs) => {
    try {
      const res = await fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };
  return {
    get: path => call(path, { method: 'GET' }, (POLL_SECONDS + 5) * 1000),
    post: (path, value) => call(path, { method: 'POST', body: JSON.stringify(value) }, CONNECT_TIMEOUT_MS),
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function parse(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && typeof value.tool_name === 'string' ? value : null;
  } catch {
    return null;
  }
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}
