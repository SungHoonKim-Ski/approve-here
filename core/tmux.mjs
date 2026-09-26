import { execFile } from 'node:child_process';

const KEY_DELAY_MS = 250;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tmux(args) {
  return new Promise(resolve => {
    execFile('tmux', args, { timeout: 3000 }, (error, stdout, stderr) =>
      resolve(error ? { ok: false, error: (stderr || error.message).trim() } : { ok: true, stdout: stdout.trim() }),
    );
  });
}

/** 훅이 상속한 TMUX_PANE(%N)으로 그 pane이 보이는 창으로 전환한다. 붙어 있는 클라이언트가 없으면 그 사실을 돌려준다. */
export async function jump({ pane }) {
  if (!pane) return { ok: false, error: 'tmux pane 정보가 없는 요청입니다.' };
  const switched = await tmux(['switch-client', '-t', pane]);
  if (switched.ok) return switched;
  // switch-client는 붙어 있는 클라이언트가 필요하다. 없으면 창 선택만 해둔다.
  const selected = await tmux(['select-window', '-t', pane]);
  return selected.ok ? { ok: true, note: '붙어 있는 tmux 클라이언트가 없어 창만 선택했습니다.' } : switched;
}

/** 창 이름만 돌려준다. 세션:창.pane 같은 좌표는 사람이 읽는 배경으로는 쓸모가 없다. */
export async function describe({ pane }) {
  if (!pane) return null;
  const result = await tmux(['display-message', '-p', '-t', pane, '#{window_name}']);
  return result.ok && result.stdout ? result.stdout : null;
}

export async function screen({ pane }) {
  const result = await tmux(['capture-pane', '-p', '-t', pane]);
  return result.ok ? result.stdout : null;
}

async function keys(pane, ...names) {
  for (const name of names) {
    const result = await tmux(['send-keys', '-t', pane, name]);
    if (!result.ok) return result;
    await sleep(KEY_DELAY_MS);
  }
  return { ok: true };
}

async function literal(pane, text) {
  const result = await tmux(['send-keys', '-t', pane, '-l', text]);
  await sleep(KEY_DELAY_MS);
  return result;
}

/**
 * 카드에서 내린 결정을 그 세션의 터미널 다이얼로그에 키로 넣는다(mirror 모드).
 * 실측한 조작 규칙(Claude Code 2.1.283):
 *  - 단일 선택: 옵션 번호 한 글자로 즉시 선택, 질문이 여럿이면 다음 탭으로 자동 이동
 *  - 자유 입력: "Type something" 번호(옵션 수 + 1) → 텍스트 → Enter
 *  - 여러 개 선택: 번호로 토글 → → (Submit 탭) → Enter(또는 1)
 * Codex 승인 프롬프트: y = 허용, Esc = 거부.
 * 보내기 전에 화면을 읽어 다이얼로그가 아직 떠 있는지 본다 — 이미 답했으면 입력창에 글자가 들어가기 때문이다.
 */
export async function drive(record, decision) {
  const pane = record.tmux?.pane;
  if (!pane) return { ok: false, reason: 'no-pane' };
  const before = await screen({ pane });
  if (before === null) return { ok: false, reason: 'no-pane' };

  if (record.kind === 'question') {
    if (!/Enter to select/.test(before)) return { ok: false, reason: 'no-dialog' };
    const questions = record.questions || [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const answer = decision.answers?.[q.question];
      if (answer === undefined) return { ok: false, reason: 'missing-answer' };
      const labels = (q.options || []).map(o => o.label);
      const last = i === questions.length - 1;
      if (q.multiSelect) {
        for (const label of answer.split(', ')) {
          const index = labels.indexOf(label);
          if (index >= 0) await keys(pane, String(index + 1));
        }
        await keys(pane, 'Right'); // 다음 탭(다음 질문 또는 Submit)
        if (last) await keys(pane, 'Enter');
      } else if (labels.includes(answer)) {
        await keys(pane, String(labels.indexOf(answer) + 1)); // 즉시 선택·자동 이동
        if (last && questions.length > 1) await keys(pane, 'Enter'); // Submit 확인
      } else {
        await keys(pane, String(labels.length + 1)); // Type something
        await literal(pane, answer);
        await keys(pane, 'Enter');
        if (last && questions.length > 1) await keys(pane, 'Enter');
      }
    }
    return { ok: true };
  }

  // Codex 승인 프롬프트
  if (!/Press enter to confirm|Would you like to run|Yes, proceed/.test(before)) return { ok: false, reason: 'no-dialog' };
  const result = await keys(pane, decision.behavior === 'allow' ? 'y' : 'Escape');
  return result.ok ? { ok: true } : { ok: false, reason: result.error };
}

export const defaultTmux = { jump, describe, screen, drive };
