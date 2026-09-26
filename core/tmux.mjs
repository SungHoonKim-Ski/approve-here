import { execFile } from 'node:child_process';

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

export const defaultTmux = { jump, describe };
