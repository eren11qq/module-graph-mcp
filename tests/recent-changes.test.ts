import { startHttpServer } from '../src/server/http.js';
import { IncrementalGraph } from '../src/server/incremental-graph.js';
import { startLiveReload } from '../src/server/live-reload.js';
import { createRecentChanges, RECENT_CHANGES_CAP, type RecentChanges } from '../src/server/recent-changes.js';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyEdits } from '../src/server/edit-scope.js';
import { getFreePort } from './helpers/net.js';
import { makeTempProject } from './helpers/temp-project.js';

/**
 * GitNexus port step 3: the recent-changes record.
 *
 * Part 1 pins the bounded Map semantics directly (cap eviction, recency
 * refresh, null skipping, ordering). Part 2 pins THE integration that
 * motivated the module: the watcher window records RAW event paths even when
 * applying them produced an EMPTY graph delta — a pure content edit of an
 * already-known file is the most common "changed file" signal, and the delta
 * alone would miss it.
 */

describe('createRecentChanges — bounded record semantics', () => {
  it('records, skips null/empty entries, and lists newest-first with id tie-break', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const rc = createRecentChanges();
      rc.record(['a.ts', 'b.ts', null, undefined, '']);
      expect(rc.list().map((c) => c.id)).toEqual(['a.ts', 'b.ts']); // same ms → id ascending

      // non-source files (coverage report etc.) never enter the evidence chain
      rc.record(['coverage/coverage-summary.json', 'README.md', 'c.tsx', 'd.js']);
      expect(rc.list().map((c) => c.id)).toEqual(['a.ts', 'b.ts', 'c.tsx', 'd.js']); // same ms → id ascending; non-source skipped

      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      rc.record(['c.ts']);
      expect(rc.list().map((c) => c.id)).toEqual(['c.ts', 'a.ts', 'b.ts', 'c.tsx', 'd.js']); // strictly newer first; tsx/js keep old-timestamp order

      const listed = rc.list();
      expect(listed[0]!.changedAt).toBe(Date.parse('2026-01-01T00:00:01Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-recording refreshes the timestamp AND the eviction recency', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const rc = createRecentChanges();
      for (let i = 0; i < RECENT_CHANGES_CAP; i++) rc.record([`f${i}.ts`]);
      // f0 is the oldest; refreshing it must hand eviction to f1 instead.
      rc.record(['f0.ts']);
      rc.record(['overflow.ts']);
      const ids = rc.list().map((c) => c.id);
      expect(ids).toHaveLength(RECENT_CHANGES_CAP);
      expect(ids).toContain('f0.ts'); // refreshed → survived
      expect(ids).not.toContain('f1.ts'); // oldest after the refresh → evicted
      expect(ids).toContain('overflow.ts');
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts past the cap without ever exceeding it', () => {
    const rc = createRecentChanges();
    for (let i = 0; i < RECENT_CHANGES_CAP + 10; i++) rc.record([`g${i}.ts`]);
    const ids = rc.list().map((c) => c.id);
    expect(ids).toHaveLength(RECENT_CHANGES_CAP);
    expect(ids).not.toContain('g0.ts');
    expect(ids).toContain(`g${RECENT_CHANGES_CAP + 9}.ts`);
  });

  it('clear() empties the record', () => {
    const rc = createRecentChanges();
    rc.record(['a.ts']);
    rc.clear();
    expect(rc.list()).toEqual([]);
  });
});

/**
 * Ticket 13 修法 B: the evidence chain persists to
 * <root>/.module-graph/recent-changes.json (same dir + hygiene as
 * reviews.json) — restart-loses-the-proof (假绿) is the failure this closes.
 */
describe('createRecentChanges — disk persistence (evidence survives restart)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recent-changes-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const storeFile = (): string => join(dir, '.module-graph', 'recent-changes.json');
  const writeStore = (raw: string): void => {
    mkdirSync(join(dir, '.module-graph'), { recursive: true });
    writeFileSync(storeFile(), raw, 'utf8');
  };

  it('records to disk and restores the same evidence after a "restart"', () => {
    const first = createRecentChanges({ rootPath: dir });
    first.record(['src/server/http.ts', null, 'src/server/mcp.ts']);
    expect(JSON.parse(readFileSync(storeFile(), 'utf8')).version).toBe(1);

    const revived = createRecentChanges({ rootPath: dir });
    expect(revived.list()).toEqual(first.list());

    // The pre-restart 越界 is still watcher evidence for an undeclared-scope
    // verification after the restart — the false-green path is closed.
    const v = verifyEdits(null, [], revived.list());
    expect(v.outOfScope.map((e) => e.id)).toEqual(['src/server/http.ts', 'src/server/mcp.ts']);
  });

  it('a corrupt store file is treated as empty and stays usable', () => {
    writeStore('{not json');
    const logs: string[] = [];
    const rc = createRecentChanges({ rootPath: dir, log: (m) => logs.push(m) });
    expect(rc.list()).toEqual([]);
    rc.record(['a.ts']);
    expect(rc.list().map((c) => c.id)).toEqual(['a.ts']);
    expect(logs.some((m) => m.includes('corrupt'))).toBe(true);
  });

  it('merges a same-root sibling process on write (neither side loses proof)', () => {
    const a = createRecentChanges({ rootPath: dir });
    a.record(['a.ts']);
    const b = createRecentChanges({ rootPath: dir });
    b.record(['b.ts']);
    const view = createRecentChanges({ rootPath: dir });
    expect(view.list().map((c) => c.id).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('clear() empties the disk store too (deleted evidence must not resurrect)', () => {
    const rc = createRecentChanges({ rootPath: dir });
    rc.record(['a.ts']);
    rc.clear();
    expect(createRecentChanges({ rootPath: dir }).list()).toEqual([]);
  });

  it('restores newest-first and trims an oversized file to the cap', () => {
    const base = 1_000_000;
    writeStore(
      JSON.stringify({
        version: 1,
        changes: Array.from({ length: RECENT_CHANGES_CAP + 5 }, (_, i) => ({ id: `f${i}.ts`, changedAt: base + i }))
      })
    );
    const rc = createRecentChanges({ rootPath: dir });
    const ids = rc.list().map((c) => c.id);
    expect(ids).toHaveLength(RECENT_CHANGES_CAP);
    expect(ids[0]).toBe('f104.ts'); // newest first
    expect(ids).not.toContain('f0.ts'); // oldest five dropped
  });

  it('restoring drops legacy non-source entries from disk', () => {
    writeStore(
      JSON.stringify({
        version: 1,
        changes: [
          { id: 'src/a.ts', changedAt: 1 },
          { id: 'coverage/coverage-summary.json', changedAt: 2 },
          { id: 'README.md', changedAt: 3 }
        ]
      })
    );
    const rc = createRecentChanges({ rootPath: dir });
    expect(rc.list().map((c) => c.id)).toEqual(['src/a.ts']);
  });
});

describe('live-reload feeds the record with raw watcher paths (GitNexus port)', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempProject({ 'known.ts': 'export const v1 = 1;\n' });
  });

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('records pure-content edits (empty delta) and additions alike, root-relative', async () => {
    const graph = new IncrementalGraph(root);
    const started = await startHttpServer({
      preferredPort: await getFreePort(),
      publicDir: join('dist', 'server', 'public'),
      info: { rootPath: root, port: 0, version: 'test' },
      getSnapshot: () => graph.snapshot()
    });
    const recent: RecentChanges = createRecentChanges();
    const live = startLiveReload({
      rootPath: root,
      hub: started.hub,
      log: () => {},
      debounceMs: 50,
      graph,
      recentChanges: recent,
      states: false
    });
    const teardown = async (): Promise<void> => {
      await live.stop();
      started.server.closeAllConnections?.();
      started.server.close();
    };

    try {
      await live.ready;
      await writeFile(join(root, 'known.ts'), 'export const v2 = 2;\n', 'utf8'); // empty-delta edit
      await writeFile(join(root, 'added.ts'), 'export const a = 1;\n', 'utf8'); // delta-bearing add

      // No WS client to wait on: poll the record itself.
      const deadline = Date.now() + 8000;
      while (!['added.ts', 'known.ts'].every((id) => recent.list().some((c) => c.id === id))) {
        if (Date.now() > deadline) throw new Error(`timed out; recorded: ${JSON.stringify(recent.list())}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      // Absolute watcher paths are normalised to graph-id vocabulary.
      expect(recent.list().map((c) => c.id).sort()).toEqual(['added.ts', 'known.ts']);
    } finally {
      await teardown();
    }
  });
});
