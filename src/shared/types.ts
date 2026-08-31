export type TestState = 'untested' | 'has-tests-unrun' | 'passing' | 'failing';

export interface TypeErrorEntry {
  line: number;
  code: string;
  message: string;
}

/**
 * Ticket 12: AI review channel. The agent is the executor — it reports
 * begin/end via the MCP tools, the server stores the review on the node and
 * broadcasts node_update, and the dashboard renders it. Three-color verdicts:
 * confident (green) / unsure (amber) / error (red).
 */
export type AiVerdict = 'confident' | 'unsure' | 'error';

export interface AiReviewEntry {
  /** 1-based source line the verdict refers to. */
  line: number;
  verdict: AiVerdict;
  /** Optional free-form explanation shown as the row's trailing marker. */
  message?: string;
}

export interface AiReview {
  status: 'checking' | 'done';
  verdicts: AiReviewEntry[];
  /** One-line overall conclusion, present once the review is done. */
  summary?: string;
  reviewedAt?: number;
}

export interface ModuleNode {
  /** POSIX-style path relative to the watched root */
  id: string;
  path: string;
  language: 'ts' | 'tsx' | 'js' | 'jsx';
  testState: TestState;
  coveredBy: string[];
  typeErrors: TypeErrorEntry[];
  lastTestRunAt?: number;
  /** Ticket 10: free-form note attached via the MCP report_note tool. */
  note?: string;
  /**
   * Ticket 12: AI review state reported via begin_review/end_review. Optional
   * so older snapshots (and frame-guards) stay valid. Since 2026-09-01 the
   * done conclusions persist on disk (<root>/.module-graph/reviews.json) and
   * are re-attached after every baseline scan; checking states stay
   * in-memory only.
   */
  aiReview?: AiReview;
}

export interface Edge {
  /** importer */
  from: string;
  /** imported */
  to: string;
}

/** Ticket 05: net change of one debounce window, applied incrementally client-side. */
export interface GraphDelta {
  addedNodes: ModuleNode[];
  removedNodeIds: string[];
  addedEdges: Edge[];
  removedEdges: Edge[];
}

export interface GraphSnapshot {
  rootPath: string;
  generatedAt: number;
  nodes: ModuleNode[];
  edges: Edge[];
}

/**
 * GitNexus port: per-module graph statistics, part of the get_module_details
 * RESPONSE ENVELOPE only. Deliberately NOT fields of ModuleNode — snapshot
 * nodes are live objects shared with the engine, so derived stats pinned onto
 * them would go stale the moment the graph moves. The details tool derives
 * these fresh per call (memoized by generatedAt in src/server/impact.ts).
 */
export interface ModuleContextStats {
  /** Importers (edges pointing at this module). */
  inDegree: number;
  /** Imports (edges leaving this module). */
  outDegree: number;
  /** true when the module sits on a dependency cycle. */
  inCycle: boolean;
  /** (in + out) / (2·(n−1)); 0 for degenerate graphs. */
  centrality: number;
}

/**
 * ADR 0002 / MODULE-DESIGN §7.2: agent 开工前声明的改动边界（declare_
 * edit_scope 的参数、edit_scope wire 事件的载荷）。modules = 功能模块 id
 * （模块表），files = 显式文件（POSIX 根相对路径，表外文件只能走这里）。
 */
export interface EditScopeDecl {
  modules: string[];
  files: string[];
}

/**
 * ADR 0002 / MODULE-DESIGN §7.2: 一次核对的结果（report_edits 之后广播的
 * edit_verification 事件载荷）。edited = 系统认定的改动文件（上报 ∪ watcher
 * 磁盘事实）；outOfScope = 范围外改动；unreported = watcher 看见但没上报的。
 */
export interface EditVerificationWire {
  edited: string[];
  outOfScope: string[];
  unreported: string[];
}

/** Wire messages pushed over /ws (see plan §WS protocol) */
export type GraphEvent =
  | { type: 'snapshot'; snapshot: GraphSnapshot }
  | { type: 'graph_delta'; delta: GraphDelta }
  | { type: 'node_update'; node: ModuleNode }
  /** Ticket 04: a debounced rescan failed; pages keep the last good snapshot and show a light notice. */
  | { type: 'scan_error'; message: string }
  /**
   * Code-review 2026-08-29: a begin_review never followed by end_review —
   * the server retired the checking state itself (the paired node_update
   * already stopped the pulse); pages surface the timeout in the ticker.
   */
  | { type: 'review_timeout'; id: string; path: string }
  /**
   * Code-review 2026-08-29: the agent READ a module (get_module_details).
   * Transient — the page lights the ball with the lighter `viewing` pulse
   * for a few seconds; unlike node_update this carries no state, and pages
   * that miss it lose nothing.
   */
  | { type: 'module_activity'; id: string; path: string; activity: 'viewing'; at: number }
  /**
   * ADR 0002 / MODULE-DESIGN §7.2: declare_edit_scope 落地（scope null =
   * 范围已清除）。页面据此给范围内文件画常驻紫环。
   */
  | { type: 'edit_scope'; scope: EditScopeDecl | null }
  /**
   * ADR 0002 / MODULE-DESIGN §7.2: report_edits 核对结果——已改整球变紫、
   * 越界红角标 + 状态栏警示条；unreported 只在警示文案里点名。
   */
  | { type: 'edit_verification'; verification: EditVerificationWire };
