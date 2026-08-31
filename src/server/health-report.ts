import type { AiReview, Edge, GraphSnapshot } from '../shared/types.js';

/**
 * The health report (trust-loop roadmap PR-3): a deterministic risk ranking
 * over the graph snapshot. Same input → same output, byte for byte, so the
 * evals probe can assert exact ordering.
 *
 * Score = the sum of the integer weight table below (decision #6 of the
 * plan); ties break by id, ascending. "高中心度" = the top 20% of modules
 * by in+out degree (rank cutoff, not a degree threshold). The Chinese brief
 * carries the top 5 plus a remaining count — it is presentation, the items
 * array is the contract.
 */

/** Fixed integer weights; never float — the ranking must stay exact. */
export interface HealthWeights {
  highCentrality: number;
  untested: number;
  typeErrors: number;
  onCycle: number;
  reviewError: number;
}

export const HEALTH_WEIGHTS: HealthWeights = {
  highCentrality: 3,
  untested: 2,
  typeErrors: 2,
  onCycle: 1,
  reviewError: 2
};

/**
 * Flag → 中文 label map, insertion order = display order. Exported because
 * the /api/report page renders the same vocabulary (single source).
 */
export const HEALTH_FLAG_LABELS: Record<keyof HealthWeights, string> = {
  highCentrality: '高中心度',
  untested: '未测',
  typeErrors: '类型错误',
  onCycle: '在环上',
  reviewError: '评审error'
};

export interface HealthFlags {
  highCentrality: boolean;
  untested: boolean;
  typeErrors: boolean;
  onCycle: boolean;
  reviewError: boolean;
}

export interface HealthReportItem {
  id: string;
  score: number;
  flags: HealthFlags;
}

export interface HealthReport {
  rootPath: string;
  generatedAt: number;
  totalModules: number;
  weights: HealthWeights;
  /** Risk-descending; ties break by id ascending. */
  items: HealthReportItem[];
  /** 中文简报：top 5 + 剩余计数。 */
  brief: string;
}

/**
 * Server-side cycle detection, ported from the browser's findBackEdges
 * (src/web/back-edges.ts) but shaped for the shared Edge vocabulary and
 * answering a different question: WHICH NODES sit on a cycle (the health
 * weights need nodes, not arcs).
 *
 * Multi-start DFS; an arc pointing to an on-stack (GRAY) ancestor closes a
 * cycle — every node on the stack path from that ancestor onward is on it.
 * A self-loop marks the node itself. Pure function, input never mutated.
 */
export function findCycleNodeIds(edges: readonly Edge[]): Set<string> {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    if (!adjacency.has(e.to)) adjacency.set(e.to, []);
    adjacency.get(e.from)!.push(e.to);
  }
  // Deterministic traversal order: ids sorted once up front.
  const order = [...adjacency.keys()].sort();
  const color = new Map<string, number>(order.map((id) => [id, WHITE]));
  const onCycle = new Set<string>();

  for (const start of order) {
    if (color.get(start) !== WHITE) continue;
    color.set(start, GRAY);
    const stack: Array<{ id: string; idx: number }> = [{ id: start, idx: 0 }];
    const path: string[] = [start];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const out = adjacency.get(frame.id)!;
      if (frame.idx < out.length) {
        const to = out[frame.idx++]!;
        const c = color.get(to);
        if (c === WHITE) {
          color.set(to, GRAY);
          stack.push({ id: to, idx: 0 });
          path.push(to);
        } else if (c === GRAY) {
          // Back edge frame.id → to: the whole stack path from `to` onward
          // is on a cycle (a self-loop lands here with at === last index).
          for (let i = path.lastIndexOf(to); i < path.length; i++) onCycle.add(path[i]!);
        }
        // BLACK targets are fully explored; their cycles (if any) are closed.
      } else {
        color.set(frame.id, BLACK);
        path.pop();
        stack.pop();
      }
    }
  }
  return onCycle;
}

/** True when a finished review flagged any line as error (checking counts not). */
function reviewHasError(review: AiReview | undefined): boolean {
  return review?.status === 'done' && review.verdicts.some((v) => v.verdict === 'error');
}

/**
 * The "high centrality" set, shared with the impact module (GitNexus port):
 * max(1, ceil(n × 0.2)) modules by in+out degree, rank cutoff with
 * id-ascending tie-break so the selected set is exact.
 */
export function computeHighCentralityIds(snap: Pick<GraphSnapshot, 'nodes' | 'edges'>): Set<string> {
  const degree = new Map<string, number>();
  for (const node of snap.nodes) degree.set(node.id, 0);
  for (const e of snap.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  // Rank cutoff: degree desc, id asc — the first K ids win, exact set.
  const centralityRank = [...degree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const k = Math.max(1, Math.ceil(snap.nodes.length * 0.2));
  return new Set(centralityRank.slice(0, k).map(([id]) => id));
}

/**
 * Build the deterministic health report. `topCentrality` is derived, not
 * configured: see computeHighCentralityIds for the exact rule.
 */
export function buildHealthReport(snap: Pick<GraphSnapshot, 'rootPath' | 'generatedAt' | 'nodes' | 'edges'>): HealthReport {
  const highCentrality = computeHighCentralityIds(snap);

  const onCycle = findCycleNodeIds(snap.edges);

  const items: HealthReportItem[] = snap.nodes.map((node) => {
    const flags: HealthFlags = {
      highCentrality: highCentrality.has(node.id),
      untested: node.testState === 'untested',
      typeErrors: node.typeErrors.length > 0,
      onCycle: onCycle.has(node.id),
      reviewError: reviewHasError(node.aiReview)
    };
    const score =
      (flags.highCentrality ? HEALTH_WEIGHTS.highCentrality : 0) +
      (flags.untested ? HEALTH_WEIGHTS.untested : 0) +
      (flags.typeErrors ? HEALTH_WEIGHTS.typeErrors : 0) +
      (flags.onCycle ? HEALTH_WEIGHTS.onCycle : 0) +
      (flags.reviewError ? HEALTH_WEIGHTS.reviewError : 0);
    return { id: node.id, score, flags };
  });
  items.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return {
    rootPath: snap.rootPath,
    generatedAt: snap.generatedAt,
    totalModules: snap.nodes.length,
    weights: HEALTH_WEIGHTS,
    items,
    brief: renderBrief(items)
  };
}

/** 中文简报：top 5（同 items 排序），其后一行剩余计数；文本逐字稳定。 */
function renderBrief(items: readonly HealthReportItem[]): string {
  const top = items.slice(0, 5);
  const lines = top.map((item, i) => {
    const active = (Object.keys(HEALTH_FLAG_LABELS) as Array<keyof HealthFlags>)
      .filter((f) => item.flags[f])
      .map((f) => HEALTH_FLAG_LABELS[f]);
    const reason = active.length > 0 ? active.join('、') : '无风险信号';
    return `${i + 1}. ${item.id}（${item.score} 分：${reason}）`;
  });
  const remaining = items.length - top.length;
  const header = `模块健康简报：共 ${items.length} 个模块，按风险分排序`;
  if (remaining > 0) lines.push(`其余 ${remaining} 个模块风险较低，见 items。`);
  return [header, ...lines].join('\n');
}
