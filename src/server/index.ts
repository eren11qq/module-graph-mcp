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
/** How long the secondary-instance probe of the preferred port may take. */
const PRIMARY_PROBE_TIMEOUT_MS = 800;

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
 * Ask whoever holds the preferred port whether it is a module-graph server
 * watching the SAME root (its /api/info rootPath is realpath'd too, so the
 * strings compare directly). Null = probe failed / foreign process.
 */
async function probePrimaryRoot(preferredPort: number): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PRIMARY_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${preferredPort}/api/info`, { signal: abort.signal });
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
    onSecurityEvent: log
  });

  log(`Module Graph dashboard v${VERSION}`);
  log(`watched root : ${rootPath}`);
  log(`dashboard    : ${url}`);
  log(`note         : ports bumped automatically when busy (started at ${port})`);

  // Same-root dedup: when the preferred port was taken by another instance of
  // THIS root, that instance's tab is already the one on screen — stay
  // headless and relay tool activity to it instead of popping another tab.
  const portBumped = boundPort !== port;
  const primaryRoot = portBumped ? await probePrimaryRoot(port) : null;
  const sameRootPrimary = primaryRoot === rootPath;
  const autoOpen = shouldAutoOpen({ noOpen, forceOpen: open, portBumped, primaryRoot, rootPath });
  if (autoOpen) {
    const openMsg = openBrowser(url);
    if (openMsg) log(openMsg);
  } else if (noOpen) {
    log('browser auto-open suppressed (--no-open)');
  } else {
    log(`same-root instance already serves this dashboard at http://127.0.0.1:${port} — keeping this session headless (${url})`);
  }

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

  const forwardEvent = sameRootPrimary ? makeForwarder(port) : undefined;
  const mcp = new McpStdioServer(process.stdin, process.stdout, log, graph, {
    broadcast: (event: GraphEvent) => {
      hub.broadcast(event);
      forwardEvent?.(event);
    },
    reportTestRun: (failed: boolean) => liveReload.reportTestRun(failed),
    httpInfo: () => ({ url, port: boundPort, rootPath, version: VERSION }),
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
