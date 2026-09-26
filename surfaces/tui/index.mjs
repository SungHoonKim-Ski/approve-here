#!/usr/bin/env node
/**
 * tmux pane용 대기함 — 데몬의 /events(SSE)를 구독해 대기 목록을 그리고 키 하나로 결정한다.
 * 표면은 데몬 API만 소비한다. 판단 로직은 여기 없다.
 *
 *   j/k 이동 · a 허용 · d 거부 · r 허용 + 이 접두 기억 · g 그 tmux 창으로 점프 · q 종료
 */
import { inboxHome, readToken, readDaemonInfo } from '../../core/config.mjs';

const home = inboxHome();
const info = readDaemonInfo(home);
const token = readToken(home);
if (!info || !token) {
  console.error('데몬이 실행 중이 아닙니다. `approve-here start`로 시작하세요.');
  process.exit(1);
}
const base = `http://127.0.0.1:${info.port}`;
const headers = { 'x-approve-here-token': token, 'content-type': 'application/json' };

let pending = [];
let recent = [];
let cursor = 0;
let notice = '';
let connected = false;

async function api(path, init = {}) {
  const res = await fetch(base + path, { ...init, headers });
  const value = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`);
  return value;
}

async function refresh() {
  [pending, recent] = await Promise.all([api('/requests?status=pending'), api('/requests?status=recent')]);
  cursor = Math.min(cursor, Math.max(0, pending.length - 1));
  render();
}

async function subscribe() {
  while (true) {
    try {
      const res = await fetch(`${base}/events?token=${token}`);
      connected = true;
      await refresh();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('\n\n')) {
          buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
          await refresh();
        }
      }
    } catch {
      connected = false;
      render();
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function decide(behavior, remember) {
  const target = pending[cursor];
  if (!target) return;
  if (target.kind === 'question') {
    notice = '질문 카드: 숫자로 옵션을 고르거나 t(터미널에서 답하기)';
    return render();
  }
  const body = remember ? { behavior, remember } : { behavior };
  try {
    await api(`/requests/${target.id}/decision`, { method: 'POST', body: JSON.stringify(body) });
    notice = `${behavior === 'allow' ? '허용' : '거부'}: ${summary(target)}${remember ? ` (기억: ${remember.commandPrefix})` : ''}`;
  } catch (error) {
    notice = `실패: ${error.message}`;
  }
  await refresh();
}

/** 질문 카드: 숫자 키가 아직 답하지 않은 첫 질문의 옵션을 고른다. 모두 답하면 보낸다. */
const drafts = new Map();
async function pickOption(digit) {
  const target = pending[cursor];
  if (!target || target.kind !== 'question') return;
  const draft = drafts.get(target.id) ?? {};
  const question = (target.questions || []).find(q => !(q.question in draft));
  if (!question) return;
  const option = (question.options || [])[digit - 1];
  if (!option) return;
  const next = { ...draft, [question.question]: option.label };
  drafts.set(target.id, next);
  if (Object.keys(next).length < (target.questions || []).length) {
    notice = `${question.question} → ${option.label}. 다음 질문의 옵션 번호를 누르세요`;
    return render();
  }
  try {
    await api(`/requests/${target.id}/decision`, { method: 'POST', body: JSON.stringify({ answers: next }) });
    notice = `답 전송: ${Object.values(next).join(', ')}`;
  } catch (error) {
    notice = `실패: ${error.message}`;
  }
  drafts.delete(target.id);
  await refresh();
}

async function passthrough() {
  const target = pending[cursor];
  if (!target || target.kind !== 'question') return;
  try {
    await api(`/requests/${target.id}/decision`, { method: 'POST', body: JSON.stringify({ passthrough: true }) });
    notice = '그 세션 터미널의 다이얼로그로 넘겼습니다';
  } catch (error) {
    notice = `실패: ${error.message}`;
  }
  await refresh();
}

async function jump() {
  const target = pending[cursor];
  if (!target) return;
  try {
    const result = await api(`/requests/${target.id}/jump`, { method: 'POST' });
    notice = result.note || `tmux ${target.tmux?.pane}로 이동`;
  } catch (error) {
    notice = `점프 실패: ${error.message}`;
  }
  render();
}

function summary(r) {
  const command = r.toolInput?.command;
  if (typeof command === 'string') return command.replace(/\s+/g, ' ');
  const path = r.toolInput?.file_path || r.toolInput?.path;
  if (path) return `${r.toolName} ${path}`;
  // AskUserQuestion은 "질문을 띄울 권한" 요청이다. 질문 본문을 보여 주되, 답은 여기서 못 한다.
  const questions = r.toolInput?.questions;
  if (Array.isArray(questions)) return `질문 띄우기: ${questions.map(q => q.question).join(' / ')}`;
  return `${r.toolName} ${JSON.stringify(r.toolInput)}`;
}

// 되돌릴 수 없는 명령은 접두로 기억시키지 않는다.
const NEVER_REMEMBER = new Set(['rm', 'sudo', 'dd', 'mkfs', 'kill', 'killall', 'shutdown', 'reboot', 'chmod', 'chown', 'curl', 'wget']);
function commandPrefix(r) {
  const command = r.toolInput?.command;
  if (typeof command !== 'string') return null;
  const words = command.trim().split(/\s+/);
  if (NEVER_REMEMBER.has(words[0])) return null;
  return words.slice(0, Math.min(2, words.length)).join(' ');
}

function age(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

function render() {
  const width = process.stdout.columns || 100;
  const lines = [];
  const state = connected ? `${pending.length}건 대기` : '데몬 연결 끊김 — 재시도 중';
  lines.push(`approve-here  ${state}`.padEnd(width));
  lines.push('─'.repeat(Math.min(width, 120)));
  if (!pending.length) lines.push('  대기 중인 승인 요청이 없습니다.');
  pending.forEach((r, i) => {
    const mark = i === cursor ? '❯' : ' ';
    const label = r.kind === 'question' ? '질문' : r.toolName;
    const head = `${mark} [${r.provider}] ${r.project ?? '?'} · ${label} · ${age(r.createdAt)}${r.tmux?.pane ? ` · tmux ${r.tmux.pane}` : ''}`;
    lines.push(head.slice(0, width));
    if (r.kind === 'question') {
      const draft = drafts.get(r.id) ?? {};
      for (const q of r.questions || []) {
        const answered = draft[q.question];
        lines.push(`    ${answered ? '✓' : '?'} ${q.question}${answered ? ` → ${answered}` : ''}`.slice(0, width));
        if (!answered) lines.push(`      ${(q.options || []).map((o, n) => `${n + 1}) ${o.label}`).join('   ')}`.slice(0, width));
      }
      return;
    }
    lines.push(`    ${summary(r)}`.slice(0, width));
    if (r.description) lines.push(`    ↳ ${r.description}`.slice(0, width));
  });
  lines.push('');
  lines.push('최근 처리');
  for (const r of recent.slice(0, 5)) {
    const by = r.status === 'auto' ? `자동(${r.decidedBy})` : r.status;
    lines.push(`  ${by.padEnd(22)} ${summary(r)}`.slice(0, width));
  }
  lines.push('');
  if (notice) lines.push(`» ${notice}`.slice(0, width));
  lines.push('a 허용 · d 거부 · r 허용+기억 · 1-9 질문 옵션 · t 터미널로 · g 창으로 · j/k 이동 · q 종료');
  process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', key => {
  if (key === 'q' || key === '\u0003') {
    process.stdout.write('\x1b[2J\x1b[H');
    process.exit(0);
  }
  if (key === 'j' || key === '\u001b[B') cursor = Math.min(cursor + 1, Math.max(0, pending.length - 1));
  if (key === 'k' || key === '\u001b[A') cursor = Math.max(cursor - 1, 0);
  if (key === 'a') return decide('allow');
  if (key === 'd') return decide('deny');
  if (key === 'r') {
    const prefix = pending[cursor] ? commandPrefix(pending[cursor]) : null;
    return prefix ? decide('allow', { commandPrefix: prefix }) : decide('allow');
  }
  if (key === 'g') return jump();
  if (key === 't') return passthrough();
  if (/^[1-9]$/.test(key)) return pickOption(Number(key));
  render();
});
process.stdout.on('resize', render);
subscribe();
