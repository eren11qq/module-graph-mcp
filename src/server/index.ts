#!/usr/bin/env node
/**
 * Entry point: one Node process running both transports.
 *
 *   stdio  -> MCP JSON-RPC (agents)
 *   HTTP   -> dashboard page + REST + WS (humans)
 *
 * IMPORTANT: stdout belongs to MCP. Every human-readable log goes to stderr.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncrementalGraph } from './incremental-graph.js';
import { McpStdioServer } from './mcp.js';
import { startHttpServer } from './http.js';
import { openBrowser, shouldAutoOpen } from './open-browser.js';
import { startLiveReload } from './live-reload.js';
import type { GraphEvent } from '../shared/types.js';

const VERSION = '0.1.0';
const DEFAULT_PORT = 24282;
/** How long ONE band-walk probe of a /api/info endpoint may take. */
const PROBE_TIMEOUT_MS = 800;
/** Hard cap for the whole band walk; unseen ports past it count as absent. */
const WALK_DEADLINE_MS = 3000;
/** Must match startHttpServer's default bump range (http.ts maxTries). */
const PORT_BAND_TRIES = 20;

interface ParsedArgs {
  root: string;
  port: number;
  noOpen: boolean;
  open: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = { root: process.cwd(), port: DEFAULT_PORT, noOpen: false, open: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      args.root = argv[++i] ?? '';
    } else if (a === '--port') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) fail(`--port must be an integer between 1 and 65535, got "${argv[i]}"`);
      args.port = n;
    } else if (a === '--no-open') {
      args.noOpen = true;
    } else if (a === '--open') {
      args.open = true;
    } else {
      fail(`Unknown argument: ${a}\nUsage: module-graph [--root <dir>] [--port <n>] [--open | --no-open]`);
    }
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`module-graph-mcp: error: ${message}\n`);
  process.exit(1);
}

/**
 * Read the watched root of whichever module-graph instance listens on this
 * port. Null = closed port, foreign service, or probe failure — all treated
 * the same by the band walk (keep scanning).
 */
async function probeInstanceRoot(port: number): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: abort.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { rootPath?: unknown };
    return typeof body.rootPath === 'string' ? body.rootPath : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Same-root dedup, band edition (popup policy): startHttpServer bumps through
 * consecutive ports from the preferred one, so live instances occupy a band.
 * Scan it and report the first instance watching the SAME root, or null when
 * every port is closed / foreign. The caller's own bound port is skipped — a
 * primary must never mistake itself for a same-root holder and go headless.
 */
async function findSameRootInstance(opts: {
  preferredPort: number;
  selfPort: number;
  rootPath: string;
}): Promise<number | null> {
  const deadline = Date.now() + WALK_DEADLINE_MS;
  for (let port = opts.preferredPort; port < opts.preferredPort + PORT_BAND_TRIES; port++) {
    if (port === opts.selfPort) continue;
    if (Date.now() > deadline) return null;
    const holderRoot = await probeInstanceRoot(port);
    if (holderRoot === opts.rootPath) return port;
  }
  return null;
}

/**
 * Cross-session relay (code-review 2026-08-29): a same-root secondary posts
 * its tool-driven events to the primary's /internal/broadcast so the ONE tab
 * the user actually keeps open shows every session's AI activity.
 */
function makeForwarder(primaryPort: number): (event: GraphEvent) => void {
  return (event: GraphEvent) => {
    void fetch(`http://127.0.0.1:${primaryPort}/internal/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event)
    }).catch(() => {}); // best-effort: the primary may have exited already
  };
}

async function main(): Promise<void> {
  const log = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  };

  const { root, port, noOpen, open } = parseArgs(process.argv);

  if (root.length === 0 || !existsSync(root) || !statSync(root).isDirectory()) {
    fail(`--root must be an existing directory, got "${root}"`);
  }
  const rootPath = realpathSync(root);

  // Single graph engine: the same IncrementalGraph instance serves the
  // startup baseline (fullScan inside startLiveReload), every watcher window
  // afterwards, and every reader (HTTP / WS handshake / MCP tools).
  const graph = new IncrementalGraph(rootPath);

  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = join(here, 'public');

  const { url, port: boundPort, hub } = await startHttpServer({
    preferredPort: port,
    publicDir,
    info: { rootPath, port, version: VERSION },
    getSnapshot: () => graph.snapshot(),
    onSecurityEvent: log,
    // Popup policy: an accepted relay from a same-root secondary is session
    // activity too — it must pop the armed primary's tab even when the
    // primary's own session has not called a tool yet.
    onRelayAccepted: () => popOnFirstActivity('relayed activity')
  });

  log(`Module Graph dashboard v${VERSION}`);
  log(`watched root : ${rootPath}`);
  log(`dashboard    : ${url}`);
  log(`note         : ports bumped automatically when busy (started at ${port})`);

  // Popup policy: a server process starting is NOT activity — a desktop
  // client spawns one process per project at app open, and popping here
  // produced N tabs before the user touched anything. So nothing opens now;
  // the logic below only ARMS an instance, and the popup fires on this
  // project's first real session activity (first MCP tool call, or the first
  // event a same-root secondary relays in).
  const portBumped = boundPort !== port;
  // Only a bumped instance needs the band walk: the preferred-port holder is
  // the root's primary by construction (a same-root instance can only ever
  // sit on a later port) and must never demote itself to headless. The walk
  // runs concurrently — it must never delay the MCP handshake.
  const sameRootWalk: Promise<number | null> = portBumped
    ? findSameRootInstance({ preferredPort: port, selfPort: boundPort, rootPath })
    : Promise.resolve(null);

  let popped = false;
  let armed = false;
  const popOnFirstActivity = (reason: string): void => {
    if (!armed || popped) return;
    popped = true;
    log(`dashboard auto-open (${reason})`);
    const openMsg = openBrowser(url);
    if (openMsg) log(openMsg);
  };

  // Where a same-root secondary's tool events go (and which URL a headless
  // instance reports), resolved by the walk.
  let relayTargetPort: number | null = null;
  let relayForward: ((event: GraphEvent) => void) | undefined;

  if (open) {
    // --open pops right now, whatever the dedup decides later.
    const openMsg = openBrowser(url);
    if (openMsg) log(openMsg);
  } else if (noOpen) {
    log('browser auto-open suppressed (--no-open)');
  }
  void sameRootWalk.then((holderPort) => {
    if (holderPort !== null) {
      relayTargetPort = holderPort;
      relayForward = makeForwarder(holderPort);
    }
    if (noOpen || open) return;
    if (shouldAutoOpen({ noOpen, forceOpen: open, portBumped, sameRootHolder: holderPort !== null })) {
      armed = true;
      log('auto-open armed: the dashboard opens on this project\'s first tool call');
    } else {
      log(`same-root instance already serves this dashboard at http://127.0.0.1:${holderPort} — keeping this session headless (${url})`);
    }
  });

  // Ticket 04+05: watch the tree; watcher windows become graph_delta pushes.
  // ready resolves once the baseline scan is done (or degraded — a failed
  // scan logs a warning and serves an empty graph until the next file event
  // rebuilds it) and the watcher is listening.
  const liveReload = startLiveReload({ rootPath, hub, log, graph });
  // Plugin mode (code-review 2026-08-29): the MCP transport must come up
  // BEFORE the baseline scan finishes — an MCP client drops a server whose
  // handshake times out (30s default), and a big repository can scan longer
  // than that. So the scan runs concurrently; mid-scan tool calls are
  // annotated via isBaselineDone instead of being blocked.
  let baselineDone = false;
  void liveReload.ready
    .catch((err: unknown) => {
      log(`warning      : startup pipeline failed (${err instanceof Error ? err.message : String(err)})`);
    })
    .finally(() => {
      baselineDone = true;
    });

  const mcp = new McpStdioServer(process.stdin, process.stdout, log, graph, {
    broadcast: (event: GraphEvent) => {
      hub.broadcast(event);
      // Read live: the walk resolves asynchronously, so this binding starts
      // undefined and is filled in once a same-root holder is found.
      relayForward?.(event);
    },
    reportTestRun: (failed: boolean) => liveReload.reportTestRun(failed),
    httpInfo: () => {
      // A headless secondary hands the agent the PRIMARY's URL, so the link
      // given to the user is always the one tab that shows every session.
      const reportedPort = relayTargetPort ?? boundPort;
      return { url: `http://127.0.0.1:${reportedPort}`, port: reportedPort, rootPath, version: VERSION };
    },
    onFirstToolCall: () => popOnFirstActivity('first tool call'),
    isBaselineDone: () => baselineDone
  });
  await mcp.serve();
  log('stdin closed — shutting down');
  await liveReload.stop();
  hub.closeAll();
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`module-graph-mcp: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
