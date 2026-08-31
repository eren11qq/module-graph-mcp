import { check, type EvalTask, type ProbeResult } from '../types.js';

/** Probe ③: get_module_details returns the full envelope incl. source text. */
export const task: EvalTask = {
  id: 'module-details-source',
  description: 'get_module_details on utils/format.ts carries state, edges and the real source text',
  maxMs: 500,
  maxBytes: 1500,
  async probe(client): Promise<ProbeResult> {
    const res = await client.callTool('get_module_details', { path: 'utils/format.ts' });
    check(!res.failed, `get_module_details failed: ${res.rpcError?.message ?? res.text}`);
    const p = res.payload as {
      id?: string;
      language?: string;
      testState?: string;
      source?: { content?: string; truncated?: boolean };
      outgoingDependencies?: string[];
      incomingDependents?: string[];
    };
    check(p.id === 'utils/format.ts', `wrong id: ${String(p.id)}`);
    check(p.language === 'ts', `wrong language: ${String(p.language)}`);
    check(p.testState === 'untested', `wrong testState: ${String(p.testState)}`);
    check(typeof p.source?.content === 'string' && p.source.content.includes('formatLabel'), 'source text missing');
    check(p.source?.truncated === false, 'source must not be truncated for a small fixture file');
    check(Array.isArray(p.outgoingDependencies) && p.outgoingDependencies.length === 0, 'format.ts is a leaf: no outgoing deps');
    check(Array.isArray(p.incomingDependents) && p.incomingDependents.includes('core/app.ts'), 'missing incoming edge from core/app.ts');
    return { bytes: res.bytes };
  }
};
