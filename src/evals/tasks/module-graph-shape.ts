import { check, type EvalTask, type ProbeResult } from '../types.js';

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

/** Probe ②: the full graph keeps the fixture's exact node/edge invariants. */
export const task: EvalTask = {
  id: 'module-graph-shape',
  description: 'get_module_graph returns exactly the sample-app 7-node/8-edge inventory (cycle pair included)',
  maxMs: 500,
  maxBytes: 4000,
  async probe(client): Promise<ProbeResult> {
    const res = await client.callTool('get_module_graph');
    check(!res.failed, `get_module_graph failed: ${res.rpcError?.message ?? res.text}`);
    const p = res.payload as { nodes?: Array<{ id: string }>; edges?: Array<{ from: string; to: string }> };
    const nodeIds = (p.nodes ?? []).map((n) => n.id).sort();
    check(nodeIds.length === 7, `expected 7 nodes, got ${nodeIds.length}`);
    check(JSON.stringify(nodeIds) === JSON.stringify([...EXPECTED_NODE_IDS].sort()), `node ids drifted: ${nodeIds.join(', ')}`);
    const pairs = (p.edges ?? []).map((e) => `${e.from}->${e.to}`).sort();
    check(pairs.length === 8, `expected 8 edges, got ${pairs.length}`);
    for (const [from, to] of EXPECTED_EDGES) {
      check(pairs.includes(`${from}->${to}`), `missing edge ${from}->${to}`);
    }
    check(!nodeIds.some((id) => id.includes('garbage')), 'garbage.txt leaked into the graph');
    return { bytes: res.bytes };
  }
};
