import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticateRequest } from './auth.js';
import { makeIceConfig } from './ice.js';
import { SignalingHub } from './signaling.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const updateDir = resolve(process.env.UPDATE_DIR ?? join(process.cwd(), 'updates'));
const publicDir = resolve(process.env.PUBLIC_DIR ?? join(process.cwd(), 'dist/renderer'));
const iceConfig = makeIceConfig();
const hub = new SignalingHub({ iceConfig });

const server = createServer((req, res) => {
  const base = `http://${req.headers.host ?? `${host}:${port}`}`;
  const url = new URL(req.url ?? '/', base);
  const isReadRequest = req.method === 'GET' || req.method === 'HEAD';
  const headOnly = req.method === 'HEAD';

  if (isReadRequest && url.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      clients: hub.getClientCount()
    }, headOnly);
    return;
  }

  if (isReadRequest && url.pathname === '/ice-config') {
    writeJson(res, 200, iceConfig, headOnly);
    return;
  }

  if (isReadRequest && url.pathname === '/online-users') {
    writeJson(res, 200, { users: hub.getOnlinePeers() }, headOnly);
    return;
  }

  if (isReadRequest && url.pathname.startsWith('/updates/')) {
    serveStaticFile(res, updateDir, url.pathname.slice('/updates/'.length), {
      headOnly,
      noStore: url.pathname.endsWith('.json') || url.pathname.endsWith('.yml') || url.pathname.endsWith('.yaml')
    });
    return;
  }

  if (isReadRequest && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
    const relativePath = url.pathname === '/app' || url.pathname === '/app/' ? 'index.html' : url.pathname.slice('/app/'.length);
    serveStaticFile(res, publicDir, relativePath, { headOnly, spaFallback: 'index.html' });
    return;
  }

  writeJson(res, 404, { error: 'not_found' }, headOnly);
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

function writeJson(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(JSON.stringify(body));
}

function serveStaticFile(
  res: ServerResponse,
  rootDir: string,
  relativePath: string,
  options: { headOnly?: boolean; noStore?: boolean; spaFallback?: string } = {}
): void {
  const safeRelativePath = normalize(decodeURIComponent(relativePath)).replace(/^(\.\.[/\\])+/, '');
  let filePath = resolve(rootDir, safeRelativePath);

  if (!filePath.startsWith(rootDir)) {
    writeJson(res, 403, { error: 'forbidden' });
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    if (!options.spaFallback) {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }
    filePath = resolve(rootDir, options.spaFallback);
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }

  res.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'cache-control': options.noStore ? 'no-store' : 'public, max-age=3600'
  });
  if (options.headOnly) {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.yml':
    case '.yaml':
      return 'text/yaml; charset=utf-8';
    case '.exe':
      return 'application/vnd.microsoft.portable-executable';
    case '.dmg':
      return 'application/x-apple-diskimage';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}
