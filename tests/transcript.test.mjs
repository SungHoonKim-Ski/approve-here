import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionContext, codexApprovalsReviewer } from '../core/transcript.mjs';

const dir = mkdtempSync(join(tmpdir(), 'inbox-transcript-'));
const line = obj => JSON.stringify(obj) + '\n';

test('Claude transcript: 첫 요청과 마지막 요청을 뽑고 tool_result·시스템 태그는 건너뛴다', () => {
  const path = join(dir, 'claude.jsonl');
  writeFileSync(
    path,
    line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }) +
      line({ type: 'user', message: { role: 'user', content: '결제 모듈에 환불 API를 추가해줘' } }) +
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '네' }] } }) +
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }) +
      line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '테스트도   같이\n돌려' }] } }),
  );
  assert.deepEqual(sessionContext(path), { task: '결제 모듈에 환불 API를 추가해줘', latest: '테스트도 같이 돌려', assistant: '네' });
});

test('Codex rollout: payload.role=user의 input_text를 읽고 <environment_context> 같은 태그 문단은 건너뛴다', () => {
  const path = join(dir, 'codex.jsonl');
  writeFileSync(
    path,
    line({ type: 'session_meta', payload: { id: 's' } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }] } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'README 끝에 hello 추가' }] } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '했습니다' }] } }),
  );
  assert.deepEqual(sessionContext(path), { task: 'README 끝에 hello 추가', latest: 'README 끝에 hello 추가', assistant: '했습니다' });
});

test('긴 요청은 200자로 자르고, 큰 파일은 앞뒤만 읽어도 마지막 요청을 찾는다', () => {
  const path = join(dir, 'big.jsonl');
  const filler = line({ type: 'assistant', message: { content: 'x'.repeat(2000) } }).repeat(600); // ≈1.2MB
  writeFileSync(
    path,
    line({ type: 'user', message: { content: '첫 요청 ' + 'a'.repeat(400) } }) + filler + line({ type: 'user', message: { content: '마지막 요청' } }),
  );
  const context = sessionContext(path);
  assert.equal(context.task.length, 200);
  assert.ok(context.task.endsWith('…'));
  assert.equal(context.latest, '마지막 요청');
  assert.equal(context.assistant.length, 400, 'assistant 배경은 400자까지');
});

test('질문 직전 assistant 설명이 배경(assistant)으로 잡힌다 — 질문 카드의 "왜 묻나"', () => {
  const path = join(dir, 'background.jsonl');
  writeFileSync(
    path,
    line({ type: 'user', message: { content: 'DB 골라줘' } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '두 후보가 있습니다. Postgres는 운영 경험이 있고, SQLite는 배포가 단순합니다.' }, { type: 'tool_use', name: 'AskUserQuestion' }] } }),
  );
  assert.equal(sessionContext(path).assistant, '두 후보가 있습니다. Postgres는 운영 경험이 있고, SQLite는 배포가 단순합니다.');
});

test('없는 파일·깨진 줄은 null 또는 건너뛰기', () => {
  assert.equal(sessionContext('/nonexistent/x.jsonl'), null);
  assert.equal(sessionContext(null), null);
  const path = join(dir, 'broken.jsonl');
  writeFileSync(path, 'not json\n' + line({ type: 'user', message: { content: '멀쩡한 줄' } }) + '{broken');
  assert.deepEqual(sessionContext(path), { task: '멀쩡한 줄', latest: '멀쩡한 줄', assistant: null });
});

test('Codex 자동 검토는 현재 turn_context에서 읽으며 사용자 메시지나 이전 턴을 믿지 않는다', () => {
  const path = join(dir, 'reviewer.jsonl');
  writeFileSync(path, line({ type: 'turn_context', payload: { turn_id: 'current', approvals_reviewer: 'auto_review' } }));
  assert.equal(codexApprovalsReviewer(path, 'current'), 'auto_review');
  assert.equal(codexApprovalsReviewer(path, 'other'), null);
  writeFileSync(path, line({ type: 'turn_context', payload: { turn_id: 'old', approvals_reviewer: 'auto_review' } }) + line({ type: 'turn_context', payload: { turn_id: 'current', approvals_reviewer: 'user' } }));
  assert.equal(codexApprovalsReviewer(path, 'current'), 'user');
  writeFileSync(path, line({ type: 'response_item', payload: { turn_id: 'current', approvals_reviewer: 'auto_review' } }));
  assert.equal(codexApprovalsReviewer(path, 'current'), null);
});

test('큰 턴 출력 뒤에서도 승인 검토자를 찾고 깨진 기록은 결정 근거로 사용하지 않는다', () => {
  const path = join(dir, 'reviewer-big.jsonl');
  writeFileSync(path, line({ type: 'turn_context', payload: { turn_id: 'current', approvals_reviewer: 'auto_review' } }) + line({ type: 'event_msg', payload: { text: 'x'.repeat(700000) } }));
  assert.equal(codexApprovalsReviewer(path, 'current'), 'auto_review');
  assert.equal(codexApprovalsReviewer('/missing', 'current'), null);
  assert.equal(codexApprovalsReviewer(path, null), null);
});
