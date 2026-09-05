import { check, type EvalTask } from '../types.js';

/**
 * Probe: on a cold start with zero file events the change evidence chain is
 * WELL-FORMED empty — changes [], impacts [], overallRisk "low" — and the
 * Chinese heuristics text is present (the agent reads it to learn the risk
 * rules without a round-trip to the docs).
 */
export const task: EvalTask = {
  id: 'change-impact-empty',
  description: 'get_change_impact answers a well-formed empty evidence chain on a cold start',
  maxMs: 500,
  maxBytes: 2500,
  async probe(client): Promise<void> {
    const res = await client.callTool('get_change_impact');
    check(!res.failed, `get_change_impact failed: ${res.rpcError?.message ?? res.text}`);
    const p = res.payload as {
      changes?: unknown[];
      impacts?: unknown[];
      overallRisk?: string;
      heuristics?: string;
    };
    check(Array.isArray(p.changes) && p.changes.length === 0, `changes not empty: ${JSON.stringify(p.changes)}`);
    check(Array.isArray(p.impacts) && p.impacts.length === 0, `impacts not empty: ${JSON.stringify(p.impacts)}`);
    check(p.overallRisk === 'low', `overallRisk wrong: ${String(p.overallRisk)}`);
    check(typeof p.heuristics === 'string' && p.heuristics.includes('风险级启发式'), `heuristics text missing: ${String(p.heuristics).slice(0, 60)}`);
  }
};
