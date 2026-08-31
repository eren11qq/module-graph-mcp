import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReviewStore, type ReviewGraph } from '../src/server/review-store.js';
import type { AiReview, ModuleNode } from '../src/shared/types.js';

/**
 * 常驻 (2026-09-01): the persistent AI-review store — done verdicts survive
 * process restarts, so the dashboard's green/amber/red rings come back on
 * the next cold start instead of vanishing with the popup page.
 *
 * Interface under test: attachInto / set / remove + the on-disk
 * `.module-graph/reviews.json` round-trip, the checking-drop rule, the
 * stale-entry prune and the read-merge-write concurrency safety.
 */

const dirs: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'review-store-'));
  dirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function done(over: Partial<AiReview> = {}): AiReview {
  return { status: 'done', verdicts: [], ...over };
}

function fakeGraph(nodes: string[]): { graph: ReviewGraph; nodesById: Map<string, ModuleNode> } {
  const nodesById = new Map(nodes.map((id) => [id, { id, path: id, language: 'ts' as const, testState: 'untested' as const, coveredBy: [], typeErrors: [] }]));
  return {
    nodesById,
    graph: {
      node: (id) => nodesById.get(id),
      setReview: (id, review) => {
        const n = nodesById.get(id);
        if (!n) return false;
        n.aiReview = review;
        return true;
      }
    }
  };
}

const storeFile = (root: string): string => join(root, '.module-graph', 'reviews.json');

async function writeStoreFile(root: string, body: unknown): Promise<void> {
  await mkdir(join(root, '.module-graph'), { recursive: true });
  await writeFile(storeFile(root), JSON.stringify(body), 'utf8');
}

describe('createReviewStore — round trip', () => {
  it('end_review conclusions survive a full store restart (attach back onto nodes)', async () => {
    const root = await tempRoot();
    const a = createReviewStore({ rootPath: root });
    a.set('src/a.ts', done({ verdicts: [{ line: 3, verdict: 'confident' }], summary: 'ok', reviewedAt: 1234 }));

    // Fresh store instance = fresh process: only the disk file remains.
    const b = createReviewStore({ rootPath: root });
    const { graph, nodesById } = fakeGraph(['src/a.ts', 'src/b.ts']);
    const restored = b.attachInto(graph);
    expect(restored).toBe(1);
    expect(nodesById.get('src/a.ts')!.aiReview).toEqual(
      done({ verdicts: [{ line: 3, verdict: 'confident' }], summary: 'ok', reviewedAt: 1234 })
    );
    expect(nodesById.get('src/b.ts')!.aiReview).toBeUndefined();
  });

  it('set(undefined) clears the entry for good', async () => {
    const root = await tempRoot();
    const a = createReviewStore({ rootPath: root });
    a.set('src/a.ts', done());
    a.set('src/a.ts', undefined);

    const b = createReviewStore({ rootPath: root });
    const { graph, nodesById } = fakeGraph(['src/a.ts']);
    expect(b.attachInto(graph)).toBe(0);
    expect(nodesById.get('src/a.ts')!.aiReview).toBeUndefined();
  });

  it('remove(ids) drops the entries (file unlinked)', async () => {
    const root = await tempRoot();
    const a = createReviewStore({ rootPath: root });
    a.set('src/a.ts', done());
    a.set('src/b.ts', done());
    a.remove(['src/a.ts']);

    const b = createReviewStore({ rootPath: root });
    const { graph, nodesById } = fakeGraph(['src/a.ts', 'src/b.ts']);
    expect(b.attachInto(graph)).toBe(1);
    expect(nodesById.get('src/a.ts')!.aiReview).toBeUndefined();
    expect(nodesById.get('src/b.ts')!.aiReview).toEqual(done());
  });
});

describe('createReviewStore — load rules', () => {
  it('checking states are never restored (a restored pulse has no timer)', async () => {
    const root = await tempRoot();
    await writeStoreFile(root, {
      version: 1,
      reviews: {
        'src/a.ts': { status: 'checking', verdicts: [{ line: 1, verdict: 'confident' }] },
        'src/b.ts': done()
      }
    });
    const b = createReviewStore({ rootPath: root });
    const { graph, nodesById } = fakeGraph(['src/a.ts', 'src/b.ts']);
    expect(b.attachInto(graph)).toBe(1);
    expect(nodesById.get('src/a.ts')!.aiReview).toBeUndefined();
    expect(nodesById.get('src/b.ts')!.aiReview).toEqual(done());
  });

  it('entries for files that no longer exist are pruned from the file too', async () => {
    const root = await tempRoot();
    const a = createReviewStore({ rootPath: root });
    a.set('src/gone.ts', done());

    const b = createReviewStore({ rootPath: root });
    const { graph } = fakeGraph(['src/still-here.ts']);
    expect(b.attachInto(graph)).toBe(0);
    const onDisk = JSON.parse(await readFile(storeFile(root), 'utf8')) as { reviews: Record<string, unknown> };
    expect(onDisk.reviews).toEqual({});
  });

  it('a corrupt or foreign file degrades to empty instead of crashing', async () => {
    const root = await tempRoot();
    await mkdir(join(root, '.module-graph'), { recursive: true });
    await writeFile(storeFile(root), '{{{ not json', 'utf8');
    const a = createReviewStore({ rootPath: root, log: () => {} });
    const { graph, nodesById } = fakeGraph(['src/a.ts']);
    expect(a.attachInto(graph)).toBe(0);
    expect(nodesById.get('src/a.ts')!.aiReview).toBeUndefined();

    await writeStoreFile(root, { version: 99, reviews: {} });
    const b = createReviewStore({ rootPath: root, log: () => {} });
    expect(b.attachInto(graph)).toBe(0);
  });

  it('verdict entries outside the vocabulary are dropped on load', async () => {
    const root = await tempRoot();
    await writeStoreFile(root, {
      version: 1,
      reviews: { 'src/a.ts': { status: 'done', verdicts: [{ line: 1, verdict: 'maybe' }, { line: 2, verdict: 'error' }] } }
    });
    const a = createReviewStore({ rootPath: root });
    const { graph, nodesById } = fakeGraph(['src/a.ts']);
    a.attachInto(graph);
    expect(nodesById.get('src/a.ts')!.aiReview!.verdicts).toEqual([{ line: 2, verdict: 'error' }]);
  });
});

describe('createReviewStore — concurrency', () => {
  it('two processes writing different files both survive (read-merge-write)', async () => {
    const root = await tempRoot();
    const a = createReviewStore({ rootPath: root });
    a.set('src/a.ts', done());

    // Process B starts later (loads a's file), ends its own review, writes.
    const b = createReviewStore({ rootPath: root });
    b.set('src/b.ts', done());

    // Process C cold-starts: both conclusions are there.
    const c = createReviewStore({ rootPath: root });
    const { graph, nodesById } = fakeGraph(['src/a.ts', 'src/b.ts']);
    expect(c.attachInto(graph)).toBe(2);
    expect(nodesById.get('src/a.ts')!.aiReview).toEqual(done());
    expect(nodesById.get('src/b.ts')!.aiReview).toEqual(done());
  });

  it('a deletion tombstone wins over a stale disk residue (same key)', async () => {
    const root = await tempRoot();
    const a = createReviewStore({ rootPath: root });
    a.set('src/a.ts', done());
    a.remove(['src/a.ts']); // unlink: must not resurrect from disk

    const b = createReviewStore({ rootPath: root });
    const { graph, nodesById } = fakeGraph(['src/a.ts']);
    expect(b.attachInto(graph)).toBe(0);
    expect(nodesById.get('src/a.ts')!.aiReview).toBeUndefined();
  });
});

describe('createReviewStore — hygiene', () => {
  it('writes atomically under .module-graph/ and gitignores the dir by default', async () => {
    const root = await tempRoot();
    const a = createReviewStore({ rootPath: root });
    a.set('src/a.ts', done());
    const gitignore = await readFile(join(root, '.module-graph', '.gitignore'), 'utf8');
    expect(gitignore).toContain('*');
    expect(gitignore).toContain('!.gitignore');
    expect((await readFile(storeFile(root), 'utf8')).trim().length).toBeGreaterThan(0);
  });

  it('a root that cannot be written degrades to in-memory with a single warning, never throws', async () => {
    const root = await tempRoot();
    // A regular file where the .module-graph dir would go: mkdir fails ENOTDIR.
    await writeFile(join(root, '.module-graph'), 'blocking file', 'utf8');
    const warnings: string[] = [];
    const a = createReviewStore({ rootPath: root, log: (m) => warnings.push(m) });
    expect(() => a.set('src/a.ts', done())).not.toThrow();
    expect(warnings.length).toBe(1);
    // Second failure stays silent (warn once).
    a.set('src/b.ts', done());
    expect(warnings.length).toBe(1);
  });
});
