import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { startDaemon } from '../core/daemon.mjs';

const approval = (id, threadId = 'app-thread') => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn', itemId: `item-${id}`, command: 'npm run build', cwd: '/tmp/project', reason: 'Build project' } });
const questions = id => ({ id, method: 'item/tool/requestUserInput', params: { threadId: 'app-thread', turnId: 'turn', itemId: `item-${id}`, questions: [
  { id: 'first', question: '어느 DB?', header: 'DB', options: [{ label: 'Postgres', description: '서버' }, { label: 'SQLite', description: '파일' }] },
  { id: 'second', question: '어느 DB?', header: 'Replica', options: null },
] } });

async function until(read, predicate = Boolean) {
  for (let i = 0; i < 120; i++) {
    const result = await read();
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Timed out');
}

async function boot(t, config = {}, approvalsReviewer = 'user') {
  const home = mkdtempSync(join(tmpdir(), 'codex-inbox-'));
  const socketPath = join(home, 'codex.sock');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sent = [], resumed = [], sockets = [];
  const nativeRequests = new Map();
  let ws;
  const send = message => ws.send(JSON.stringify(message));
  wss.on('connection', socket => {
    ws = socket; sockets.push(socket);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'codex-app/0.157.1' } });
      else if (message.method === 'thread/loaded/list') send({ id: message.id, result: { data: ['app-thread', 'cli-thread'], nextCursor: null } });
      else if (message.method === 'thread/resume') {
        resumed.push(message.params);
        send({ id: message.id, result: { approvalsReviewer, thread: { id: message.params.threadId, cwd: '/tmp/project', preview: '프로젝트 작업' } } });
        for (const request of nativeRequests.values()) if (request.params.threadId === message.params.threadId) send(request);
      } else if (message.method === 'thread/items/list') {
        send({ id: message.id, result: { data: [{ item: { id: 'file', changes: [{ path: '/tmp/project/a.txt', diff: '-before\n+after' }] } }], nextCursor: null } });
      } else if (!message.method) {
        sent.push(message);
        const request = nativeRequests.get(message.id);
        nativeRequests.delete(message.id);
        send({ method: 'serverRequest/resolved', params: { threadId: request?.params.threadId ?? 'app-thread', requestId: message.id } });
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ ...config }));
  const daemon = await startDaemon({ home, port: 0, codexBridge: { socketPath, enabled: () => true, intervalMs: 30 }, tmux: { drive: () => assert.fail('tmux must never be used') } });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ ...config, port: daemon.port }));
  const headers = { 'x-approve-here-token': daemon.token, 'content-type': 'application/json' };
  const api = async (path, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, { headers, ...init });
    return { code: res.status, body: await res.json() };
  };
  t.after(async () => {
    await daemon.close();
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  await api('/requests');
  await until(() => api('/codex?sessionId=app-thread'), r => r.body.bridged);
  return { home, api, sent, resumed, sockets, send, nativeRequests,
    request(message) { nativeRequests.set(message.id, message); send(message); },
    async pending() { return (await api('/requests')).body; },
    async decide(id, decision) { return api(`/requests/${id}/decision`, { method: 'POST', body: JSON.stringify(decision) }); },
  };
}

test('Codex app·CLI 승인은 tmux 없이 원래 request ID로 응답하고 앞으로 자동을 저장한다', async t => {
  const b = await boot(t);
  assert.deepEqual(b.resumed[0], { threadId: 'app-thread', excludeTurns: true }, '세션 설정을 바꾸지 않는다');
  b.request(approval(101));
  const [card] = await until(b.pending, r => r.length === 1);
  assert.equal(card.mode, 'codex');
  assert.equal(card.tmux, null);
  const decision = await b.decide(card.id, { behavior: 'allow', remember: { commandPrefix: 'npm run' } });
  assert.equal(decision.code, 200);
  assert.equal(decision.body.status, 'allowed');
  assert.deepEqual(b.sent[0], { id: 101, result: { decision: 'accept' } });
  b.request(approval(102, 'cli-thread'));
  await until(() => b.sent.length === 2);
  assert.equal(b.sent[1].result.decision, 'accept');
  assert.equal((await b.pending()).length, 0, '저장한 규칙은 CLI 세션에도 적용된다');
});

test('같은 질문 문구도 ID로 구분하며 선택과 자유 입력을 Codex 응답 형식으로 보낸다', async t => {
  const b = await boot(t);
  b.request(questions('question-rpc'));
  const [card] = await until(b.pending, r => r.length === 1);
  assert.equal(card.kind, 'question');
  assert.equal(card.questions[0].id, 'first');
  assert.equal((await b.decide(card.id, { answers: { first: 'SQLite' } })).code, 409);
  assert.equal(b.sent.length, 0, '불완전한 답은 전송하지 않는다');
  const result = await b.decide(card.id, { answers: { first: 'SQLite', second: '직접 입력한 답' } });
  assert.equal(result.body.status, 'answered');
  assert.deepEqual(b.sent[0], { id: 'question-rpc', result: { answers: { first: { answers: ['SQLite'] }, second: { answers: ['직접 입력한 답'] } } } });
});

test('Codex 원래 화면에서 답하거나 취소하면 카드가 사라지고 늦은 카드 응답은 거절한다', async t => {
  const b = await boot(t);
  b.request(questions(1));
  const [card] = await until(b.pending, r => r.length === 1);
  b.nativeRequests.delete(1);
  b.send({ method: 'serverRequest/resolved', params: { threadId: 'app-thread', requestId: 1 } });
  await until(b.pending, r => r.length === 0);
  assert.equal((await b.decide(card.id, { answers: { first: 'SQLite', second: 'x' } })).code, 409);
  assert.equal(b.sent.length, 0);
});

test('원래 화면으로 넘기면 응답을 보내지 않고 같은 요청의 재전송도 다시 카드로 띄우지 않는다', async t => {
  const b = await boot(t);
  b.request(questions(1));
  const [card] = await until(b.pending, r => r.length === 1);
  assert.equal((await b.decide(card.id, { passthrough: true })).body.status, 'passed');
  b.send(questions(1));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await b.pending()).length, 0);
  assert.equal(b.sent.length, 0);
});

test('연결이 끊기면 원래 화면에 남겨 두고 재연결 시 대기 요청을 다시 받는다', async t => {
  const b = await boot(t);
  b.request(approval(1));
  const [card] = await until(b.pending, r => r.length === 1);
  b.sockets[0].terminate();
  const pending = await until(b.pending, r => r.length === 1 && r[0].id !== card.id);
  assert.equal((await b.decide(card.id, { behavior: 'allow' })).code, 409);
  assert.equal((await b.decide(pending[0].id, { behavior: 'deny' })).body.status, 'denied');
  assert.equal(b.sent[0].result.decision, 'decline');
});

test('정책 처리 중 재연결되어도 이전 연결의 요청이 중복 카드를 만들지 않는다', async t => {
  const b = await boot(t, { policyHooks: { codex: ['sleep 0.3'] } });
  b.request(approval(1));
  await new Promise(resolve => setTimeout(resolve, 70));
  b.sockets[0].terminate();
  await until(() => b.sockets.length >= 2);
  await new Promise(resolve => setTimeout(resolve, 500));
  const cards = await b.pending();
  assert.equal(cards.length, 1);
  assert.equal((await b.decide(cards[0].id, { behavior: 'allow' })).code, 200);
});

test('파일 변경과 권한 요청도 각각의 Codex 응답 계약을 따른다', async t => {
  const b = await boot(t);
  b.request({ ...approval(1), method: 'item/fileChange/requestApproval', params: { threadId: 'app-thread', turnId: 'turn', itemId: 'file', grantRoot: '/tmp/project' } });
  const [file] = await until(b.pending, r => r.length === 1);
  assert.equal(file.toolName, 'apply_patch');
  assert.equal(file.toolInput.file_path, '/tmp/project/a.txt');
  assert.match(file.description, /before/);
  await b.decide(file.id, { behavior: 'deny' });
  assert.deepEqual(b.sent[0].result, { decision: 'decline' });
  const permissions = { network: { enabled: true }, fileSystem: { write: ['/tmp/project'] } };
  b.request({ id: 2, method: 'item/permissions/requestApproval', params: { threadId: 'app-thread', itemId: 'perm', permissions } });
  const [permission] = await until(b.pending, r => r.length === 1);
  await b.decide(permission.id, { behavior: 'allow' });
  assert.deepEqual(b.sent[1].result, { permissions, scope: 'turn' });
});

test('비밀 입력·알 수 없는 서버 요청은 원래 Codex 화면에 남긴다', async t => {
  const b = await boot(t);
  const secret = questions(1); secret.params.questions[0].isSecret = true;
  b.request(secret);
  b.request({ id: 2, method: 'account/chatgptAuthTokens/refresh', params: {} });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await b.pending()).length, 0);
  assert.equal(b.sent.length, 0);
});

test('App Server가 담당하는 세션은 PermissionRequest 훅 카드와 중복되지 않는다', async t => {
  const b = await boot(t);
  const output = await new Promise(resolve => {
    const child = spawn(process.execPath, [new URL('../hook/permission-hook.mjs', import.meta.url).pathname, '--provider', 'codex'], { env: { ...process.env, APPROVE_HERE_HOME: b.home, TMUX_PANE: '' } });
    let stdout = ''; child.stdout.on('data', d => stdout += d);
    child.on('close', code => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify({ session_id: 'app-thread', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run build' } }));
  });
  assert.deepEqual(output, { code: 0, stdout: '' });
  assert.equal((await b.pending()).length, 0);
});

test('나 대신 승인 세션의 MCP 권한 훅은 카드 대기 없이 Codex 자동 검토로 인계한다', async t => {
  const b = await boot(t, {}, 'auto_review');
  assert.equal((await b.api('/codex?sessionId=app-thread')).body.approvalsReviewer, 'auto_review');
  const output = await new Promise(resolve => {
    const child = spawn(process.execPath, [new URL('../hook/permission-hook.mjs', import.meta.url).pathname, '--provider', 'codex'], { env: { ...process.env, APPROVE_HERE_HOME: b.home, TMUX_PANE: '' } });
    let stdout = ''; child.stdout.on('data', d => stdout += d);
    child.on('close', code => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify({ session_id: 'app-thread', hook_event_name: 'PermissionRequest', tool_name: 'mcp__example__write', tool_input: { value: 'test' } }));
  });
  assert.deepEqual(output, { code: 0, stdout: '' });
  assert.equal((await b.pending()).length, 0);
  b.send({ method: 'thread/settings/updated', params: { threadId: 'app-thread', threadSettings: { approvalsReviewer: 'user' } } });
  await until(() => b.api('/codex?sessionId=app-thread'), r => r.body.approvalsReviewer === 'user');
});
