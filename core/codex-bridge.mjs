import WebSocket from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, readAllowlist } from './config.mjs';
import { allowlistDecision, runPolicyHooks } from './policy.mjs';
import { sessionContext } from './transcript.mjs';

const METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']);

/** Connect to the existing shared Codex server. Never start threads or change their settings. */
export function startCodexBridge({ home, store, surfaceActive, userHome = homedir(), intervalMs = 2000, socketPath, enabled, log = () => {} }) {
  const codexHome = process.env.CODEX_HOME || join(userHome, '.codex');
  const path = socketPath || join(codexHome, 'app-server-control', 'app-server-control.sock');
  const active = enabled || (() => {
    try {
      if (loadConfig(home).codexAppServer === false) return false;
      const hooks = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).hooks;
      return (hooks?.PermissionRequest || []).some(g => g.hooks?.some(h => h.command?.includes('permission-hook.mjs')));
    } catch { return false; }
  });
  let ws, stopped = false, syncing = false, sequence = 0;
  const rpc = new Map(), threads = new Map(), reviewers = new Map(), subscribed = new Set(), items = new Map(), requests = new Map(), suppressed = new Set();
  const status = { connected: false, error: null };

  function send(message) {
    return new Promise((resolve, reject) => {
      if (ws?.readyState !== WebSocket.OPEN) return reject(new Error('Codex 연결이 끊겼습니다.'));
      ws.send(JSON.stringify(message), error => error ? reject(error) : resolve());
    });
  }

  function call(method, params = {}) {
    const id = `approve-here:${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rpc.delete(id); reject(new Error(`${method}: timeout`)); }, 5000);
      rpc.set(id, { resolve, reject, timer });
      send({ id, method, params }).catch(error => { clearTimeout(timer); rpc.delete(id); reject(error); });
    });
  }

  function disconnected() {
    status.connected = false;
    for (const pending of rpc.values()) { clearTimeout(pending.timer); pending.reject(new Error('Codex 연결이 끊겼습니다.')); }
    rpc.clear();
    for (const { record } of requests.values()) if (record) store.expire(record.id, 'handed_off');
    requests.clear(); threads.clear(); reviewers.clear(); subscribed.clear(); items.clear(); suppressed.clear();
  }

  function resolveRequest(id) {
    const entry = requests.get(id);
    if (entry?.record && !entry.responding) store.expire(entry.record.id, 'answered_externally');
    requests.delete(id);
    suppressed.delete(id);
  }

  async function receive(message) {
    if (message.id !== undefined && !message.method) {
      const pending = rpc.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); rpc.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    const p = message.params || {};
    if (message.method === 'thread/settings/updated') reviewers.set(p.threadId, p.threadSettings?.approvalsReviewer);
    if (message.method === 'item/started' && p.item) {
      items.set(`${p.threadId}:${p.item.id}`, p.item);
      if (items.size > 200) items.delete(items.keys().next().value);
    }
    if (message.method === 'serverRequest/resolved') return resolveRequest(p.requestId);
    if (message.method === 'thread/closed') {
      threads.delete(p.threadId);
      reviewers.delete(p.threadId);
      subscribed.delete(p.threadId);
      for (const [id, entry] of requests) if (entry.params.threadId === p.threadId) resolveRequest(id);
      return;
    }
    if (message.method === 'thread/started' && p.thread) threads.set(p.thread.id, p.thread);
    if (message.id === undefined || !METHODS.has(message.method) || suppressed.has(message.id) || requests.has(message.id)) return;
    if (!surfaceActive()) return;
    // Secrets belong in Codex's own masked input, never in the persisted inbox.
    if (p.questions?.some(q => q.isSecret)) return;
    const thread = threads.get(p.threadId);
    const question = message.method === 'item/tool/requestUserInput';
    const network = p.networkApprovalContext;
    const toolName = question ? 'request_user_input' : network ? 'Network' : message.method.includes('fileChange') ? 'apply_patch' : message.method.includes('permissions') ? 'request_permissions' : 'Bash';
    const recordInput = {
      provider: 'codex', kind: question ? 'question' : 'permission', mode: 'codex',
      sessionId: p.threadId, turnId: p.turnId, toolUseId: p.itemId, toolName,
      toolInput: question ? { questions: p.questions } : network ? { network } : { ...(p.command ? { command: p.command } : {}), ...(p.permissions ? { permissions: p.permissions } : {}), ...(p.grantRoot ? { grantRoot: p.grantRoot } : {}) },
      questions: question ? p.questions.map(q => ({ ...q, multiSelect: false })) : undefined,
      description: p.reason || (network ? `${network.protocol}://${network.host}` : p.permissions ? JSON.stringify(p.permissions) : null),
      cwd: p.cwd || thread?.cwd, context: sessionContext(thread?.path) || (thread?.preview ? { task: thread.preview, latest: thread.preview } : null),
    };
    const entry = { params: p, method: message.method, record: null, responding: false };
    requests.set(message.id, entry);
    if (toolName === 'apply_patch') {
      let item = items.get(`${p.threadId}:${p.itemId}`);
      if (!item) {
        try {
          let cursor;
          do {
            const page = await call('thread/items/list', { threadId: p.threadId, turnId: p.turnId, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
            item = page.data.map(entry => entry.item).find(item => item?.id === p.itemId);
            cursor = page.nextCursor;
          } while (!item && cursor);
        } catch {}
      }
      if (requests.get(message.id) !== entry) return;
      const changes = item?.changes;
      if (!changes?.length) { suppressed.add(message.id); requests.delete(message.id); return; }
      recordInput.toolInput = { ...recordInput.toolInput, file_path: changes.map(c => c.path).join(', '), changes };
      recordInput.description = [p.reason, ...changes.map(c => `${c.path}\n${c.diff}`)].filter(Boolean).join('\n').slice(0, 4000);
    }
    if (!question) {
      const config = loadConfig(home);
      let decision = config.allowlist !== false ? allowlistDecision(recordInput, readAllowlist(home)) : null;
      let decidedBy = 'allowlist';
      if (!decision) {
        const input = JSON.stringify({ session_id: p.threadId, turn_id: p.turnId, tool_name: toolName, tool_input: recordInput.toolInput, cwd: recordInput.cwd, hook_event_name: 'PermissionRequest' });
        const result = await runPolicyHooks(config.policyHooks.codex, input, { timeoutMs: config.policyTimeoutSeconds * 1000 });
        decision = result?.decision; decidedBy = `policy:${result?.policy}`;
      }
      if (requests.get(message.id) !== entry) return;
      if (!surfaceActive() || !active()) { requests.delete(message.id); return; }
      if (decision) {
        entry.responding = true;
        await send({ id: message.id, result: responseFor(entry, decision) });
        store.create({ ...recordInput, status: 'auto', decision, decidedBy });
        return;
      }
    }
    if (requests.get(message.id) === entry && surfaceActive() && active()) entry.record = store.create(recordInput);
  }

  function responseFor(entry, decision) {
    if (entry.method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const q of entry.params.questions) {
        const value = decision.answers?.[q.id];
        if (typeof value !== 'string' || !value.trim()) throw new Error('모든 질문에 답해 주세요.');
        answers[q.id] = { answers: [value] };
      }
      return { answers };
    }
    if (entry.method === 'item/permissions/requestApproval') return { permissions: decision.behavior === 'allow' ? entry.params.permissions : {}, scope: 'turn' };
    const value = decision.behavior === 'allow' ? 'accept' : 'decline';
    if (entry.params.availableDecisions && !entry.params.availableDecisions.includes(value)) throw new Error('이 요청은 Codex 원래 화면에서 처리해 주세요.');
    return { decision: value };
  }

  async function sync() {
    if (stopped || syncing) return;
    if (!active() || !surfaceActive()) { ws?.terminate(); return; }
    syncing = true;
    try {
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        if (!existsSync(path)) { status.error = 'Codex 로컬 App Server를 찾지 못했습니다.'; return; }
        ws = new WebSocket(`ws+unix://${path}:/`, { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
        ws.on('message', data => {
          try { receive(JSON.parse(data.toString())).catch(error => { status.error = error.message; log(error.message); }); }
          catch (error) { status.error = error.message; }
        });
        ws.on('close', disconnected);
        ws.on('error', error => { status.error = error.message; });
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        await call('initialize', { clientInfo: { name: 'approve_here', title: 'Approve Here', version: '0.4.0' }, capabilities: { experimentalApi: true } });
        await send({ method: 'initialized' });
        status.connected = true; status.error = null;
      }
      if (!status.connected) return;
      let cursor;
      do {
        const page = await call('thread/loaded/list', { ...(cursor ? { cursor } : {}) });
        for (const threadId of page.data) if (!subscribed.has(threadId)) {
          let result;
          try { result = await call('thread/resume', { threadId, excludeTurns: true }); }
          catch (error) {
            // New/ephemeral threads may not have a rollout yet. One such thread must not disconnect everyone.
            if (!status.connected || ws?.readyState !== WebSocket.OPEN) throw error;
            status.error = error.message;
            continue;
          }
          threads.set(threadId, result.thread);
          reviewers.set(threadId, result.approvalsReviewer);
          subscribed.add(threadId);
        }
        cursor = page.nextCursor;
      } while (cursor);
    } catch (error) { status.error = error.message; ws?.terminate(); }
    finally { syncing = false; }
  }
  const timer = setInterval(sync, intervalMs); timer.unref();
  sync();
  return {
    status,
    ownsSession: id => status.connected && subscribed.has(id),
    reviewerFor: id => status.connected ? reviewers.get(id) ?? null : null,
    async decide(record, decision) {
      const pair = [...requests].find(([, entry]) => entry.record?.id === record.id);
      if (!pair || pair[1].responding) throw new Error('Codex에서 이미 처리한 요청입니다.');
      const [id, entry] = pair;
      if (decision.passthrough) { suppressed.add(id); requests.delete(id); return; }
      const result = responseFor(entry, decision);
      entry.responding = true;
      try { await send({ id, result }); }
      catch (error) { entry.responding = false; throw error; }
    },
    close() { stopped = true; clearInterval(timer); ws?.terminate(); disconnected(); },
  };
}
