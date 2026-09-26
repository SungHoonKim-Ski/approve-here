#!/usr/bin/env node
/**
 * Claude Code·Codex 훅. 두 이벤트를 받는다.
 *
 *  - PermissionRequest: 도구 실행 허용/거부. 사용자 정책(allowlist → config.policyHooks[provider])을 먼저 실행하고,
 *    결정이 없을 때만 대기함에 올려 사용자 결정을 기다린다.
 *  - PreToolUse(AskUserQuestion, Claude만): 질문을 대기함에 올리고, 사용자가 옵션을 고르면 tool_input.answers를 채워
 *    allow로 돌려준다. Claude는 다이얼로그 없이 그 답을 받는다(2.1.283 실측; 문서에는 없는 경로).
 *
 * 어떤 실패에서도 결정 없이 exit 0으로 끝낸다 — 그러면 CLI가 원래 프롬프트/다이얼로그를 띄운다.
 * 판단은 여기서 하지 않는다. 판단은 사용자 정책과 사용자가 하고, 이 훅은 그 자리와 대기함을 잇는다.
 */
import { inboxHome, loadConfig, readToken, readAllowlist } from '../core/config.mjs';
import { allowlistDecision, runPolicyHooks } from '../core/policy.mjs';
import { sessionContext } from '../core/transcript.mjs';

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
  const question = input.hook_event_name === 'PreToolUse' && input.tool_name === 'AskUserQuestion';
  if (input.hook_event_name === 'PreToolUse' && !question) return; // 다른 PreToolUse는 우리 일이 아니다

  // "질문을 띄울 권한"은 묻지 않는다. 질문 자체는 PreToolUse 카드(또는 원래 다이얼로그)가 받는다.
  // 여기서 한 번 더 물으면 질문 하나에 카드가 두 장 뜬다.
  if (input.hook_event_name === 'PermissionRequest' && input.tool_name === 'AskUserQuestion') {
    const decision = { behavior: 'allow', message: '질문은 카드에서 답합니다' };
    emitPermission(decision);
    await record(home, config, { ...toRequest(input, provider), status: 'auto', decision, decidedBy: 'question-tool' });
    return;
  }

  const request = question ? toQuestionRequest(input, provider) : toRequest(input, provider);
  if (question && !request.context?.assistant) {
    // transcript는 비동기로 쓰여서 질문 직전 설명이 아직 없을 수 있다. 잠깐 기다려 다시 읽는다(최대 1.5초).
    for (let i = 0; i < 3 && !request.context?.assistant; i++) {
      await new Promise(r => setTimeout(r, 500));
      request.context = sessionContext(input.transcript_path) ?? request.context;
    }
  }

  if (!question) {
    const policy = await decideByPolicy(request, raw, config, home);
    if (policy) {
      emitPermission(policy.decision);
      await record(home, config, { ...request, status: 'auto', decision: policy.decision, decidedBy: policy.decidedBy });
      return;
    }
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
    if (state.status === 'pending') continue;
    if (question) {
      if (state.status === 'answered' && state.decision?.answers) emitAnswers(input.tool_input, state.decision.answers);
      return; // passed·expired: 출력 없음 → 원래 다이얼로그
    }
    if (state.decision?.behavior) emitPermission(state.decision);
    return;
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

function common(input, provider) {
  return {
    provider,
    sessionId: input.session_id ?? null,
    turnId: input.turn_id ?? null,
    toolUseId: input.tool_use_id ?? null,
    toolName: input.tool_name,
    toolInput: input.tool_input ?? {},
    cwd: input.cwd ?? process.cwd(),
    permissionMode: input.permission_mode ?? null,
    model: input.model ?? null,
    tmux: process.env.TMUX_PANE ? { pane: process.env.TMUX_PANE, socket: process.env.TMUX ?? null } : null,
    // 이 세션이 무슨 일을 하고 있나 — 카드에서 어느 세션인지 알아보는 배경.
    context: sessionContext(input.transcript_path),
  };
}

function toRequest(input, provider) {
  return { ...common(input, provider), description: input.tool_input?.description ?? null };
}

function toQuestionRequest(input, provider) {
  const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
  return { ...common(input, provider), kind: 'question', questions, description: questions.map(q => q.question).join(' / ') || null };
}

/** Codex 입력에는 turn_id·model이 있고 tool_use_id가 없다. 설치기가 --provider를 박으므로 이 추정은 보조다. */
function detectProvider(input) {
  return input.turn_id && !input.tool_use_id ? 'codex' : 'claude';
}

function emitPermission(decision) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
}

/** 질문 원문은 그대로 두고 answers만 채운다. Claude는 이 입력을 사용자가 답한 것으로 받는다. */
function emitAnswers(toolInput, answers) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, answers } },
    }),
  );
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
