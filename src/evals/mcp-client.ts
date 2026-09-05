/**
 * Cold-start MCP stdio client for the evals suite (trust-loop roadmap PR-2).
 *
 * Spawns a fresh `dist/server/index.js` per probe run and speaks
 * newline-delimited JSON-RPC 2.0 over stdio — the same wire the tests drive
 * (framing pattern from tests/mcp-e2e.test.ts). Replies leave the server in
 * COMPLETION order (tools/call is dispatched async behind the baseline
 * gate), so replies are collected and correlated by id, never by position.
 *
 * MODULE_GRAPH_NO_OPEN=1 is forced: a probe run must never open a browser.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { JsonRpcResponse } from '../server/mcp.js';
import type { McpClient, ToolCallOutcome } from './types.js';

/**
 * Grab a free loopback port and fully release it before returning.
 * This is the ONE implementation (tsconfig rootDir keeps it on this side of
 * the src/tests seam); tests/helpers/net.ts re-exports it from here.
 */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no address'));
      srv.close(() => resolve(addr.port));
    });
    srv.once('error', reject);
  });
}

/** Repo root derived from this file's compiled location (dist/evals/*.js). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Path of the compiled server entry the probes spawn. */
export function serverEntryPath(): string {
  return join(repoRoot(), 'dist', 'server', 'index.js');
}

/** Reply-wait deadline: cold start + baseline scan + tool reply, generously. */
const REPLY_TIMEOUT_MS = 30_000;

class StdioMcpClient implements McpClient {
  private nextId = 1;
  private readonly replies: JsonRpcResponse[] = [];
  private readonly stderrTail: string[] = [];
  private stderrAll = '';
  private exited = false;
  // 候选 #3 (2026-09-05): the byte budget is metered HERE, where every wire
  // byte necessarily passes — probes assert, they do not account. Raw chunk
  // length (not re-encoded text): the honest count of what the server wrote,
  // garbage lines included. countExternal folds off-wire fetches (HTTP probes)
  // into the same number so there is exactly one budget to forget.
  private stdoutBytes = 0;
  private externalBytes = 0;

  constructor(
    private readonly child: ReturnType<typeof spawn>,
    onExit: () => void
  ) {
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBytes += chunk.length;
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          this.replies.push(JSON.parse(line) as JsonRpcResponse);
        } catch {
          this.stderrTail.push(`unparseable stdout line: ${line.slice(0, 120)}`);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep a bounded tail for failure diagnostics, and the full text for
      // stderr-observing e2e tests (startup banners, popup policy lines).
      const s = chunk.toString('utf8');
      this.stderrAll += s;
      this.stderrTail.push(s);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });
    child.on('exit', () => {
      this.exited = true;
      onExit();
    });
  }

  private async waitForReply(id: number): Promise<JsonRpcResponse> {    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    for (;;) {
      const at = this.replies.findIndex((r) => r.id === id);
      if (at >= 0) return this.replies.splice(at, 1)[0]!;
      if (this.exited) throw new Error(`server exited before replying to ${id}; stderr tail:\n${this.stderrTail.join('')}`);
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for MCP reply ${id}; stderr tail:\n${this.stderrTail.join('')}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Complete the MCP handshake; spawnClient calls this before first use. */
  async initialize(): Promise<void> {
    const id = 0;
    this.child.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`
    );
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await this.waitForReply(id);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallOutcome> {
    const id = this.nextId++;
    this.child.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`
    );
    const reply = await this.waitForReply(id);
    if (reply.error !== undefined) {
      return { payload: undefined, text: '', failed: true, rpcError: reply.error };
    }
    const content = (reply.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
    const first = content.find((c) => c.type === 'text' && typeof c.text === 'string');
    const text = first?.text ?? '';
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    const isError = (reply.result as { isError?: unknown } | undefined)?.isError === true;
    return { payload, text, failed: isError };
  }

  async listTools(): Promise<string[]> {
    const id = this.nextId++;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`);
    const reply = await this.waitForReply(id);
    if (reply.error !== undefined) throw new Error(`tools/list failed: ${reply.error.message}`);
    const tools = (reply.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [];
    return tools.map((t) => String(t.name));
  }

  /** Raw JSON-RPC request (auto id) — for probes/tests that need the reply envelope. */
  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    return this.waitForReply(id);
  }

  /** 候选 #3: total bytes metered — every stdout wire byte plus probe-deposited off-wire fetches. */
  bytesSeen(): number {
    return this.stdoutBytes + this.externalBytes;
  }

  /** 候选 #3: charge non-stdio traffic (HTTP bodies) to the same budget. */
  countExternal(byteCount: number): void {
    this.externalBytes += byteCount;
  }

  /** Full stderr accumulated so far — for log-observing e2e assertions. */
  stderr(): string {
    return this.stderrAll;
  }

  /** Wait until the child's stderr contains `needle` (startup banners, popup-policy lines). */
  async waitUntilStderr(needle: string, timeoutMs = 30_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      if (this.stderrAll.includes(needle)) return;
      if (this.exited) throw new Error(`server exited before stderr contained "${needle}"; got:\n${this.stderrAll}`);
      if (Date.now() - started > timeoutMs) throw new Error(`stderr never contained "${needle}"; got:\n${this.stderrAll}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async close(): Promise<void> {
    this.child.kill();
    await new Promise<void>((res) => {
      if (this.exited) return res();
      const timer = setTimeout(res, 3000); // never let a wedged child hang the runner
      this.child.once('exit', () => {
        clearTimeout(timer);
        res();
      });
    });
  }
}

export interface SpawnedClient extends McpClient {
  /** Loopback port the spawned dashboard bound (free-port picked by us, or the pinned one). */
  port: number;
  /** Raw JSON-RPC request (auto id) — reply envelope visible, for wire-level assertions. */
  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse>;
  /** Full stderr text so far (human logs; the MCP channel is stdout). */
  stderr(): string;
  /** Wait until stderr contains `needle`. */
  waitUntilStderr(needle: string, timeoutMs?: number): Promise<void>;
}

/**
 * P0-4: pull the startup token out of the spawned dashboard URL so HTTP
 * probes can authenticate their /api/* fetches and WS handshakes.
 */
export async function dashboardToken(client: McpClient): Promise<string> {
  const res = await client.callTool('get_dashboard_info');
  if (res.failed) throw new Error(`get_dashboard_info failed: ${res.rpcError?.message ?? res.text}`);
  const payload = res.payload as { dashboardUrl?: unknown };
  const m =
    typeof payload.dashboardUrl === 'string'
      ? payload.dashboardUrl.match(/[?&]token=([0-9a-f]+)/)
      : null;
  if (m === null) throw new Error(`no startup token in dashboardUrl: ${String(payload.dashboardUrl)}`);
  return m[1]!;
}

export interface SpawnClientOptions {
  /**
   * Extra env vars merged over process.env (MODULE_GRAPH_NO_OPEN stays
   * forced). Used by the read-only-mode probe to boot the server with
   * MODULE_GRAPH_MCP_READ_ONLY=1.
   */
  env?: Record<string, string>;
  /**
   * Pin the preferred port instead of letting the picker choose one — for
   * tests that must know the port up front (same-root bump/relay scenarios).
   */
  port?: number;
}

/**
 * Cold-start one server against `fixtureRoot`, complete the MCP handshake
 * and return a ready client. Every evals task spawns its own — isolation by
 * process, never shared state between probes.
 */
export async function spawnClient(fixtureRoot: string, options: SpawnClientOptions = {}): Promise<SpawnedClient> {
  const port = options.port ?? await getFreePort();
  const child = spawn(
    process.execPath,
    [serverEntryPath(), '--root', fixtureRoot, '--port', String(port)],
    {
      env: { ...process.env, MODULE_GRAPH_NO_OPEN: '1', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );
  const client = new StdioMcpClient(child, () => {});
  await client.initialize();
  return Object.assign(client, { port });
}
