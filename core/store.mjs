import { appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureHome } from './config.mjs';

export const PENDING = 'pending';
const FINAL = new Set(['allowed', 'denied', 'answered', 'answered_externally', 'passed', 'handed_off', 'expired', 'auto', 'skipped']);
const PRESET = new Set(['auto', 'skipped']);
const RECENT_LIMIT = 100;

/** 요청을 메모리에 들고 requests.jsonl에 사건 단위로 덧붙인다. 다시 읽어 복원하는 용도는 아니다. */
export class Store {
  constructor(home) {
    this.home = ensureHome(home);
    this.requests = new Map();
    this.waiters = new Map();
    this.listeners = new Set();
  }

  create(input) {
    const now = new Date().toISOString();
    const status = PRESET.has(input.status) ? input.status : PENDING;
    const record = Object.freeze({
      id: randomUUID(),
      // permission: 도구 실행 허용/거부 · question: AskUserQuestion의 답
      kind: input.kind === 'question' ? 'question' : 'permission',
      questions: input.kind === 'question' ? input.questions ?? [] : null,
      provider: input.provider,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      toolUseId: input.toolUseId ?? null,
      toolName: input.toolName,
      toolInput: input.toolInput ?? {},
      description: input.description ?? null,
      cwd: input.cwd ?? null,
      project: input.cwd ? basename(input.cwd) : null,
      permissionMode: input.permissionMode ?? null,
      model: input.model ?? null,
      tmux: input.tmux ?? null,
      context: input.context ?? null,
      // 이 시각이 지나면 훅이 물러나 CLI에 원래 프롬프트가 뜬다. null이면 CLI가 이미 함께 띄우고 있다.
      handoffAt: input.handoffAt ?? null,
      // wait: 훅이 결정을 기다림 · mirror: 훅은 물러났고 터미널 다이얼로그가 떠 있음(카드 결정은 tmux 키로 전달)
      mode: input.mode === 'mirror' ? 'mirror' : 'wait',
      status,
      decision: status === 'auto' ? input.decision ?? null : null,
      decidedBy: status === 'auto' ? input.decidedBy ?? 'policy' : status === 'skipped' ? input.decidedBy ?? 'no-surface' : null,
      createdAt: now,
      updatedAt: now,
    });
    this.requests.set(record.id, record);
    this.append('registered', record);
    this.emit('registered', record);
    return record;
  }

  get(id) {
    return this.requests.get(id) ?? null;
  }

  list(status = PENDING) {
    const all = [...this.requests.values()];
    if (status === PENDING) {
      return all.filter(r => r.status === PENDING).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return all
      .filter(r => FINAL.has(r.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, RECENT_LIMIT);
  }

  /** 같은 세션의 대기 중 mirror 요청들 — 터미널에서 답했거나 닫혔으면 다이얼로그는 이미 없다. */
  pendingMirror({ sessionId, toolUseId = null }) {
    return [...this.requests.values()].filter(
      r => r.status === PENDING && r.mode === 'mirror' && r.sessionId === sessionId && (toolUseId === null || r.toolUseId === null || r.toolUseId === toolUseId),
    );
  }

  decide(id, decision, decidedBy = 'user') {
    const current = this.requests.get(id);
    if (!current || current.status !== PENDING) return null;
    const status = decision.answers ? 'answered' : decision.passthrough ? 'passed' : decision.behavior === 'allow' ? 'allowed' : 'denied';
    const next = Object.freeze({ ...current, status, decision, decidedBy, updatedAt: new Date().toISOString() });
    this.settle(next, 'decided');
    return next;
  }

  expire(id, status = 'expired') {
    const current = this.requests.get(id);
    if (!current || current.status !== PENDING) return current ?? null;
    const next = Object.freeze({ ...current, status, updatedAt: new Date().toISOString() });
    this.settle(next, status);
    return next;
  }

  /** 결정이 날 때까지 기다린다. timeoutMs 안에 결정이 없으면 현재 레코드를 그대로 돌려준다. */
  wait(id, timeoutMs) {
    const current = this.requests.get(id);
    if (!current || current.status !== PENDING) return Promise.resolve(current ?? null);
    return new Promise(resolve => {
      const set = this.waiters.get(id) ?? new Set();
      const timer = setTimeout(() => {
        set.delete(entry);
        resolve(this.requests.get(id) ?? null);
      }, timeoutMs);
      const entry = record => {
        clearTimeout(timer);
        resolve(record);
      };
      set.add(entry);
      this.waiters.set(id, set);
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  settle(record, kind) {
    this.requests.set(record.id, record);
    this.append(kind, record);
    const set = this.waiters.get(record.id);
    if (set) {
      this.waiters.delete(record.id);
      for (const resolve of set) resolve(record);
    }
    this.emit(kind, record);
  }

  emit(kind, record) {
    for (const listener of this.listeners) listener({ type: kind, request: record });
  }

  /** 사건 이름은 event에 둔다 — record.kind(permission/question)와 이름이 겹쳐 덮어쓰였다. */
  append(event, record) {
    appendFileSync(join(this.home, 'requests.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, ...record }) + '\n');
  }
}
