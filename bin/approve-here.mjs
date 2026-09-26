#!/usr/bin/env node
import { inboxHome, loadConfig, readToken, readDaemonInfo } from '../core/config.mjs';
import { startDaemon } from '../core/daemon.mjs';
import { ensureDaemon, daemonHealth, stopDaemon } from '../core/lifecycle.mjs';

const [command, ...rest] = process.argv.slice(2);

const commands = {
  /** 데몬을 이 터미널에서 전경 실행한다. 표면들은 보통 이걸 직접 부르지 않고 ensureDaemon으로 분리 실행한다. */
  async daemon() {
    const home = inboxHome();
    const config = loadConfig(home);
    const port = Number(flag('--port') ?? config.port);
    let daemon;
    const stop = () => daemon?.close().then(() => process.exit(0));
    daemon = await startDaemon({
      home,
      port,
      onIdle: () => {
        console.log('표면도 대기 요청도 없어 데몬을 닫습니다.');
        stop();
      },
    });
    console.log(`approve-here daemon · http://127.0.0.1:${daemon.port} · 데이터 ${home}`);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },
  start: () => commands.daemon(),
  async 'ensure-daemon'() {
    const result = await ensureDaemon({ home: inboxHome() });
    console.log(`${result.started ? '데몬 시작' : '데몬 사용 중'} · 포트 ${result.port}`);
  },
  async stop() {
    console.log((await stopDaemon(inboxHome())) ? '데몬에 종료를 요청했습니다.' : '실행 중인 데몬이 없습니다.');
  },
  async status() {
    const health = await daemonHealth(inboxHome());
    console.log(health ? `실행 중 · 포트 ${health.port} · 대기 ${health.pending}건 · 표면 ${health.surfaceActive ? '있음' : '없음'}` : '데몬이 실행 중이 아닙니다. 표면(tui·app·open)을 열면 같이 뜹니다.');
  },
  async pending() {
    const list = await api('/requests?status=pending');
    if (!list.length) return console.log('대기 중인 요청이 없습니다.');
    for (const r of list) console.log(`${r.id}  [${r.provider}] ${r.project ?? ''}  ${r.toolName}  ${summary(r)}`);
  },
  async decide() {
    const [id, behavior, ...message] = rest;
    if (!id || !['allow', 'deny'].includes(behavior)) throw new Error('사용법: approve-here decide <id> allow|deny [메시지]');
    const result = await api(`/requests/${id}/decision`, { method: 'POST', body: JSON.stringify({ behavior, message: message.join(' ') || undefined }) });
    console.log(`${result.status}: ${result.toolName} ${summary(result)}`);
  },
  async tui() {
    await ensureDaemon({ home: inboxHome() });
    await import('../surfaces/tui/index.mjs');
  },
  async open() {
    const { port } = await ensureDaemon({ home: inboxHome() });
    const url = `http://127.0.0.1:${port}/#token=${readToken(inboxHome())}`;
    console.log(url);
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  },
  async app() {
    if (process.platform !== 'darwin') throw new Error('메뉴바 앱은 macOS 전용입니다. `approve-here tui` 또는 `approve-here open`을 쓰세요.');
    await ensureDaemon({ home: inboxHome() });
    const { launchMenubarApp } = await import('../core/menubar-app.mjs');
    await launchMenubarApp({ home: inboxHome(), log: console.log, confirm });
  },
  install: async () =>
    (await import('../core/install.mjs')).install({ claude: rest.includes('--claude'), codex: rest.includes('--codex'), home: inboxHome() }),
  async uninstall() {
    const { uninstallFrom } = await import('../core/install.mjs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const targets = [];
    if (rest.includes('--claude')) targets.push(join(homedir(), '.claude', 'settings.json'));
    if (rest.includes('--codex')) targets.push(join(homedir(), '.codex', 'hooks.json'));
    if (!targets.length) throw new Error('--claude, --codex 중 하나 이상을 지정하세요.');
    for (const path of targets) {
      const result = uninstallFrom(path);
      console.log(`${result.changed ? '훅 제거' : '등록된 훅 없음'}: ${path}`);
    }
    await stopDaemon(inboxHome());
    console.log(`데이터 폴더 ${inboxHome()}는 남겨 둡니다. 필요 없으면 직접 지우세요.`);
  },
  help() {
    console.log(`approve-here <command>

  install --claude --codex  훅을 CLI 설정에 등록 (한 번)
  uninstall --claude --codex  훅 제거
  tui                       이 터미널(tmux pane)을 대기함으로  ← 인자 없이 실행하면 이것
  app                       macOS 메뉴바 앱 (없으면 내려받음)
  open                      브라우저 대기함
  status · pending          데몬 상태 · 대기 목록
  decide <id> allow|deny    터미널에서 결정
  stop                      데몬 종료 (표면을 열면 다시 뜬다)

표면을 열면 데몬이 같이 뜨고, 표면도 대기 요청도 없이 10분이 지나면 스스로 닫힙니다.
데이터 폴더: ${inboxHome()} (APPROVE_HERE_HOME으로 변경)`);
  },
};

const chosen = command ?? (process.stdout.isTTY ? 'tui' : 'help');
Promise.resolve()
  .then(() => (commands[chosen] ?? commands.help)())
  .catch(error => {
    console.error(error.message);
    process.exit(1);
  });

function flag(name) {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
}

async function api(path, init = {}) {
  const home = inboxHome();
  const info = readDaemonInfo(home);
  const token = readToken(home);
  if (!info || !token) throw new Error('데몬이 실행 중이 아닙니다. 표면(tui·app·open)을 열면 같이 뜹니다.');
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: { 'x-approve-here-token': token, 'content-type': 'application/json' },
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`);
  return value;
}

/** 터미널에서 y/N을 묻는다. TTY가 아니면 거절로 본다. */
function confirm(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise(resolve => {
    process.stdout.write(`${question} (y/N) `);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', answer => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function summary(r) {
  const command = r.toolInput?.command;
  return typeof command === 'string' ? command.slice(0, 80) : JSON.stringify(r.toolInput).slice(0, 80);
}
