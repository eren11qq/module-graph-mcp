import { rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncrementalGraph } from '../src/server/incremental-graph.js';
import type { Edge, GraphSnapshot, ModuleNode } from '../src/shared/types.js';
import { getFreePort } from './helpers/net.js';
import { makeTempProject } from './helpers/temp-project.js';
import { startHttpServer } from '../src/server/http.js';

/**
 * Former GraphAnalyzer coverage (Ticket 02), now exercised through the one
 * graph engine's full-rebuild mode. The hand-tallied sample-app inventory
 * still IS the manual oracle; only the driving interface changed.
 */

const FIXTURE = join('test-fixtures', 'sample-app');

async function fullScanSnapshot(root: string): Promise<GraphSnapshot> {
  const graph = new IncrementalGraph(root);
  await graph.fullScan();
  return graph.snapshot();
}

// ---------------------------------------------------------------------------
// Hand-tallied regression anchors for test-fixtures/sample-app.
// 7 source files; every one of them imports exactly as listed below, so the
// numbers below ARE the manual inventory (update deliberately, never casually).
// ---------------------------------------------------------------------------
const EXPECTED_NODE_IDS = [
  'core/app.ts',
  'core/emitter.ts',
  'index.ts',
  'store/history.ts',
  'store/state.ts',
  'utils/format.ts',
  'utils/logger.ts'
].sort();

const EXPECTED_EDGES: Array<[string, string]> = [
  ['core/app.ts', 'core/emitter.ts'], // named import
  ['core/app.ts', 'utils/format.ts'], // ./utils/format.js remap onto .ts
  ['core/emitter.ts', 'store/state.ts'], // cycle forward
  ['index.ts', 'core/app.ts'], // named import
  ['index.ts', 'core/emitter.ts'], // side-effect import
  ['index.ts', 'store/history.ts'], // dynamic import()
  ['store/history.ts', 'utils/logger.ts'], // named import
  ['store/state.ts', 'core/emitter.ts'] // cycle back
];

function sortedEdgePairs(snapshot: GraphSnapshot): Array<[string, string]> {
  return snapshot.edges
    .map((e) => [e.from, e.to] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
}

describe('full rebuild on test-fixtures/sample-app (Ticket 02)', () => {
  it('returns exactly the hand-tallied node and edge inventory', async () => {
    const snapshot = await fullScanSnapshot(FIXTURE);

    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual(EXPECTED_NODE_IDS);
    // 7 nodes; the .txt junk file produces no node.
    expect(snapshot.nodes.length).toBe(7);
    expect(snapshot.edges.length).toBe(8);
    expect(sortedEdgePairs(snapshot)).toEqual(EXPECTED_EDGES.sort());
    expect(snapshot.rootPath.endsWith('sample-app')).toBe(true);
    expect(typeof snapshot.generatedAt).toBe('number');
  });

  it('emits both cycle edges with importer-first direction', async () => {
    const snapshot = await fullScanSnapshot(FIXTURE);
    const edges = sortedEdgePairs(snapshot);
    // from = whoever wrote the import, to = whoever is imported
    expect(edges).toContainEqual(['core/emitter.ts', 'store/state.ts']);
    expect(edges).toContainEqual(['store/state.ts', 'core/emitter.ts']);
  });

  it('aligns every node and edge with the shared types, key by key', async () => {
    const snapshot = await fullScanSnapshot(FIXTURE);

    for (const node of snapshot.nodes) {
      // Compile-time proof: this literal only typechecks if the engine
      // output satisfies ModuleNode exactly.
      const aligned: ModuleNode = {
        id: node.id,
        path: node.path,
        language: node.language,
        testState: node.testState,
        coveredBy: node.coveredBy,
        typeErrors: node.typeErrors,
        ...(node.lastTestRunAt === undefined ? {} : { lastTestRunAt: node.lastTestRunAt })
      };
      expect(aligned.id).toBe(node.id);
      expect(aligned.path).toBe(node.id);
      expect(['ts', 'tsx', 'js', 'jsx']).toContain(aligned.language);
      expect(aligned.testState).toBe('untested');
      expect(aligned.coveredBy).toEqual([]);
      expect(aligned.typeErrors).toEqual([]);
      expect(aligned.lastTestRunAt).toBeUndefined();
    }

    for (const edge of snapshot.edges) {
      const aligned: Edge = { from: edge.from, to: edge.to };
      expect(Object.keys(edge).sort()).toEqual(['from', 'to']);
      expect(typeof aligned.from).toBe('string');
      expect(typeof aligned.to).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Temporary-project scenarios
// ---------------------------------------------------------------------------

describe('full rebuild on temporary projects (Ticket 02)', () => {
  it('ignores node_modules entirely: no nodes and no edges for bare-ish local hits inside it', async () => {
    const root = await makeTempProject({
      'src/index.js': "import { helper } from '../node_modules/foo/index.js';\nexport const x = helper;\n",
      'node_modules/foo/index.js': 'export const helper = 1;\n'
    });
    try {
      const snapshot = await fullScanSnapshot(root);
      expect(snapshot.nodes.map((n) => n.id)).toEqual(['src/index.js']);
      expect(snapshot.edges).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drops deleted files and their edges on a fresh scan (no stale nodes)', async () => {
    const root = await makeTempProject({
      'a.js': 'export const a = 1;\n',
      'b.js': "import { a } from './a.js';\nexport const b = a;\n"
    });
    try {
      const before = await fullScanSnapshot(root);
      expect(before.nodes.map((n) => n.id).sort()).toEqual(['a.js', 'b.js']);
      expect(before.edges).toEqual([{ from: 'b.js', to: 'a.js' }]);

      await unlink(join(root, 'b.js'));
      const after = await fullScanSnapshot(root);
      expect(after.nodes.map((n) => n.id)).toEqual(['a.js']);
      expect(after.edges).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honours a root .gitignore rule; removing the rule exposes the file again', async () => {
    const root = await makeTempProject({
      'src/main.js': "export const main = 1;\n",
      'ignores/me.js': "export const me = 2;\n"
    });
    try {
      await writeFile(join(root, '.gitignore'), 'ignores/me.js\n', 'utf8');
      const hidden = await fullScanSnapshot(root);
      expect(hidden.nodes.map((n) => n.id)).toEqual(['src/main.js']);

      await writeFile(join(root, '.gitignore'), '# nothing to ignore\n', 'utf8');
      const visible = await fullScanSnapshot(root);
      expect(visible.nodes.map((n) => n.id).sort()).toEqual(['ignores/me.js', 'src/main.js']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps every source extension to its language value', async () => {
    const root = await makeTempProject({
      'one.ts': 'export const a = 1;\n',
      'two.tsx': 'export const b = 1;\n',
      'three.js': 'export const c = 1;\n',
      'four.jsx': 'export const d = 1;\n'
    });
    try {
      const snapshot = await fullScanSnapshot(root);
      const languages = Object.fromEntries(snapshot.nodes.map((n) => [n.id, n.language]));
      expect(languages).toEqual({
        'four.jsx': 'jsx',
        'one.ts': 'ts',
        'three.js': 'js',
        'two.tsx': 'tsx'
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves extensionless and directory-index relative imports', async () => {
    const root = await makeTempProject({
      'src/main.ts': "import { v1 } from './extless';\nimport { v2 } from './widget';\nexport const both = [v1, v2];\n",
      'src/extless.ts': 'export const v1 = 1;\n',
      'src/widget/index.ts': 'export const v2 = 2;\n'
    });
    try {
      const snapshot = await fullScanSnapshot(root);
      const pairs = sortedEdgePairs(snapshot);
      expect(pairs).toEqual([
        ['src/main.ts', 'src/extless.ts'],
        ['src/main.ts', 'src/widget/index.ts']
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// REST endpoint GET /api/graph
// ---------------------------------------------------------------------------

describe('GET /api/graph (Ticket 02)', () => {
  it('returns the injected snapshot as JSON when getSnapshot is provided', async () => {
    const port = await getFreePort();
    const fixtureSnapshot = await fullScanSnapshot(FIXTURE);
    const started = await startHttpServer({
      preferredPort: port,
      publicDir: join('dist', 'server', 'public'),
      info: { rootPath: '/x', port, version: 'test' },
      getSnapshot: () => fixtureSnapshot
    });
    try {
      const response = await fetch(`${started.url}/api/graph`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = (await response.json()) as GraphSnapshot;
      expect(body.nodes.length).toBe(fixtureSnapshot.nodes.length);
      expect(body.edges.length).toBe(fixtureSnapshot.edges.length);
      expect(body.rootPath).toBe(fixtureSnapshot.rootPath);
    } finally {
      started.server.closeAllConnections?.();
      started.server.close();
    }
  });

  it('answers 503 {"error":"graph not ready"} when getSnapshot is not wired', async () => {
    const port = await getFreePort();
    const started = await startHttpServer({
      preferredPort: port,
      publicDir: join('dist', 'server', 'public'),
      info: { rootPath: '/x', port, version: 'test' }
    });
    try {
      const response = await fetch(`${started.url}/api/graph`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'graph not ready' });
    } finally {
      started.server.closeAllConnections?.();
      started.server.close();
    }
  });
});
