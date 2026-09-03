#!/usr/bin/env node
/**
 * Entry point: one Node process running both transports.
 *
 *   stdio  -> MCP JSON-RPC (agents)
 *   HTTP   -> dashboard page + REST + WS (humans)
 *
 * IMPORTANT: stdout belongs to MCP. Every human-readable log goes to stderr.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncrementalGraph } from './incremental-graph.js';
import { McpStdioServer } from './mcp.js';
import { rootRelayToken, startHttpServer } from './http.js';
import { openBrowser, shouldAutoOpen, shouldPopFile } from './open-browser.js';
import { startLiveReload } from './live-reload.js';
import { createRecentChanges } from './recent-changes.js';
import { createReviewStore } from './review-store.js';
import { VERSION } from './version.js';
import type { GraphEvent } from '../shared/types.js';

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

/**
 * GitNexus port: guardrail environment, validated LOUDLY (stderr + exit 1,
 * same discipline as a bad --port) — a typo'd value must never silently
 * change behavior. Returns read-only mode and the default token budget.
 */
function parseGuardrailEnv(): { readOnly: boolean; defaultMaxTokens: number | undefined } {
  const rawReadOnly = process.env.MODULE_GRAPH_MCP_READ_ONLY;
  let readOnly = false;
  if (rawReadOnly !== undefined && rawReadOnly !== '0') {
    if (rawReadOnly === '1') readOnly = true;
    else fail(`MODULE_GRAPH_MCP_READ_ONLY must be unset, "0" or "1", got "${rawReadOnly}"`);
  }

  const rawBudget = process.env.MODULE_GRAPH_MCP_DEFAULT_MAX_TOKENS;
  let defaultMaxTokens: number | undefined;
  if (rawBudget !== undefined) {
    const parsed = Number(rawBudget);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      fail(`MODULE_GRAPH_MCP_DEFAULT_MAX_TOKENS must be a positive integer, got "${rawBudget}"`);
    }
    defaultMaxTokens = parsed;
  }
  return { readOnly, defaultMaxTokens };
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
    } else if (a === '--version') {
      // No MCP session is up yet, so writing to stdout is safe here.
      // writeSync: stdout is async on macOS pipes, so process.exit right
      // after process.stdout.write can truncate the line mid-flight.
      writeSync(1, `${VERSION}\n`);
      process.exit(0);
    } else {
      fail(`Unknown argument: ${a}\nUsage: module-graph [--root <dir>] [--port <n>] [--open | --no-open] [--version]`);
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
function makeForwarder(primaryPort: number, rootPath: string): (event: GraphEvent) => void {
  // P0-3: the relay accepts only same-root instances — the shared root token
  // is derived from the watched root, so every session of this project
  // computes the same value without a handshake.
  const relayToken = rootRelayToken(rootPath);
  return (event: GraphEvent) => {
    void fetch(`http://127.0.0.1:${primaryPort}/internal/broadcast?token=${relayToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event)
    }).catch(() => {}); // best-effort: the primary may have exited already
  };
}

/**
 * The module a relayed event is about, or null when it names no file
 * (scan_error). Only file-naming events can trigger the file-granular popup.
 */
function fileIdFromEvent(event: GraphEvent): string | null {
  switch (event.type) {
    case 'node_update':
      return event.node.id;
    case 'module_activity':
    case 'review_timeout':
      return event.id;
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const log = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  };

  const { root, port, noOpen, open } = parseArgs(process.argv);
  const { readOnly, defaultMaxTokens } = parseGuardrailEnv();
  // P0-4: a random per-startup token rides in the dashboard URL; /api/* and
  // /ws demand it, so a same-machine low-privilege process cannot read
  // source files through the HTTP surface.
  const startupToken = randomBytes(16).toString('hex');

  if (root.length === 0 || !existsSync(root) || !statSync(root).isDirectory()) {
    fail(`--root must be an existing directory, got "${root}"`);
  }
  const rootPath = realpathSync(root);

  // Single graph engine: the same IncrementalGraph instance serves the
  // startup baseline (fullScan inside startLiveReload), every watcher window
  // afterwards, and every reader (HTTP / WS handshake / MCP tools).
  const graph = new IncrementalGraph(rootPath);

  // 常驻: completed end_review verdicts persist to <root>/.module-graph/
  // reviews.json. live-reload attaches them after the baseline scan and
  // prunes them on unlink; end_review lands them via the MCP deps below.
  const reviewStore = createReviewStore({ rootPath, log });

  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = join(here, 'public');

  const { url, port: boundPort, hub } = await startHttpServer({
    preferredPort: port,
    publicDir,
    info: { rootPath, port, version: VERSION },
    getSnapshot: () => graph.snapshot(),
    onSecurityEvent: log,
    token: startupToken,
    readOnly,
    // Popup policy (file-granular): a relayed event from a same-root
    // secondary names the file its agent opened — the armed primary pops
    // for that file (once per file), even when its own session has not
    // called a tool yet.
    onRelayAccepted: (event) => {
      const fileId = fileIdFromEvent(event);
      if (fileId !== null) popOnFileActivity(fileId, 'relayed activity');
    }
  });

  log(`Module Graph dashboard v${VERSION}`);
  log(`watched root : ${rootPath}`);
  log(`dashboard    : ${url}`);
  log(`note         : ports bumped automatically when busy (started at ${port})`);

  // Popup policy (file-granular): a server process starting is NOT activity —
  // a desktop client spawns one process per project at app open, and popping
  // here produced N tabs before the user touched anything. So nothing opens
  // now; the logic below only ARMS an instance, and the popup fires per file:
  // each distinct module the agent opens (via a file-targeted MCP tool, or a
  // relayed event from a same-root secondary naming that file) pops once.
  // Files the agent never opens never pop.
  const portBumped = boundPort !== port;
  // Only a bumped instance needs the band walk: the preferred-port holder is
  // the root's primary by construction (a same-root instance can only ever
  // sit on a later port) and must never demote itself to headless. The walk
  // runs concurrently — it must never delay the MCP handshake.
  const sameRootWalk: Promise<number | null> = portBumped
    ? findSameRootInstance({ preferredPort: port, selfPort: boundPort, rootPath })
    : Promise.resolve(null);

  // File-granular popup dedup: each distinct file the agent opens pops the
  // dashboard at most once; files never opened never pop. While a dashboard
  // tab is already connected, no further pop happens — the rhythm is "one tab
  // per idle stretch", not "one tab per file the agent reads".
  const poppedFiles = new Set<string>();
  let armed = false;
  const popOnFileActivity = (fileId: string, reason: string): void => {
    const decision = {
      armed,
      alreadyPopped: poppedFiles.has(fileId),
      pageConnected: hub.hasOpenClient()
    };
    if (shouldPopFile(decision)) {
      poppedFiles.add(fileId);
      log(`dashboard auto-open for ${fileId} (${reason})`);
      const openMsg = openBrowser(url);
      if (openMsg) log(openMsg);
    } else if (decision.armed && !decision.alreadyPopped) {
      // The only false term left is pageConnected. NOT recorded in
      // poppedFiles: once the tab closes, later files can pop again.
      log(`dashboard already open in a browser — skip auto-open for ${fileId}`);
    }
  };

  // Where a same-root secondary's tool events go (and which URL a headless
  // instance reports), resolved by the walk.
  let relayTargetPort: number | null = null;
  let relayForward: ((event: GraphEvent) => void) | undefined;

  if (open && !noOpen) {
    // --open pops right now (--no-open still wins, as in shouldAutoOpen),
    // whatever the dedup decides later.
    const openMsg = openBrowser(url);
    if (openMsg) log(openMsg);
  } else if (noOpen) {
    log('browser auto-open suppressed (--no-open)');
  }
  void sameRootWalk.then((holderPort) => {
    if (holderPort !== null) {
      relayTargetPort = holderPort;
      relayForward = makeForwarder(holderPort, rootPath);
      // Log even under --no-open / --open: a silent headless demotion hides
      // that this session's AI activity still shows on the primary tab.
      log(`same-root instance serves this dashboard at http://127.0.0.1:${holderPort} — relaying tool events there (this instance: ${url})`);
    }
    if (noOpen || open) return;
    if (shouldAutoOpen({ noOpen, forceOpen: open, portBumped, sameRootHolder: holderPort !== null })) {
      armed = true;
      log(`auto-open armed: the dashboard opens when this project's agent first opens a file`);
    } else if (holderPort !== null) {
      log(`auto-open stays off: the same-root dashboard tab already covers this project`);
    }
  });

  // Ticket 04+05: watch the tree; watcher windows become graph_delta pushes.
  // ready resolves once the baseline scan is done (or degraded — a failed
  // scan logs a warning and serves an empty graph until the next file event
  // rebuilds it) and the watcher is listening.
  // Ticket 13 修法 B: the watcher evidence chain persists to
  // <root>/.module-graph/recent-changes.json — restart no longer clears the
  // proof needed by report_edits / get_change_impact (false-green fix).
  const recentChanges = createRecentChanges({ rootPath, log });
  const liveReload = startLiveReload({ rootPath, hub, log, graph, reviewStore, recentChanges });
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
      // P0-4: every instance hands out its OWN tokenized URL. The primary's
      // random startup token is deliberately not shareable to other local
      // processes (that is the point of the auth), so a headless secondary
      // can no longer mint a working link to the primary's port — its own
      // dashboard serves the same root, and its tool events still relay to
      // whatever primary tab is open.
      return { url: `http://127.0.0.1:${boundPort}?token=${startupToken}`, port: boundPort, rootPath, version: VERSION };
    },
    onFileActivity: (fileId) => popOnFileActivity(fileId, 'file opened by agent'),
    isBaselineDone: () => baselineDone,
    recentChanges: liveReload.recentChanges,
    readOnly,
    defaultMaxTokens,
    reviewStore
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
