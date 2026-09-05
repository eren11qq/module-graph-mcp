import type { AiReview, AiReviewEntry, AiVerdict, GraphEvent, GraphSnapshot, ModuleNode } from '../shared/types.js';

/**
 * The AI-review checking lifecycle, one place (architecture review
 * 2026-08-29, candidate #1). Four cross-module invariants used to live as
 * prose comments across the three tool bodies, a timer closure, the engine's
 * snapshot aliasing and the dashboard's event assumptions:
 *
 * - begin/end pairing: a begin_review without its end_review leaves the ball
 *   pulsing forever — after REVIEW_CHECKING_TIMEOUT_MS the server retires the
 *   checking state itself and tells the dashboard.
 * - update re-arms: setReview swaps node.aiReview for a fresh object, which
 *   would silently disarm a timer that captured the old one (the identity
 *   token no longer matches) — every update re-binds the timeout.
 * - event order on timeout: the paired node_update goes out BEFORE
 *   review_timeout so the dashboard's pulse is already stopped when the
 *   ticker explains why.
 * - live-reference payloads: broadcasts carry the post-mutation node object;
 *   the wire stays honest because snapshots share live nodes with the engine
 *   and WsHub serializes at call time.
 *
 * All four are implementation details here. Callers resolve the path/arguments
 * (the MCP seam keeps its reply texts); this module only sees ids it can look
 * up in the same graph and emits finished GraphEvents in order.
 */

export interface ReviewLifecycleDeps {
  /** The lifecycle only needs the snapshot read and setReview. */
  graph: {
    snapshot(): GraphSnapshot;
    setReview(id: string, review: AiReview | undefined): boolean;
  };
  /** Fan-out for the emitted events; typically wired to the WsHub. */
  broadcast?(event: GraphEvent): void;
}

/** Verdict vocabulary, owned here because verdict cleaning is owned here. */
export const AI_VERDICTS: readonly AiVerdict[] = ['confident', 'unsure', 'error'];

// The verdict-shape budgets, single source for the whole review pipeline:
// the lifecycle cleans live input, review-store re-cleans disk revivals with
// THE SAME function, and mcp.ts interpolates these numbers into every
// user-visible text (tool descriptions, playbook) — a number may not be
// retyped anywhere (architecture review 2026-09-05, candidates #2/#10).
export const MAX_VERDICT_ENTRIES = 500;
export const MAX_VERDICT_MESSAGE = 200;
export const MAX_REVIEW_SUMMARY = 500;
/** Interface knowledge: after this long an unanswered begin retires itself. */
export const REVIEW_CHECKING_TIMEOUT_MS = 10 * 60 * 1000;

export interface BeginResult {
  checking: AiReview;
}

export type UpdateResult =
  | { ok: true; checking: AiReview; verdictCount: number }
  | { ok: false; reason: 'no-review-in-progress' };

export interface EndResult {
  done: AiReview;
  verdictCount: number;
}

/**
 * Validate and normalise raw verdict entries: non-objects, bad lines and
 * unknown verdicts are dropped silently (a partial review beats none);
 * messages are truncated; per line the LAST entry wins; output is sorted by
 * line and capped at MAX_VERDICT_ENTRIES.
 *
 * Exported because the disk reviver (review-store) must produce the EXACT
 * same shape as the live path — one cleaner, no forks (候选 #2).
 */
export function normalizeVerdicts(raw: unknown): AiReviewEntry[] {
  if (!Array.isArray(raw)) return [];
  const byLine = new Map<number, AiReviewEntry>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as { line?: unknown; verdict?: unknown; message?: unknown };
    if (typeof e.line !== 'number' || !Number.isInteger(e.line) || e.line < 1) continue;
    if (typeof e.verdict !== 'string' || !AI_VERDICTS.includes(e.verdict as AiVerdict)) continue;
    const entry: AiReviewEntry = { line: e.line, verdict: e.verdict as AiVerdict };
    if (typeof e.message === 'string' && e.message.trim().length > 0) {
      entry.message = e.message.trim().slice(0, MAX_VERDICT_MESSAGE);
    }
    byLine.set(entry.line, entry);
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line).slice(0, MAX_VERDICT_ENTRIES);
}

/**
 * Fold one update batch into the pending verdicts — on the same line the
 * batch entry wins (the same last-wins rule normalizeVerdicts applies within
 * one batch); output stays line-sorted and capped at MAX_VERDICT_ENTRIES.
 */
function mergeVerdicts(existing: AiReviewEntry[], batch: AiReviewEntry[]): AiReviewEntry[] {
  const byLine = new Map<number, AiReviewEntry>();
  for (const e of existing) byLine.set(e.line, e);
  for (const e of batch) byLine.set(e.line, e);
  return [...byLine.values()].sort((a, b) => a.line - b.line).slice(0, MAX_VERDICT_ENTRIES);
}

export function createReviewLifecycle(deps: ReviewLifecycleDeps) {
  const { graph } = deps;
  const broadcast = (event: GraphEvent): void => deps.broadcast?.(event);
  const findNode = (id: string): ModuleNode | undefined => graph.snapshot().nodes.find((n) => n.id === id);

  // node id → pending checking-timeout timer. Cleared by end_review and by a
  // re-arm; the callback is a no-op unless the node still carries the exact
  // review object captured when the timer was armed, so a rescan or a fresh
  // begin disarms stale timers for free.
  const checkingTimers = new Map<string, NodeJS.Timeout>();
  const clearCheckingTimer = (id: string): void => {
    const timer = checkingTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      checkingTimers.delete(id);
    }
  };
  const armCheckingTimer = (id: string, path: string, checking: AiReview): void => {
    clearCheckingTimer(id);
    const timer = setTimeout(() => {
      checkingTimers.delete(id);
      const current = findNode(id);
      if (current === undefined || current.aiReview !== checking) return;
      graph.setReview(id, undefined);
      // The paired node_update must precede review_timeout: the dashboard
      // stops the pulse on the update and explains it on the timeout.
      broadcast({ type: 'node_update', node: current });
      broadcast({ type: 'review_timeout', id, path });
    }, REVIEW_CHECKING_TIMEOUT_MS);
    timer.unref?.(); // never keep the dashboard process alive for a dangling check
    checkingTimers.set(id, timer);
  };

  return {
    /** Mark a module checking and arm its timeout. `id` must resolve in the graph. */
    begin(id: string, path: string): BeginResult {
      const checking: AiReview = { status: 'checking', verdicts: [] };
      graph.setReview(id, checking);
      armCheckingTimer(id, path, checking);
      const node = findNode(id);
      if (node !== undefined) broadcast({ type: 'node_update', node });
      return { checking };
    },

    /**
     * Fold a partial verdict batch into the pending review and re-arm the
     * timeout (the fresh checking object would otherwise outlive the timer's
     * identity token and leave the module stuck in checking forever).
     */
    update(id: string, path: string, rawVerdicts: unknown): UpdateResult {
      const pending = findNode(id)?.aiReview;
      if (pending === undefined || pending.status !== 'checking') {
        return { ok: false, reason: 'no-review-in-progress' };
      }
      const checking: AiReview = {
        status: 'checking',
        verdicts: mergeVerdicts(pending.verdicts, normalizeVerdicts(rawVerdicts))
      };
      graph.setReview(id, checking);
      armCheckingTimer(id, path, checking);
      const node = findNode(id);
      if (node !== undefined) broadcast({ type: 'node_update', node });
      return { ok: true, checking, verdictCount: checking.verdicts.length };
    },

    /** Land the final verdicts, disarm the timeout, broadcast the done state. */
    end(id: string, rawVerdicts: unknown, rawSummary: unknown): EndResult {
      const verdicts = normalizeVerdicts(rawVerdicts);
      const summary =
        typeof rawSummary === 'string' && rawSummary.trim().length > 0
          ? rawSummary.trim().slice(0, MAX_REVIEW_SUMMARY)
          : undefined;

      clearCheckingTimer(id);
      const review: AiReview = { status: 'done', verdicts, reviewedAt: Date.now() };
      if (summary !== undefined) review.summary = summary;
      graph.setReview(id, review);
      const node = findNode(id);
      if (node !== undefined) broadcast({ type: 'node_update', node });
      return { done: review, verdictCount: verdicts.length };
    }
  };
}
