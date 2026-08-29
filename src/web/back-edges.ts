/**
 * Cycle detection over the dependency graph (code-review 2026-08-29 抽出):
 * extracted from the deleted hierarchy-layout.ts — the layout itself was
 * retired by the ticket-00 amendment (fcose is the only layout), but the red
 * cycle arcs and the statusbar 循环依赖 counter still come from this
 * multi-start DFS: an arc pointing to an on-stack ancestor is a back edge.
 *
 * Pure function: same input always yields the same output, and the input is
 * never mutated. Link ids are `${from}->${to}` unless overridden.
 */

export interface LayoutNodeInput {
  id: string;
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

export function linkId(link: { id?: string; from: string; to: string }): string {
  return link.id ?? `${link.from}->${link.to}`;
}

/**
 * Multi-start DFS over the WHOLE graph: an arc pointing to an on-stack
 * ancestor is a back edge. Also yields a topological order of the acyclic
 * remainder (reverse postorder) for the rare caller that wants it.
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
