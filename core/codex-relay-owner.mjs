import WebSocket from 'ws';
import { connect } from 'node:net';

/** Check the live parent relay, so an inherited environment flag cannot hide another session's hook. */
export function codexRelayOwnsSession(socketPath, sessionId) {
  if (!socketPath || !sessionId) return Promise.resolve(false);
  return new Promise(resolve => {
    const ws = new WebSocket('ws://localhost/', { createConnection: () => connect(socketPath), handshakeTimeout: 1000, maxPayload: 16 * 1024 * 1024 });
    let done = false;
    const finish = owned => { if (done) return; done = true; clearTimeout(timer); ws.terminate(); resolve(owned); };
    const timer = setTimeout(() => finish(false), 1500);
    ws.on('error', () => finish(false));
    ws.on('open', () => ws.send(JSON.stringify({ id: 'initialize', method: 'initialize', params: {} })));
    ws.on('message', data => {
      try {
        const message = JSON.parse(data.toString());
        if (message.id === 'initialize') ws.send(JSON.stringify({ id: 'owner', method: 'approveHere/ownsSession', params: { sessionId } }));
        if (message.id === 'owner') finish(message.result?.owned === true);
      } catch { finish(false); }
    });
    ws.on('close', () => finish(false));
  });
}
