import { StringDecoder } from 'node:string_decoder';
import { readSourceFile, type SourceReadResult } from './source-reader.js';
import { AI_VERDICTS, createReviewLifecycle } from './review-lifecycle.js';
import { VERSION } from './version.js';
import type { AiReview, GraphEvent, GraphSnapshot, ModuleNode } from '../shared/types.js';

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

/**
 * Only versions this server actually implements. A client asking for an
 * unsupported version gets PROTOCOL_VERSION back — never an echo of a
 * version we cannot speak.
 */
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION];

/** MCP stdio transport cap: messages larger than this are protocol garbage. */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

const SERVER_INFO = {
  name: 'module-graph-mcp',
  version: VERSION
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
  /**
   * Plugin-mode discovery (code-review 2026-08-29): lets get_dashboard_info
   * hand the agent the dashboard URL and the watched root, so a wrong-root
   * spawn is visible immediately and the user can be handed the link.
   */
  httpInfo?(): { url: string; port: number; rootPath: string; version: string };
  /**
   * Popup policy (code-review 2026-08-29): the first tools/call of a session
   * is the signal that this project is actually being worked on — the wired
   * callback opens the dashboard (fired once per process, before the tool
   * runs). Handshake-time methods deliberately do not count: initialize and
   * tools/list already happen when a desktop client restores every project
   * at app open, so counting them would pop N tabs at launch.
   */
  onFirstToolCall?(): void;
  /**
   * False while the startup baseline scan is still running (wired by
   * index.ts). get_module_graph annotates its reply so an agent reading the
   * graph during the scan knows the node list is partial, not empty.
   */
  isBaselineDone?(): boolean;
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
// end_review stores the final three-color verdicts. The pairing discipline,
// verdict cleaning, the checking timeout and the event order live in
// review-lifecycle.ts; these tools only validate arguments and shape replies.
// ---------------------------------------------------------------------------

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
  const lifecycle = createReviewLifecycle({ graph, broadcast: deps.broadcast });
  return {
    get_dashboard_info: {
      description:
        'Return dashboard connection info: the browser URL of the live module-graph dashboard, the watched repository root, and current node/edge counts. Call this once per session to verify the server watches the tree you are working in, and to hand the user the dashboard link.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      execute() {
        const snap = graph.snapshot();
        const info = deps.httpInfo?.();
        if (info === undefined) {
          return textToolResult({
            rootPath: snap.rootPath,
            nodeCount: snap.nodes.length,
            edgeCount: snap.edges.length,
            note: 'dashboard not wired in this deployment'
          });
        }
        return textToolResult({
          dashboardUrl: info.url,
          port: info.port,
          rootPath: info.rootPath,
          version: info.version,
          nodeCount: snap.nodes.length,
          edgeCount: snap.edges.length,
          ...(deps.isBaselineDone?.() === false ? { scanning: true } : {})
        });
      }
    },

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
        // Plugin mode: the handshake must never wait for the baseline scan,
        // so an early call lands mid-scan — say so instead of presenting an
        // empty graph as fact.
        const scanning = deps.isBaselineDone?.() === false;
        return textToolResult({
          rootPath: snap.rootPath,
          generatedAt: snap.generatedAt,
          ...(scanning
            ? { scanning: true, note: 'baseline scan still in progress — node list is partial; retry shortly' }
            : {}),
          nodes: snap.nodes,
          edges: snap.edges
        });
      }
    },

    get_module_details: {
      description:
        'Return full details for ONE module: path, language, test state, coveredBy test files, type errors (line+code+message), last test run time, note, in/out edges, and the full source code text. Every read briefly lights that module ball on the dashboard, so the user can see which file you are looking at.',
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

        // Code-review 2026-08-29: exploration is now visible. A pure read used
        // to produce zero dashboard activity — the ball only ever pulsed for
        // begin_review — so an agent browsing files looked invisible to the
        // user. The transient `viewing` pulse needs no pairing cleanup.
        deps.broadcast?.({ type: 'module_activity', id: node.id, path: node.path, activity: 'viewing', at: Date.now() });

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

        const { checking } = lifecycle.begin(node.id, node.path);
        return textToolResult({
          ok: true,
          id: node.id,
          aiReview: checking
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
        const outcome = lifecycle.update(node.id, node.path, args.verdicts);
        if (!outcome.ok) {
          return {
            content: [{ type: 'text', text: 'no review in progress for this module — call begin_review first.' }],
            isError: true
          };
        }
        return textToolResult({
          ok: true,
          id: node.id,
          verdictCount: outcome.verdictCount,
          aiReview: outcome.checking
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
        const { done, verdictCount } = lifecycle.end(node.id, args.verdicts, args.summary);
        return textToolResult({
          ok: true,
          id: node.id,
          verdictCount,
          aiReview: done
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
  /**
   * Tools whose answers depend on graph CONTENT (code-review 2026-08-29).
   * Plugin mode serves before the baseline scan finishes, and an agent's
   * first begin_review would otherwise hit "module not found" through no
   * fault of its own — these wait (bounded) for the baseline instead.
   * Self-describing tools (get_dashboard_info, get_module_graph) answer
   * immediately with their scanning annotation, and report_test_run is
   * content-independent.
   */
  private static readonly BASELINE_GATED = new Set([
    'get_module_details',
    'list_untested',
    'report_note',
    'begin_review',
    'update_review',
    'end_review'
  ]);

  private buffer = '';
  private readonly tools: Record<string, ToolDef>;
  private readonly deps: McpToolDeps;
  private firstToolCallFired = false;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly logger: (msg: string) => void,
    graph: GraphSnapshotSource,
    deps: McpToolDeps = {}
  ) {
    this.tools = buildTools(graph, deps);
    this.deps = deps;
  }

  /** Start consuming stdin; resolves when stdin closes. */
  serve(): Promise<void> {
    return new Promise((resolve, reject) => {
      // StringDecoder keeps multi-byte UTF-8 characters intact when stdin
      // delivers them split across chunks (plain toString() would corrupt
      // them into replacement characters and the JSON line would be lost).
      const decoder = new StringDecoder('utf8');
      // Oversized input must never kill the process. An over-limit line (or
      // newline-less flood) is dropped with at most ONE -32600 per episode;
      // the episode ends when a healthy line goes through again.
      let skipping = false;
      let overLimitReplied = false;
      const overLimit = (bytes: number): void => {
        if (overLimitReplied) return;
        overLimitReplied = true;
        const mb = Math.floor(MAX_MESSAGE_BYTES / (1024 * 1024));
        this.logger(`mcp: dropped stdio message of ${bytes} bytes (limit ${mb} MB)`);
        this.errorReply(
          null,
          -32600,
          `stdio message of ${bytes} bytes exceeds the ${mb} MB stdio limit — line dropped`
        );
      };
      const onData = (chunk: Buffer | string): void => {
        this.buffer += decoder.write(chunk);
        if (skipping) {
          const end = this.buffer.indexOf('\n');
          if (end === -1) {
            this.buffer = '';
            return;
          }
          this.buffer = this.buffer.slice(end + 1);
          skipping = false;
        }
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line.length === 0) continue;
          const bytes = Buffer.byteLength(line, 'utf8');
          if (bytes > MAX_MESSAGE_BYTES) {
            overLimit(bytes);
            continue;
          }
          overLimitReplied = false;
          this.handleLine(line);
        }
        // No newline in sight and the buffer keeps growing: garbage stream.
        // Drop it and skip input until the next newline so the buffer cannot
        // re-bloat.
        const buffered = Buffer.byteLength(this.buffer, 'utf8');
        if (buffered > MAX_MESSAGE_BYTES) {
          overLimit(buffered);
          this.buffer = '';
          skipping = true;
        }
      };
      const onEnd = (): void => resolve();
      const onError = (err: Error): void => reject(err);
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
      this.errorReply(null, -32700, 'Parse error: invalid JSON');
      return;
    }
    // JSON.parse("null") yields null, and reading .id off it would throw
    // inside this data handler — an uncaught kill. Reply as invalid request.
    if (msg === null || typeof msg !== 'object') {
      this.logger(`mcp: dropping non-object JSON line (${line.slice(0, 80)})`);
      this.errorReply(null, -32600, 'Invalid Request: expected a JSON-RPC 2.0 message object');
      return;
    }

    const hasId = msg.id !== undefined && msg.id !== null;

    try {
      switch (msg.method) {
        case 'initialize': {
          if (!hasId) return;
          const requested = msg.params?.protocolVersion;
          this.reply(msg.id!, {
            protocolVersion:
              typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO
          });
          return;
        }
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
          // Dispatch is async (the baseline gate may hold the reply); JSON-RPC
          // allows responses to leave in completion order.
          void this.callTool(msg.id!, String(name), tool, args);
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

  private async callTool(id: string | number, name: string, tool: ToolDef, args: Record<string, unknown>): Promise<void> {
    // Only reached for known tools (unknown names error out in handleLine),
    // so a flood of garbage calls never counts as session activity.
    if (!this.firstToolCallFired) {
      this.firstToolCallFired = true;
      this.deps.onFirstToolCall?.();
    }
    try {
      await this.awaitBaseline(name);
      this.reply(id, tool.execute(args));
    } catch (err) {
      this.logger(`mcp: handler error: ${err instanceof Error ? err.message : String(err)}`);
      this.errorReply(id, -32603, 'Internal error');
    }
  }

  /**
   * Bounded wait for the startup baseline when `name` reads graph content.
   * Past the cap the tool runs against the partial graph anyway — the
   * self-explaining errors guide the agent to retry — so a slow scan can
   * never wedge a request.
   */
  private awaitBaseline(name: string): Promise<void> {
    if (this.deps.isBaselineDone?.() !== false || !McpStdioServer.BASELINE_GATED.has(name)) {
      return Promise.resolve();
    }
    const WAIT_CAP_MS = 20_000;
    const started = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (this.deps.isBaselineDone?.() !== false || Date.now() - started >= WAIT_CAP_MS) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }

  private reply(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private errorReply(id: string | number | null, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(res: JsonRpcResponse): void {
    this.output.write(`${JSON.stringify(res)}\n`);
  }
}
