export type TestState = 'untested' | 'has-tests-unrun' | 'passing' | 'failing';

export interface TypeErrorEntry {
  line: number;
  code: string;
  message: string;
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
  | { type: 'scan_error'; message: string };
