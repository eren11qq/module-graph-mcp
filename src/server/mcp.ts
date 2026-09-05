import { StringDecoder } from 'node:string_decoder';
import { readSourceFile, type SourceReadResult } from './source-reader.js';
import {
  AI_VERDICTS,
  createReviewLifecycle,
  MAX_REVIEW_SUMMARY,
  MAX_VERDICT_ENTRIES,
  MAX_VERDICT_MESSAGE
} from './review-lifecycle.js';
import type { ReviewStore } from './review-store.js';
import { buildHealthReport } from './health-report.js';
import {
  CHANGE_IMPACT_HEURISTICS,
  computeImpact,
  createGraphStats,
  IMPACT_DIRECTIONS,
  scoreChanges,
  type ImpactDirection
} from './impact.js';
import type { RecentChanges } from './recent-changes.js';
import {
  createEditScopeStore,
  isInScope,
  normalizeFilePath,
  VALID_MODULE_IDS,
  verifyEdits,
  type EditScopeStore
} from './edit-scope.js';
import { filesInModule, FUNCTIONAL_MODULES } from '../shared/module-table.js';
import { applyTokenBudget } from './response-budget.js';
import { VERSION } from './version.js';
import type { AiReview, EditScopeDecl, GraphEvent, GraphSnapshot, ModuleNode } from '../shared/types.js';

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

/** 统一错误信封：一条 text + isError——所有失败路径共用,不再手搓字面量。 */
function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** 读字符串数组参数:非数组视为空,非字符串元素静默丢弃。 */
function readStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

export interface ToolDef {
  /**
   * 策略元数据(架构评审第二轮 #7):注册表即名单,三张消费名单全部从这里派生。
   * `mutating` — 写数据、改图状态的工具,read-only 模式下必须隐藏并以审计错误
   * 拒答;`contentDependent` — 答案依赖图内容的工具,基线扫描完成前有界等待
   * (plugin 模式下先答 = "module not found" 冤案)。免闸门的只有自描述类
   * (get_dashboard_info / get_module_graph)与 report_test_run(只带退出码,
   * 不读图)。新增工具漏登记任何一 bit = 编译红。
   */
  mutating: boolean;
  contentDependent: boolean;
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
   * Popup policy (file-granular): fired whenever a tool successfully opens a
   * specific module — get_module_details, report_note, begin_review,
   * update_review, end_review. index.ts owns the dedup: at most one popup
   * per distinct file, and files the agent never opens never pop.
   * Handshake-time methods and file-less tools (get_dashboard_info,
   * get_module_graph, get_health_report, list_untested, report_test_run)
   * deliberately do not fire, and neither do the analysis tools (get_impact,
   * get_change_impact): analysis is not "opening a file", and a pre-edit
   * blast-radius check is high-frequency — popping for it would noise the
   * user's desktop.
   */
  onFileActivity?(id: string): void;
  /**
   * False while the startup baseline scan is still running (wired by
   * index.ts). get_module_graph annotates its reply so an agent reading the
   * graph during the scan knows the node list is partial, not empty.
   */
  isBaselineDone?(): boolean;
  /**
   * GitNexus port: the recent-changes record fed by the live-reload
   * pipeline; get_change_impact replays it as the change evidence chain.
   * Absent (bare buildTools tests) → the tool reports an empty chain with a
   * note instead of failing.
   */
  recentChanges?: RecentChanges;
  /**
   * GitNexus port: default response-token budget, parsed from
   * MODULE_GRAPH_MCP_DEFAULT_MAX_TOKENS and validated LOUDLY in index.ts.
   * A per-call `arguments._maxTokens` (positive integer) overrides it;
   * neither set → replies pass through unbudgeted.
   */
  defaultMaxTokens?: number;
  /**
   * 常驻: persistent AI-review store — end_review lands the done review
   * here so it survives restarts. Absent → in-memory only (tests).
   */
  reviewStore?: ReviewStore;
  /**
   * GitNexus port: read-only mode (MODULE_GRAPH_MCP_READ_ONLY=1, parsed in
   * index.ts). buildTools skips registering the seven mutation tools — so
   * tools/list hides them — and the transport answers their tools/call with
   * a dedicated audit-friendly error instead of "Unknown tool".
   */
  readOnly?: boolean;
}

/**
 * Suggest close node ids when a path argument does not match — the error
 * must tell the agent how to fix its own parameters (ticket 10 checklist 4).
 */
function suggestNodeIds(nodes: readonly ModuleNode[], badPath: string): string[] {
  const posix = normalizeFilePath(badPath);
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
  return errorResult(lines.join('\n'));
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
 * The review playbook, embedded verbatim in every begin_review reply
 * (trust-loop roadmap PR-5): stable, assertion-friendly text that teaches
 * the agent the three-color verdict vocabulary, the update cadence and the
 * begin/end pairing rule. The section headers are part of the contract —
 * the playbook-present evals probe asserts them byte-for-byte; edit only
 * with the probe (and CLAUDE.md) in the same change. The budget numbers are
 * interpolated from review-lifecycle (候选 #10): retyping them here would
 * fork the contract — the probe asserts the interpolated phrasing, so a
 * hardcoded re-introduction trips it.
 */
const REVIEW_PLAYBOOK = [
  '## Review playbook',
  '### Verdicts',
  '- confident: the code is correct as-is; nothing to fix.',
  '- unsure: a suspicion you cannot confirm — say what to check and why.',
  '- error: a concrete defect — name the line and the failure it causes.',
  '### Cadence',
  '- begin_review marks the module checking; the dashboard ball pulses.',
  '- update_review pushes partial verdicts in batches while you read; on the same line the new entry wins, so dashboard rows paint live.',
  `- end_review lands the final verdicts (max ${MAX_VERDICT_ENTRIES} entries, last entry per line wins; message max ${MAX_VERDICT_MESSAGE} chars).`,
  '### Closure',
  '- ALWAYS pair a begin_review with an end_review for the same path — an empty verdicts array means "reviewed, all clear".',
  `- Include a one-line summary (max ${MAX_REVIEW_SUMMARY} chars) so the dashboard detail panel can show the conclusion.`,
  '- Verdicts persist on disk: a server restart keeps them (re-review only when the code changes).'
].join('\n');

/** report_note 的备注长度上限(候选 #10):描述文本与工具体 slice 共用此常数。 */
const MAX_NOTE_LENGTH = 2000;

/** update_review / end_review 共用守卫句——同一字节串,单一来源(探针盯文本)。 */
const VERDICTS_ARRAY_ERROR = 'verdicts is required and must be an array (possibly empty).';

/** declare_edit_scope 的 inScopeFiles 展开上限:大仓库不封顶会挤爆回复;计数保持精确。 */
const EDIT_SCOPE_EXPAND_CAP = 200;

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
    return { failure: errorResult('path is required and must be a non-empty string, e.g. "src/index.ts".') };
  }
  const posix = normalizeFilePath(rawPath);
  const node = snap.nodes.find((n) => n.id === posix);
  if (!node) return { failure: notFoundResult(snap.nodes, rawPath) };
  return { node };
}

// 变更证据链的风险判定与启发式文本已迁入 impact.ts(scoreChanges /
// CHANGE_IMPACT_HEURISTICS,候选 #6)——域数学住图数学模块,MCP 层只整形。

export function buildTools(graph: GraphSnapshotSource, deps: McpToolDeps = {}): Record<string, ToolDef> {
  const readSource = deps.readSourceFile ?? readSourceFile;
  const lifecycle = createReviewLifecycle({ graph, broadcast: deps.broadcast });
  // Graph stats memo shared by get_module_details (context) and
  // get_change_impact (risk heuristic): recomputed only when the snapshot's
  // generatedAt moves. One factory instance per buildTools call = one graph.
  const statsFor = createGraphStats(() => graph.snapshot());
  // ADR 0002 §7.2: 会话级编辑范围（declare_edit_scope 覆盖旧声明；重启即清）。
  const editScopeStore: EditScopeStore = createEditScopeStore();
  const tools: Record<string, ToolDef> = {
    get_dashboard_info: {
      mutating: false,
      contentDependent: false,
      description:
        'Return dashboard connection info: the browser URL of the live module-graph dashboard, the watched repository root, and current node/edge counts. Call this once per session to verify the server watches the tree you are working in, and to hand the user the dashboard link.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      execute() {
        const snap = graph.snapshot();
        // ADR 0002 §7.1: 模块表（模块名 + 路径清单）随 get_dashboard_info 交
        // 给 agent —— declare_edit_scope 的 modules 从这里取合法 id。
        const nodeIds = snap.nodes.map((n) => n.id);
        const modules = FUNCTIONAL_MODULES.map((m) => ({
          id: m.id,
          label: m.label,
          files: filesInModule(nodeIds, m.id)
        }));
        const info = deps.httpInfo?.();
        if (info === undefined) {
          return textToolResult({
            rootPath: snap.rootPath,
            nodeCount: snap.nodes.length,
            edgeCount: snap.edges.length,
            modules,
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
          modules,
          ...(deps.isBaselineDone?.() === false ? { scanning: true } : {})
        });
      }
    },

    get_module_graph: {
      mutating: false,
      contentDependent: false,
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
      mutating: false,
      contentDependent: true,
      description:
        'Return full details for ONE module: path, language, test state, coveredBy test files, type errors (line+code+message), last test run time, note, in/out edges, context stats (in/out degree, cycle membership, normalized centrality — derived fresh per call, never stale), and the full source code text. Every read briefly lights that module ball on the dashboard, so the user can see which file you are looking at.',
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
        deps.onFileActivity?.(node.id);

        // Code-review 2026-08-29: exploration is now visible. A pure read used
        // to produce zero dashboard activity — the ball only ever pulsed for
        // begin_review — so an agent browsing files looked invisible to the
        // user. The transient `viewing` pulse needs no pairing cleanup.
        deps.broadcast?.({ type: 'module_activity', id: node.id, path: node.path, activity: 'viewing', at: Date.now() });

        const outgoing = snap.edges.filter((e) => e.from === node.id).map((e) => e.to);
        const incoming = snap.edges.filter((e) => e.to === node.id).map((e) => e.from);
        const source = readSource(snap.rootPath, node.id);
        const stats = statsFor();

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
          context: {
            inDegree: stats.inDegree.get(node.id) ?? 0,
            outDegree: stats.outDegree.get(node.id) ?? 0,
            inCycle: stats.inCycle.has(node.id),
            centrality: stats.centrality(node.id)
          },
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
      mutating: false,
      contentDependent: true,
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
      mutating: true,
      contentDependent: true,
      description:
        `Attach a free-form note to a module (max ${MAX_NOTE_LENGTH} chars). The note appears live in the dashboard detail panel for that node. Pass an empty text to clear the note.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Module id: POSIX path relative to the watched root, e.g. "src/index.ts"'
          },
          text: {
            type: 'string',
            description: `Note text (max ${MAX_NOTE_LENGTH} chars). Empty string clears the note.`
          },
          note: {
            type: 'string',
            description: 'Alias for `text` (the tool is named report_note, so callers often guess `note`). When both are given, `text` wins.'
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
        deps.onFileActivity?.(node.id);

        const body = typeof args.text === 'string' ? args.text : args.note;
        if (typeof body !== 'string') {
          return errorResult('text is required and must be a string (empty string clears the note). `note` is accepted as an alias.');
        }

        const text = body.trim().slice(0, MAX_NOTE_LENGTH);
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
      mutating: true,
      contentDependent: true,
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
        deps.onFileActivity?.(node.id);

        const { checking } = lifecycle.begin(node.id, node.path);
        return textToolResult({
          ok: true,
          id: node.id,
          aiReview: checking,
          playbook: REVIEW_PLAYBOOK
        });
      }
    },

    update_review: {
      mutating: true,
      contentDependent: true,
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
              `Per-line verdicts found so far: { line: 1-based number, verdict: "confident"|"unsure"|"error", message?: string (max ${MAX_VERDICT_MESSAGE} chars) }`,
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
        deps.onFileActivity?.(node.id);

        if (!Array.isArray(args.verdicts)) return errorResult(VERDICTS_ARRAY_ERROR);
        const outcome = lifecycle.update(node.id, node.path, args.verdicts);
        if (!outcome.ok) return errorResult('no review in progress for this module — call begin_review first.');
        return textToolResult({
          ok: true,
          id: node.id,
          verdictCount: outcome.verdictCount,
          aiReview: outcome.checking
        });
      }
    },

    end_review: {
      mutating: true,
      contentDependent: true,
      description:
        `Finish the AI review of a module: store per-line verdicts (confident / unsure / error, max ${MAX_VERDICT_ENTRIES} entries, last entry per line wins) plus an optional one-line summary. The dashboard stops the checking pulse and renders green/amber/red row highlights live. Verdicts persist on disk (.module-graph/reviews.json): they survive restarts, so a re-review is only needed when the code changed.`,
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
              `Per-line verdicts: { line: 1-based number, verdict: "confident"|"unsure"|"error", message?: string (max ${MAX_VERDICT_MESSAGE} chars) }`,
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
            description: `Optional one-line overall conclusion (max ${MAX_REVIEW_SUMMARY} chars).`
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
        deps.onFileActivity?.(node.id);

        if (!Array.isArray(args.verdicts)) return errorResult(VERDICTS_ARRAY_ERROR);
        const { done, verdictCount } = lifecycle.end(node.id, args.verdicts, args.summary);
        // 常驻: the completed conclusion is the one durable trace — persist it
        // (begin/update stay transient; an interrupted re-review keeps the
        // last completed end_review instead of erasing it).
        deps.reviewStore?.set(node.id, done);
        return textToolResult({
          ok: true,
          id: node.id,
          verdictCount,
          aiReview: done
        });
      }
    },

    report_test_run: {
      mutating: true,
      contentDependent: false,
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
          return errorResult('failed is required and must be a boolean (true = failing run).');
        }
        if (deps.reportTestRun === undefined) {
          return textToolResult({ ok: true, failed: args.failed, note: 'no state pipeline wired; flag not applied' });
        }
        deps.reportTestRun(args.failed);
        return textToolResult({ ok: true, failed: args.failed, note: 'coverage remap triggered' });
      }
    },

    // -----------------------------------------------------------------------
    // ADR 0002 §7.2: 改动核对工具对。declare_edit_scope 开工前声明边界；
    // report_edits 改完后上报实际改动；服务端用模块表展开范围 + watcher
    // 磁盘事实交叉验证——越界与漏报都判红，核对不靠 AI 自觉。
    // -----------------------------------------------------------------------

    declare_edit_scope: {
      mutating: true,
      contentDependent: false,
      description:
        'Declare your edit scope BEFORE you start editing: the functional modules (ids from get_dashboard_info.modules) and/or explicit files you plan to touch. The server checks every later report_edits against this boundary — a file outside it is an out-of-scope edit (red on the dashboard), and the watcher record catches files you changed but never reported. Each successful declaration stamps a baseline moment: watcher evidence changed before it (leftovers from earlier sessions) is reported as preexisting instead of being judged against you. A new declaration replaces the old one; the scope is session-level and cleared on restart. Pass an empty object to clear the scope.',
      inputSchema: {
        type: 'object',
        properties: {
          modules: {
            type: 'array',
            items: { type: 'string' },
            description: 'Functional module ids to cover, e.g. ["graph-engine"] — get_dashboard_info lists the valid ids'
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Explicit file paths (POSIX relative to the watched root). Files outside the module table can only be admitted here.'
          }
        },
        additionalProperties: false
      },
      execute(args) {
        const rawModules = readStringArray(args.modules);
        const rawFiles = readStringArray(args.files);
        const badModules = rawModules.filter((m) => !VALID_MODULE_IDS.includes(m as (typeof VALID_MODULE_IDS)[number]));
        if (badModules.length > 0) {
          return errorResult(
            `unknown functional module(s): ${badModules.join(', ')}. ` +
              `valid ids: ${VALID_MODULE_IDS.join(', ')} (see get_dashboard_info.modules).`
          );
        }
        const modules = [...new Set(rawModules)];
        const files = [...new Set(rawFiles.map(normalizeFilePath).filter((f) => f !== ''))];
        const scope: EditScopeDecl = { modules, files };
        editScopeStore.declare(scope);
        const snap = graph.snapshot();
        const inScopeFiles = snap.nodes.map((n) => n.id).filter((id) => isInScope(id, scope));
        deps.broadcast?.({ type: 'edit_scope', scope });
        return textToolResult({
          ok: true,
          scope: { modules, files },
          inScopeFileCount: inScopeFiles.length,
          inScopeFiles: inScopeFiles.slice(0, EDIT_SCOPE_EXPAND_CAP),
          ...(inScopeFiles.length > EDIT_SCOPE_EXPAND_CAP ? { truncated: true } : {}),
          note: 'scope declared; report the actual edits with report_edits when done'
        });
      }
    },

    report_edits: {
      mutating: true,
      contentDependent: false,
      description:
        'Report the files you actually edited after the work is done. The server checks every file against the declared edit scope (declare_edit_scope) and cross-checks the watcher record: a file the watcher saw changed but you did not report is unreported (漏报), and any change outside the scope is an out-of-scope edit. Watcher evidence is scoped by the declaration baseline (scope epoch): records changed BEFORE the current scope was declared — e.g. leftovers from an earlier session — are listed in preexisting (informational, never affects ok). Anything you report yourself is always judged. Returns all lists and an ok flag (ok = no out-of-scope and no unreported).',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Edited file paths (POSIX relative to the watched root), e.g. ["src/server/mcp.ts"]'
          }
        },
        required: ['files'],
        additionalProperties: false
      },
      execute(args) {
        if (!Array.isArray(args.files)) {
          return errorResult('files is required and must be an array of POSIX file paths.');
        }
        const reported = [...new Set(readStringArray(args.files).map(normalizeFilePath).filter((f) => f !== ''))];
        const watcher = deps.recentChanges?.list() ?? [];
        // Ticket 13 (scope epoch): pass the timestamped records — verifyEdits
        // keeps changedAt < declaredAt as preexisting instead of judging it.
        const verification = verifyEdits(editScopeStore.current(), reported, watcher);
        const prebaseline = new Set(verification.preexisting);
        deps.broadcast?.({
          type: 'edit_verification',
          verification: {
            edited: [...new Set([...reported, ...watcher.map((c) => c.id).filter((id) => !prebaseline.has(id))])],
            outOfScope: verification.outOfScope.map((e) => e.id),
            unreported: verification.unreported
          }
        });
        return textToolResult({
          ok: verification.ok,
          scopeDeclared: verification.scopeDeclared,
          reported,
          outOfScope: verification.outOfScope,
          unreported: verification.unreported,
          preexisting: verification.preexisting,
          note: verification.ok
            ? verification.preexisting.length > 0
              ? `all edits inside the declared scope and everything reported — clean (${verification.preexisting.length} pre-baseline watcher record(s) listed in preexisting, not judged).`
              : 'all edits inside the declared scope and everything reported — clean.'
            : 'out-of-scope edits and/or unreported changes detected — check the lists.'
        });
      }
    },

    get_health_report: {
      mutating: false,
      contentDependent: true,
      description:
        'Return the deterministic health report for the watched graph: every module scored by a fixed integer weight table (high centrality=3, untested=2, type errors=2, on a dependency cycle=1, review error verdict=2; ties break by id). Items come risk-descending, plus a Chinese brief (top 5 + remaining count) and the weight table itself — same input always yields the same ranking.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      execute() {
        return textToolResult(buildHealthReport(graph.snapshot()));
      }
    },

    get_impact: {
      mutating: false,
      contentDependent: true,
      description:
        'BEFORE editing a file, see its blast radius: every module upstream (who imports it) and/or downstream (what it imports), grouped by BFS depth, each entry carrying the node test state and type-error count. Scope your change with it; nodes sitting on a dependency cycle or in the high-centrality top-20% deserve extra care (get_change_impact scores that per change after you edit). direction defaults to "both"; maxDepth defaults to 3 (hard cap 10, illegal values fall back to 3).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Module id: POSIX path relative to the watched root, e.g. "src/index.ts"'
          },
          direction: {
            type: 'string',
            enum: [...IMPACT_DIRECTIONS],
            description: 'upstream = who imports it, downstream = what it imports, both (default) = union of both walks'
          },
          maxDepth: {
            type: 'number',
            description: 'BFS depth limit: default 3, hard cap 10, illegal values fall back to 3'
          }
        },
        required: ['path'],
        additionalProperties: false
      },
      execute(args) {
        const snap = graph.snapshot();
        const found = resolveRequestedNode(args, snap);
        if ('failure' in found) return found.failure;

        const direction = args.direction ?? 'both';
        if (typeof direction !== 'string' || !IMPACT_DIRECTIONS.includes(direction as ImpactDirection)) {
          return errorResult('direction must be one of "upstream", "downstream", "both" (omitted means both).');
        }

        const impact = computeImpact(snap, found.node.id, {
          direction: direction as ImpactDirection,
          maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : undefined
        });
        // Unreachable via resolveRequestedNode (the node exists), kept total.
        if (!impact.ok) return textToolResult(impact);
        return textToolResult({ ...impact, affectedCount: impact.affected.length });
      }
    },

    get_change_impact: {
      mutating: false,
      contentDependent: true,
      description:
        'AFTER editing, replay the change evidence chain: every file the watcher recorded as changed recently (id, changedAt, whether still in the graph), and per in-graph change the computed blast radius (both directions, depth 3) with a risk level. 风险级：波及在环上或高中心度节点 → high；受影响节点 > 10 → medium；否则 low。Call it right after saving files to double-check the scope of what you just touched — before running tests or reporting a review. Records persist to .module-graph/recent-changes.json and survive a restart (bounded to the newest 100).',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      execute() {
        const snap = graph.snapshot();
        if (deps.recentChanges === undefined) {
          return textToolResult({
            changes: [],
            impacts: [],
            overallRisk: 'low',
            heuristics: CHANGE_IMPACT_HEURISTICS,
            note: 'no recent-changes pipeline wired in this deployment'
          });
        }
        // 打分全在图数学模块的纯函数里 (impact.scoreChanges);此处只剩整形。
        return textToolResult({
          ...scoreChanges(snap, deps.recentChanges.list(), statsFor()),
          heuristics: CHANGE_IMPACT_HEURISTICS
        });
      }
    }
  };

  if (deps.readOnly === true) return hideMutatingTools(tools);
  return tools;
}

/**
 * The read-only visibility layer: mutation-class tools (flag `mutating`) are
 * dropped, so tools/list hides them naturally (the list is generated from
 * this record); the transport still answers their tools/call with a dedicated
 * audit error. Inspection tools stay visible: a read-only session can still
 * explore, it just cannot write anything back.
 */
export function hideMutatingTools(tools: Record<string, ToolDef>): Record<string, ToolDef> {
  const visible: Record<string, ToolDef> = {};
  for (const [name, def] of Object.entries(tools)) {
    if (!def.mutating) visible[name] = def;
  }
  return visible;
}

export class McpStdioServer {
  private buffer = '';
  /**
   * Full registry — the policy flags (`mutating` / `contentDependent`) live on
   * the ToolDefs, so the baseline gate and the read-only audit error are
   * derived, never hand-copied (架构评审第二轮 #7).
   */
  private readonly allTools: Record<string, ToolDef>;
  /** What this session may see and call: the full record minus hidden mutation tools. */
  private readonly tools: Record<string, ToolDef>;
  private readonly deps: McpToolDeps;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly logger: (msg: string) => void,
    graph: GraphSnapshotSource,
    deps: McpToolDeps = {}
  ) {
    this.deps = deps;
    // buildTools is called exactly ONCE — it owns per-session state (the
    // edit-scope store, review bookkeeping); visibility is a projection on
    // top, never a second registry.
    this.allTools = buildTools(graph, { ...deps, readOnly: false });
    this.tools = deps.readOnly === true ? hideMutatingTools(this.allTools) : this.allTools;
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
            // Audit error, not "Unknown tool": the name IS a registered tool,
            // it just carries the `mutating` flag this session must refuse.
            const blocked =
              typeof name === 'string' &&
              Object.hasOwn(this.allTools, name) &&
              this.allTools[name]!.mutating;
            if (this.deps.readOnly === true && blocked) {
              // Audit-friendly: distinguishable from Unknown tool, names the
              // mode and the env var that caused it.
              this.errorReply(
                msg.id!,
                -32602,
                `tool "${String(name)}" is unavailable in read-only mode (MODULE_GRAPH_MCP_READ_ONLY=1)`
              );
              return;
            }
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
    try {
      await this.awaitBaseline(tool);
      const result = tool.execute(args);
      this.reply(id, this.withinBudget(name, args, result));
    } catch (err) {
      this.logger(`mcp: handler error: ${err instanceof Error ? err.message : String(err)}`);
      this.errorReply(id, -32603, 'Internal error');
    }
  }

  /**
   * Response budget (GitNexus port): a per-call `_maxTokens` (positive
   * integer) wins over the deps' default; neither set → pass through. An
   * illegal per-call value NEVER kills the call — it is ignored with one
   * stderr line, and the reply goes out untruncated. Truncation (when it
   * fires) is logged on the same human-readable channel.
   */
  private withinBudget(name: string, args: Record<string, unknown>, result: ToolResult): ToolResult {
    let maxTokens: number | undefined;
    const raw = args._maxTokens;
    if (raw !== undefined) {
      if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
        maxTokens = raw;
      } else {
        const shown = typeof raw === 'string' ? `"${raw}"` : String(raw);
        this.logger(`mcp: ignoring illegal _maxTokens ${shown} for ${name} (must be a positive integer)`);
      }
    }
    if (maxTokens === undefined) maxTokens = this.deps.defaultMaxTokens;
    if (maxTokens === undefined) return result;

    const first = result.content[0];
    if (first === undefined || first.type !== 'text') return result;
    const budgeted = applyTokenBudget(first.text, maxTokens);
    if (!budgeted.truncated) return result;
    this.logger(`mcp: reply for ${name} truncated to ~${maxTokens} tokens (original ≈ ${budgeted.originalTokens})`);
    return { ...result, content: [{ type: 'text', text: budgeted.text }] };
  }

  /**
   * Bounded wait for the startup baseline when the tool's `contentDependent`
   * flag says its answer reads graph content (plugin mode serves before the
   * baseline scan finishes — see the ToolDef doc). Past the cap the tool runs
   * against the partial graph anyway — the self-explaining errors guide the
   * agent to retry — so a slow scan can never wedge a request.
   */
  private awaitBaseline(tool: ToolDef): Promise<void> {
    if (this.deps.isBaselineDone?.() !== false || !tool.contentDependent) {
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
