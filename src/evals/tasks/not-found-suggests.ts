import { check, type EvalTask, type ProbeResult } from '../types.js';

/** Probe ④: a bad path errors with self-explaining suggestions (ticket 10). */
export const task: EvalTask = {
  id: 'not-found-suggests',
  description: 'get_module_details on a wrong path fails with "did you mean" suggestions',
  maxMs: 500,
  maxBytes: 600,
  async probe(client): Promise<ProbeResult> {
    const res = await client.callTool('get_module_details', { path: 'core/app' });
    check(res.failed, 'a wrong path must produce an error result');
    check(res.rpcError === undefined, `wrong path must be a tool-level error, not a transport error: ${String(res.rpcError?.message)}`);
    check(res.text.includes('module not found'), `error text lacks "module not found": ${res.text.slice(0, 120)}`);
    check(res.text.includes('core/app.ts'), `error text lacks the suggestion "core/app.ts": ${res.text.slice(0, 200)}`);
    return { bytes: res.bytes };
  }
};
