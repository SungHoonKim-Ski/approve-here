import { openSync, readSync, closeSync, statSync } from 'node:fs';

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const MAX_CHARS = 200;

/** Codex의 실제 턴 설정만 읽는다. 사용자 메시지·설정 파일의 기본값은 승인 모드의 근거로 쓰지 않는다. */
export function codexApprovalsReviewer(transcriptPath, turnId) {
  if (!transcriptPath || !turnId) return null;
  try {
    const size = statSync(transcriptPath).size;
    for (let bytes = TAIL_BYTES; bytes <= 16 * 1024 * 1024; bytes *= 2) {
      const start = Math.max(0, size - bytes);
      const lines = readSlice(transcriptPath, start, size).split('\n');
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        let record;
        try { record = JSON.parse(lines[i]); } catch { continue; }
        if (record.type !== 'turn_context') continue;
        if (record.payload?.turn_id !== turnId) return null;
        const reviewer = record.payload.approvals_reviewer;
        return ['user', 'auto_review', 'guardian_subagent'].includes(reviewer) ? reviewer : null;
      }
      if (start === 0) break;
    }
  } catch {}
  return null;
}

/**
 * 훅 입력의 transcript_path에서 "이 세션이 무슨 일을 하고 있나"를 뽑는다.
 * 첫 사용자 요청(task)과 마지막 사용자 요청(latest)만 본다 — 카드에서 어느 세션인지 알아보는 데는 그걸로 충분하다.
 * Claude Code(`type: user`의 message.content)와 Codex(`payload.role: user`의 input_text)를 같은 함수로 읽는다.
 * 파일이 크면 앞 64KB·뒤 512KB만 읽는다. 어떤 실패에서도 null을 돌려준다.
 */
export function sessionContext(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const size = statSync(transcriptPath).size;
    const head = readSlice(transcriptPath, 0, Math.min(size, HEAD_BYTES));
    const tail = size > HEAD_BYTES ? readSlice(transcriptPath, Math.max(HEAD_BYTES, size - TAIL_BYTES), size) : '';
    const first = texts(head, 'user', { dropFirstPartial: false })[0] ?? null;
    const latest = texts(tail, 'user', { dropFirstPartial: true }).at(-1) ?? texts(head, 'user').at(-1) ?? null;
    // 질문 직전에 agent가 한 설명 — 질문의 배경. 마지막 assistant 텍스트를 쓴다.
    const assistant = texts(tail, 'assistant', { dropFirstPartial: true }, ASSISTANT_CHARS).at(-1) ?? texts(head, 'assistant', {}, ASSISTANT_CHARS).at(-1) ?? null;
    if (!first && !latest && !assistant) return null;
    return { task: first, latest: latest ?? first, assistant };
  } catch {
    return null;
  }
}

const ASSISTANT_CHARS = 400;

function readSlice(path, start, end) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function texts(chunk, role, { dropFirstPartial = false } = {}, maxChars = MAX_CHARS) {
  const lines = chunk.split('\n');
  if (dropFirstPartial) lines.shift();
  const found = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const text = roleText(json, role);
    if (text) found.push(clean(text, maxChars));
  }
  return found.filter(Boolean);
}

function roleText(json, role) {
  // Claude Code transcript: type이 role과 같고 message.content에 본문
  if (json?.type === role && json.message) return contentText(json.message.content);
  // Codex rollout: payload.role
  const payload = json?.payload;
  if (payload?.type === 'message' && payload.role === role) return contentText(payload.content);
  return null;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string')
    .map(part => part.text)
    .join(' ');
}

/** 시스템이 끼워 넣은 태그 문단(<environment_context> 등)과 tool_result는 사람 말이 아니다. 한 줄로 접고 길면 자른다. */
function clean(text, maxChars) {
  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.startsWith('<')) return null;
  const oneLine = trimmed.replace(/\s+/g, ' ');
  return oneLine.length > maxChars ? oneLine.slice(0, maxChars - 1) + '…' : oneLine;
}
