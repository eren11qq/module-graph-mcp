import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncrementalGraph } from '../src/server/incremental-graph.js';
import { makeTempProject } from './helpers/temp-project.js';

// P0-2 (2026-08-31 audit): report_note data-loss regression tests.
// Path A: a node deleted then re-added inside applyEvents was rebuilt via
// freshNode, silently dropping the user's note. Path B: a readdir failure
// (EACCES/EMFILE) made the whole subtree look empty, so its nodes were
// pruned in the same window and re-added note-less on the next one.
//
// The readdir mock is module-level (vitest replaces the import for every
// importer, including IncrementalGraph); the factory keeps the real
// implementation as the default behaviour so the rest of the suite's fs
// traffic is unaffected.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const SEED: Record<string, string> = {
  'entry.ts': "import { x } from './x';\nexport const entry = x;\n",
  'a.ts': 'export const a = 1;\n',
  'x.ts': "import { a } from './a';\nexport const x = a;\n"
};

describe('P0-2 note persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('path A: a note survives the delete/recreate cycle of its file', async () => {
    const root = await makeTempProject(SEED);
    try {
      const graph = new IncrementalGraph(root);
      await graph.fullScan();
      expect(graph.setNote('a.ts', 'my precious note')).toBe(true);

      // Editor-style save that goes through a temp rename: one window sees
      // the unlink, the next window sees the file back on disk.
      await unlink(join(root, 'a.ts'));
      await graph.applyEvents([{ path: join(root, 'a.ts'), kind: 'unlink' }]);
      expect(graph.snapshot().nodes.find((n) => n.id === 'a.ts')).toBeUndefined();

      await writeFile(join(root, 'a.ts'), 'export const a = 42;\n', 'utf8');
      await graph.applyEvents([{ path: join(root, 'a.ts'), kind: 'add' }]);

      const back = graph.snapshot().nodes.find((n) => n.id === 'a.ts');
      expect(back).toBeDefined();
      expect(back?.note).toBe('my precious note');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('path B: a readdir failure keeps the subtree nodes (and their notes) and marks the window degraded', async () => {
    const root = await makeTempProject({
      ...SEED,
      'blocked/inner.ts': 'export const inner = 1;\n'
    });
    try {
      const graph = new IncrementalGraph(root);
      await graph.fullScan();
      graph.setNote('blocked/inner.ts', 'note inside the unreadable dir');

      // Make ONLY the blocked/ directory unreadable from here on.
      const { readdir } = await import('node:fs/promises');
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(readdir).mockImplementation((path: string | URL, opts?: unknown) => {
        if (String(path).endsWith('/blocked')) {
          return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
        }
        return actual.readdir(path, opts);
      });

      // A normal save elsewhere in the tree triggers a window whose walk
      // hits the unreadable dir.
      await writeFile(join(root, 'a.ts'), 'export const a = 7;\n', 'utf8');
      const delta = await graph.applyEvents([{ path: join(root, 'a.ts'), kind: 'change' }]);

      // The subtree is NOT pruned; the note survives; the window says so.
      const inner = graph.snapshot().nodes.find((n) => n.id === 'blocked/inner.ts');
      expect(inner).toBeDefined();
      expect(inner?.note).toBe('note inside the unreadable dir');
      expect(delta.walkFailed).toBe(true);

      // Recovery: once the directory is readable again, pruning works
      // normally and the node is still there (it exists on disk).
      vi.mocked(readdir).mockImplementation((path: string | URL, opts?: unknown) => actual.readdir(path, opts));
      await graph.applyEvents([{ path: join(root, 'a.ts'), kind: 'change' }]);
      expect(graph.snapshot().nodes.find((n) => n.id === 'blocked/inner.ts')).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
