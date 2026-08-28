import { StringDecoder } from 'node:string_decoder';
import { readSourceFile, type SourceReadResult } from './source-reader.js';
import type { GraphEvent, GraphSnapshot, ModuleNode } from '../shared/types.js';

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
          outgoingDependencies: outgoing,
          incomingDependents: incoming,
          source:
            source.ok
              ? { path: source.path, sizeBytes: source.sizeBytes, content: source.content }
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
