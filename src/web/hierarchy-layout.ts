/**
 * Deterministic top-down hierarchical layout engine.
 *
 * TS port of the ticket-00 archive docs/layout-hierarchy.prototype.js
 * (ES5 → TS, same algorithm). One deliberate deviation mandated by the
 * ticket-03 handoff: the prototype's single ROOT_ID is generalized to the
 * set of in-degree-0 entry nodes — multiple roots sit horizontally side by
 * side in the top layer. backEdges semantics are unchanged: an arc pointing
 * to an on-stack DFS ancestor is peeled out of the layering and reported so
 * the renderer can draw it as the 2.4px dashed #D55E00 violation edge.
 *
 * Invariants (page-structure spec §1):
 * - layer depth = longest path along the dependency direction (from → to),
 *   so every non-back edge points strictly deeper (y(to) > y(from));
 * - nodes unreachable from any root sink to an extra layer below
 *   (sorted by dir/label then id for determinism);
 * - within a layer: BFS discovery order refined by two rounds of
 *   parent-median barycenter sweeps to reduce crossings;
 * - pure function: same input always yields the same output, and the input
 *   is never mutated.
 */

export interface LayoutNodeInput {
  id: string;
  dir?: string;
  label?: string;
}

export interface LayoutLinkInput {
  /** Defaults to `${from}->${to}` when absent. */
  id?: string;
  from: string;
  to: string;
}

export interface LayoutGraphInput {
  nodes?: LayoutNodeInput[];
  links?: LayoutLinkInput[];
}

export interface LayoutPosition {
  x: number;
  y: number;
}

export interface HierarchyLayoutOptions {
  rankGap?: number;
  nodeGapX?: number;
  /**
   * Caller-owned cycle arcs (link ids as produced by findBackEdges). When
   * provided, the layout consumes exactly these instead of detecting its
   * own, so the renderer's cycle styling and the layout's peeled arcs can
   * never disagree.
   */
  backEdges?: ReadonlySet<string>;
}

export interface HierarchyLayoutResult {
  depthOf: Map<string, number>;
  layers: string[][];
  pos: Map<string, LayoutPosition>;
  /** Link ids removed to break cycles (arc → on-stack ancestor). */
  backEdges: Set<string>;
  orphans: string[];
  maxWidth: number;
}

const DEFAULT_RANK_GAP = 110;
const DEFAULT_NODE_GAP_X = 96;

export function linkId(link: { id?: string; from: string; to: string }): string {
  return link.id ?? `${link.from}->${link.to}`;
}

/**
 * Cycle detection over the WHOLE graph (multi-start DFS): an arc pointing to
 * an on-stack ancestor is a back edge. Also yields a topological order of
 * the acyclic remainder (reverse postorder). Exported as findBackEdges so
 * the renderer can restyle cycle edges incrementally on delta updates.
 */
function findBackEdgesInternal(
  order: readonly string[],
  outAdj: ReadonlyMap<string, LayoutLinkInput[]>,
  forcedBack?: ReadonlySet<string>
): { back: Set<string>; topo: string[] } {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of order) color.set(id, WHITE);
  const back = new Set<string>(forcedBack ?? []);
  const post: string[] = [];
  for (const start of order) {
    if (color.get(start) !== WHITE) continue;
    color.set(start, GRAY);
    const stack: Array<{ id: string; el: LayoutLinkInput[]; idx: number }> = [
      { id: start, el: outAdj.get(start)!, idx: 0 }
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      let moved = false;
      while (frame.idx < frame.el.length) {
        const e = frame.el[frame.idx]!;
        frame.idx++;
        // Caller-forced arcs are peeled, never traversed or reclassified.
        if (forcedBack?.has(linkId(e))) continue;
        const c = color.get(e.to);
        if (c === WHITE) {
          color.set(e.to, GRAY);
          stack.push({ id: e.to, el: outAdj.get(e.to)!, idx: 0 });
          moved = true;
          break;
        }
        if (c === GRAY && !forcedBack) back.add(linkId(e));
      }
      if (!moved) {
        color.set(frame.id, BLACK);
        post.push(frame.id);
        stack.pop();
      }
    }
  }
  return { back, topo: [...post].reverse() };
}

/** Public cycle-arc detection over a layout-shaped graph (link ids = from->to). */
export function findBackEdges(graph: LayoutGraphInput): Set<string> {
  const order: string[] = [];
  const outAdj = new Map<string, LayoutLinkInput[]>();
  for (const nd of graph.nodes ?? []) {
    if (!nd || !nd.id || outAdj.has(nd.id)) continue;
    order.push(nd.id);
    outAdj.set(nd.id, []);
  }
  for (const lk of graph.links ?? []) {
    if (!lk || !outAdj.has(lk.from) || !outAdj.has(lk.to)) continue;
    outAdj.get(lk.from)!.push(lk);
  }
  return findBackEdgesInternal(order, outAdj).back;
}

export function hierarchyLayout(
  graph: LayoutGraphInput,
  opts: HierarchyLayoutOptions = {}
): HierarchyLayoutResult {
  const rankGap = positive(opts.rankGap, DEFAULT_RANK_GAP);
  const nodeGapX = positive(opts.nodeGapX, DEFAULT_NODE_GAP_X);

  const nodesIn = graph.nodes ?? [];
  const linksIn = graph.links ?? [];

  // ---------- index ----------
  const byId = new Map<string, LayoutNodeInput>();
  const order: string[] = [];
  for (const nd of nodesIn) {
    if (!nd || !nd.id || byId.has(nd.id)) continue;
    byId.set(nd.id, nd);
    order.push(nd.id);
  }
  const empty: HierarchyLayoutResult = {
    depthOf: new Map(),
    layers: [],
    pos: new Map(),
    backEdges: new Set(),
    orphans: [],
    maxWidth: 0
  };
  if (order.length === 0) return empty;

  const outAdj = new Map<string, LayoutLinkInput[]>();
  const inDegree = new Map<string, number>();
  const links: LayoutLinkInput[] = [];
  for (const id of order) {
    outAdj.set(id, []);
    inDegree.set(id, 0);
  }
  for (const lk of linksIn) {
    if (!lk || !byId.has(lk.from) || !byId.has(lk.to)) continue;
    outAdj.get(lk.from)!.push(lk);
    inDegree.set(lk.to, inDegree.get(lk.to)! + 1);
    links.push(lk);
  }

  // ---------- roots: in-degree-0 entries (multi-root generalization) ----------
  const roots = order.filter((id) => inDegree.get(id) === 0);
  if (roots.length === 0) roots.push(order[0]!); // fully cyclic graph fallback

  const { back, topo } = findBackEdgesInternal(order, outAdj, opts.backEdges);

  // ---------- BFS reachability + initial same-layer order ----------
  const reach = new Set<string>(roots);
  const bfsSeq = [...roots];
  for (let head = 0; head < bfsSeq.length; head++) {
    for (const e of outAdj.get(bfsSeq[head]!)!) {
      if (!reach.has(e.to)) {
        reach.add(e.to);
        bfsSeq.push(e.to);
      }
    }
  }

  // ---------- longest-path layering: non-back edges must go strictly deeper ----------
  const depth = new Map<string, number>();
  for (const root of roots) depth.set(root, 0);
  let changed = true;
  let guard = bfsSeq.length + 1;
  while (changed && guard-- > 0) {
    changed = false;
    for (const tu of topo) {
      const du = depth.get(tu);
      if (du === undefined) continue;
      for (const e of outAdj.get(tu)!) {
        if (back.has(linkId(e))) continue;
        const nvd = du + 1;
        const cur = depth.get(e.to);
        if (cur === undefined || nvd > cur) {
          depth.set(e.to, nvd);
          changed = true;
        }
      }
    }
  }

  // ---------- orphans (unreachable from any root) sink to an extra bottom layer ----------
  const orphans: string[] = [];
  for (const id of order) {
    if (!reach.has(id)) orphans.push(id);
  }
  orphans.sort((a, b) => {
    const na = byId.get(a)!;
    const nb = byId.get(b)!;
    const da = na.dir ?? '';
    const db = nb.dir ?? '';
    if (da !== db) return da < db ? -1 : 1;
    const la = na.label ?? '';
    const lb = nb.label ?? '';
    if (la !== lb) return la < lb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  let maxDepth = 0;
  for (const d of depth.values()) {
    if (d > maxDepth) maxDepth = d;
  }
  const maxLayer = maxDepth + (orphans.length > 0 ? 1 : 0);

  const layers: string[][] = [];
  for (let i = 0; i <= maxLayer; i++) layers.push([]);
  for (const id of bfsSeq) layers[depth.get(id)!]!.push(id);
  for (const id of orphans) {
    depth.set(id, maxLayer);
    layers[maxLayer]!.push(id);
  }

  // ---------- within-layer ordering: two rounds of parent-median barycenter ----------
  const slot = new Map<string, number>();
  layers.forEach((layer, di) => {
    layer.forEach((id, i) => slot.set(id, i));
  });

  const parentsOf = new Map<string, string[]>();
  for (const lk of links) {
    if (back.has(linkId(lk)) || !reach.has(lk.from) || !reach.has(lk.to)) continue;
    const arr = parentsOf.get(lk.to);
    if (arr) arr.push(lk.from);
    else parentsOf.set(lk.to, [lk.from]);
  }

  for (let round = 0; round < 2; round++) {
    for (let di = 1; di < layers.length; di++) {
      const layer = layers[di]!;
      if (layer.length < 2) continue;
      const items = layer.map((id, oi) => {
        const parents = parentsOf.get(id);
        let key: number;
        if (parents && parents.length > 0) {
          key = median(parents.map((p) => slot.get(p)!)) ?? slot.get(id)!;
        } else {
          key = slot.get(id)!;
        }
        return { id, key, cur: slot.get(id)!, oi };
      });
      items.sort((a, b) => a.key - b.key || a.cur - b.cur || a.oi - b.oi);
      items.forEach((it, i) => slot.set(it.id, i));
    }
  }

  // ---------- coordinates: per-layer equidistant and centered, y linear in depth ----------
  const pos = new Map<string, LayoutPosition>();
  let maxWidth = 0;
  layers.forEach((layer, di) => {
    if (layer.length > maxWidth) maxWidth = layer.length;
    const w = layer.length;
    layer.forEach((id, i) => {
      pos.set(id, { x: (i - (w - 1) / 2) * nodeGapX, y: di * rankGap });
    });
  });

  return { depthOf: depth, layers, pos, backEdges: back, orphans, maxWidth };
}

function positive(v: number | undefined, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor((s.length - 1) / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m]! + s[s.length / 2]!) / 2;
}
