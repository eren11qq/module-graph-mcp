import { check, type EvalTask } from '../types.js';

/** The hand-tallied sample-app inventory (mirrors tests/graph-engine.test.ts). */
const EXPECTED_NODE_IDS = [
  'core/app.ts',
  'core/emitter.ts',
  'index.ts',
  'store/history.ts',
  'store/state.ts',
  'utils/format.ts',
  'utils/logger.ts'
];

const EXPECTED_EDGES: Array<[string, string]> = [
  ['core/app.ts', 'core/emitter.ts'],
  ['core/app.ts', 'utils/format.ts'],
  ['core/emitter.ts', 'store/state.ts'],
  ['index.ts', 'core/app.ts'],
  ['index.ts', 'core/emitter.ts'],
  ['index.ts', 'store/history.ts'],
  ['store/history.ts', 'utils/logger.ts'],
  ['store/state.ts', 'core/emitter.ts']
];

/**
 * Probe ②: the full graph keeps the fixture's exact node/edge invariants.
 *
 * P0-1 (交付审计): get_module_graph deliberately answers immediately with
 * `scanning: true` while the baseline scan is still running (plugin-mode
 * handshake must never wait), so a cold start under load can land on an
 * empty graph. The probe therefore waits out the baseline with a bounded
 * retry budget instead of asserting on the first reply; if the scan still
 * has not settled when the budget is spent, the invariant checks below fail
 * with the usual explicit message. maxMs is budgeted for that worst case
 * (measured p50 ~130ms / p95 ~255ms when the baseline is warm, ADR 0001).
 */
const SCAN_RETRY_BUDGET_MS = 2500;
const SCAN_RETRY_STEP_MS = 100;

export const task: EvalTask = {
  id: 'module-graph-shape',
  description: 'get_module_graph returns exactly the sample-app 7-node/8-edge inventory (cycle pair included)',
  maxMs: 3000,
  maxBytes: 4000,
  async probe(client): Promise<void> {
    let res = await client.callTool('get_module_graph');
    check(!res.failed, `get_module_graph failed: ${res.rpcError?.message ?? res.text}`);
    let p = res.payload as {
      scanning?: boolean;
      nodes?: Array<{ id: string }>;
      edges?: Array<{ from: string; to: string }>;
    };
    const settled = () => p.scanning !== true && (p.nodes ?? []).length === EXPECTED_NODE_IDS.length;
    const deadline = Date.now() + SCAN_RETRY_BUDGET_MS;
    while (!settled() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SCAN_RETRY_STEP_MS));
      res = await client.callTool('get_module_graph');
      check(!res.failed, `get_module_graph failed on retry: ${res.rpcError?.message ?? res.text}`);
      p = res.payload as typeof p;
    }
    const nodeIds = (p.nodes ?? []).map((n) => n.id).sort();
    check(nodeIds.length === 7, `expected 7 nodes, got ${nodeIds.length}`);
    check(JSON.stringify(nodeIds) === JSON.stringify([...EXPECTED_NODE_IDS].sort()), `node ids drifted: ${nodeIds.join(', ')}`);
    const pairs = (p.edges ?? []).map((e) => `${e.from}->${e.to}`).sort();
    check(pairs.length === 8, `expected 8 edges, got ${pairs.length}`);
    for (const [from, to] of EXPECTED_EDGES) {
      check(pairs.includes(`${from}->${to}`), `missing edge ${from}->${to}`);
    }
    check(!nodeIds.some((id) => id.includes('garbage')), 'garbage.txt leaked into the graph');
  }
};
