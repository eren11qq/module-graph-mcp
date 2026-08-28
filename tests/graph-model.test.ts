import { describe, expect, it } from 'vitest';
import { createGraphModel } from '../src/web/graph-model.js';
import type { GraphDelta, GraphSnapshot } from '../src/shared/types.js';

/**
 * The one browser-side fold: snapshot / delta / node_update frames land here
 * and nothing else may keep a second copy of the graph. Adjacency (the detail
 * panel's in/out lists) is answered through the same interface.
 */

const snapshot: GraphSnapshot = {
  rootPath: '/proj',
  generatedAt: 1,
  nodes: [
    { id: 'a.ts', path: 'a.ts', language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [] },
    { id: 'b.ts', path: 'b.ts', language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [] }
  ],
  edges: [{ from: 'b.ts', to: 'a.ts' }]
};

describe('GraphModel fold', () => {
  it('folds a snapshot into nodes, edges and the root path', () => {
    const model = createGraphModel();
    model.foldSnapshot(snapshot);
    expect(model.nodes().map((n) => n.id).sort()).toEqual(['a.ts', 'b.ts']);
    expect(model.edges()).toEqual([{ from: 'b.ts', to: 'a.ts' }]);
    expect(model.rootPath()).toBe('/proj');
    expect(model.node('a.ts')).toBeDefined();
    expect(model.node('missing.ts')).toBeUndefined();
  });

  it('folds a delta: removals first, then additions (net effect)', () => {
    const model = createGraphModel();
    model.foldSnapshot(snapshot);
    const delta: GraphDelta = {
      addedNodes: [
        { id: 'c.ts', path: 'c.ts', language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [] }
      ],
      removedNodeIds: ['b.ts'],
      addedEdges: [{ from: 'c.ts', to: 'a.ts' }],
      removedEdges: [{ from: 'b.ts', to: 'a.ts' }]
    };
    model.foldDelta(delta);
    expect(model.nodes().map((n) => n.id)).toEqual(['a.ts', 'c.ts']);
    expect(model.edges()).toEqual([{ from: 'c.ts', to: 'a.ts' }]);
  });

  it('re-adds an unknown node via node_update and replaces a known one', () => {
    const model = createGraphModel();
    model.foldSnapshot(snapshot);
    model.foldNodeUpdate({
      id: 'a.ts', path: 'a.ts', language: 'ts', testState: 'passing', coveredBy: ['a.test.ts'], typeErrors: []
    });
    expect(model.node('a.ts')!.testState).toBe('passing');
    model.foldNodeUpdate({
      id: 'new.ts', path: 'new.ts', language: 'ts', testState: 'untested', coveredBy: [], typeErrors: []
    });
    expect(model.node('new.ts')).toBeDefined();
  });

  it('answers adjacency: incoming = importers, outgoing = imports', () => {
    const model = createGraphModel();
    model.foldSnapshot(snapshot);
    expect(model.neighbors('a.ts')).toEqual({ incoming: ['b.ts'], outgoing: [] });
    expect(model.neighbors('b.ts')).toEqual({ incoming: [], outgoing: ['a.ts'] });
    expect(model.neighbors('ghost.ts')).toEqual({ incoming: [], outgoing: [] });
  });

  it('a fresh snapshot replaces everything a previous graph held', () => {
    const model = createGraphModel();
    model.foldSnapshot(snapshot);
    model.foldSnapshot({ ...snapshot, nodes: [], edges: [], rootPath: '/other' });
    expect(model.nodes()).toEqual([]);
    expect(model.edges()).toEqual([]);
    expect(model.rootPath()).toBe('/other');
  });
});
