/**
 * Claude Code의 AskUserQuestion 터미널 다이얼로그를 읽고, 카드의 답을 그 다이얼로그에 넣는 순서를 정한다.
 * 화면은 tmux capture-pane 텍스트다. 실측(Claude Code 2.1.283, 2026-09-28):
 *
 *   ←  ☐ 기능  ☒ DB  ☐ 재시도  ✔ Submit  →      탭 줄. ☒ = 답한 탭. 양 끝에서 ←/→는 멈춘다(순환 없음)
 *   어떤 기능?                                   지금 보는 질문. Submit 탭이면 "Review your answers"
 *   ❯ 1. [✔] 알림                                여러 개 선택: 번호가 [ ]/[✔] 토글. →로 다음 탭
 *     2. SQLite ✔                                단일 선택: 번호가 곧 선택이고 다음 탭으로 자동 이동. 답한 옵션 뒤에 " ✔"
 *     4. Type something(.)                       자유 입력. 절대 실수로 누르지 않는다
 *     5. Chat about this                         누르면 질문이 "명확히 하고 싶다"로 끝난다. 절대 누르지 않는다
 *   Review your answers / ⚠ You have not answered all questions / ● 질문 → 답 / 1. Submit answers / 2. Cancel
 *
 * 키를 보낼 때마다 화면을 다시 읽어 기대한 상태가 됐는지 본다. 어긋나면 더 보내지 않고 물러난다 —
 * 사람이 터미널을 먼저 만졌을 수 있고(탭을 옮겼거나 일부를 답함), 그때 눈감고 보낸 번호는 다른 탭에 떨어져 취소나
 * "Chat about this"까지 누른다(2026-09-27 실측 사고).
 */

const NOISE = /^(Type something\.?|Chat about this|Submit answers|Cancel|Next|Submit)$/;

export function parseDialog(text) {
  if (!text) return null;
  const lines = text.split('\n');
  // 탭 줄: "←  ☐ 기능  ☒ DB  ✔ Submit  →". 질문 하나·단일 선택이면 화살표와 Submit 없이 " ☐ DB"만 있고 번호가 곧 제출이다.
  const tabAt = lines.findIndex(l => /^\s*(←\s+)?[☐☒]\s+\S/.test(l));
  if (tabAt < 0) return null;
  const hasSubmit = /✔\s*Submit/.test(lines[tabAt]);
  const tabs = lines[tabAt].trim().split(/\s{2,}/)
    .filter(t => /^[☐☒]/.test(t))
    .map(t => ({ label: t.replace(/^[☐☒]\s*/, '').trim(), answered: t.startsWith('☒') }));
  const body = [];
  for (const line of lines.slice(tabAt + 1)) {
    body.push(line);
    if (/Esc to cancel/.test(line) || /^\s*2\.\s+Cancel\s*$/.test(line)) break;
  }
  const question = (body.map(l => l.trim()).find(l => l.length > 0) ?? '').replace(/\s+/g, ' ');
  const review = /^Review your answers/.test(question);
  const dialog = { tabs, hasSubmit, question, review, unanswered: false, reviewAnswers: [], options: [], typeSomething: null, chat: null, submit: null, cancel: null };

  let current = null;
  for (const raw of body) {
    const numbered = raw.match(/^\s*(?:❯\s*)?(\d+)\.\s+(?:\[([ ✔])\]\s*)?(.*?)\s*$/);
    if (numbered) {
      const number = Number(numbered[1]);
      let label = numbered[3];
      const answeredMark = / ✔$/.test(label);
      label = label.replace(/ ✔$/, '').trim();
      if (/^Type something\.?$/.test(label)) dialog.typeSomething = number;
      else if (label === 'Chat about this') dialog.chat = number;
      else if (label === 'Submit answers') dialog.submit = number;
      else if (label === 'Cancel') dialog.cancel = number;
      else if (!NOISE.test(label)) dialog.options.push({ number, label, checked: numbered[2] === '✔' || answeredMark });
      current = null;
      continue;
    }
    if (/You have not answered all questions/.test(raw)) dialog.unanswered = true;
    const asked = raw.match(/^\s*●\s+(.*?)\s*$/);
    if (asked) { current = { question: asked[1].replace(/\s+/g, ' '), answer: '' }; dialog.reviewAnswers.push(current); continue; }
    const answered = raw.match(/^\s*→\s+(.*?)\s*$/);
    if (answered && current) { current.answer = answered[1]; continue; }
    // 긴 답은 줄이 넘어간다. 화살표 다음의 들여쓴 줄은 이어지는 답이다.
    if (current && current.answer && /^\s{4,}\S/.test(raw) && !/^\s*(Ready to submit|●)/.test(raw)) current.answer += ' ' + raw.trim();
  }
  return dialog;
}

const normalize = s => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 화면의 질문 줄은 길면 잘리거나 넘어간다. 표시된 전체 접두가 일치해야 같은 질문이다. */
export function sameQuestion(shown, question) {
  const a = normalize(shown), b = normalize(question);
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * 답을 넣는 절차. io = { read(): dialog|null, send(key), type(text) }. read는 키를 보낸 뒤 화면이 바뀌길 잠깐 기다려 읽는다.
 * 결과 { ok } 또는 { ok:false, reason } — reason은 어디서 어긋났는지 기록용.
 */
export async function answerDialog(io, questions, answers) {
  let dialog = await io.read();
  if (!dialog) return { ok: false, reason: 'no-dialog' };
  // 사람이 탭을 옮겨 두었을 수 있다. ←는 첫 탭에서 멈추므로 질문 수만큼 눌러 첫 질문으로 돌아간다.
  for (let i = 0; i < questions.length && !sameQuestion(dialog.question, questions[0].question); i++) {
    await io.send('Left');
    dialog = await io.read();
    if (!dialog) return { ok: false, reason: 'dialog-gone' };
  }
  if (!sameQuestion(dialog.question, questions[0].question)) return { ok: false, reason: `first-tab:${dialog.question.slice(0, 20)}` };

  // 질문 하나·단일 선택은 Submit 탭이 없다. 번호(또는 자유 입력 + Enter)가 곧 제출이라 다이얼로그가 사라지면 끝이다.
  const direct = !dialog.hasSubmit;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = answers?.[q.question];
    if (answer === undefined) return { ok: false, reason: 'missing-answer' };
    if (!sameQuestion(dialog.question, q.question)) return { ok: false, reason: `tab-mismatch:${i}` };
    const next = i + 1 < questions.length ? d => d && sameQuestion(d.question, questions[i + 1].question) : direct ? d => !d : d => d && d.review;

    if (q.multiSelect) {
      const wanted = new Set(String(answer).split(', ').map(normalize));
      for (const option of dialog.options) {
        const shouldCheck = wanted.has(normalize(option.label));
        if (shouldCheck === option.checked) continue;
        await io.send(String(option.number));
        dialog = await io.read(d => d && d.options.find(o => o.number === option.number)?.checked === shouldCheck);
        if (!dialog) return { ok: false, reason: `toggle:${option.label}` };
      }
      await io.send('Right');
    } else {
      const option = dialog.options.find(o => normalize(o.label) === normalize(answer));
      if (option) await io.send(String(option.number));
      else {
        if (!dialog.typeSomething) return { ok: false, reason: 'no-free-text' };
        await io.send(String(dialog.typeSomething));
        await io.type(String(answer));
        await io.send('Enter');
      }
    }
    if (direct && i === questions.length - 1) {
      const closed = await io.read(next, { allowNull: true });
      return closed === null ? { ok: true } : { ok: false, reason: 'submit-unconfirmed' };
    }
    dialog = await io.read(next);
    if (!dialog) return { ok: false, reason: `advance:${i}` };
  }

  // Submit 탭. 화면의 답 목록이 카드의 답과 같을 때만 보낸다. 2(Cancel)는 어떤 경우에도 누르지 않는다.
  if (!dialog.review || dialog.unanswered) return { ok: false, reason: 'review-incomplete' };
  if (dialog.reviewAnswers.length !== questions.length) return { ok: false, reason: 'review-count' };
  for (const [index, q] of questions.entries()) {
    const shown = dialog.reviewAnswers[index];
    if (!shown || !sameQuestion(shown.question, q.question)) return { ok: false, reason: `review-question:${index}` };
    if (normalize(shown.answer) !== normalize(answers[q.question])) return { ok: false, reason: `review-mismatch:${normalize(q.question).slice(0, 20)}` };
  }
  if (!dialog.submit) return { ok: false, reason: 'no-submit' };
  await io.send(String(dialog.submit));
  const closed = await io.read(d => !d, { allowNull: true });
  return closed === null ? { ok: true } : { ok: false, reason: 'submit-unconfirmed' };
}
