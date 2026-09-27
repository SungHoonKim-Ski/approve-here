import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDialog, sameQuestion, answerDialog } from '../core/dialog.mjs';

// 실제 Claude Code 2.1.283 화면(2026-09-28 실측)에서 그대로 가져온 조각들.
const MULTI_FIRST = `
⏺ 질문 4개를 한 번에 물어보겠습니다.
────────────────────────────────────────────────
←  ☐ 기능  ☐ DB  ☐ 재시도  ☐ 배포  ✔ Submit  →

어떤 기능?

❯ 1. [✔] 알림
         이벤트 발생 시 사용자에게 알림 전송
  2. [ ] 다크 모드
         어두운 테마 UI 지원
  3. [✔] 자동 저장
  4. [ ] 동기화
  5. [ ] Type something
     Next
────────────────────────────────────────────────
  6. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

const SINGLE_ANSWERED_TAB = `
←  ☐ 기능  ☐ DB  ☐ 재시도  ☒ 배포  ✔ Submit  →

배포?

❯ 1. Vercel
     Vercel 플랫폼에 배포
  2. 자체 서버 ✔
     직접 운영하는 서버에 배포
  3. Type something.
────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

const REVIEW_INCOMPLETE = `
←  ☐ 기능  ☐ DB  ☐ 재시도  ☒ 배포  ✔ Submit  →

Review your answers

⚠ You have not answered all questions

 ● 배포?
   → 자체 서버

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`;

const REVIEW_COMPLETE = `
←  ☒ 기능  ☒ DB  ☒ 재시도  ☒ 배포  ✔ Submit  →
Review your answers
 ● 어떤 기능?
   → 알림, 다크 모드, 자동 저장, 동기화
 ● 어느 DB?
   → SQLite
 ● 재시도?
   → 3회
 ● 배포?
   → Vercel
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
`;

const SINGLE_DIRECT = `
 ☐ DB
어느 DB?
❯ 1. Postgres
     기능이 풍부한 오픈소스 관계형 DB.
  2. SQLite
  3. MySQL
  4. Type something.
────────────────────────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

test('여러 개 선택 화면: 탭·질문·체크 상태·Type something·Chat about this 번호를 읽는다', () => {
  const d = parseDialog(MULTI_FIRST);
  assert.equal(d.hasSubmit, true);
  assert.deepEqual(d.tabs.map(t => t.label), ['기능', 'DB', '재시도', '배포']);
  assert.equal(d.question, '어떤 기능?');
  assert.deepEqual(d.options.map(o => [o.number, o.label, o.checked]), [[1, '알림', true], [2, '다크 모드', false], [3, '자동 저장', true], [4, '동기화', false]]);
  assert.equal(d.typeSomething, 5);
  assert.equal(d.chat, 6);
  assert.equal(d.review, false);
});

test('단일 선택 화면: 답한 옵션의 ✔ 표시를 checked로 읽고 라벨에서 뗀다', () => {
  const d = parseDialog(SINGLE_ANSWERED_TAB);
  assert.equal(d.tabs[3].answered, true);
  assert.deepEqual(d.options.map(o => [o.label, o.checked]), [['Vercel', false], ['자체 서버', true]]);
  assert.equal(d.typeSomething, 3);
  assert.equal(d.chat, 4);
});

test('Submit 탭: 답 목록과 미답 경고, Submit·Cancel 번호를 읽는다', () => {
  const partial = parseDialog(REVIEW_INCOMPLETE);
  assert.equal(partial.review, true);
  assert.equal(partial.unanswered, true);
  assert.deepEqual(partial.reviewAnswers, [{ question: '배포?', answer: '자체 서버' }]);
  assert.equal(partial.submit, 1);
  assert.equal(partial.cancel, 2);
  const full = parseDialog(REVIEW_COMPLETE);
  assert.equal(full.unanswered, false);
  assert.equal(full.reviewAnswers.length, 4);
  assert.equal(full.reviewAnswers[0].answer, '알림, 다크 모드, 자동 저장, 동기화');
});

test('질문 하나·단일 선택 화면은 Submit 탭이 없다(번호가 곧 제출)', () => {
  const d = parseDialog(SINGLE_DIRECT);
  assert.equal(d.hasSubmit, false);
  assert.deepEqual(d.tabs, [{ label: 'DB', answered: false }]);
  assert.equal(d.options.length, 3);
});

test('다이얼로그가 없는 화면은 null', () => {
  assert.equal(parseDialog('❯ \n  ⏸ manual mode on'), null);
  assert.equal(parseDialog(''), null);
});

test('질문 비교는 앞 16자만 본다(화면에서 잘리거나 줄이 넘어가도 같은 질문)', () => {
  assert.ok(sameQuestion('금융결제원(2027 상반기)·CJ(2026 하반기, 9/30 마감)는 신입', '금융결제원(2027 상반기)·CJ(2026 하반기, 9/30 마감)는 신입 공채입니다. 기준문서 §4는 신입 공채를 skip으로 봅니다.'));
  assert.ok(!sameQuestion('어느 DB?', '어떤 기능?'));
});

/**
 * 실측 규칙을 그대로 옮긴 다이얼로그 모형. 번호=단일 선택(다음 탭으로 자동 이동)/여러 개 선택 토글, →/←=탭 이동(양 끝에서 멈춤),
 * Submit 탭에서 1=제출(다이얼로그 사라짐), 2=취소. 옵션 밖 번호(Type something·Chat about this)를 누르면 사고로 기록한다.
 */
function simulate(questions, { tab = 0, picked = {} } = {}) {
  const state = { tab, picked: { ...picked }, closed: false, accidents: [] };
  const render = () => {
    if (state.closed) return null;
    const tabs = questions.map((q, i) => `${state.picked[i]?.length ? '☒' : '☐'} ${q.header}`).join('  ');
    if (state.tab === questions.length) {
      const missing = questions.some((_, i) => !state.picked[i]?.length);
      const lines = questions.filter((_, i) => state.picked[i]?.length).map((q, i) => ` ● ${q.question}\n   → ${state.picked[questions.indexOf(q)].join(', ')}`);
      return `←  ${tabs}  ✔ Submit  →\n\nReview your answers\n${missing ? '\n⚠ You have not answered all questions\n' : ''}${lines.join('\n')}\nReady to submit your answers?\n❯ 1. Submit answers\n  2. Cancel\n`;
    }
    const q = questions[state.tab];
    const options = q.options.map((o, i) => q.multiSelect
      ? `  ${i + 1}. [${state.picked[state.tab]?.includes(o.label) ? '✔' : ' '}] ${o.label}`
      : `  ${i + 1}. ${o.label}${state.picked[state.tab]?.includes(o.label) ? ' ✔' : ''}`);
    const n = q.options.length;
    return `←  ${tabs}  ✔ Submit  →\n\n${q.question}\n\n${options.join('\n')}\n  ${n + 1}. ${q.multiSelect ? '[ ] Type something' : 'Type something.'}\n     Next\n────\n  ${n + 2}. Chat about this\n\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n`;
  };
  const press = key => {
    if (state.closed) { state.accidents.push(`typed into prompt: ${key}`); return; }
    if (key === 'Right') { state.tab = Math.min(state.tab + 1, questions.length); return; }
    if (key === 'Left') { state.tab = Math.max(state.tab - 1, 0); return; }
    if (key === 'Escape') { state.closed = true; state.accidents.push('cancelled'); return; }
    if (state.tab === questions.length) {
      if (key === '1') state.closed = true;
      else if (key === '2') { state.closed = true; state.accidents.push('cancelled'); }
      return;
    }
    const q = questions[state.tab];
    const index = Number(key) - 1;
    if (!(index >= 0 && index < q.options.length)) { state.accidents.push(`out of range on tab ${state.tab}: ${key}`); return; }
    const label = q.options[index].label;
    if (q.multiSelect) {
      const set = new Set(state.picked[state.tab] ?? []);
      set.has(label) ? set.delete(label) : set.add(label);
      state.picked[state.tab] = q.options.map(o => o.label).filter(l => set.has(l));
    } else {
      state.picked[state.tab] = [label];
      state.tab += 1;
    }
  };
  const io = {
    read: async (expect = d => Boolean(d), { allowNull = false } = {}) => { const d = parseDialog(render() ?? ''); return expect(d) ? d : allowNull ? d : null; },
    send: async key => press(key),
    type: async () => {},
  };
  return { io, state };
}

const FOUR = [
  { question: '어떤 기능?', header: '기능', multiSelect: true, options: [{ label: '알림' }, { label: '다크 모드' }, { label: '자동 저장' }, { label: '동기화' }] },
  { question: '어느 DB?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'MySQL' }] },
  { question: '재시도?', header: '재시도', options: [{ label: '3회' }, { label: '없음' }, { label: '1회' }] },
  { question: '배포?', header: '배포', options: [{ label: 'Vercel' }, { label: '자체 서버' }] },
];
const ANSWERS = { '어떤 기능?': '알림, 다크 모드, 자동 저장, 동기화', '어느 DB?': 'MySQL', '재시도?': '없음', '배포?': 'Vercel' };

test('초기 상태의 4개 질문 다이얼로그에 답을 넣고 제출한다', async () => {
  const { io, state } = simulate(FOUR);
  assert.deepEqual(await answerDialog(io, FOUR, ANSWERS), { ok: true });
  assert.equal(state.closed, true);
  assert.deepEqual(state.accidents, []);
  assert.deepEqual(state.picked, { 0: ['알림', '다크 모드', '자동 저장', '동기화'], 1: ['MySQL'], 2: ['없음'], 3: ['Vercel'] });
});

test('사람이 터미널에서 일부를 답하고 셋째 탭까지 옮겨 둔 상태에서도 카드의 답대로 맞춘다 (2026-09-27 사고 재현)', async () => {
  const { io, state } = simulate(FOUR, { tab: 2, picked: { 0: ['자동 저장', '동기화'], 1: ['SQLite'] } });
  assert.deepEqual(await answerDialog(io, FOUR, ANSWERS), { ok: true });
  assert.deepEqual(state.accidents, []);
  assert.deepEqual(state.picked, { 0: ['알림', '다크 모드', '자동 저장', '동기화'], 1: ['MySQL'], 2: ['없음'], 3: ['Vercel'] });
});

test('Submit 탭에 서 있어도 첫 질문으로 돌아가 답한다', async () => {
  const { io, state } = simulate(FOUR, { tab: 4, picked: { 3: ['자체 서버'] } });
  assert.deepEqual(await answerDialog(io, FOUR, ANSWERS), { ok: true });
  assert.deepEqual(state.accidents, []);
  assert.deepEqual(state.picked[3], ['Vercel']);
});

test('다이얼로그가 이미 사라졌으면 키를 하나도 보내지 않는다', async () => {
  const { io, state } = simulate(FOUR);
  state.closed = true;
  assert.equal((await answerDialog(io, FOUR, ANSWERS)).ok, false);
  assert.deepEqual(state.accidents, []);
});

test('질문 하나·단일 선택은 번호 하나로 끝난다', async () => {
  const one = [{ question: '어느 DB?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'MySQL' }] }];
  let closed = false, sent = [];
  const io = {
    read: async (expect = d => Boolean(d), { allowNull = false } = {}) => { const d = closed ? null : parseDialog(SINGLE_DIRECT); return expect(d) ? d : allowNull ? d : null; },
    send: async key => { sent.push(key); if (key === '2') closed = true; },
    type: async () => {},
  };
  assert.deepEqual(await answerDialog(io, one, { '어느 DB?': 'SQLite' }), { ok: true });
  assert.deepEqual(sent, ['2']);
});
