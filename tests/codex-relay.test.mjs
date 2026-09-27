import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, lstatSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { connect } from 'node:net';
import { codexRelayOwnsSession } from '../core/codex-relay-owner.mjs';
import { createStdioRelay, isStdioAppServer } from '../core/codex-stdio-relay.mjs';
import { installCodexLauncher } from '../core/codex-launcher.mjs';
import { startDaemon } from '../core/daemon.mjs';

async function until(read, predicate = Boolean) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('Timed out');
}
async function boot(t, config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'relay 한글 #'));
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const relay = await createStdioRelay({ home });
  const appInput = new PassThrough(), appOutput = new PassThrough(), serverInput = new PassThrough(), serverOutput = new PassThrough();
  const native = []; let output = '', buffer = '';
  serverInput.on('data', data => { buffer += data.toString(); let n; while ((n = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); try { native.push(JSON.parse(line)); } catch {} } });
  appOutput.on('data', data => output += data.toString());
  relay.attach({ clientInput: appInput, clientOutput: appOutput, serverInput, serverOutput });
  const daemon = await startDaemon({ home, port: 0, codexBridge: { socketPath: join(home, 'missing-shared.sock'), enabled: () => true, intervalMs: 25 } });
  t.after(async () => { await daemon.close(); await relay.close(); for (const stream of [appInput, appOutput, serverInput, serverOutput]) stream.destroy(); });
  const api = async (path, body) => { const r = await fetch(`http://127.0.0.1:${daemon.port}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { code: r.status, body: await r.json() }; };
  const client = message => appInput.write(JSON.stringify(message) + '\n');
  const server = message => serverOutput.write(JSON.stringify(message) + '\n');
  await api('/requests');
  client({ id: 'start', method: 'thread/start', params: {} });
  server({ id: 'start', result: { approvalsReviewer: 'user', thread: { id: 'desktop', cwd: '/tmp/project', preview: '현재 앱 대화' } } });
  await until(() => api('/codex?sessionId=desktop'), r => r.body.bridged);
  return { home, relay, native, appInput, client, server, output: () => output, api, pending: async () => (await api('/requests')).body, decide: (id, decision) => api(`/requests/${id}/decision`, decision) };
}
const question = (id = 10, secret = false) => ({ id, method: 'item/tool/requestUserInput', params: { threadId: 'desktop', turnId: 'turn', itemId: 'q', questions: [{ id: 'question-id', question: '선택하세요', isSecret: secret, options: [{ label: '예', description: '진행' }, { label: '아니요', description: '중지' }] }] } });

test('앱 중계만 연결돼 있어도 CLI 공유 서버가 준비됐다고 표시하지 않는다', async t => {
  const b = await boot(t);
  const { codexAppServer: status } = (await b.api('/health')).body;
  assert.equal(status.connected, true);
  assert.equal(status.relayCount, 1);
  assert.equal(status.sharedConnected, false);
  assert.match(status.sharedError, /찾지 못했습니다/);
});

test('stdio 앱 대화의 질문 답변이 원래 서버로 돌아가고 앱 응답과 중복되지 않는다', async t => {
  const b = await boot(t); b.server(question());
  const [card] = await until(b.pending, list => list.length === 1);
  assert.equal(card.mode, 'codex');
  assert.equal((await b.decide(card.id, { answers: { 'question-id': '선택지 밖의 한글 답변' } })).code, 200);
  await until(() => b.native.find(m => m.id === 10));
  assert.deepEqual(b.native.find(m => m.id === 10).result, { answers: { 'question-id': { answers: ['선택지 밖의 한글 답변'] } } });
  b.client({ id: 10, result: { answers: { 'question-id': { answers: ['예'] } } } });
  assert.equal(b.native.filter(m => m.id === 10).length, 1);
  assert.match(b.output(), /requestUserInput/);
});

test('stdio 앱의 현재 턴이 나 대신 승인으로 바뀌면 user permission 카드는 만들지 않는다', async t => {
  const b = await boot(t);
  b.client({ id: 'turn-start', method: 'turn/start', params: { threadId: 'desktop', approvalsReviewer: 'auto_review' } });
  b.server({ id: 'turn-start', result: { turn: { id: 'turn' } } });
  await until(() => b.api('/codex?sessionId=desktop'), r => r.body.approvalsReviewer === 'auto_review');
  b.server({ id: 90, method: 'item/permissions/requestApproval', params: { threadId: 'desktop', turnId: 'turn', permissions: { fileSystem: { write: ['/tmp/example'] } } } });
  b.server(question(91));
  const [card] = await until(b.pending, list => list.length === 1);
  assert.equal(card.kind, 'question');
  assert.match(b.output(), /item\/permissions\/requestApproval/, '원래 앱으로 요청은 그대로 전달한다');
  assert.equal(b.native.filter(m => m.id === 90).length, 0, '중계기가 권한 응답을 대신 내리지 않는다');
  assert.equal((await b.decide(card.id, { answers: { 'question-id': '예' } })).code, 200);
  assert.deepEqual(b.native.find(m => m.id === 91).result, { answers: { 'question-id': { answers: ['예'] } } });
});

test('원래 앱에서 먼저 답하면 카드는 정리되고 늦은 카드 응답은 거절한다', async t => {
  const b = await boot(t); b.server(question());
  const [card] = await until(b.pending, list => list.length === 1);
  b.client({ id: 10, result: { answers: { 'question-id': { answers: ['예'] } } } });
  await until(b.pending, list => list.length === 0);
  assert.equal((await b.decide(card.id, { answers: { 'question-id': '아니요' } })).code, 409);
  assert.equal(b.native.filter(m => m.id === 10).length, 1);
});

test('stdio의 명령·파일·권한 승인은 각각의 native 응답 형식을 유지한다', async t => {
  const b = await boot(t);
  const cases = [
    { id: 20, method: 'item/commandExecution/requestApproval', params: { command: 'echo hi', availableDecisions: ['accept', 'decline'] }, expected: { decision: 'accept' } },
    { id: 21, method: 'item/fileChange/requestApproval', params: {}, expected: { decision: 'accept' } },
    { id: 22, method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { write: ['/tmp/example'] } } }, expected: { permissions: { fileSystem: { write: ['/tmp/example'] } }, scope: 'turn' } },
    { id: 23, method: 'item/commandExecution/requestApproval', behavior: 'deny', params: { command: 'printf probe', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf', 'probe'] } }, 'cancel'] }, expected: { decision: 'cancel' } },
  ];
  for (const sample of cases) {
    b.server({ method: 'item/started', params: { threadId: 'desktop', turnId: 'turn', item: { id: `item-${sample.id}`, type: 'fileChange', changes: [{ path: '/tmp/example', diff: '+ hello', kind: 'add' }] } } });
    b.server({ ...sample, params: { ...sample.params, threadId: 'desktop', turnId: 'turn', itemId: `item-${sample.id}` } });
    const [card] = await until(b.pending, list => list.length === 1);
    assert.equal((await b.decide(card.id, { behavior: sample.behavior || 'allow' })).code, 200);
    await until(() => b.native.find(m => m.id === sample.id));
    assert.deepEqual(b.native.find(m => m.id === sample.id).result, sample.expected);
  }
});

test('비밀 질문·알 수 없는 요청·일반 응답은 앱으로 그대로 전달되며 카드를 만들지 않는다', async t => {
  const b = await boot(t); b.server(question(30, true));
  b.server({ id: 31, method: 'unknown/method', params: { threadId: 'desktop' } });
  b.server({ id: 'normal', result: { text: '한글 🙂' } });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(await b.pending(), []);
  assert.match(b.output(), /한글 🙂/);
  b.client({ id: 30, result: { answers: {} } });
  assert.equal(b.native.filter(m => m.id === 30).length, 1);
});

test('턴 종료와 중계 소켓 종료는 카드를 인계하며 기존 stdio 앱은 계속 답할 수 있다', async t => {
  const b = await boot(t); b.server(question());
  await until(b.pending, list => list.length === 1);
  b.server({ method: 'turn/completed', params: { threadId: 'desktop', turn: { id: 'turn', status: 'interrupted' } } });
  await until(b.pending, list => list.length === 0);
  b.server(question(40)); await until(b.pending, list => list.length === 1);
  await b.relay.close(); await until(b.pending, list => list.length === 0);
  b.client({ id: 40, result: { answers: { 'question-id': { answers: ['예'] } } } });
  assert.equal(b.native.filter(m => m.id === 40).length, 1);
});

test('중계 연결은 현재 사용자만 접근하는 소켓이며 심볼릭 링크 폴더를 거절한다', async t => {
  const b = await boot(t);
  assert.equal(statSync(b.relay.socketPath).mode & 0o777, 0o600);
  const other = mkdtempSync(join(tmpdir(), 'relay-symlink-'));
  symlinkSync(join(b.home, 'codex-relays'), join(other, 'codex-relays'));
  await assert.rejects(createStdioRelay({ home: other }), /소유자/);
});

test('중계 실행기는 stdio 서버만 감싸고 CLI의 다른 명령·서버 전송은 바꾸지 않는다', () => {
  assert.equal(isStdioAppServer(['app-server', '--listen', 'stdio://']), true);
  assert.equal(isStdioAppServer(['-c', 'features.code_mode_host=true', 'app-server']), true);
  for (const args of [['--version'], ['app-server', 'proxy'], ['app-server', 'daemon', 'status'], ['app-server', '--listen=unix://'], ['app-server', '--help']]) assert.equal(isStdioAppServer(args), false);
});

test('훅의 중계 소유 확인은 살아 있는 현재 앱 세션만 인정한다', async t => {
  const b = await boot(t);
  assert.equal(await codexRelayOwnsSession(b.relay.socketPath, 'desktop'), true);
  assert.equal(await codexRelayOwnsSession(b.relay.socketPath, 'inherited-other-session'), false);
  await b.relay.close();
  assert.equal(await codexRelayOwnsSession(b.relay.socketPath, 'desktop'), false);
});

test('공백·따옴표가 있는 앱 경로에서도 실행기는 별도 앱을 만들며 원래 번들을 수정하지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), "launcher '한글 "));
  const app = join(root, 'ChatGPT.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents/MacOS/ChatGPT'), 'original');
  writeFileSync(join(app, 'Contents/Resources/codex'), 'cli');
  const target = join(root, 'Codex with Approve Here.app');
  assert.equal(installCodexLauncher({ appPath: app, target, inspectExecutable: () => 'ChatGPT' }), target);
  for (const file of ['launcher', 'codex-shim']) execFileSync('/bin/sh', ['-n', join(target, 'Contents/MacOS', file)]);
  assert.equal(statSync(join(app, 'Contents/MacOS/ChatGPT')).size, 8);
  const alias = join(root, 'Alias.app'); symlinkSync(app, alias);
  assert.throws(() => installCodexLauncher({ appPath: app, target: alias, inspectExecutable: () => 'ChatGPT' }), /덮어/);
  assert.throws(() => installCodexLauncher({ appPath: app, target: join(root, 'x/../ChatGPT.app'), inspectExecutable: () => 'ChatGPT' }), /별도/);
});

test('배포 앱의 미리 빌드한 실행기를 복사하고 경로는 JSON 설정으로 보존한다', t => {
  const root = mkdtempSync(join(tmpdir(), "prebuilt launcher '한글 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'ChatGPT.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
  const appBinary = join(app, 'Contents/MacOS/ChatGPT');
  const realCli = join(app, 'Contents/Resources/codex');
  writeFileSync(appBinary, 'original');
  writeFileSync(realCli, 'original cli');
  const template = join(root, 'prebuilt-template');
  writeFileSync(template, 'prebuilt executable bytes');
  const target = join(root, 'Codex with Approve Here.app');
  installCodexLauncher({ appPath: app, target, launcherTemplate: template, inspectExecutable: () => 'ChatGPT' });
  assert.equal(readFileSync(join(target, 'Contents/MacOS/launcher'), 'utf8'), 'prebuilt executable bytes');
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'Contents/Resources/launcher.json'), 'utf8')), { appBinary, realCli, processName: 'ChatGPT' });
  assert.ok(statSync(join(target, 'Contents/MacOS/launcher')).mode & 0o111);
  assert.equal(readFileSync(appBinary, 'utf8'), 'original');
});

test('실행기 설치 실패는 기존 앱을 보존하고 첫 설치도 다시 시도할 수 있다', t => {
  const root = mkdtempSync(join(tmpdir(), 'launcher-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'ChatGPT.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents/MacOS/ChatGPT'), 'original');
  writeFileSync(join(app, 'Contents/Resources/codex'), 'cli');
  const template = join(root, 'template');
  writeFileSync(template, 'good template');
  const brokenTemplate = join(root, 'directory-not-binary');
  mkdirSync(brokenTemplate);
  const target = join(root, 'Existing.app');
  const options = { appPath: app, inspectExecutable: () => 'ChatGPT' };
  installCodexLauncher({ ...options, target, launcherTemplate: template });
  assert.throws(() => installCodexLauncher({ ...options, target, launcherTemplate: brokenTemplate }));
  assert.equal(readFileSync(join(target, 'Contents/MacOS/launcher'), 'utf8'), 'good template');
  const first = join(root, 'First.app');
  assert.throws(() => installCodexLauncher({ ...options, target: first, launcherTemplate: join(root, 'missing-template'), requirePrebuilt: true }), /Approve Here를 다시 내려받아/);
  assert.equal(existsSync(first), false);
  assert.throws(() => installCodexLauncher({ ...options, target: first, launcherTemplate: brokenTemplate }));
  assert.equal(existsSync(first), false);
  installCodexLauncher({ ...options, target: first, launcherTemplate: template });
  writeFileSync(template, 'updated template');
  installCodexLauncher({ ...options, target, launcherTemplate: template });
  assert.equal(readFileSync(join(target, 'Contents/MacOS/launcher'), 'utf8'), 'updated template');
  assert.equal(readdirSync(root).some(name => name.startsWith('.approve-here-launcher-')), false);
  const dangling = join(root, 'Dangling.app');
  symlinkSync(join(root, 'missing.app'), dangling);
  assert.throws(() => installCodexLauncher({ ...options, target: dangling, launcherTemplate: template }), /심볼릭/);
  assert.equal(lstatSync(dangling).isSymbolicLink(), true);
});

test('앱 도구가 부모 환경을 지워도 설치된 shim은 원래 Codex 실행 파일을 실행한다', () => {
  const root = mkdtempSync(join(tmpdir(), "launcher env '한글 "));
  const app = join(root, 'ChatGPT.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents/MacOS/ChatGPT'), 'original');
  const cli = join(app, 'Contents/Resources/codex');
  writeFileSync(cli, '#!/bin/sh\n[ "$1" = "--version" ] && printf "isolated-cli-version\\n"\n');
  chmodSync(cli, 0o755);
  const target = join(root, 'Codex with Approve Here.app');
  installCodexLauncher({ appPath: app, target, inspectExecutable: () => 'ChatGPT' });
  const result = execFileSync(join(target, 'Contents/MacOS/codex-shim'), ['--version'], {
    env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(result.trim(), 'isolated-cli-version');
});

test('실행기를 설치한 뒤 Node 경로가 없어져도 원래 Codex CLI로 돌아간다', t => {
  const root = mkdtempSync(join(tmpdir(), "launcher missing node '한글 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'ChatGPT.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents/MacOS/ChatGPT'), 'original');
  const cli = join(app, 'Contents/Resources/codex');
  writeFileSync(cli, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(cli, 0o755);
  const target = join(root, 'Codex with Approve Here.app');
  installCodexLauncher({ appPath: app, target, nodePath: join(root, 'removed-node'), inspectExecutable: () => 'ChatGPT' });
  const output = execFileSync(join(target, 'Contents/MacOS/codex-shim'), ['app-server', '--stdio'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(output, 'app-server\n--stdio\n');
});

test('잘못된 observer JSON은 그 연결만 닫으며 원래 앱과 카드 연결을 유지한다', async t => {
  const b = await boot(t);
  const observer = new WebSocket('ws://localhost/', { createConnection: () => connect(b.relay.socketPath) });
  await new Promise((resolve, reject) => { observer.once('open', resolve); observer.once('error', reject); });
  const closed = new Promise(resolve => observer.once('close', resolve));
  observer.send('null'); await closed;
  b.server(question());
  const [card] = await until(b.pending, list => list.length === 1);
  assert.equal((await b.decide(card.id, { answers: { 'question-id': '예' } })).code, 200);
});

test('큰 JSON 입력을 부분 전달할 때 카드 응답을 끼워 넣지 않고 원래 앱으로 인계한다', async t => {
  const b = await boot(t); b.server(question());
  const [card] = await until(b.pending, list => list.length === 1);
  const text = 'x'.repeat(17 * 1024 * 1024);
  const line = JSON.stringify({ id: 'huge', method: 'test/large', params: { text } }) + '\n';
  const boundary = 16 * 1024 * 1024 + 100;
  b.appInput.write(line.slice(0, boundary));
  await until(b.pending, list => list.length === 0);
  assert.equal((await b.decide(card.id, { answers: { 'question-id': '예' } })).code, 409);
  b.appInput.write(line.slice(boundary));
  await until(() => b.native.find(m => m.id === 'huge'));
  assert.equal(b.native.find(m => m.id === 'huge').params.text.length, text.length);
  b.client({ id: 10, result: { answers: { 'question-id': { answers: ['아니요'] } } } });
  assert.equal(b.native.filter(m => m.id === 10).length, 1);
});

test('실제 wrapper 프로세스는 종료 직전의 큰 stdout을 끝까지 전달하고 CLI 일반 호출은 그대로 실행한다', async () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-process-'));
  const cli = join(home, 'fake-codex');
  writeFileSync(cli, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({text:'z'.repeat(1024*1024),args:process.argv.slice(2),relay:process.env.APPROVE_HERE_CODEX_RELAY||null})+'\\n',()=>process.exit(0));\n`);
  chmodSync(cli, 0o755);
  const wrapper = fileURLToPath(new URL('../bin/codex-relay.mjs', import.meta.url));
  const run = args => new Promise((resolve, reject) => execFile(process.execPath, [wrapper, ...args], { env: { ...process.env, APPROVE_HERE_HOME: home, APPROVE_HERE_CODEX_CLI: cli }, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
  const serverArgs = ['app-server', '--listen', 'stdio://'];
  const result = await run(serverArgs);
  assert.equal(result.text.length, 1024 * 1024); assert.equal(result.relay, '1'); assert.deepEqual(result.args, serverArgs);
  const normal = await run(['--version']);
  assert.deepEqual(normal.args, ['--version']); assert.equal(normal.relay, null);
});
