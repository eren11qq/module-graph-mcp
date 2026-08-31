import { check, type EvalTask, type ProbeResult } from '../types.js';

/** Probe ⑤: list_untested counts every fixture module (none of them is tested). */
export const task: EvalTask = {
  id: 'list-untested-counts',
  description: 'list_untested reports 7/7 untested modules for the bare sample-app fixture',
  maxMs: 500,
  maxBytes: 1200,
  async probe(client): Promise<ProbeResult> {
    const res = await client.callTool('list_untested');
    check(!res.failed, `list_untested failed: ${res.rpcError?.message ?? res.text}`);
    const p = res.payload as { totalModules?: number; untestedCount?: number; modules?: Array<{ id: string }> };
    check(p.totalModules === 7, `totalModules wrong: ${String(p.totalModules)}`);
    check(p.untestedCount === 7, `untestedCount wrong: ${String(p.untestedCount)}`);
    const ids = (p.modules ?? []).map((m) => m.id).sort();
    check(ids.length === 7 && ids.includes('utils/format.ts') && ids.includes('core/emitter.ts'), `untested ids drifted: ${ids.join(', ')}`);
    return { bytes: res.bytes };
  }
};
