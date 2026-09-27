import { spawn } from 'node:child_process';

const BEHAVIORS = new Set(['allow', 'deny']);

/**
 * 훅 stdout에서 PermissionRequest 결정을 읽는다. Claude Code·Codex가 같은 모양을 쓴다.
 * PreToolUse 모양(permissionDecision)도 같은 뜻이라 함께 읽는다. 그 외(빈 출력·continue·ask)는 결정 없음이다.
 */
export function parseDecision(stdout) {
  const text = (stdout || '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const output = parsed?.hookSpecificOutput;
  if (!output || typeof output !== 'object') return null;
  const decision = output.decision;
  if (decision && BEHAVIORS.has(decision.behavior)) {
    return withMessage(decision.behavior, decision.message ?? decision.reason);
  }
  if (BEHAVIORS.has(output.permissionDecision)) {
    return withMessage(output.permissionDecision, output.permissionDecisionReason);
  }
  return null;
}

function withMessage(behavior, message) {
  return typeof message === 'string' && message ? { behavior, message } : { behavior };
}

/** 내장 allowlist 정책. 규칙에 맞는 Bash 명령 접두만 allow하고 나머지는 판단하지 않는다. */
export function allowlistDecision(request, rules) {
  if (request.toolName !== 'Bash') return null;
  for (const rule of rules || []) {
    if (rule.provider && rule.provider !== request.provider) continue;
    if (rule.tool !== request.toolName) continue;
    if (typeof rule.commandPrefix === 'string') {
      const command = request.toolInput?.command;
      if (typeof command === 'string' && command.startsWith(rule.commandPrefix)) {
        return { behavior: 'allow', message: `allowlist: ${rule.commandPrefix}` };
      }
    }
  }
  return null;
}

/**
 * 사용자 정책 훅을 순서대로 실행한다. 같은 stdin을 넘기고 첫 결정을 돌려준다.
 * 죽거나 시간을 넘긴 훅은 결정 없음으로 본다 — 판단은 사용자 훅이 하고 여기서는 자리만 준다.
 */
export async function runPolicyHooks(commands, input, { timeoutMs = 60000, env = process.env } = {}) {
  for (const command of commands || []) {
    const stdout = await runOne(command, input, timeoutMs, env);
    const decision = stdout === null ? null : parseDecision(stdout);
    if (decision) return { policy: command, decision };
  }
  return null;
}

function runOne(command, input, timeoutMs, env) {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', chunk => (stdout += chunk));
    child.on('error', () => finish(null));
    child.on('close', code => finish(code === 0 ? stdout : null));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
