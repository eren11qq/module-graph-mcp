import { describe, expect, it, vi } from 'vitest';
import { createReviewLifecycle, REVIEW_CHECKING_TIMEOUT_MS } from '../src/server/review-lifecycle.js';
import type { AiReview, GraphEvent, ModuleNode } from '../src/shared/types.js';

/**
 * The checking lifecycle tested on its own interface: pairing, verdict
 * merging, the timeout's identity token, and the node_update → review_timeout
 * event order. The tool-level wiring keeps two pins in tests/mcp-tools.test.ts.
 */

const TIMEOUT_MS = REVIEW_CHECKING_TIMEOUT_MS;

function node(over: Partial<ModuleNode> = {}): ModuleNode {
  return { id: 'a.ts', path: 'src/a.ts', language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [], ...over };
}

/** Mirrors the engine's aliasing contract: snapshot() hands out the SAME node
    objects setReview() mutates, so post-mutation reads see the change. */
function build(nodes: ModuleNode[] = [node(), node({ id: 'b.ts', path: 'src/b.ts' })]) {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const reviews = new Map<string, AiReview | undefined>();
  const events: GraphEvent[] = [];
  const graph = {
    snapshot: () => ({ rootPath: '/proj', generatedAt: 42, nodes: [...nodesById.values()], edges: [] }),
    setReview: (id: string, review: AiReview | undefined) => {
      const n = nodesById.get(id);
      if (n === undefined) return false;
      n.aiReview = review;
      reviews.set(id, review);
      return true;
    }
  };
  const lifecycle = createReviewLifecycle({ graph, broadcast: (e) => events.push(e) });
  return {
    lifecycle,
    reviews,
    events,
    nodeEvents: () => events.filter((e) => e.type === 'node_update').map((e) => (e as { node: ModuleNode }).node),
    otherEvents: () => events.filter((e) => e.type !== 'node_update') as Array<{ type: string; id?: string; path?: string }>,
    /** Simulate a rescan: fresh node objects, in-memory reviews gone. */
    rescan: () => {
      for (const [id, n] of nodesById) nodesById.set(id, node({ id, path: n.path }));
    }
  };
}

describe('ReviewLifecycle — begin', () => {
  it('marks checking, broadcasts one node_update, and holds until the deadline', () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, reviews, nodeEvents } = build();
      const { checking } = lifecycle.begin('a.ts', 'src/a.ts');
      expect(checking).toEqual({ status: 'checking', verdicts: [] });
      expect(reviews.get('a.ts')).toEqual({ status: 'checking', verdicts: [] });
      expect(nodeEvents()).toHaveLength(1);
      expect(nodeEvents()[0]!.aiReview).toEqual({ status: 'checking', verdicts: [] });

      vi.advanceTimersByTime(TIMEOUT_MS - 1);
      expect(reviews.get('a.ts')).toEqual({ status: 'checking', verdicts: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ReviewLifecycle — timeout retirement', () => {
  it('after the deadline: clears checking, node_update precedes review_timeout', () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, reviews, events, nodeEvents, otherEvents } = build();
      lifecycle.begin('a.ts', 'src/a.ts');

      vi.advanceTimersByTime(TIMEOUT_MS);
      expect(reviews.get('a.ts')).toBeUndefined();
      expect(nodeEvents().at(-1)!.aiReview).toBeUndefined();
      // The paired node_update goes out first so the pulse is already
      // stopped when the ticker explains the timeout.
      expect(events.at(-2)!.type).toBe('node_update');
      expect(otherEvents()).toEqual([{ type: 'review_timeout', id: 'a.ts', path: 'src/a.ts' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rescan that replaces the node objects disarms the pending timeout for free', () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, nodeEvents, otherEvents, rescan } = build();
      lifecycle.begin('a.ts', 'src/a.ts');
      rescan();

      vi.advanceTimersByTime(TIMEOUT_MS * 2);
      expect(otherEvents()).toEqual([]); // no review_timeout: identity token no longer matches
      expect(nodeEvents()).toHaveLength(1); // only the begin's own node_update
    } finally {
      vi.useRealTimers();
    }
  });

  it('a re-begin replaces the window: the old deadline must not retire the fresh state', () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, reviews, otherEvents } = build();
      lifecycle.begin('a.ts', 'src/a.ts');
      vi.advanceTimersByTime(TIMEOUT_MS - 1000);
      lifecycle.begin('a.ts', 'src/a.ts'); // fresh checking object + fresh window

      vi.advanceTimersByTime(1001); // crosses the ORIGINAL deadline
      expect(reviews.get('a.ts')).toEqual({ status: 'checking', verdicts: [] });
      expect(otherEvents()).toEqual([]);
      vi.advanceTimersByTime(TIMEOUT_MS - 1002);
      expect(reviews.get('a.ts')).toEqual({ status: 'checking', verdicts: [] });
      vi.advanceTimersByTime(1);
      expect(reviews.get('a.ts')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ReviewLifecycle — update', () => {
  it('without a pending review it is refused and stays silent', () => {
    const { lifecycle, events } = build();
    const outcome = lifecycle.update('a.ts', 'src/a.ts', [{ line: 1, verdict: 'error' }]);
    expect(outcome).toEqual({ ok: false, reason: 'no-review-in-progress' });
    expect(events).toEqual([]);
  });

  it('merges batches (last-per-line wins, sorted) and re-arms: the fresh window governs', () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, reviews, otherEvents } = build();
      lifecycle.begin('a.ts', 'src/a.ts');

      // Push an update 1s before the ORIGINAL deadline. This replaces the
      // node's review with a new object — without the re-arm the old timer
      // would no-op and the module would sit in checking forever.
      vi.advanceTimersByTime(TIMEOUT_MS - 1000);
      const first = lifecycle.update('a.ts', 'src/a.ts', [
        { line: 9, verdict: 'unsure' },
        { line: 3, verdict: 'confident' }
      ]);
      expect(first).toEqual({ ok: true, verdictCount: 2, checking: { status: 'checking', verdicts: [
        { line: 3, verdict: 'confident' },
        { line: 9, verdict: 'unsure' }
      ] } });

      vi.advanceTimersByTime(1001); // crosses the original deadline
      expect(reviews.get('a.ts')!.status).toBe('checking');
      expect(otherEvents()).toEqual([]);

      // The re-armed window started at the update (t = TIMEOUT-1000): the
      // new deadline is 2*TIMEOUT-1000, not the original 1*TIMEOUT.
      vi.advanceTimersByTime(TIMEOUT_MS - 1002);
      expect(reviews.get('a.ts')!.status).toBe('checking');
      vi.advanceTimersByTime(1);
      expect(reviews.get('a.ts')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ReviewLifecycle — end', () => {
  it('lands done with reviewedAt + summary, disarms the timeout entirely', () => {
    vi.useFakeTimers();
    try {
      const { lifecycle, reviews, otherEvents } = build();
      lifecycle.begin('a.ts', 'src/a.ts');
      lifecycle.update('a.ts', 'src/a.ts', [{ line: 2, verdict: 'confident' }]);

      const { done, verdictCount } = lifecycle.end('a.ts', [], 'clean');
      expect(verdictCount).toBe(0);
      expect(done.status).toBe('done');
      expect(done.summary).toBe('clean');
      expect(typeof done.reviewedAt).toBe('number');
      expect(reviews.get('a.ts')!.status).toBe('done');

      vi.advanceTimersByTime(TIMEOUT_MS * 2);
      expect(reviews.get('a.ts')!.status).toBe('done');
      expect(otherEvents()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
