import { check, type EvalTask, type ProbeResult } from '../types.js';

/**
 * Probe ⑦: the full review lifecycle on one module — begin → update batches
 * (fold: per line the new entry wins) → end with summary.
 */
export const task: EvalTask = {
  id: 'review-begin-end-pairs',
  description: 'begin_review → update_review merge → end_review round-trip keeps the three-state lifecycle',
  maxMs: 500,
  // begin_review now embeds the playbook (probe-asserted in playbook-present);
  // this budget covers the four-call lifecycle around it.
  maxBytes: 3000,
  async probe(client): Promise<ProbeResult> {
    let bytes = 0;
    const begin = await client.callTool('begin_review', { path: 'utils/logger.ts' });
    check(!begin.failed, `begin_review failed: ${begin.rpcError?.message ?? begin.text}`);
    const beginP = begin.payload as { aiReview?: { status?: string; verdicts?: unknown[] } };
    check(beginP.aiReview?.status === 'checking' && beginP.aiReview.verdicts?.length === 0, 'begin must land in checking with no verdicts');
    bytes += begin.bytes;

    const upd1 = await client.callTool('update_review', {
      path: 'utils/logger.ts',
      verdicts: [
        { line: 3, verdict: 'unsure', message: 'first pass' },
        { line: 5, verdict: 'confident' }
      ]
    });
    check(!upd1.failed, `update_review #1 failed: ${upd1.rpcError?.message ?? upd1.text}`);
    const upd1P = upd1.payload as { verdictCount?: number };
    check(upd1P.verdictCount === 2, `verdictCount after batch 1 wrong: ${String(upd1P.verdictCount)}`);
    bytes += upd1.bytes;

    // Same line again: the new entry wins, the count stays folded per line.
    const upd2 = await client.callTool('update_review', {
      path: 'utils/logger.ts',
      verdicts: [{ line: 5, verdict: 'error', message: 'upgraded after second look' }]
    });
    check(!upd2.failed, `update_review #2 failed: ${upd2.rpcError?.message ?? upd2.text}`);
    const upd2P = upd2.payload as { verdictCount?: number; aiReview?: { status?: string; verdicts?: Array<{ line: number; verdict: string }> } };
    check(upd2P.verdictCount === 2, `verdictCount after batch 2 wrong: ${String(upd2P.verdictCount)}`);
    const line5 = upd2P.aiReview?.verdicts?.find((v) => v.line === 5);
    check(line5?.verdict === 'error', 'the re-reported line 5 must win with verdict error');
    bytes += upd2.bytes;

    const end = await client.callTool('end_review', {
      path: 'utils/logger.ts',
      verdicts: [],
      summary: 'evals probe: lifecycle closed'
    });
    check(!end.failed, `end_review failed: ${end.rpcError?.message ?? end.text}`);
    const endP = end.payload as { aiReview?: { status?: string; summary?: string } };
    check(endP.aiReview?.status === 'done', 'end must land in done');
    check(endP.aiReview?.summary === 'evals probe: lifecycle closed', 'summary not carried through end_review');
    bytes += end.bytes;
    return { bytes };
  }
};
