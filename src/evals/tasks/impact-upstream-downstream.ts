import { check, type EvalTask, type ProbeResult } from '../types.js';

/**
 * Probe: get_impact answers both directions over the fixture graph with the
 * exact depth grouping, and the emitter→state cycle CONVERGES (BFS visited
 * set) instead of looping — sample-app hand-math:
 *   upstream(utils/format.ts) = core/app.ts @1 ← index.ts @2
 *   downstream(core/emitter.ts, depth 10) = store/state.ts @1, then the
 *   back-edge state→emitter hits the visited set: exactly one affected node.
 */
export const task: EvalTask = {
  id: 'impact-upstream-downstream',
  description: 'get_impact walks exact upstream/downstream depth groups and the fixture cycle converges',
  maxMs: 600,
  maxBytes: 4500,
  async probe(client): Promise<ProbeResult> {
    const upstream = await client.callTool('get_impact', { path: 'utils/format.ts', direction: 'upstream' });
    check(!upstream.failed, `get_impact upstream failed: ${upstream.rpcError?.message ?? upstream.text}`);
    const up = upstream.payload as { affected?: Array<{ depth: number; id: string; testState?: string; typeErrorCount?: number }> };
    check(
      JSON.stringify(up.affected) ===
        JSON.stringify([
          { depth: 1, id: 'core/app.ts', path: 'core/app.ts', testState: 'untested', typeErrorCount: 0 },
          { depth: 2, id: 'index.ts', path: 'index.ts', testState: 'untested', typeErrorCount: 0 }
        ]),
      `upstream walk drifted: ${JSON.stringify(up.affected)}`
    );

    const downstream = await client.callTool('get_impact', { path: 'core/emitter.ts', direction: 'downstream', maxDepth: 10 });
    check(!downstream.failed, `get_impact downstream failed: ${downstream.rpcError?.message ?? downstream.text}`);
    const down = downstream.payload as { affected?: Array<{ depth: number; id: string }>; maxDepth?: number };
    check(down.maxDepth === 10, `maxDepth not honored: ${String(down.maxDepth)}`);
    check(
      JSON.stringify(down.affected?.map((n) => [n.depth, n.id])) === JSON.stringify([[1, 'store/state.ts']]),
      `cycle did not converge to the exact affected set: ${JSON.stringify(down.affected)}`
    );

    const unknown = await client.callTool('get_impact', { path: 'no/such/file.ts' });
    check(unknown.failed, 'unknown path must be a structured error, not a crash');
    check(unknown.text.includes('module not found'), `not-found guidance missing: ${unknown.text.slice(0, 80)}`);
    return { bytes: upstream.bytes + downstream.bytes + unknown.bytes };
  }
};
