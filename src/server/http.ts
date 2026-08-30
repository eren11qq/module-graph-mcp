import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { readSourceFile } from './source-reader.js';
import type { GraphEvent, GraphSnapshot } from '../shared/types.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

/** Strict CSP for HTML responses (inline styles allowed: legend swatches / hljs themes). */
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

/** Upper bound for a relayed event body (node_update carries a small node patch, never source). */
const MAX_INTERNAL_BODY_BYTES = 1024 * 1024;

/** Every response carries nosniff so a sniffed payload can never execute. */
function sendHead(resp: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  resp.writeHead(status, { 'x-content-type-options': 'nosniff', ...headers });
}

/** DNS-rebinding guard: browsers always attach Host, a rebound name arrives with a foreign one. */
function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export interface HttpInfo {
  rootPath: string;
  port: number;
  version: string;
}

/** Fan-out hub for dashboard websocket clients. */
export class WsHub {
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly wss: WebSocketServer) {}

  register(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  broadcast(event: GraphEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  /** Shutdown path: politely close every connected dashboard socket. */
  closeAll(): void {
    for (const client of this.clients) client.close();
  }

  get size(): number {
    return this.clients.size;
  }
}

/**
 * Start the dashboard HTTP server bound to loopback.
 * If the preferred port is busy, retries successive ports (up to `maxTries`)
 * so a stale instance never blocks a fresh one.
 */
export function startHttpServer(opts: {
  preferredPort: number;
  maxTries?: number;
  publicDir: string;
  info: HttpInfo;
  /** Ticket 02: returns the current graph snapshot; absence degrades /api/graph to 503. */
  getSnapshot?: () => GraphSnapshot;
  /** Ticket 09: receives one line per denied /api/source request (security log). */
  onSecurityEvent?: (msg: string) => void;
  /**
   * Popup policy (code-review 2026-08-29): invoked after a relayed event from
   * a same-root secondary is accepted — the armed primary counts the relay as
   * this project's first activity and pops its dashboard tab.
   */
  onRelayAccepted?: () => void;
}): Promise<{ url: string; port: number; server: ReturnType<typeof createServer>; hub: WsHub }> {
  const { preferredPort, maxTries = 20, publicDir, info, getSnapshot, onSecurityEvent, onRelayAccepted } = opts;

  return new Promise((res, rej) => {
    let attempt = preferredPort;

  const app = createServer((req, resp) =>
    handle(req, resp, publicDir, info, getSnapshot, onSecurityEvent, onRelayAccepted, () => attempt, (event) => hub.broadcast(event))
  );

    // Websocket endpoint shares the same port (plan §架构). Upgrades are limited
    // to /ws; browsers must present the dashboard's own origin (CSWSH guard).
    // A missing Origin means a non-browser client, which cannot be a CSWSH victim.
    const wss = new WebSocketServer({
      noServer: true,
      verifyClient: (info: { req: IncomingMessage }) => {
        const origin = info.req.headers.origin;
        if (origin === undefined || origin === '') return true;
        return origin === `http://127.0.0.1:${attempt}` || origin === `http://localhost:${attempt}`;
      }
    });
    const hub = new WsHub(wss);
    app.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        hub.register(ws);
        // Handshake frame: the client's real baseline snapshot. (A null
        // snapshot here used to violate the GraphEvent wire type and relied
        // on client-side guards to not crash.)
        if (getSnapshot) ws.send(JSON.stringify({ type: 'snapshot', snapshot: getSnapshot() }));
      });
    });

    // `on` (not `once`): with `once`, the second consecutive EADDRINUSE had
    // no handler left and killed the process mid-retry.
    app.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt - preferredPort < maxTries) {
        attempt += 1;
        app.listen(attempt, '127.0.0.1');
      } else {
        rej(err);
      }
    });

    app.listen(attempt, '127.0.0.1', () => {
      res({ url: `http://127.0.0.1:${attempt}`, port: attempt, server: app, hub });
    });
  });
}

function handle(
  req: IncomingMessage,
  resp: ServerResponse,
  publicDir: string,
  info: HttpInfo,
  getSnapshot: (() => GraphSnapshot) | undefined,
  onSecurityEvent: ((msg: string) => void) | undefined,
  onRelayAccepted: (() => void) | undefined,
  boundPort: () => number,
  broadcast: (event: GraphEvent) => void
): void {
  if (!hostAllowed(req.headers.host, boundPort())) {
    sendHead(resp, 403, { 'content-type': 'text/plain; charset=utf-8' });
    resp.end('forbidden');
    return;
  }

  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

  // Code-review 2026-08-29: cross-session relay — a same-root secondary
  // instance posts its tool-driven events here so the one dashboard tab the
  // user keeps open shows every session's AI activity.
  if (pathname === '/internal/broadcast') {
    serveInternalBroadcast(req, resp, broadcast, onRelayAccepted);
    return;
  }

  if (pathname === '/api/info') {
    sendHead(resp, 200, { 'content-type': 'application/json; charset=utf-8' });
    resp.end(JSON.stringify(info));
    return;
  }

  if (pathname === '/api/graph') {
    if (!getSnapshot) {
      sendHead(resp, 503, { 'content-type': 'application/json; charset=utf-8' });
      resp.end(JSON.stringify({ error: 'graph not ready' }));
      return;
    }
    sendHead(resp, 200, { 'content-type': 'application/json; charset=utf-8' });
    resp.end(JSON.stringify(getSnapshot()));
    return;
  }

  if (pathname === '/api/source') {
    const requested = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('path') ?? '';
    serveSource(requested, resp, info, onSecurityEvent);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendHead(resp, 405, { 'content-type': 'text/plain; charset=utf-8' });
    resp.end('method not allowed');
    return;
  }

  let rel: string;
  if (pathname === '/') {
    rel = 'index.html';
  } else {
    try {
      rel = decodeURIComponent(pathname.slice(1));
    } catch {
      sendHead(resp, 400, { 'content-type': 'text/plain; charset=utf-8' });
      resp.end('malformed percent-encoding');
      return;
    }
  }
  const abs = resolve(join(publicDir, rel));

  // Path traversal guard: everything served must stay under publicDir.
  if (!abs.startsWith(resolve(publicDir) + sep) && abs !== resolve(publicDir)) {
    sendHead(resp, 403, { 'content-type': 'text/plain; charset=utf-8' });
    resp.end('forbidden');
    return;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    sendHead(resp, 404, { 'content-type': 'text/plain; charset=utf-8' });
    resp.end('not found');
    return;
  }

  const headers: Record<string, string> = {
    'content-type': MIME[extname(abs)] ?? 'application/octet-stream'
  };
  if (extname(abs) === '.html') headers['content-security-policy'] = CSP;
  sendHead(resp, 200, headers);
  createReadStream(abs).pipe(resp);
}

/**
 * Ticket 09: read ONE text source file inside the watched root through the
 * shared security envelope (source-reader.ts). Every denial is reported to
 * onSecurityEvent (the human-facing stderr log).
 */
function serveSource(
  requested: string,
  resp: ServerResponse,
  info: HttpInfo,
  onSecurityEvent?: (msg: string) => void
): void {
  const result = readSourceFile(info.rootPath, requested);
  if (!result.ok) {
    onSecurityEvent?.(`source read denied (${result.status}): ${result.reason} — ${result.detail}`);
    sendHead(resp, result.status, { 'content-type': 'application/json; charset=utf-8' });
    resp.end(JSON.stringify({ error: result.reason }));
    return;
  }
  sendHead(resp, 200, { 'content-type': 'application/json; charset=utf-8' });
  resp.end(
    JSON.stringify({
      path: result.path,
      sizeBytes: result.sizeBytes,
      content: result.content,
      truncated: result.truncated === true
    })
  );
}

/**
 * Code-review 2026-08-29: events a same-root secondary instance may relay to
 * the primary's dashboards. snapshot/graph_delta are excluded on purpose —
 * every instance watches the tree itself, so relaying deltas would double
 * flash every page; only tool-driven state needs the relay.
 */
const FORWARDABLE_TYPES: ReadonlySet<string> = new Set(['node_update', 'module_activity', 'review_timeout', 'scan_error']);

/** Light shape check — full client-side guards (frame-guards) still run on the page. */
export function isForwardableEvent(value: unknown): value is GraphEvent {
  if (value === null || typeof value !== 'object') return false;
  const ev = value as Record<string, unknown>;
  if (typeof ev.type !== 'string' || !FORWARDABLE_TYPES.has(ev.type)) return false;
  switch (ev.type) {
    case 'node_update':
      return ev.node !== null && typeof ev.node === 'object' && typeof (ev.node as { id?: unknown }).id === 'string';
    case 'module_activity':
      return typeof ev.id === 'string' && ev.activity === 'viewing';
    case 'review_timeout':
      return typeof ev.id === 'string';
    case 'scan_error':
      return typeof ev.message === 'string';
    default:
      // FORWARDABLE_TYPES already filtered `type`, but TS sees a plain string.
      return false;
  }
}

function isLoopbackPeer(remote: string | undefined): boolean {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function serveInternalBroadcast(
  req: IncomingMessage,
  resp: ServerResponse,
  broadcast: (event: GraphEvent) => void,
  onRelayAccepted?: () => void
): void {
  if (req.method !== 'POST') {
    sendHead(resp, 405, { 'content-type': 'text/plain; charset=utf-8' });
    resp.end('method not allowed');
    return;
  }
  // The server binds loopback only, but an open local proxy could relay a
  // foreign peer's POST; the socket address is the check that actually holds.
  if (!isLoopbackPeer(req.socket.remoteAddress)) {
    sendHead(resp, 403, { 'content-type': 'text/plain; charset=utf-8' });
    resp.end('forbidden');
    return;
  }

  let body = '';
  let size = 0;
  let done = false;
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => {
    size += chunk.length;
    if (size > MAX_INTERNAL_BODY_BYTES && !done) {
      done = true;
      sendHead(resp, 413, { 'content-type': 'text/plain; charset=utf-8' });
      resp.end('event too large');
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on('end', () => {
    if (done) return;
    done = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendHead(resp, 400, { 'content-type': 'text/plain; charset=utf-8' });
      resp.end('malformed JSON');
      return;
    }
    if (!isForwardableEvent(parsed)) {
      sendHead(resp, 400, { 'content-type': 'text/plain; charset=utf-8' });
      resp.end('event type not relayable');
      return;
    }
    broadcast(parsed);
    onRelayAccepted?.();
    sendHead(resp, 204);
    resp.end();
  });
  req.on('error', () => {
    if (!done) {
      done = true;
      resp.destroy();
    }
  });
}
