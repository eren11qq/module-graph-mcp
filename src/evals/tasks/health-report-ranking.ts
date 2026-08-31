import { check, type EvalTask, type ProbeResult } from '../types.js';

/**
 * Probe: the health report ranks the fixture's KNOWN problem first, and the
 * whole ordering is the deterministic contract (fixed weights, id tie-break).
 * sample-app hand-math: core/emitter.ts = 高中心度3 + 未测2 + 在环上1 = 6;
 * core/app.ts = 5 (高中心度, 未测); store/state.ts = 3 (未测 + 在环上).
 */
export const task: EvalTask = {
  id: 'health-report-ranking',
  description: 'get_health_report ranks the untested high-centrality cycle module first, deterministically',
  maxMs: 500,
  maxBytes: 4000,
  async probe(client): Promise<ProbeResult> {
    const res = await client.callTool('get_health_report');
    check(!res.failed, `get_health_report failed: ${res.rpcError?.message ?? res.text}`);
    const p = res.payload as {
      totalModules?: number;
      weights?: Record<string, number>;
      items?: Array<{ id: string; score: number }>;
      brief?: string;
    };
    check(p.totalModules === 7, `totalModules wrong: ${String(p.totalModules)}`);
    check(
      JSON.stringify(p.weights) ===
        JSON.stringify({ highCentrality: 3, untested: 2, typeErrors: 2, onCycle: 1, reviewError: 2 }),
      `weight table drifted: ${JSON.stringify(p.weights)}`
    );
    const items = p.items ?? [];
    check(items.length === 7, `items length wrong: ${items.length}`);
    check(items[0]?.id === 'core/emitter.ts' && items[0]?.score === 6, `rank #1 wrong: ${JSON.stringify(items[0])}`);
    check(items[1]?.id === 'core/app.ts' && items[1]?.score === 5, `rank #2 wrong: ${JSON.stringify(items[1])}`);
    check(items[2]?.id === 'store/state.ts' && items[2]?.score === 3, `rank #3 wrong: ${JSON.stringify(items[2])}`);
    const brief = p.brief ?? '';
    check(brief.includes('共 7 个模块'), `brief lacks the header: ${brief.slice(0, 80)}`);
    check(brief.includes('core/emitter.ts（6 分：高中心度、未测、在环上）'), `brief lacks the ranked top line: ${brief.slice(0, 200)}`);
    return { bytes: res.bytes };
  }
};
