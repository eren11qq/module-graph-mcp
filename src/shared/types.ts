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
   * so older snapshots (and frame-guards) stay valid; in-memory only — a
   * rescan rebuilds nodes without it and the agent re-reports.
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
  | { type: 'module_activity'; id: string; path: string; activity: 'viewing'; at: number };
