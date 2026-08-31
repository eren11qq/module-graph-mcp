/**
 * Bounded in-memory record of recently changed files (GitNexus port, plan
 * step 3): the evidence chain get_change_impact replays. The watcher window
 * records the RAW event paths (root-normalised) — recording only the
 * GraphDelta would miss the most common case, a pure content edit of an
 * already-known file, which produces an empty delta.
 *
 * Memory semantics match the AI-review state: in-memory only, a server
 * restart clears it, nothing is persisted anywhere.
 */

export interface RecentChange {
  /** Root-relative module id (same vocabulary as GraphSnapshot node ids). */
  id: string;
  /** Wall-clock ms of the most recent recording of this path. */
  changedAt: number;
}

/** Newest-wins capacity: recording past the cap evicts the OLDEST entry. */
export const RECENT_CHANGES_CAP = 100;

export interface RecentChanges {
  /**
   * Record root-relative ids (or null/undefined for outside-root paths —
   * skipped). Re-recording a path refreshes its timestamp.
   */
  record(paths: ReadonlyArray<string | null | undefined>): void;
  /** Newest first; same-millisecond ties break by id ascending. */
  list(): RecentChange[];
  clear(): void;
}

export function createRecentChanges(): RecentChanges {
  // Insertion order = recency order: re-recording a path deletes + re-inserts
  // it, so the OLDEST entry is always the Map's first key and eviction is O(1)
  // without scanning for a minimum.
  const entries = new Map<string, number>();
  return {
    record(paths) {
      for (const p of paths) {
        if (typeof p !== 'string' || p.length === 0) continue;
        entries.delete(p);
        entries.set(p, Date.now());
      }
      while (entries.size > RECENT_CHANGES_CAP) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    list() {
      return [...entries.entries()]
        .map(([id, changedAt]) => ({ id, changedAt }))
        .sort((a, b) => b.changedAt - a.changedAt || a.id.localeCompare(b.id));
    },
    clear() {
      entries.clear();
    }
  };
}
