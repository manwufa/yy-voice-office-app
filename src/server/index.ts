import { createServer, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticateRequest } from './auth.js';
import { makeIceConfig } from './ice.js';
import { SignalingHub } from './signaling.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const iceConfig = makeIceConfig();
const hub = new SignalingHub({ iceConfig });

const server = createServer((req, res) => {
  const base = `http://${req.headers.host ?? `${host}:${port}`}`;
  const url = new URL(req.url ?? '/', base);

  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      clients: hub.getClientCount()
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/ice-config') {
    writeJson(res, 200, iceConfig);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/online-users') {
    writeJson(res, 200, { users: hub.getOnlinePeers() });
    return;
  }

  writeJson(res, 404, { error: 'not_found' });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  const user = authenticateRequest(req);
  if (!user) {
    socket.close(4401, 'unauthorized');
    return;
  }

  hub.connect(user, (message) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  });

  socket.on('message', (data) => {
    try {
      hub.handleMessage(user.id, JSON.parse(data.toString()));
    } catch {
      socket.send(JSON.stringify({ type: 'error', code: 'bad_json', message: 'Invalid JSON.' }));
    }
  });

  socket.on('close', () => {
    hub.disconnect(user.id);
  });
});

setInterval(() => {
  hub.makeHeartbeat();
}, 25_000).unref();

server.listen(port, host, () => {
  console.log(`signal server listening on http://${host}:${port}`);
});

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  });
  res.end(JSON.stringify(body));
}
