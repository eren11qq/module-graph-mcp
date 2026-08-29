import { StringDecoder } from 'node:string_decoder';
import { readSourceFile, type SourceReadResult } from './source-reader.js';
import type { AiReview, AiReviewEntry, AiVerdict, GraphEvent, GraphSnapshot, ModuleNode } from '../shared/types.js';

/**
 * Minimal MCP (Model Context Protocol) server over stdio.
 *
 * Speaks newline-delimited JSON-RPC 2.0 as required by the MCP spec for
 * stdio transports. Only the surface this product needs is implemented; the
 * official SDK can replace it later if we outgrow it.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = '2025-06-18';

/** MCP stdio transport cap: messages larger than this are protocol garbage. */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

const SERVER_INFO = {
  name: 'module-graph-mcp',
  version: '0.1.0'
};

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * The smallest graph interface the tools need. IncrementalGraph satisfies it
 * structurally; tests substitute plain literals.
 */
export interface GraphSnapshotSource {
  snapshot(): GraphSnapshot;
  setNote(id: string, note: string | undefined): boolean;
  /** Ticket 12: store/clear the AI review state of one node. */
  setReview(id: string, review: AiReview | undefined): boolean;
}

function textToolResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): ToolResult;
}

export interface McpToolDeps {
  /**
   * Ticket 10: fan-out channel so report_note can push a node_update to
   * connected dashboards the moment the note lands.
   */
  broadcast?(event: GraphEvent): void;
  /**
   * Agent-driven test outcome (code-review 2026-08-29): the agent runs the
   * tests, so only it holds the real exit code. Fire-and-forget — the
   * pipeline owns the remap and the node_update broadcast; the tool reply
   * only confirms receipt.
   */
  reportTestRun?(failed: boolean): void;
  /**
   * Test seam for the source-read envelope; defaults to the real one so
   * production and HTTP share identical security semantics.
   */
  readSourceFile?(rootPath: string, requested: string): SourceReadResult;
}

/**
 * Suggest close node ids when a path argument does not match — the error
 * must tell the agent how to fix its own parameters (ticket 10 checklist 4).
 */
function suggestNodeIds(nodes: readonly ModuleNode[], badPath: string): string[] {
  const posix = badPath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  const base = posix.slice(posix.lastIndexOf('/') + 1);
  const stemOf = (p: string): string => {
    const dot = p.lastIndexOf('.');
    return dot > p.lastIndexOf('/') ? p.slice(0, dot) : p;
  };
  const badStem = stemOf(base);
  const scored: Array<{ id: string; score: number }> = [];
  for (const node of nodes) {
    let score = 0;
    if (node.id === posix) score = 100;
    else if (node.id.endsWith(posix) || posix.endsWith(node.id)) score = 80;
    else if (base.length > 0 && node.id.endsWith(`/${base}`)) score = 60;
    else if (badStem.length >= 3 && stemOf(node.id).endsWith(`/${badStem}`)) score = 55;
    else if (node.id.includes(posix) && posix.length >= 3) score = 40;
    if (score > 0) scored.push({ id: node.id, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((s) => s.id);
}

function notFoundResult(nodes: readonly ModuleNode[], rawPath: unknown): ToolResult {
  const shown = typeof rawPath === 'string' ? rawPath : String(rawPath);
  const suggestions = suggestNodeIds(nodes, shown);
  const lines = [
    `module not found: "${shown}"`,
    `the watched graph currently has ${nodes.length} module(s).`,
    'Path must be a POSIX path relative to the watched root, e.g. "src/index.ts".'
  ];
  if (suggestions.length > 0) lines.push(`did you mean: ${suggestions.join(', ')}?`);
  else lines.push('call get_module_graph to list all module ids first.');
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

// ---------------------------------------------------------------------------
// Ticket 12: AI review tooling. The agent is the executor — begin_review
// marks a module "checking" (edge pulse on the dashboard), update_review
// pushes partial verdicts while it works (rows paint line by line), and
// end_review stores the final three-color verdicts. Caps keep a runaway
// agent from flooding the wire or the DOM.
// ---------------------------------------------------------------------------

const AI_VERDICTS: readonly AiVerdict[] = ['confident', 'unsure', 'error'];
const MAX_VERDICT_ENTRIES = 500;
const MAX_VERDICT_MESSAGE = 200;
const MAX_REVIEW_SUMMARY = 500;
/**
 * Code-review 2026-08-29: a begin_review without its end_review leaves the
 * ball pulsing forever — the "checking" state would be lying. After this
 * long the server retires the checking state itself and tells the dashboard.
 */
const REVIEW_CHECKING_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Validate and normalise raw verdict entries: non-objects, bad lines and
 * unknown verdicts are dropped silently (a partial review beats none);
 * messages are truncated; per line the LAST entry wins; output is sorted by
 * line and capped at MAX_VERDICT_ENTRIES.
 */
function normalizeVerdicts(raw: unknown): AiReviewEntry[] {
  if (!Array.isArray(raw)) return [];
  const byLine = new Map<number, AiReviewEntry>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as { line?: unknown; verdict?: unknown; message?: unknown };
    if (typeof e.line !== 'number' || !Number.isInteger(e.line) || e.line < 1) continue;
    if (typeof e.verdict !== 'string' || !AI_VERDICTS.includes(e.verdict as AiVerdict)) continue;
    const entry: AiReviewEntry = { line: e.line, verdict: e.verdict as AiVerdict };
    if (typeof e.message === 'string' && e.message.trim().length > 0) {
      entry.message = e.message.trim().slice(0, MAX_VERDICT_MESSAGE);
    }
    byLine.set(entry.line, entry);
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line).slice(0, MAX_VERDICT_ENTRIES);
}

/**
 * Code-review 2026-08-29: fold one update_review batch into the pending
 * verdicts — on the same line the batch entry wins (the same last-wins rule
 * normalizeVerdicts applies within one batch); output stays line-sorted and
 * capped at MAX_VERDICT_ENTRIES.
 */
function mergeVerdicts(existing: AiReviewEntry[], batch: AiReviewEntry[]): AiReviewEntry[] {
  const byLine = new Map<number, AiReviewEntry>();
  for (const e of existing) byLine.set(e.line, e);
  for (const e of batch) byLine.set(e.line, e);
  return [...byLine.values()].sort((a, b) => a.line - b.line).slice(0, MAX_VERDICT_ENTRIES);
}

/**
 * Shared argument handling of the two path-taking tools (get_module_details,
 * report_note): validate `path`, normalise to a root-relative POSIX id and
 * resolve the node, with the guiding error results on every failure path.
 */
function resolveRequestedNode(
  args: Record<string, unknown>,
  snap: GraphSnapshot
): { node: ModuleNode } | { failure: ToolResult } {
  const rawPath = args.path;
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return {
      failure: {
        content: [{ type: 'text', text: 'path is required and must be a non-empty string, e.g. "src/index.ts".' }],
        isError: true
      }
    };
  }
  const posix = rawPath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  const node = snap.nodes.find((n) => n.id === posix);
  if (!node) return { failure: notFoundResult(snap.nodes, rawPath) };
  return { node };
}

export function buildTools(graph: GraphSnapshotSource, deps: McpToolDeps = {}): Record<string, ToolDef> {
  const readSource = deps.readSourceFile ?? readSourceFile;
  // node id → pending checking-timeout timer (code-review 2026-08-29).
  // Cleared by end_review and by a re-arm; the callback is a no-op unless
  // the node still carries the exact review object captured when the timer
  // was armed, so a rescan or a fresh begin disarms stale timers for free.
  const checkingTimers = new Map<string, NodeJS.Timeout>();
  const clearCheckingTimer = (id: string): void => {
    const timer = checkingTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      checkingTimers.delete(id);
    }
  };
  // (Re)arm the checking timeout for `checking`. BOTH begin_review and
  // update_review must arm it: update_review replaces node.aiReview with a
  // new checking object, which would otherwise silently disarm a timer that
  // captured the old object (the identity token no longer matches) and leave
  // the module stuck in checking forever.
  const armCheckingTimer = (id: string, path: string, checking: AiReview): void => {
    clearCheckingTimer(id);
    const timer = setTimeout(() => {
      checkingTimers.delete(id);
      const current = graph.snapshot().nodes.find((n) => n.id === id);
      if (current === undefined || current.aiReview !== checking) return;
      graph.setReview(id, undefined);
      deps.broadcast?.({ type: 'node_update', node: current });
      // After the paired node_update so the ticker shows the timeout.
      deps.broadcast?.({ type: 'review_timeout', id, path });
    }, REVIEW_CHECKING_TIMEOUT_MS);
    timer.unref?.(); // never keep the dashboard process alive for a dangling check
    checkingTimers.set(id, timer);
  };
  return {
    get_module_graph: {
      description:
        'Return the full module dependency graph of the watched repository: file-level nodes with their test/typecheck status and the import edges between them.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      execute() {
        const snap = graph.snapshot();
        return textToolResult({
          rootPath: snap.rootPath,
          generatedAt: snap.generatedAt,
          nodes: snap.nodes,
          edges: snap.edges
        });
      }
    },

    get_module_details: {
      description:
        'Return full details for ONE module: path, language, test state, coveredBy test files, type errors (line+code+message), last test run time, note, in/out edges, and the full source code text.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Module id: POSIX path relative to the watched root, e.g. "src/index.ts"'
          }
        },
        required: ['path'],
        additionalProperties: false
      },
      execute(args) {
        const snap = graph.snapshot();
        const found = resolveRequestedNode(args, snap);
        if ('failure' in found) return found.failure;
        const node = found.node;

        const outgoing = snap.edges.filter((e) => e.from === node.id).map((e) => e.to);
        const incoming = snap.edges.filter((e) => e.to === node.id).map((e) => e.from);
        const source = readSource(snap.rootPath, node.id);

        return textToolResult({
          id: node.id,
          path: node.path,
          language: node.language,
          testState: node.testState,
          coveredBy: node.coveredBy,
          typeErrors: node.typeErrors,
          lastTestRunAt: node.lastTestRunAt ?? null,
          note: node.note ?? null,
          aiReview: node.aiReview ?? null,
          outgoingDependencies: outgoing,
          incomingDependents: incoming,
          source:
            source.ok
              ? {
                  path: source.path,
                  sizeBytes: source.sizeBytes,
                  content: source.content,
                  truncated: source.truncated === true
                }
              : { error: `${source.reason} (${source.detail})` }
        });
      }
    },

    list_untested: {
      description:
        'List every module currently in the untested state (no coverage data and no test file by naming convention). Returns ids plus a summary count.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      execute() {
        const snap = graph.snapshot();
        const untested = snap.nodes
          .filter((n) => n.testState === 'untested')
          .map((n) => ({ id: n.id, language: n.language }));
        return textToolResult({
          totalModules: snap.nodes.length,
          untestedCount: untested.length,
          modules: untested
        });
      }
    },

    report_note: {
      description:
        'Attach a free-form note to a module (max 2000 chars). The note appears live in the dashboard detail panel for that node. Pass an empty text to clear the note.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Module id: POSIX path relative to the watched root, e.g. "src/index.ts"'
          },
          text: {
            type: 'string',
            description: 'Note text (max 2000 chars). Empty string clears the note.'
          }
        },
        required: ['path', 'text'],
        additionalProperties: false
      },
      execute(args) {
        const snap = graph.snapshot();
        const found = resolveRequestedNode(args, snap);
        if ('failure' in found) return found.failure;
        const node = found.node;

        if (typeof args.text !== 'string') {
          return {
            content: [{ type: 'text', text: 'text is required and must be a string (empty string clears the note).' }],
            isError: true
          };
        }

        const text = args.text.trim().slice(0, 2000);
        const previous = node.note;
        graph.setNote(node.id, text.length > 0 ? text : undefined);
        if (node.note !== previous) {
          deps.broadcast?.({ type: 'node_update', node });
        }
        return textToolResult({
          ok: true,
          id: node.id,
          note: node.note ?? null,
          cleared: node.note === undefined
        });
      }
    },

    begin_review: {
      description:
        'Mark a module as "AI reviewing". The dashboard ball gets an animated edge pulse and its detail panel shows a checking state until end_review lands for the same path. Call this right before you start reviewing/editing a file; while checking, push partial findings with update_review, and always pair the begin with an end_review.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Module id: POSIX path relative to the watched root, e.g. "src/index.ts"'
          }
        },
        required: ['path'],
        additionalProperties: false
      },
      execute(args) {
        const snap = graph.snapshot();
        const found = resolveRequestedNode(args, snap);
        if ('failure' in found) return found.failure;
        const node = found.node;

        const checking: AiReview = { status: 'checking', verdicts: [] };
        graph.setReview(node.id, checking);
        armCheckingTimer(node.id, node.path, checking);
        deps.broadcast?.({ type: 'node_update', node });
        return textToolResult({
          ok: true,
          id: node.id,
          aiReview: node.aiReview ?? null
        });
      }
    },

    update_review: {
      description:
        'Push PARTIAL per-line verdicts while a review is still checking (after begin_review, before end_review): the dashboard paints the reported rows live, line by line. Verdicts merge into the pending review — on the same line the new entry wins. Optional, but recommended for long files so the user sees progress; end_review finishes the review.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Module id: POSIX path relative to the watched root, e.g. "src/index.ts"'
          },
          verdicts: {
            type: 'array',
            description:
              'Per-line verdicts found so far: { line: 1-based number, verdict: "confident"|"unsure"|"error", message?: string (max 200 chars) }',
            items: {
              type: 'object',
              properties: {
                line: { type: 'number' },
                verdict: { type: 'string', enum: [...AI_VERDICTS] },
                message: { type: 'string' }
              },
              required: ['line', 'verdict'],
              additionalProperties: false
            }
          }
        },
        required: ['path', 'verdicts'],
        additionalProperties: false
      },
      execute(args) {
        const snap = graph.snapshot();
        const found = resolveRequestedNode(args, snap);
        if ('failure' in found) return found.failure;
        const node = found.node;

        if (!Array.isArray(args.verdicts)) {
          return {
            content: [{ type: 'text', text: 'verdicts is required and must be an array (possibly empty).' }],
            isError: true
          };
        }
        const pending = node.aiReview;
        if (pending === undefined || pending.status !== 'checking') {
          return {
            content: [{ type: 'text', text: 'no review in progress for this module — call begin_review first.' }],
            isError: true
          };
        }

        // A fresh checking object per update: setReview swaps node.aiReview,
        // which would go stale against the pending timer's identity token —
        // armCheckingTimer re-binds the timeout to the new object.
        const checking: AiReview = {
          status: 'checking',
          verdicts: mergeVerdicts(pending.verdicts, normalizeVerdicts(args.verdicts))
        };
        graph.setReview(node.id, checking);
        armCheckingTimer(node.id, node.path, checking);
        deps.broadcast?.({ type: 'node_update', node });
        return textToolResult({
          ok: true,
          id: node.id,
          verdictCount: checking.verdicts.length,
          aiReview: node.aiReview ?? null
        });
      }
    },

    end_review: {
      description:
        'Finish the AI review of a module: store per-line verdicts (confident / unsure / error, max 500 entries, last entry per line wins) plus an optional one-line summary. The dashboard stops the checking pulse and renders green/amber/red row highlights live. Verdicts are in-memory; a rescan clears them and you re-report.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Module id: POSIX path relative to the watched root, e.g. "src/index.ts"'
          },
          verdicts: {
            type: 'array',
            description:
              'Per-line verdicts: { line: 1-based number, verdict: "confident"|"unsure"|"error", message?: string (max 200 chars) }',
            items: {
              type: 'object',
              properties: {
                line: { type: 'number' },
                verdict: { type: 'string', enum: [...AI_VERDICTS] },
                message: { type: 'string' }
              },
              required: ['line', 'verdict'],
              additionalProperties: false
            }
          },
          summary: {
            type: 'string',
            description: 'Optional one-line overall conclusion (max 500 chars).'
          }
        },
        required: ['path', 'verdicts'],
        additionalProperties: false
      },
      execute(args) {
        const snap = graph.snapshot();
        const found = resolveRequestedNode(args, snap);
        if ('failure' in found) return found.failure;
        const node = found.node;

        if (!Array.isArray(args.verdicts)) {
          return {
            content: [{ type: 'text', text: 'verdicts is required and must be an array (possibly empty).' }],
            isError: true
          };
        }
        const verdicts = normalizeVerdicts(args.verdicts);
        const summary =
          typeof args.summary === 'string' && args.summary.trim().length > 0
            ? args.summary.trim().slice(0, MAX_REVIEW_SUMMARY)
            : undefined;

        clearCheckingTimer(node.id);
        const review: AiReview = { status: 'done', verdicts, reviewedAt: Date.now() };
        if (summary !== undefined) review.summary = summary;
        graph.setReview(node.id, review);
        deps.broadcast?.({ type: 'node_update', node });
        return textToolResult({
          ok: true,
          id: node.id,
          verdictCount: verdicts.length,
          aiReview: node.aiReview ?? null
        });
      }
    },

    report_test_run: {
      description:
        'Report the outcome of the test run you just executed. failed=true marks the run as failing: files present in the coverage report turn red on the dashboard; failed=false turns them back green. Call this after every test run so the map reflects the real last run.',
      inputSchema: {
        type: 'object',
        properties: {
          failed: {
            type: 'boolean',
            description: 'true = the run had failures, false = clean run'
          }
        },
        required: ['failed'],
        additionalProperties: false
      },
      execute(args) {
        if (typeof args.failed !== 'boolean') {
          return {
            content: [{ type: 'text', text: 'failed is required and must be a boolean (true = failing run).' }],
            isError: true
          };
        }
        if (deps.reportTestRun === undefined) {
          return textToolResult({ ok: true, failed: args.failed, note: 'no state pipeline wired; flag not applied' });
        }
        deps.reportTestRun(args.failed);
        return textToolResult({ ok: true, failed: args.failed, note: 'coverage remap triggered' });
      }
    }
  };
}

export class McpStdioServer {
  private buffer = '';
  private readonly tools: Record<string, ToolDef>;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly logger: (msg: string) => void,
    graph: GraphSnapshotSource,
    deps: McpToolDeps = {}
  ) {
    this.tools = buildTools(graph, deps);
  }

  /** Start consuming stdin; resolves when stdin closes. */
  serve(): Promise<void> {
    return new Promise((resolve, reject) => {
      // StringDecoder keeps multi-byte UTF-8 characters intact when stdin
      // delivers them split across chunks (plain toString() would corrupt
      // them into replacement characters and the JSON line would be lost).
      const decoder = new StringDecoder('utf8');
      const onData = (chunk: Buffer | string): void => {
        this.buffer += decoder.write(chunk);
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line.length === 0) continue;
          if (line.length > MAX_MESSAGE_BYTES) {
            fail(`message of ${line.length} bytes exceeds the ${MAX_MESSAGE_BYTES}-byte stdio limit`);
            return;
          }
          this.handleLine(line);
        }
        // No newline in sight and the buffer keeps growing: garbage stream.
        if (this.buffer.length > MAX_MESSAGE_BYTES) {
          fail(`buffered input exceeds the ${MAX_MESSAGE_BYTES}-byte stdio limit without a newline`);
        }
      };
      const onEnd = (): void => resolve();
      const onError = (err: Error): void => reject(err);
      const fail = (message: string): void => {
        this.input.off('data', onData);
        this.input.off('end', onEnd);
        this.input.off('error', onError);
        reject(new Error(`mcp: ${message} — closing stdio transport`));
      };
      this.input.on('data', onData);
      this.input.on('end', onEnd);
      this.input.on('error', onError);
    });
  }

  private handleLine(line: string): void {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.logger(`mcp: dropping unparseable line (${line.slice(0, 80)})`);
      return;
    }

    const hasId = msg.id !== undefined && msg.id !== null;

    try {
      switch (msg.method) {
        case 'initialize':
          if (!hasId) return;
          this.reply(msg.id!, {
            protocolVersion:
              typeof msg.params?.protocolVersion === 'string'
                ? (msg.params.protocolVersion as string)
                : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO
          });
          return;
        case 'notifications/initialized':
          return; // notification: no reply
        case 'ping':
          if (!hasId) return;
          this.reply(msg.id!, {});
          return;
        case 'tools/list':
          if (!hasId) return;
          this.reply(msg.id!, {
            tools: Object.entries(this.tools).map(([name, def]) => ({
              name,
              description: def.description,
              inputSchema: def.inputSchema
            }))
          });
          return;
        case 'tools/call': {
          if (!hasId) return;
          const name = msg.params?.name;
          // Object.hasOwn keeps prototype keys (__proto__, constructor, …)
          // out of the lookup: they must report Unknown tool, not blow up
          // into an Internal error.
          const tool = typeof name === 'string' && Object.hasOwn(this.tools, name) ? this.tools[name] : undefined;
          if (!tool) {
            this.errorReply(msg.id!, -32602, `Unknown tool: ${String(name)}`);
            return;
          }
          const args =
            msg.params?.arguments && typeof msg.params.arguments === 'object'
              ? (msg.params.arguments as Record<string, unknown>)
              : {};
          this.reply(msg.id!, tool.execute(args));
          return;
        }
        default:
          if (hasId) this.errorReply(msg.id!, -32601, `Method not found: ${msg.method}`);
          this.logger(`mcp: unhandled method ${msg.method}`);
      }
    } catch (err) {
      this.logger(`mcp: handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (hasId) this.errorReply(msg.id!, -32603, 'Internal error');
    }
  }

  private reply(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private errorReply(id: string | number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(res: JsonRpcResponse): void {
    this.output.write(`${JSON.stringify(res)}\n`);
  }
}
