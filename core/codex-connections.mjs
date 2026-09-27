import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { startCodexBridge } from './codex-bridge.mjs';

export function startCodexConnections(options) {
  const shared = startCodexBridge(options), relays = new Map();
  const directory = join(options.home, 'codex-relays');
  const all = () => [shared, ...relays.values()];
  function scan() {
    let sockets = [];
    try {
      const parent = lstatSync(directory);
      if (parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0) sockets = readdirSync(directory).filter(name => name.endsWith('.sock')).map(name => join(directory, name)).filter(path => { const stat = lstatSync(path); return stat.isSocket() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0; });
    } catch {}
    for (const [path, bridge] of relays) if (!sockets.includes(path)) { bridge.close(); relays.delete(path); }
    for (const path of sockets) if (!relays.has(path)) relays.set(path, startCodexBridge({ ...options, socketPath: path, relay: true }));
  }
  scan(); const timer = setInterval(scan, 1000); timer.unref();
  return {
    get status() {
      const connected = all().some(b => b.status.connected);
      return {
        connected,
        sharedConnected: shared.status.connected,
        sharedError: shared.status.error,
        relayCount: [...relays.values()].filter(b => b.status.connected).length,
        error: connected ? null : all().find(b => b.status.error)?.status.error ?? null,
      };
    },
    ownsSession: id => all().some(b => b.ownsSession(id)),
    reviewerFor: id => all().find(b => b.ownsSession(id))?.reviewerFor(id) ?? null,
    async decide(record, decision) {
      // Request IDs belong to each bridge, rather than just to the saved thread ID.
      const bridge = all().find(b => b.ownsRequest(record.id));
      if (!bridge) throw new Error('Codex에서 이미 처리한 요청입니다.');
      return bridge.decide(record, decision);
    },
    close() { clearInterval(timer); for (const bridge of all()) bridge.close(); },
  };
}
