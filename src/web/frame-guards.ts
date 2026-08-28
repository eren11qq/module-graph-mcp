import type { GraphDelta, GraphSnapshot, ModuleNode } from '../shared/types.js';

/**
 * Runtime guards for WS frames (P1-3): the server is the only sender, but a
 * malformed frame must never throw inside a client callback and kill the
 * render loop. Frames failing their guard are dropped whole (with a
 * console.warn at the dispatch site) instead of being blindly `as`-cast.
 */

export function isGraphSnapshot(v: unknown): v is GraphSnapshot {
  const s = v as Partial<GraphSnapshot> | null;
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.rootPath === 'string' &&
    Array.isArray(s.nodes) &&
    Array.isArray(s.edges)
  );
}

export function isGraphDelta(v: unknown): v is GraphDelta {
  const d = v as Partial<GraphDelta> | null;
  return (
    typeof d === 'object' &&
    d !== null &&
    Array.isArray(d.addedNodes) &&
    Array.isArray(d.removedNodeIds) &&
    Array.isArray(d.addedEdges) &&
    Array.isArray(d.removedEdges)
  );
}

export function isModuleNode(v: unknown): v is ModuleNode {
  const n = v as Partial<ModuleNode> | null;
  return (
    typeof n === 'object' &&
    n !== null &&
    typeof n.id === 'string' &&
    typeof n.path === 'string' &&
    typeof n.testState === 'string' &&
    Array.isArray(n.coveredBy) &&
    Array.isArray(n.typeErrors)
  );
}
