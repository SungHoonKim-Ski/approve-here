import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, PENDING } from './store.mjs';
import { ensureHome, ensureToken, loadConfig, readAllowlist, writeAllowlist, writeDaemonInfo } from './config.mjs';
import { defaultTmux } from './tmux.mjs';
import { startCodexConnections } from './codex-connections.mjs';

const MAX_BODY = 256 * 1024;
const MAX_WAIT_SECONDS = 30;
const WEB_DIR = fileURLToPath(new URL('../surfaces/web/', import.meta.url));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 로컬 대기함 데몬. 훅이 요청을 올리고 결정을 기다리며, 표면(메뉴바·TUI·웹)이 목록을 읽고 결정을 쓴다.
 * 127.0.0.1에만 묶고 같은 사용자만 읽을 수 있는 token 파일로 호출자를 가른다.
 */
export async function startDaemon({
  home,
  port,
  tmux = defaultTmux,
  presenceSeconds,
  idleExitMs,
  idleCheckMs = 30000,
  onIdle = () => {},
  onShutdown = () => {},
  codexBridge = false,
} = {}) {
  const root = ensureHome(home);
  const config = loadConfig(root);
  const token = ensureToken(root);
  const store = new Store(root);
  const listenPort = port ?? config.port;
  const presenceMs = (presenceSeconds ?? config.presenceSeconds) * 1000;
  const idleMs = idleExitMs ?? config.idleExitSeconds * 1000;
  let lastSurfaceAt = 0;
  let lastActivityAt = Date.now();
  const server = createServer((req, res) => handle(req, res).catch(error => fail(res, error)));

  const surfaceActive = () => Date.now() - lastSurfaceAt < presenceMs;
  const bridge = codexBridge ? startCodexConnections({ home: root, store, surfaceActive, ...(typeof codexBridge === 'object' ? codexBridge : {}) }) : null;
  store.subscribe(() => (lastActivityAt = Date.now()));
  // 표면도 대기 요청도 없이 오래 놀면 물러난다. 표면이 다시 열리면 ensureDaemon이 새로 띄운다.
  const idleTimer =
    idleMs > 0
      ? setInterval(() => {
          const quiet = Math.max(lastActivityAt, lastSurfaceAt);
          if (!surfaceActive() && store.list(PENDING).length === 0 && Date.now() - quiet > idleMs) onIdle();
        }, idleCheckMs)
      : null;
  idleTimer?.unref();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const [, resource, id, action] = url.pathname.split('/');
    if (req.method === 'GET' && url.pathname === '/health')
      return json(res, 200, { ok: true, pid: process.pid, pending: store.list(PENDING).length, surfaceActive: surfaceActive(), codexAppServer: bridge?.status ?? null });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) return serveWeb(url.pathname, res);
    authorize(req, url);
    if (resource === 'codex' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      return json(res, 200, { bridged: bridge?.ownsSession(sessionId) ?? false, approvalsReviewer: bridge?.reviewerFor(sessionId) ?? null });
    }
    // 훅이 아닌 인증된 호출은 전부 "표면이 보고 있다"는 신호다.
    if (req.headers['x-approve-here-client'] !== 'hook') lastSurfaceAt = Date.now();

    if (resource === 'requests' && !id) {
      if (req.method === 'GET') return json(res, 200, store.list(url.searchParams.get('status') || PENDING));
      if (req.method === 'POST') {
        const input = validateRequest(await body(req));
        // 같은 세션에서 사용자에게 갈 새 요청이 왔으면 이전 다이얼로그는 이미 닫혔다(답했거나 Esc).
        // 자동 처리 기록(auto·skipped)과 질문 도구 자체의 권한 요청은 다이얼로그가 살아 있는 채로 함께 오므로 밀어내지 않는다.
        const supersedes = !input.status && !(input.toolName === 'AskUserQuestion' && input.kind !== 'question');
        if (supersedes) for (const stale of store.pendingMirror({ sessionId: input.sessionId })) store.expire(stale.id, 'answered_externally');
        return json(res, 201, { id: store.create(await describeTmux(input)).id });
      }
    }
    // 터미널에서 답했다는 신호(PostToolUse). 같은 세션의 mirror 요청을 외부 처리로 마감한다.
    if (resource === 'external' && req.method === 'POST') {
      const input = await body(req);
      const settled = store.pendingMirror({ sessionId: input.sessionId, toolUseId: input.toolUseId ?? null }).map(r => store.expire(r.id, 'answered_externally'));
      return json(res, 200, { settled: settled.length });
    }
    if (resource === 'requests' && id) {
      const record = store.get(id);
      if (!record) throw new HttpError(404, '그런 요청이 없습니다.');
      if (req.method === 'GET' && !action) return json(res, 200, record);
      if (req.method === 'GET' && action === 'wait') {
        const seconds = Math.min(Number(url.searchParams.get('timeout') ?? 25), MAX_WAIT_SECONDS);
        const settled = await store.wait(id, Math.max(0, seconds) * 1000);
        return json(res, 200, { status: settled.status, decision: settled.decision });
      }
      if (req.method === 'POST' && action === 'decision') return json(res, 200, await decide(record, validateDecision(await body(req))));
      if (req.method === 'POST' && action === 'expire') return json(res, 200, store.expire(id));
      // 훅이 물러나 CLI에 원래 프롬프트가 떴다. 카드는 사라지고 기록에는 handed_off로 남는다.
      if (req.method === 'POST' && action === 'handoff') return json(res, 200, store.expire(id, 'handed_off'));
      if (req.method === 'POST' && action === 'jump') {
        const result = await tmux.jump({ pane: record.tmux?.pane });
        return json(res, result.ok ? 200 : 409, result);
      }
    }
    if (resource === 'allowlist') {
      if (req.method === 'GET') return json(res, 200, readAllowlist(root));
      if (req.method === 'PUT') {
        const rules = await body(req);
        if (!Array.isArray(rules)) throw new HttpError(400, 'allowlist는 배열이어야 합니다.');
        writeAllowlist(root, rules);
        return json(res, 200, rules);
      }
    }
    if (resource === 'events' && req.method === 'GET') return stream(req, res);
    if (resource === 'shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true });
      setTimeout(() => onShutdown(), 50);
      return;
    }
    throw new HttpError(404, '알 수 없는 경로입니다.');
  }

  /**
   * mirror 요청: 훅은 이미 물러났고 터미널에 다이얼로그가 떠 있다. 카드의 결정을 그 다이얼로그에 키로 넣는다.
   * 다이얼로그가 이미 사라졌으면(터미널에서 답함) 카드 결정은 거절하고 요청을 외부 처리로 마감한다.
   */
  async function driveTerminal(record, decision) {
    if (typeof tmux.drive !== 'function') throw new HttpError(409, '이 요청은 터미널에서만 답할 수 있습니다.');
    const result = await tmux.drive(record, decision).catch(error => ({ ok: false, reason: error.message }));
    if (!result.ok) {
      store.expire(record.id, 'answered_externally');
      throw new HttpError(409, '터미널 다이얼로그를 찾지 못했습니다 — 그 세션에서 이미 답했거나 닫혔습니다.');
    }
    // 키를 넣는 사이 PostToolUse가 먼저 와서 answered_externally로 마감됐을 수 있다. 그때는 현재 레코드를 돌려준다.
    return store.decide(record.id, decision, 'user:tmux') ?? store.get(record.id);
  }

  /** tmux 창 이름은 그 세션이 무슨 일인지 말해 준다(작업 이름으로 창을 짓는 사람이 많다). 훅은 pane id만 아니까 여기서 붙인다. */
  async function describeTmux(input) {
    if (!input.tmux?.pane || typeof tmux.describe !== 'function') return input;
    const title = await tmux.describe({ pane: input.tmux.pane }).catch(() => null);
    return title ? { ...input, tmux: { ...input.tmux, title } } : input;
  }

  function authorize(req, url) {
    const given = req.headers['x-approve-here-token'] || url.searchParams.get('token');
    if (given !== token) throw new HttpError(401, '토큰이 없거나 다릅니다.');
  }

  async function decide(record, input) {
    if (record.status !== PENDING) throw new HttpError(409, `이미 ${record.status} 상태인 요청입니다.`);
    if (record.kind === 'question') {
      if (input.behavior) throw new HttpError(400, '질문 카드에는 answers 또는 passthrough를 보내세요.');
      const decision = input.passthrough ? { passthrough: true } : { answers: input.answers };
      if (record.mode === 'codex') {
        await decideCodex(record, decision);
        return store.decide(record.id, decision, 'user:codex');
      }
      if (record.mode === 'mirror' && !input.passthrough) return await driveTerminal(record, decision);
      return store.decide(record.id, decision, 'user');
    }
    if (input.answers || input.passthrough) throw new HttpError(400, '권한 카드에는 behavior(allow|deny)를 보내세요.');
    const decision = input.message ? { behavior: input.behavior, message: input.message } : { behavior: input.behavior };
    let decided;
    if (record.mode === 'codex') {
      await decideCodex(record, decision);
      decided = store.decide(record.id, decision, 'user:codex');
    } else if (record.mode === 'mirror') decided = await driveTerminal(record, decision);
    else decided = store.decide(record.id, decision, 'user');
    if (decided?.status === 'allowed' && record.toolName === 'Bash' && input.remember?.commandPrefix) {
      const rule = { tool: record.toolName, commandPrefix: input.remember.commandPrefix, provider: record.provider };
      writeAllowlist(root, [...readAllowlist(root), rule]);
    }
    return decided;
  }

  async function decideCodex(record, decision) {
    if (!bridge) throw new HttpError(409, 'Codex 연결이 없습니다.');
    try { await bridge.decide(record, decision); }
    catch (error) { throw new HttpError(409, error.message); }
  }

  function stream(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(store.list(PENDING))}\n\n`);
    const unsubscribe = store.subscribe(event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.request)}\n\n`));
    // 열려 있는 SSE 연결은 표면이 계속 보고 있다는 뜻이다.
    const heartbeat = setInterval(() => {
      lastSurfaceAt = Date.now();
      res.write(': ping\n\n');
    }, Math.max(1000, presenceMs / 2));
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  function serveWeb(pathname, res) {
    const file = pathname === '/' ? 'index.html' : pathname.slice('/assets/'.length);
    const path = join(WEB_DIR, file);
    if (!path.startsWith(WEB_DIR) || !existsSync(path)) throw new HttpError(404, '웹 표면이 없습니다.');
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(path));
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  writeDaemonInfo(root, { pid: process.pid, port: actualPort, startedAt: new Date().toISOString() });
  return {
    port: actualPort,
    token,
    store,
    close: () =>
      new Promise(resolve => {
        if (idleTimer) clearInterval(idleTimer);
        bridge?.close();
        server.close(() => {
          // 죽은 데몬의 기록이 남으면 ensureDaemon이 health 실패로 걸러내지만, 깨끗이 지우는 쪽이 낫다.
          try {
            rmSync(join(root, 'daemon.json'), { force: true });
          } catch {}
          resolve();
        });
      }),
  };
}

function validateRequest(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, '요청 본문이 객체가 아닙니다.');
  if (typeof input.provider !== 'string' || !input.provider) throw new HttpError(400, 'provider가 필요합니다.');
  if (typeof input.toolName !== 'string' || !input.toolName) throw new HttpError(400, 'toolName이 필요합니다.');
  if (input.status === 'auto' && !['allow', 'deny'].includes(input.decision?.behavior))
    throw new HttpError(400, 'auto 기록에는 decision.behavior가 필요합니다.');
  if (input.status !== undefined && !['pending', 'auto', 'skipped'].includes(input.status))
    throw new HttpError(400, 'status는 pending·auto·skipped 중 하나여야 합니다.');
  if (input.kind === 'question' && !Array.isArray(input.questions)) throw new HttpError(400, '질문 카드에는 questions 배열이 필요합니다.');
  if (input.mode !== undefined && !['wait', 'mirror'].includes(input.mode)) throw new HttpError(400, 'mode는 wait 또는 mirror여야 합니다.');
  return input;
}

function validateDecision(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, '결정 본문이 객체가 아닙니다.');
  if (input.passthrough !== undefined && input.passthrough !== true) throw new HttpError(400, 'passthrough는 true만 허용합니다.');
  if (input.answers !== undefined) {
    const entries = Object.entries(input.answers ?? {});
    if (!entries.length || entries.some(([, v]) => typeof v !== 'string')) throw new HttpError(400, 'answers는 {질문: 답(문자열)} 객체여야 합니다.');
    return input;
  }
  if (input.passthrough) return input;
  if (!['allow', 'deny'].includes(input.behavior)) throw new HttpError(400, 'behavior는 allow 또는 deny여야 합니다.');
  if (input.message !== undefined && typeof input.message !== 'string') throw new HttpError(400, 'message는 문자열이어야 합니다.');
  if (input.remember !== undefined && typeof input.remember?.commandPrefix !== 'string')
    throw new HttpError(400, 'remember.commandPrefix는 문자열이어야 합니다.');
  return input;
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) reject(new HttpError(413, '요청 본문이 너무 큽니다.'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '요청 본문이 JSON이 아닙니다.'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function fail(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500) console.error('[approve-here]', error);
  if (!res.headersSent) json(res, status, { error: error.message });
  else res.end();
}
