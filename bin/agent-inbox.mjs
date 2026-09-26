#!/usr/bin/env node
import { inboxHome, loadConfig, readToken, readDaemonInfo } from '../core/config.mjs';
import { startDaemon } from '../core/daemon.mjs';

const [command = 'help', ...rest] = process.argv.slice(2);

const commands = {
  async start() {
    const home = inboxHome();
    const config = loadConfig(home);
    const port = Number(flag('--port') ?? config.port);
    const daemon = await startDaemon({ home, port });
    console.log(`approve-here · http://127.0.0.1:${daemon.port} · 데이터 ${home}`);
    const stop = () => daemon.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },
  async status() {
    const info = readDaemonInfo(inboxHome());
    if (!info) return console.log('데몬 기록이 없습니다. `approve-here start`로 시작하세요.');
    const health = await api('/health').catch(() => null);
    console.log(health ? `실행 중 · 포트 ${info.port} · 대기 ${health.pending}건` : `기록은 있지만 응답이 없습니다 (pid ${info.pid}, 포트 ${info.port}).`);
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
    await import('../surfaces/tui/index.mjs');
  },
  async open() {
    const home = inboxHome();
    const info = readDaemonInfo(home);
    const token = readToken(home);
    if (!info || !token) throw new Error('데몬이 실행 중이 아닙니다. `approve-here start`로 시작하세요.');
    const url = `http://127.0.0.1:${info.port}/#token=${token}`;
    console.log(url);
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  },
  async app() {
    const { existsSync } = await import('node:fs');
    const { spawn } = await import('node:child_process');
    const bundle = new URL('../surfaces/macos/dist/ApproveHere.app', import.meta.url).pathname;
    if (process.platform !== 'darwin') throw new Error('메뉴바 앱은 macOS 전용입니다. `approve-here tui` 또는 `approve-here open`을 쓰세요.');
    if (!existsSync(bundle)) throw new Error(`앱 번들이 없습니다. 먼저 빌드하세요: sh ${new URL('../surfaces/macos/build.sh', import.meta.url).pathname}`);
    spawn('open', [bundle], { stdio: 'ignore', detached: true }).unref();
    console.log('메뉴바에 ⏳ 아이콘이 뜹니다. 처음 실행이면 알림 권한을 물을 수 있습니다.');
  },
  help() {
    console.log(`approve-here <command>

  install --claude --codex  훅을 CLI 설정에 등록 (한 번)
  start [--port N]          대기함 데몬을 이 터미널에서 실행
  tui                       이 터미널(tmux pane)을 대기함으로
  app                       macOS 메뉴바 앱 실행
  open                      브라우저 대기함 열기
  status · pending          데몬 상태 · 대기 목록
  decide <id> allow|deny    터미널에서 결정

데이터 폴더: ${inboxHome()} (APPROVE_HERE_HOME으로 변경)`);
  },
};

commands.install = async () => (await import('../core/install.mjs')).install({ claude: rest.includes('--claude'), codex: rest.includes('--codex'), home: inboxHome() });

(commands[command] ?? commands.help)().catch(error => {
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
  if (!info || !token) throw new Error('데몬이 실행 중이 아닙니다. `approve-here start`로 시작하세요.');
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: { 'x-approve-here-token': token, 'content-type': 'application/json' },
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`);
  return value;
}

function summary(r) {
  const command = r.toolInput?.command;
  return typeof command === 'string' ? command.slice(0, 80) : JSON.stringify(r.toolInput).slice(0, 80);
}
