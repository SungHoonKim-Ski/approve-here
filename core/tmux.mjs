import { execFile } from 'node:child_process';
import { parseDialog, answerDialog } from './dialog.mjs';

const KEY_DELAY_MS = 250;
// 키를 보낸 뒤 화면이 바뀌길 기다리는 간격과 횟수(최대 약 1.5초).
const READ_DELAY_MS = 150;
const READ_TRIES = 10;
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
 * Claude 질문은 dialog.mjs가 화면을 읽으며 한 단계씩 넣는다 — 사람이 터미널에서 탭을 옮겼거나 일부를 답한 상태여도
 * 실제 화면에 맞춰 움직이고, 기대와 어긋나면 더 보내지 않고 물러난다(그때 카드는 "터미널에서 답하라"로 끝난다).
 * Codex 승인 프롬프트: y = 허용, Esc = 거부.
 * 보내기 전에 화면을 읽어 다이얼로그가 아직 떠 있는지 본다 — 이미 답했으면 입력창에 글자가 들어가기 때문이다.
 */
export async function drive(record, decision) {
  const pane = record.tmux?.pane;
  if (!pane) return { ok: false, reason: 'no-pane' };
  const before = await screen({ pane });
  if (before === null) return { ok: false, reason: 'no-pane' };

  if (record.kind === 'question') {
    if (!/Enter to select|Ready to submit your answers/.test(before)) return { ok: false, reason: 'no-dialog' };
    const io = {
      // 키를 보낸 뒤 화면이 기대한 모양(expect)이 되기를 잠깐 기다려 읽는다. 기본은 "다이얼로그가 있다".
      async read(expect = d => Boolean(d), { allowNull = false } = {}) {
        let dialog = null;
        for (let i = 0; i < READ_TRIES; i++) {
          dialog = parseDialog(await screen({ pane }));
          if (expect(dialog)) return dialog;
          await sleep(READ_DELAY_MS);
        }
        return allowNull ? dialog : null;
      },
      send: key => keys(pane, key),
      type: text => literal(pane, text),
    };
    return answerDialog(io, record.questions || [], decision.answers);
  }

  // Codex 승인 프롬프트
  if (!/Press enter to confirm|Would you like to run|Yes, proceed/.test(before)) return { ok: false, reason: 'no-dialog' };
  const result = await keys(pane, decision.behavior === 'allow' ? 'y' : 'Escape');
  return result.ok ? { ok: true } : { ok: false, reason: result.error };
}

export const defaultTmux = { jump, describe, screen, drive };
