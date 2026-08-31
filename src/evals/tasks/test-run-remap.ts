import { check, type EvalTask, type ProbeResult } from '../types.js';

/**
 * Probe ⑧: report_test_run acknowledges both outcomes (the pipeline owns the
 * remap; the probe pins the tool's receipt contract).
 */
export const task: EvalTask = {
  id: 'test-run-remap',
  description: 'report_test_run acknowledges failed=true and failed=false receipts',
  maxMs: 500,
  maxBytes: 700,
  async probe(client): Promise<ProbeResult> {
    let bytes = 0;
    const clean = await client.callTool('report_test_run', { failed: false });
    check(!clean.failed, `report_test_run(false) failed: ${clean.rpcError?.message ?? clean.text}`);
    const cleanP = clean.payload as { ok?: unknown; failed?: unknown; note?: unknown };
    check(cleanP.ok === true && cleanP.failed === false, `receipt wrong: ${JSON.stringify(cleanP)}`);
    check(cleanP.note === 'coverage remap triggered', `unexpected note: ${String(cleanP.note)}`);
    bytes += clean.bytes;

    const failing = await client.callTool('report_test_run', { failed: true });
    check(!failing.failed, `report_test_run(true) failed: ${failing.rpcError?.message ?? failing.text}`);
    const failingP = failing.payload as { failed?: unknown };
    check(failingP.failed === true, 'failed=true must be echoed back');
    bytes += failing.bytes;
    return { bytes };
  }
};
