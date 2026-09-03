import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { makeTempProject } from './helpers/temp-project.js';
import { spawnClient } from '../src/evals/mcp-client.js';

/**
 * 常驻 e2e (2026-09-01): the review traces survive the popup page / the
 * whole process. A real dist server ends a review, dies, and a fresh
 * process over the same root restores the green ring — get_module_details
 * must report the persisted done review after the restart.
 *
 * Candidate #3 (2026-09-03): the hand-rolled Session/spawn/waitForReply copy
 * is gone — this test now crosses the SAME seam as the evals probes
 * (src/evals/mcp-client.ts), so framing fixes land in one place.
 */

interface DetailsPayload {
  aiReview?: { status: string; verdicts: unknown[]; summary?: string };
}
interface GraphPayload {
  nodes: Array<{ id: string; aiReview?: { status: string } }>;
}

describe('review persistence across process restarts (常驻 e2e)', () => {
  it('an ended review is restored by a fresh server over the same root', async () => {
    const root = await makeTempProject({
      'src/a.ts': 'export const a = 1;\n'
    });
    try {
      // Session 1: begin + end a review (green ring: empty verdicts).
      const s1 = await spawnClient(root);
      const begin = await s1.callTool('begin_review', { path: 'src/a.ts' });
      expect(begin.failed).toBe(false);
      expect((begin.payload as DetailsPayload).aiReview?.status).toBe('checking');
      const end = await s1.callTool('end_review', { path: 'src/a.ts', verdicts: [], summary: '常驻 e2e' });
      expect((end.payload as DetailsPayload).aiReview?.status).toBe('done');
      await s1.close();

      // Session 2: a brand-new process — the review must come back from disk.
      const s2 = await spawnClient(root);
      const details = await s2.callTool('get_module_details', { path: 'src/a.ts' });
      expect((details.payload as DetailsPayload).aiReview).toEqual({
        status: 'done',
        verdicts: [],
        summary: '常驻 e2e',
        reviewedAt: expect.any(Number)
      });
      // The dashboard's graph view must carry it too.
      const graph = await s2.callTool('get_module_graph', {});
      const node = (graph.payload as GraphPayload).nodes.find((n) => n.id === 'src/a.ts');
      expect(node?.aiReview?.status).toBe('done');
      await s2.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
