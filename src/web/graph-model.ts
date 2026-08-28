import type { Edge, GraphDelta, GraphSnapshot, ModuleNode } from '../shared/types.js';

/**
 * The browser-side graph state: exactly ONE module folds the three wire
 * frames (snapshot / graph_delta / node_update) into the current graph and
 * answers topology questions (adjacency) for every consumer. Before this
 * module, main.ts and graph-view each kept their own copy and folded the
 * same delta twice; the copies could only drift.
 *
 * Pure data-in/data-out — no DOM, no cytoscape — so the fold is tested
 * directly at this interface.
 */

export interface Neighbors {
  /** ids of modules that import this one */
  incoming: string[];
  /** ids of modules this one imports */
  outgoing: string[];
}

export interface GraphModel {
  foldSnapshot(snapshot: GraphSnapshot): void;
  foldDelta(delta: GraphDelta): void;
  /** Patches a known node; a node_update for an unknown id adds it. */
  foldNodeUpdate(node: ModuleNode): void;
  /** Watched root as carried by the last snapshot, if one has arrived. */
  rootPath(): string | undefined;
  nodes(): ModuleNode[];
  edges(): Edge[];
  node(id: string): ModuleNode | undefined;
  neighbors(id: string): Neighbors;
}

const edgeKey = (e: Edge): string => `${e.from}\u0000${e.to}`;

export function createGraphModel(): GraphModel {
  const nodes = new Map<string, ModuleNode>();
  const edges = new Map<string, Edge>();
  let root: string | undefined;

  function foldSnapshot(snapshot: GraphSnapshot): void {
    nodes.clear();
    edges.clear();
    root = snapshot.rootPath;
    for (const n of snapshot.nodes) nodes.set(n.id, n);
    for (const e of snapshot.edges) edges.set(edgeKey(e), e);
  }

  function foldDelta(delta: GraphDelta): void {
    for (const e of delta.removedEdges) edges.delete(edgeKey(e));
    for (const id of delta.removedNodeIds) nodes.delete(id);
    for (const n of delta.addedNodes) nodes.set(n.id, n);
    for (const e of delta.addedEdges) edges.set(edgeKey(e), e);
  }

  function foldNodeUpdate(node: ModuleNode): void {
    nodes.set(node.id, node);
  }

  return {
    foldSnapshot,
    foldDelta,
    foldNodeUpdate,
    rootPath: () => root,
    nodes: () => [...nodes.values()],
    edges: () => [...edges.values()],
    node: (id) => nodes.get(id),
    neighbors(id) {
      const incoming: string[] = [];
      const outgoing: string[] = [];
      for (const e of edges.values()) {
        if (e.to === id) incoming.push(e.from);
        if (e.from === id) outgoing.push(e.to);
      }
      return { incoming, outgoing };
    }
  };
}
