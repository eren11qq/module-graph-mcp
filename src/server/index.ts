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
import { openBrowser } from './open-browser.js';
import { startLiveReload } from './live-reload.js';
import type { GraphEvent } from '../shared/types.js';

const VERSION = '0.1.0';
const DEFAULT_PORT = 24282;

interface ParsedArgs {
  root: string;
  port: number;
  noOpen: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = { root: process.cwd(), port: DEFAULT_PORT, noOpen: false };
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
    } else {
      fail(`Unknown argument: ${a}\nUsage: module-graph [--root <dir>] [--port <n>] [--no-open]`);
    }
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`module-graph-mcp: error: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const log = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  };

  const { root, port, noOpen } = parseArgs(process.argv);

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

  // Ticket 04+05: watch the tree; watcher windows become graph_delta pushes.
  // ready resolves once the baseline scan is done (or degraded — a failed
  // scan logs a warning and serves an empty graph until the next file event
  // rebuilds it) and the watcher is listening.
  const liveReload = startLiveReload({ rootPath, hub, log, graph });
  await liveReload.ready.catch((err: unknown) => {
    log(`warning      : startup pipeline failed (${err instanceof Error ? err.message : String(err)})`);
  });

  const openMsg = openBrowser(url, { noOpen });
  if (openMsg) log(openMsg);

  const mcp = new McpStdioServer(process.stdin, process.stdout, log, graph, {
    broadcast: (event: GraphEvent) => hub.broadcast(event)
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
