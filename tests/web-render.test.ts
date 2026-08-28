import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { IncrementalGraph } from '../src/server/incremental-graph.js';
import { hierarchyLayout, type HierarchyLayoutResult, type LayoutGraphInput } from '../src/web/hierarchy-layout.js';
import { isGraphDelta, isGraphSnapshot, isModuleNode } from '../src/web/frame-guards.js';
import type { GraphSnapshot } from '../src/shared/types.js';

const DIST_PUBLIC = join('dist', 'server', 'public');
const FIXTURE = join('test-fixtures', 'sample-app');

function toLayoutInput(snapshot: GraphSnapshot): LayoutGraphInput {
  return {
    nodes: snapshot.nodes.map((n) => ({ id: n.id })),
    links: snapshot.edges.map((e) => ({ from: e.from, to: e.to }))
  };
}

// ---------------------------------------------------------------------------
// Build artifacts: vite must have emitted the dashboard into the directory
// the server process serves statically (single-process delivery).
// ---------------------------------------------------------------------------

describe('built dashboard artifacts (Ticket 03)', () => {
  it('emits index.html with the canvas mount and bundled JS into dist/server/public', () => {
    const htmlPath = join(DIST_PUBLIC, 'index.html');
    if (!existsSync(htmlPath)) {
      throw new Error(
        'dist/server/public/index.html is missing — run `npm run build` before `npm test`'
      );
    }
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('Module Graph');
    expect(html).toContain('id="cy"');

    const assetsDir = join(DIST_PUBLIC, 'assets');
    expect(existsSync(assetsDir)).toBe(true);
    const assets = readdirSync(assetsDir);
    expect(assets.some((f) => f.endsWith('.js'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hierarchyLayout against the real sample-app snapshot (ticket-03 handoff:
// 全节点有 pos / 非回边 y 严格递增 / backEdges 恰含 state⇄emitter 环弧 / 多根不重叠)
// ---------------------------------------------------------------------------

describe('hierarchyLayout on the sample-app snapshot (Ticket 03)', () => {
  let snapshot: GraphSnapshot;
  let result: HierarchyLayoutResult;

  beforeAll(async () => {
    const graph = new IncrementalGraph(FIXTURE);
    await graph.fullScan();
    snapshot = graph.snapshot();
    result = hierarchyLayout(toLayoutInput(snapshot));
  });

  it('assigns finite positions to every node', () => {
    for (const n of snapshot.nodes) {
      const p = result.pos.get(n.id);
      expect(p, n.id).toBeDefined();
      expect(Number.isFinite(p!.x)).toBe(true);
      expect(Number.isFinite(p!.y)).toBe(true);
    }
  });

  it('keeps every non-back edge strictly descending (y(to) > y(from))', () => {
    for (const e of snapshot.edges) {
      const id = `${e.from}->${e.to}`;
      if (result.backEdges.has(id)) continue;
      const a = result.pos.get(e.from)!;
      const b = result.pos.get(e.to)!;
      expect(b.y, id).toBeGreaterThan(a.y);
    }
  });

  it('peels exactly one arc of the state⇄emitter cycle as the back edge', () => {
    // Both halves of the deliberate cycle exist in the data…
    const pairs = snapshot.edges.map((e) => `${e.from}->${e.to}`);
    expect(pairs).toContain('core/emitter.ts->store/state.ts');
    expect(pairs).toContain('store/state.ts->core/emitter.ts');
    // …and the engine removes exactly one deterministic arc to break it.
    expect([...result.backEdges]).toEqual(['store/state.ts->core/emitter.ts']);
  });

  it('leaves no orphans: every sample-app node is reachable from the entry', () => {
    expect(result.orphans).toEqual([]);
    expect(result.layers[0]).toEqual(['index.ts']);
  });

  it('spreads multiple in-degree-0 roots horizontally without overlap', () => {
    const multi: LayoutGraphInput = {
      nodes: [{ id: 'a.ts' }, { id: 'b.ts' }, { id: 'c.ts' }, { id: 'd.ts' }],
      links: [
        { from: 'a.ts', to: 'c.ts' },
        { from: 'b.ts', to: 'c.ts' },
        { from: 'c.ts', to: 'd.ts' }
      ]
    };
    const r = hierarchyLayout(multi);
    expect(r.layers[0]!.slice().sort()).toEqual(['a.ts', 'b.ts']);

    const a = r.pos.get('a.ts')!;
    const b = r.pos.get('b.ts')!;
    expect(a.y).toBe(0);
    expect(b.y).toBe(0);
    expect(a.x).not.toBe(b.x);
  });
});

// ---------------------------------------------------------------------------
// WS frame guards (P1-3): a malformed frame must be dropped, never crash the
// render loop (the old path crashed in mergeDelta on missing removedEdges).
// ---------------------------------------------------------------------------

describe('WS frame guards reject malformed frames (P1-3)', () => {
  const validNode = { id: 'a.ts', path: 'src/a.ts', language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [] };
  const validDelta = { addedNodes: [], removedNodeIds: [], addedEdges: [], removedEdges: [] };
  const validSnapshot = { rootPath: '/proj', generatedAt: 1, nodes: [validNode], edges: [] };

  it('graph_delta without every array field is rejected (the old crash shape)', () => {
    expect(isGraphDelta(validDelta)).toBe(true);
    expect(isGraphDelta({})).toBe(false);
    expect(isGraphDelta({ addedNodes: [], removedNodeIds: [], addedEdges: [] })).toBe(false); // removedEdges missing
    expect(isGraphDelta({ addedNodes: 'x', removedNodeIds: [], addedEdges: [], removedEdges: [] })).toBe(false);
    expect(isGraphDelta(null)).toBe(false);
    expect(isGraphDelta(42)).toBe(false);
  });

  it('snapshot and node_update guards check the fields the client dereferences', () => {
    expect(isGraphSnapshot(validSnapshot)).toBe(true);
    expect(isGraphSnapshot({ rootPath: '/p', nodes: [] })).toBe(false); // edges missing
    expect(isGraphSnapshot(null)).toBe(false);

    expect(isModuleNode(validNode)).toBe(true);
    expect(isModuleNode({ ...validNode, typeErrors: undefined })).toBe(false);
    expect(isModuleNode({ ...validNode, id: 7 })).toBe(false);
    expect(isModuleNode('a.ts')).toBe(false);
  });
});
