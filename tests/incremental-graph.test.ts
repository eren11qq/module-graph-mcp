import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncrementalGraph } from '../src/server/incremental-graph.js';
import type { GraphSnapshot } from '../src/shared/types.js';
import { makeTempProject } from './helpers/temp-project.js';

/**
 * Engine tests. The parity assertions pin the windowed path (applyEvents) to
 * a reference full rebuild (a fresh engine's fullScan over the same tree) —
 * incremental state must equal the from-scratch truth after every window.
 */

/** Compare everything except generatedAt (rootPath is identical by construction). */
function comparable(s: GraphSnapshot): Pick<GraphSnapshot, 'nodes' | 'edges'> {
  return { nodes: s.nodes, edges: s.edges };
}

async function referenceSnapshot(root: string): Promise<GraphSnapshot> {
  const reference = new IncrementalGraph(root);
  await reference.fullScan();
  return reference.snapshot();
}

const SEED: Record<string, string> = {
  'entry.ts': "import { x } from './x';\nimport { c } from './c';\nexport const entry = x + c;\n",
  'a.ts': 'export const a = 1;\n',
  'b.ts': "import { a } from './a';\nexport const b = a;\n",
  'c.ts': "import { b } from './b';\nexport const c = b;\n",
  'x.ts': "import { y } from './y';\nexport const x = 1;\n",
  'y.ts': "import { x } from './x';\nexport const y = 2;\n"
};

describe('IncrementalGraph', () => {
  it('baseline fullScan equals the reference rebuild on the seeded fixture', async () => {
    const root = await makeTempProject(SEED);
    try {
      const graph = new IncrementalGraph(root);
      await graph.fullScan();
      expect(comparable(graph.snapshot())).toEqual(comparable(await referenceSnapshot(root)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stays identical to the full rebuild across add / change / delete / cycle windows', async () => {
    const root = await makeTempProject(SEED);
    try {
      const graph = new IncrementalGraph(root);
      await graph.fullScan();

      // window 1: a new file importing existing modules (creates a second
      // importer for a.ts and an edge into the x⇄y cycle)
      await writeFile(join(root, 'new.ts'), "import { a } from './a';\nimport { y } from './y';\nexport const n = a + y;\n", 'utf8');
      await graph.applyEvents([{ path: join(root, 'new.ts'), kind: 'add' }]);
      expect(comparable(graph.snapshot())).toEqual(comparable(await referenceSnapshot(root)));

      // window 2: redirect b's import → creates the b⇄c cycle
      await writeFile(join(root, 'b.ts'), "import { a } from './a';\nimport { c } from './c';\nexport const b = a;\n", 'utf8');
      await graph.applyEvents([{ path: join(root, 'b.ts'), kind: 'change' }]);
      expect(comparable(graph.snapshot())).toEqual(comparable(await referenceSnapshot(root)));

      // window 3: delete a file with in- AND out-edges
      await unlink(join(root, 'b.ts'));
      await graph.applyEvents([{ path: join(root, 'b.ts'), kind: 'unlink' }]);
      expect(comparable(graph.snapshot())).toEqual(comparable(await referenceSnapshot(root)));

      // window 4: re-create b.ts (node comes back, cycle closes again)
      await writeFile(join(root, 'b.ts'), "import { a } from './a';\nexport const b = a;\n", 'utf8');
      await graph.applyEvents([{ path: join(root, 'b.ts'), kind: 'add' }]);
      expect(comparable(graph.snapshot())).toEqual(comparable(await referenceSnapshot(root)));

      // window 5: a burst of several events lands in one window
      await writeFile(join(root, 'd.ts'), "import { a } from './a';\nexport const d = 1;\n", 'utf8');
      await writeFile(join(root, 'a.ts'), 'export const a = 9;\n', 'utf8');
      await unlink(join(root, 'd.ts'));
      await graph.applyEvents([
        { path: join(root, 'd.ts'), kind: 'add' },
        { path: join(root, 'a.ts'), kind: 'change' },
        { path: join(root, 'd.ts'), kind: 'unlink' }
      ]);
      expect(comparable(graph.snapshot())).toEqual(comparable(await referenceSnapshot(root)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a single-file save re-parses exactly that file — no other file is touched', async () => {
    const root = await makeTempProject(SEED);
    try {
      const graph = new IncrementalGraph(root);
      await graph.fullScan();

      const parseCounts = new Map<string, number>();
      const original = graph.parseSpecifiers.bind(graph);
      graph.parseSpecifiers = async (rel: string) => {
        parseCounts.set(rel, (parseCounts.get(rel) ?? 0) + 1);
        return original(rel);
      };

      await writeFile(join(root, 'a.ts'), 'export const a = 42;\n', 'utf8');
      const delta = await graph.applyEvents([{ path: join(root, 'a.ts'), kind: 'change' }]);

      // Only a.ts was re-parsed; no delta at all (pure content change, no
      // import changes → graph shape unchanged → nothing to push).
      expect([...parseCounts.keys()]).toEqual(['a.ts']);
      expect(delta.addedNodes).toEqual([]);
      expect(delta.removedNodeIds).toEqual([]);
      expect(delta.addedEdges).toEqual([]);
      expect(delta.removedEdges).toEqual([]);

      // Content-only change: the node survives with its identity intact.
      expect(graph.snapshot().nodes.find((n) => n.id === 'a.ts')).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deleting a file cleans up all of its in-edges and out-edges', async () => {
    const root = await makeTempProject(SEED);
    try {
      const graph = new IncrementalGraph(root);
      await graph.fullScan();

      // b.ts: in-edge from c.ts, out-edge to a.ts.
      await unlink(join(root, 'b.ts'));
      const delta = await graph.applyEvents([{ path: join(root, 'b.ts'), kind: 'unlink' }]);

      expect(delta.removedNodeIds).toEqual(['b.ts']);
      expect(delta.removedEdges).toEqual([
        { from: 'b.ts', to: 'a.ts' },
        { from: 'c.ts', to: 'b.ts' }
      ]);
      expect(delta.addedEdges).toEqual([]);
      expect(graph.snapshot().edges.some((e) => e.from === 'b.ts' || e.to === 'b.ts')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('delta payload stays tiny compared to the full snapshot on a 40-file project', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      const imports = i < 39 ? `import { v } from './m${i + 1}';\n` : '';
      files[`m${i}.ts`] = `${imports}export const v = ${i};\n`;
    }
    const root = await makeTempProject(files);
    try {
      const graph = new IncrementalGraph(root);
      await graph.fullScan();
      const fullSnapshot = graph.snapshot();

      // Redirect a single import deep in the chain.
      await writeFile(join(root, 'm0.ts'), "import { v } from './m39';\nexport const v = 0;\n", 'utf8');
      const delta = await graph.applyEvents([{ path: join(root, 'm0.ts'), kind: 'change' }]);

      const deltaJson = JSON.stringify(delta);
      const snapshotJson = JSON.stringify(fullSnapshot);
      expect(delta.addedEdges).toEqual([{ from: 'm0.ts', to: 'm39.ts' }]);
      expect(delta.removedEdges).toEqual([{ from: 'm0.ts', to: 'm1.ts' }]);
      expect(delta.addedNodes).toEqual([]);
      expect(delta.removedNodeIds).toEqual([]);
      // One redirected edge versus a 40-node/40-edge snapshot: far below 1/10.
      expect(deltaJson.length).toBeLessThan(snapshotJson.length / 10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
