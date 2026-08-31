import { check, type EvalTask, type ProbeResult } from '../types.js';

/** Probe ⑥: report_note sets, persists and clears a note (set → clear round-trip). */
export const task: EvalTask = {
  id: 'note-set-clear',
  description: 'report_note round-trips a note on utils/format.ts and clears it with an empty string',
  maxMs: 500,
  maxBytes: 800,
  async probe(client): Promise<ProbeResult> {
    let bytes = 0;
    const setRes = await client.callTool('report_note', { path: 'utils/format.ts', text: 'probe: note set by evals' });
    check(!setRes.failed, `report_note(set) failed: ${setRes.rpcError?.message ?? setRes.text}`);
    const setP = setRes.payload as { note?: unknown; cleared?: unknown };
    check(setP.note === 'probe: note set by evals', `note not stored: ${String(setP.note)}`);
    check(setP.cleared === false, 'cleared must be false after a set');
    bytes += setRes.bytes;

    const clearRes = await client.callTool('report_note', { path: 'utils/format.ts', text: '' });
    check(!clearRes.failed, `report_note(clear) failed: ${clearRes.rpcError?.message ?? clearRes.text}`);
    const clearP = clearRes.payload as { note?: unknown; cleared?: unknown };
    check(clearP.cleared === true && clearP.note === null, `note not cleared: note=${String(clearP.note)} cleared=${String(clearP.cleared)}`);
    bytes += clearRes.bytes;
    return { bytes };
  }
};
