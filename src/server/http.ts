import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { readSourceFile } from './source-reader.js';
import { buildHealthReport } from './health-report.js';
import { renderReportPage } from './report-page.js';
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

/**
 * Cross-site guard shared by the WS handshake and /internal/broadcast: a
 * browser always attaches Origin, so a foreign one is a drive-by page; a
 * missing Origin is a non-browser client (the Node-fetch relay), which
 * cannot be a cross-site victim.
 */
function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin === '') return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export interface HttpInfo {
  rootPath: string;
  port: number;
  version: string;
}

/**
 * P0-3: the cross-session relay's shared secret. Derived from the watched
 * root (NOT random per startup — a same-root secondary must be able to
 * compute the same value without a handshake), so every instance of the same
 * project speaks the same relay token while a different root is a different
 * universe. It gates ONLY the cosmetic relay surface (/internal/broadcast);
 * source reads are protected by the random startup token (P0-4) instead.
 */
export function rootRelayToken(rootPath: string): string {
  return createHash('sha256').update(`module-graph-relay:${rootPath}`).digest('hex').slice(0, 32);
}

/** The `?token=` value on a request URL, or '' when absent/unparseable. */
function tokenFromUrl(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

/**
 * P0-4: the startup-token gate. Unconfigured (token === undefined) = legacy
 * unauthenticated mode used by library tests; production (index.ts) always
 * configures it, so /api/* and /ws require the exact token.
 */
function apiTokenOk(rawUrl: string | undefined, expected: string | undefined): boolean {
  return expected === undefined || tokenFromUrl(rawUrl) === expected;
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

  /**
   * True while at least one dashboard socket is OPEN — the live page's
   * presence. Same OPEN filter as broadcast; register already evicts sockets
   * on close/error, so no extra cleanup is needed here.
   */
  hasOpenClient(): boolean {
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) return true;
    }
    return false;
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
   * Popup policy (file-granular): invoked after a relayed event from a
   * same-root secondary is accepted — the armed primary pops for the file
   * the event names (at most once per file).
   */
  onRelayAccepted?: (event: GraphEvent) => void;
  /**
   * P0-4: random per-startup token embedded in the dashboard URL. When set,
   * /api/* (except the band-walk /api/info) and the /ws handshake require
   * `?token=` to match; static assets stay public (the shell must load to
   * read the token out of its own URL).
   */
  token?: string;
  /**
   * P0-3: read-only mode (MODULE_GRAPH_MCP_READ_ONLY=1). The relay surface
   * (/internal/broadcast) is a write channel for tool-driven state — it is
   * disabled entirely so a read-only process can never be used as a forge.
   */
  readOnly?: boolean;
}): Promise<{ url: string; port: number; server: ReturnType<typeof createServer>; hub: WsHub }> {
  const { preferredPort, maxTries = 20, publicDir, info, getSnapshot, onSecurityEvent, onRelayAccepted, token, readOnly } = opts;

  return new Promise((res, rej) => {
    let attempt = preferredPort;

  const app = createServer((req, resp) =>
    handle(req, resp, publicDir, info, getSnapshot, onSecurityEvent, onRelayAccepted, () => attempt, (event) => hub.broadcast(event), token, readOnly)
  );

    // Websocket endpoint shares the same port (plan §架构). Upgrades are limited
    // to /ws; browsers must present the dashboard's own origin (CSWSH guard).
    const wss = new WebSocketServer({
      noServer: true,
      verifyClient: (info: { req: IncomingMessage }) =>
        originAllowed(info.req.headers.origin, attempt) && apiTokenOk(info.req.url, token)
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
      res({ url: `http://127.0.0.1:${attempt}${token !== undefined ? `?token=${token}` : ''}`, port: attempt, server: app, hub });
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
  onRelayAccepted: ((event: GraphEvent) => void) | undefined,
  boundPort: () => number,
  broadcast: (event: GraphEvent) => void,
  token?: string,
  readOnly?: boolean
): void {
  if (!hostAllowed(req.headers.host, boundPort())) {
    sendHead(resp, 403, { 'content-type': 'text/plain; charset=utf-8' });
    resp.end('forbidden');
    return;
  }

  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

  // Code-review 2026-08-29: cross-session relay — a same-root secondary
  // instance posts its tool-driven events here so the one dashboard tab the
  // user keeps open shows every session's AI activity. P0-3: gated by the
  // shared root token (and disabled in read-only mode).
  if (pathname === '/internal/broadcast') {
    serveInternalBroadcast(req, resp, broadcast, boundPort, onRelayAccepted, info.rootPath, readOnly);
    return;
  }

  if (pathname === '/api/info') {
    // Deliberately unauthenticated: the same-root band walk probes it to
    // learn which port holds this root's dashboard.
    sendHead(resp, 200, { 'content-type': 'application/json; charset=utf-8' });
    // Port must be the ACTUAL listening port: when the preferred port is
    // busy the server bumps to the next free one, and a stale configured
    // port would mislead external consumers (scripts / humans) into the
    // wrong address — the band walk itself only reads rootPath.
    resp.end(JSON.stringify({ ...info, port: boundPort() }));
    return;
  }

  // P0-4 self-heal: the HTML entry points read the startup token out of their
  // own URL, so a missing/stale token must not dead-end the user on the
  // auth-notice page — 302 to the same path with the CURRENT token instead
  // (openBrowser, bookmarks, and bare http://127.0.0.1:PORT/ all just work,
  // and a restart's new token is picked up on the next navigation). This
  // leaks nothing to drive-by pages: the redirect target is only visible to
  // the navigating browser itself (cross-origin fetches get opaque responses,
  // iframes can't read location, and resource-timing strips cross-origin
  // queries), while /api/* data and WS handshakes below still 401 without it.
  if (
    token !== undefined &&
    (req.method === 'GET' || req.method === 'HEAD') &&
    (pathname === '/' || pathname === '/index.html' || pathname === '/api/report') &&
    tokenFromUrl(req.url) !== token
  ) {
    const target = new URL(req.url ?? '/', 'http://127.0.0.1');
    target.searchParams.set('token', token);
    sendHead(resp, 302, { location: `${target.pathname}?${target.searchParams}`, 'cache-control': 'no-store' });
    resp.end();
    return;
  }

  // P0-4: every other /api/* endpoint requires the startup token.
  if (pathname.startsWith('/api/') && !apiTokenOk(req.url, token)) {
    sendHead(resp, 401, { 'content-type': 'text/plain; charset=utf-8' });
    resp.end('unauthorized');
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

  // Trust-loop roadmap PR-4: the acceptance report page. Same guards as the
  // dashboard shell (Host whitelist above, CSP + nosniff on the head), same
  // 503 degradation as /api/graph; deliberately NOT part of the relay surface
  // (isForwardableEvent whitelist untouched) — it is a read-only HTML view.
  if (pathname === '/api/report') {
    if (!getSnapshot) {
      sendHead(resp, 503, { 'content-type': 'application/json; charset=utf-8' });
      resp.end(JSON.stringify({ error: 'graph not ready' }));
      return;
    }
    const focus = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('focus');
    const html = renderReportPage(buildHealthReport(getSnapshot()), focus !== null && focus.length > 0 ? focus : null);
    sendHead(resp, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP });
    resp.end(html);
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
const FORWARDABLE_TYPES: ReadonlySet<string> = new Set(['node_update', 'module_activity', 'review_timeout', 'scan_error', 'edit_scope', 'edit_verification']);

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
    case 'edit_scope':
      // ADR 0002 §7.2: scope 载荷 {modules, files} 或 null（清除）。
      return (
        ev.scope === null ||
        (ev.scope !== null &&
          typeof ev.scope === 'object' &&
          Array.isArray((ev.scope as { modules?: unknown }).modules) &&
          Array.isArray((ev.scope as { files?: unknown }).files))
      );
    case 'edit_verification':
      // ADR 0002 §7.2: 核对载荷 {edited, outOfScope, unreported} 三个数组。
      return (
        ev.verification !== null &&
        typeof ev.verification === 'object' &&
        Array.isArray((ev.verification as { edited?: unknown }).edited) &&
        Array.isArray((ev.verification as { outOfScope?: unknown }).outOfScope) &&
        Array.isArray((ev.verification as { unreported?: unknown }).unreported)
      );
    default:
      // FORWARDABLE_TYPES already filtered `type`, but TS sees a plain string.
      return false;
  }
}

/**
 * P0-3: shape-check AND sanitize a relayed event. node_update is the one
 * frame whose payload a forger could use to paint authoritative-looking
 * state on the dashboard:
 *   - note is stripped entirely (user-authored content must come from the
 *     server's own snapshot, never from a local POST);
 *   - aiReview survives ONLY in the transient `checking` state (the pulse is
 *     harmless activity — and the cross-session relay exists exactly to show
 *     it); a `done` review (the fake "AI checked ✓" ring) is stripped.
 * Returns null when the value is not relayable.
 */
export function sanitizeForwardableEvent(value: unknown): GraphEvent | null {
  if (!isForwardableEvent(value)) return null;
  const ev = value as GraphEvent;
  if (ev.type === 'node_update') {
    const review = ev.node.aiReview;
    const aiReview = review !== undefined && review !== null && review.status === 'checking' ? review : undefined;
    return { ...ev, node: { ...ev.node, note: undefined, aiReview } };
  }
  return ev;
}

function isLoopbackPeer(remote: string | undefined): boolean {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function serveInternalBroadcast(
  req: IncomingMessage,
  resp: ServerResponse,
  broadcast: (event: GraphEvent) => void,
  boundPort: () => number,
  onRelayAccepted: ((event: GraphEvent) => void) | undefined,
  rootPath: string,
  readOnly?: boolean
): void {
  // Rejection helper: drain the request body before answering, so the
  // keep-alive socket stays usable — answering with the body unconsumed makes
  // Node reset the connection and poisons the client's connection pool.
  const reject = (status: number, text: string): void => {
    req.resume();
    sendHead(resp, status, { 'content-type': 'text/plain; charset=utf-8' });
    resp.end(text);
  };

  if (req.method !== 'POST') {
    reject(405, 'method not allowed');
    return;
  }
  // P0-3: read-only mode is not a relay surface — refuse before anything else.
  if (readOnly === true) {
    reject(403, 'relay disabled in read-only mode');
    return;
  }
  // The server binds loopback only, but an open local proxy could relay a
  // foreign peer's POST; the socket address is the check that actually holds.
  if (!isLoopbackPeer(req.socket.remoteAddress)) {
    reject(403, 'forbidden');
    return;
  }
  // A cross-site page can smuggle a text/plain POST past CORS (the request is
  // sent even though its response is unreadable); Origin pins it to the
  // dashboard's own page — same guard as the WS handshake (review 2026-08-30).
  if (!originAllowed(req.headers.origin, boundPort())) {
    reject(403, 'forbidden origin');
    return;
  }
  // P0-3: only same-root instances (which can compute the shared root token)
  // may relay; a blind local POST with no token is refused. Checked last so
  // the transport-level rejections (loopback, Origin) keep their statuses.
  if (tokenFromUrl(req.url) !== rootRelayToken(rootPath)) {
    reject(401, 'unauthorized');
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
    const safe = sanitizeForwardableEvent(parsed);
    if (safe === null) {
      sendHead(resp, 400, { 'content-type': 'text/plain; charset=utf-8' });
      resp.end('event type not relayable');
      return;
    }
    broadcast(safe);
    onRelayAccepted?.(safe);
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
