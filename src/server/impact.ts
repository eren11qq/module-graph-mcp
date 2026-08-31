import { computeHighCentralityIds, findCycleNodeIds } from './health-report.js';
import type { GraphSnapshot, TestState } from '../shared/types.js';

/**
 * Blast-radius analysis (GitNexus port, plan step 1): pure graph math over a
 * snapshot — which modules does a change to one file plausibly touch, and how
 * risky that reach is. No file I/O and no engine access: everything here is a
 * function of (nodes, edges), so tests drive it with plain fixtures and the
 * MCP layer owns only argument handling and reply shaping.
 */

export type ImpactDirection = 'upstream' | 'downstream' | 'both';

/** Vocabulary owned here (like AI_VERDICTS) so validation and schema share one list. */
export const IMPACT_DIRECTIONS: readonly ImpactDirection[] = ['upstream', 'downstream', 'both'];

/** BFS depth defaults pinned by the plan: 3 unless asked, hard cap 10. */
export const DEFAULT_IMPACT_DEPTH = 3;
export const MAX_IMPACT_DEPTH = 10;

export interface ImpactOptions {
  direction?: ImpactDirection;
  maxDepth?: number;
}

export interface ImpactNode {
  /** BFS distance from the start module (1 = directly touched). */
  depth: number;
  id: string;
  path: string;
  testState: TestState;
  typeErrorCount: number;
}

export type ImpactResult =
  | { ok: true; startId: string; direction: ImpactDirection; maxDepth: number; affected: ImpactNode[] }
  | { ok: false; reason: 'unknown-start'; startId: string };

/**
 * One module's blast radius. upstream = reverse edges (who imports it,
 * edges.to === current); downstream = forward edges (what it imports,
 * edges.from === current); "both" walks the union and a node's depth is its
 * minimum over either direction. A visited set makes dependency cycles
 * converge (emitter ↔ state style loops terminate instead of looping);
 * the start module itself is never part of `affected`. Output is grouped by
 * depth ascending, same depth by id ascending — deterministic byte for byte.
 */
export function computeImpact(
  snap: Pick<GraphSnapshot, 'nodes' | 'edges'>,
  startId: string,
  options: ImpactOptions = {}
): ImpactResult {
  const start = snap.nodes.find((n) => n.id === startId);
  if (start === undefined) return { ok: false, reason: 'unknown-start', startId };
  const direction = options.direction ?? 'both';
  const maxDepth = normalizeDepth(options.maxDepth);

  const downstream = adjacencyOf(snap.edges, (e) => [e.from, e.to]);
  const upstream = adjacencyOf(snap.edges, (e) => [e.to, e.from]);
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));

  const visited = new Set<string>([startId]);
  let frontier: string[] = [startId];
  const affected: ImpactNode[] = [];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of neighborsOf(direction, id, downstream, upstream)) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        next.push(nb);
      }
    }
    next.sort();
    for (const id of next) {
      const node = byId.get(id)!;
      affected.push({ depth, id, path: node.path, testState: node.testState, typeErrorCount: node.typeErrors.length });
    }
    frontier = next;
  }
  return { ok: true, startId, direction, maxDepth, affected };
}

/** Non-integer, <1 or otherwise illegal depth falls back to the default; the cap always holds. */
function normalizeDepth(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return DEFAULT_IMPACT_DEPTH;
  return Math.min(raw, MAX_IMPACT_DEPTH);
}

function adjacencyOf(edges: ReadonlyArray<{ from: string; to: string }>, pick: (e: { from: string; to: string }) => [string, string]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const [from, to] = pick(e);
    const list = adj.get(from);
    if (list === undefined) adj.set(from, [to]);
    else list.push(to);
  }
  for (const list of adj.values()) list.sort();
  return adj;
}

function neighborsOf(
  direction: ImpactDirection,
  id: string,
  downstream: ReadonlyMap<string, string[]>,
  upstream: ReadonlyMap<string, string[]>
): readonly string[] {
  const down = downstream.get(id);
  const up = upstream.get(id);
  if (direction === 'downstream') return down ?? [];
  if (direction === 'upstream') return up ?? [];
  if (down === undefined) return up ?? [];
  if (up === undefined) return down;
  return [...down, ...up].sort();
}

// ---------------------------------------------------------------------------
// Graph statistics shared by get_module_details (context enrichment) and the
// change-impact risk heuristic. Cheap to compute, so the memo is a nicety —
// but details + change-impact calls land in bursts, so one factory instance
// per graph source skips the recomputation between structural changes.
// ---------------------------------------------------------------------------

export interface GraphStats {
  readonly inDegree: ReadonlyMap<string, number>;
  readonly outDegree: ReadonlyMap<string, number>;
  /** Node ids sitting on a dependency cycle (reuses the health-report DFS). */
  readonly inCycle: ReadonlySet<string>;
  /** Top-20% by in+out degree (reuses the health-report rank cutoff). */
  readonly highCentrality: ReadonlySet<string>;
  /** (in + out) / (2·(n−1)); 0 for graphs with ≤1 node or unknown ids. */
  centrality(id: string): number;
}

/** Pure one-shot computation; prefer createGraphStats at call sites. */
export function computeGraphStats(snap: Pick<GraphSnapshot, 'nodes' | 'edges'>): GraphStats {
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const node of snap.nodes) {
    inDegree.set(node.id, 0);
    outDegree.set(node.id, 0);
  }
  for (const e of snap.edges) {
    outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }
  const n = snap.nodes.length;
  const denominator = 2 * (n - 1);
  return {
    inDegree,
    outDegree,
    inCycle: findCycleNodeIds(snap.edges),
    highCentrality: computeHighCentralityIds(snap),
    centrality(id: string): number {
      const degree = (inDegree.get(id) ?? 0) + (outDegree.get(id) ?? 0);
      return denominator > 0 ? degree / denominator : 0;
    }
  };
}

/**
 * Memoized accessor factory: recompute only when the snapshot's generatedAt
 * moved (a structural change). Node-level mutations (notes, reviews, test
 * states) never move generatedAt and never affect these stats, so the cache
 * is exact. Hold ONE instance per graph source — never share across graphs.
 */
export function createGraphStats(
  getSnap: () => Pick<GraphSnapshot, 'generatedAt' | 'nodes' | 'edges'>
): () => GraphStats {
  let cachedAt: number | null = null;
  let cached: GraphStats | null = null;
  return () => {
    const snap = getSnap();
    if (cached === null || snap.generatedAt !== cachedAt) {
      cached = computeGraphStats(snap);
      cachedAt = snap.generatedAt;
    }
    return cached;
  };
}
