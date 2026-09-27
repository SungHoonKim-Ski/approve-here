import { createServer } from 'node:http';
import { mkdirSync, lstatSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer, WebSocket } from 'ws';

const METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']);
const LIMIT = 16 * 1024 * 1024;

export function isStdioAppServer(args) {
  const index = args.indexOf('app-server');
  if (index < 0 || args.includes('--help') || args.includes('-h')) return false;
  const tail = args.slice(index + 1);
  if (tail[0] && !tail[0].startsWith('-')) return false;
  const listen = tail.find(a => a.startsWith('--listen='))?.slice(9) ?? tail[tail.indexOf('--listen') + 1];
  return !tail.includes('--listen') && !tail.some(a => a.startsWith('--listen=')) || listen === 'stdio://';
}

/** Preserve native stdio; the private socket exposes only the inbox observer's limited API. */
export async function createStdioRelay({ home, socketName = `${process.pid}.sock` }) {
  const directory = join(home, 'codex-relays');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('중계 폴더 소유자가 다릅니다.');
  chmodSync(directory, 0o700);
  const socketPath = join(directory, socketName);
  if (Buffer.byteLength(socketPath) > 100) throw new Error('중계 소켓 경로가 너무 깁니다.');
  const server = createServer();
  const wss = new WebSocketServer({ server, maxPayload: LIMIT });
  const threads = new Map(), calls = new Map(), pending = new Map(), settled = new Set(), items = new Map();
  let nativeInput, closed = false, partialClientLine = false, userAgent = 'approve-here-stdio-relay';
  const forget = id => { pending.delete(id); settled.add(id); if (settled.size > 1000) settled.delete(settled.values().next().value); };
  const writeNative = message => {
    if (!nativeInput || nativeInput.destroyed || nativeInput.writableEnded) throw new Error('Codex 연결이 끊겼습니다.');
    nativeInput.write(JSON.stringify(message) + '\n');
  };
  const publish = message => {
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN && client.initialized) {
      if (client.bufferedAmount > LIMIT) client.terminate();
      else client.send(JSON.stringify(message));
    }
  };
  const resolve = id => { forget(id); publish({ method: 'serverRequest/resolved', params: { requestId: id } }); };

  wss.on('connection', client => {
    client.on('error', () => {});
    client.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { client.close(1003); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.params === null || (message.params !== undefined && typeof message.params !== 'object')) { client.close(1003); return; }
      const { id, method, params = {} } = message;
      const reply = result => client.send(JSON.stringify({ id, result }));
      try {
        if (method === 'initialize') { client.initialized = true; reply({ userAgent }); }
        else if (!client.initialized) throw new Error('initialize가 필요합니다.');
        else if (method === 'initialized') return;
        else if (method === 'approveHere/ownsSession') reply({ owned: threads.has(params.sessionId) || [...threads.values()].some(entry => entry.thread.sessionId === params.sessionId) });
        else if (method === 'thread/loaded/list') reply({ data: [...threads.keys()], nextCursor: null });
        else if (method === 'thread/resume') {
          const entry = threads.get(params.threadId);
          if (!entry) throw new Error('현재 앱에서 실행 중인 세션이 아닙니다.');
          reply({ ...entry, thread: { ...entry.thread, turns: [] } });
          for (const item of items.values()) if (item.threadId === params.threadId) client.send(JSON.stringify({ method: 'item/started', params: item }));
          for (const request of pending.values()) if (request.params.threadId === params.threadId) client.send(JSON.stringify(request));
        } else if (method === 'thread/items/list') {
          reply({ data: [...items.values()].filter(p => p.threadId === params.threadId && p.turnId === params.turnId).map(p => ({ item: p.item })), nextCursor: null });
        } else if (method === 'approveHere/decision') {
          if (partialClientLine) throw new Error('큰 입력을 전달 중입니다. 원래 앱에서 답해 주세요.');
          const request = pending.get(params.requestId);
          if (!request) throw new Error('Codex에서 이미 처리한 요청입니다.');
          if (!validResponse(request, params.result)) throw new Error('이 요청에 맞는 답변이 아닙니다.');
          writeNative({ id: params.requestId, result: params.result });
          forget(params.requestId);
          reply({});
        } else throw new Error('중계기에서 지원하지 않는 메서드입니다.');
      } catch (error) {
        if (id !== undefined) client.send(JSON.stringify({ id, error: { code: -32600, message: error.message } }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);

  function observeServer(message) {
    const p = message.params || {};
    if (!message.method && calls.has(message.id)) {
      const call = calls.get(message.id); calls.delete(message.id);
      if (!message.error) {
        if (call.method === 'initialize') userAgent = message.result?.userAgent ?? userAgent;
        if (['thread/start', 'thread/resume', 'thread/fork'].includes(call.method) && message.result?.thread) {
          threads.set(message.result.thread.id, message.result);
          publish({ method: 'thread/started', params: { thread: message.result.thread } });
        }
        if (call.method === 'turn/start' && call.params.approvalsReviewer) {
          const entry = threads.get(call.params.threadId);
          if (entry) entry.approvalsReviewer = call.params.approvalsReviewer;
          publish({ method: 'thread/settings/updated', params: { threadId: call.params.threadId, threadSettings: { approvalsReviewer: call.params.approvalsReviewer } } });
        }
      }
    }
    if (message.method === 'thread/settings/updated') {
      const entry = threads.get(p.threadId);
      if (entry && p.threadSettings?.approvalsReviewer) entry.approvalsReviewer = p.threadSettings.approvalsReviewer;
    }
    if (message.method === 'item/started' && p.item) {
      items.set(`${p.threadId}:${p.item.id}`, p);
      if (items.size > 200) items.delete(items.keys().next().value);
    }
    if (message.method === 'serverRequest/resolved') forget(p.requestId);
    if (['thread/closed', 'turn/completed'].includes(message.method)) {
      for (const [id, request] of pending) if (request.params.threadId === p.threadId && (!p.turn?.id || request.params.turnId === p.turn.id)) resolve(id);
      if (message.method === 'thread/closed') threads.delete(p.threadId);
    }
    if (message.id !== undefined && METHODS.has(message.method)) {
      settled.delete(message.id);
      if (partialClientLine || p.questions?.some(q => q.isSecret)) return;
      settled.delete(message.id); pending.set(message.id, message);
    }
    if (message.method && (message.id === undefined || METHODS.has(message.method))) publish(message);
  }

  return {
    socketPath,
    attach({ clientInput, clientOutput, serverInput, serverOutput }) {
      nativeInput = serverInput;
      pipeLines(clientInput, serverInput, (message) => {
        if (['initialize', 'thread/start', 'thread/resume', 'thread/fork', 'turn/start'].includes(message.method) && message.id !== undefined) {
          calls.set(message.id, { method: message.method, params: { threadId: message.params?.threadId, approvalsReviewer: message.params?.approvalsReviewer } });
          if (calls.size > 1000) calls.delete(calls.keys().next().value);
        }
        if (!message.method && message.id !== undefined) {
          if (settled.has(message.id)) return false;
          if (pending.has(message.id)) resolve(message.id);
        }
      }, partial => {
        partialClientLine = partial;
        if (partial) for (const id of pending.keys()) {
          pending.delete(id);
          publish({ method: 'serverRequest/resolved', params: { requestId: id } });
        }
      });
      pipeLines(serverOutput, clientOutput, observeServer);
    },
    async close() {
      if (closed) return; closed = true;
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
      try { unlinkSync(socketPath); } catch {}
    },
  };
}

function validResponse(request, result) {
  if (request.method === 'item/tool/requestUserInput') return request.params.questions.every(q => Array.isArray(result?.answers?.[q.id]?.answers) && result.answers[q.id].answers.length === 1 && typeof result.answers[q.id].answers[0] === 'string' && result.answers[q.id].answers[0].trim());
  if (request.method === 'item/permissions/requestApproval') return result?.scope === 'turn' && JSON.stringify(result.permissions) === JSON.stringify(request.params.permissions) || result?.scope === 'turn' && result.permissions && Object.keys(result.permissions).length === 0;
  return ['accept', 'decline', 'cancel'].includes(result?.decision) && (!request.params.availableDecisions || request.params.availableDecisions.includes(result.decision));
}

/** Oversized/non-JSON traffic remains usable by the original app, without mirroring it. */
function pipeLines(source, target, observe, onPassthrough = () => {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', passthrough = false;
  const write = line => { if (!target.write(line)) { source.pause(); target.once('drain', () => source.resume()); } };
  const feed = text => {
    buffer += text;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index + 1); buffer = buffer.slice(index + 1);
      let forward = true;
      if (!passthrough && line.length <= LIMIT) try { forward = observe(JSON.parse(line)) !== false; } catch {}
      if (forward) write(line);
      if (passthrough) onPassthrough(false);
      passthrough = false;
    }
    if (buffer.length > LIMIT || passthrough) { if (!passthrough) onPassthrough(true); write(buffer); buffer = ''; passthrough = true; }
  };
  source.on('data', data => feed(decoder.write(data)));
  source.on('end', () => { feed(decoder.end()); if (buffer) write(buffer); target.end(); });
}
