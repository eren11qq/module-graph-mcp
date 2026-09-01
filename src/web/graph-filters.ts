import type { EditScopeDecl, Edge, ModuleNode, TestState } from '../shared/types.js';
import { moduleIdOf } from '../shared/module-table.js';
import { shortLabel } from './theme.js';

/**
 * Ticket 11 view-state pure functions (seams 1–3) plus the composition the
 * graph-view render pipeline calls. No DOM, no cytoscape — everything here is
 * data-in/data-out and covered by tests/graph-filters.test.ts.
 *
 * ADR 0002 §7.1: directory collapse is RETIRED. ADR 0003: the module view UI
 * is retired too — the file poster is the ONLY view; the module table stays
 * as the agent-side scope vocabulary (§7.2, deriveScopeMarks below).
 */

/**
 * Seam 3: 只看未测 predicate — true exactly for the untested state (no
 * coverage data and no test file by naming convention).
 */
export function isUntested(n: ModuleNode): boolean {
  return n.testState === 'untested';
}

/**
 * Seam 2: query → ids of nodes whose path or basename label contains it,
 * case-insensitively. A blank query matches nothing (= "no search filter"
 * for the pipeline).
 */
export function searchMatches(nodes: readonly ModuleNode[], query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const out = new Set<string>();
  if (q === '') return out;
  for (const n of nodes) {
    if (n.path.toLowerCase().includes(q) || shortLabel(n.path).toLowerCase().includes(q)) out.add(n.id);
  }
  return out;
}

/** Everything the render pipeline needs. */
export interface ViewState {
  query: string;
  untestedOnly: boolean;
  /**
   * Theme.html legend filter: states toggled off in the legend disappear from
   * the render list (empty set = everything visible).
   */
  hiddenStates: ReadonlySet<TestState>;
  /**
   * Code-review 2026-08-29 评审环图例行: true 隐藏所有已评审（aiReview done）
   * 的节点。
   */
  hideReviewed: boolean;
}

function edgesWithin(edges: readonly Edge[], ids: ReadonlySet<string>): Edge[] {
  return edges.filter((e) => ids.has(e.from) && ids.has(e.to));
}

/**
 * The view pipeline: 图例状态过滤 → 只看未测 → hideReviewed → 搜索。Later
 * stages see earlier stages' survivors.
 *
 * Pure data-in/data-out (no DOM, no cytoscape). Since ADR 0003 this is the
 * whole story of what is on canvas: the file poster is the only view, a
 * search match reveals the file ball itself.
 */
export function applyViewState(
  nodes: readonly ModuleNode[],
  edges: readonly Edge[],
  view: ViewState
): { nodes: ModuleNode[]; edges: Edge[] } {
  let keptNodes: ModuleNode[] = [...nodes];
  let keptEdges: Edge[] = [...edges];

  if (view.hiddenStates.size > 0) {
    keptNodes = keptNodes.filter((n) => !view.hiddenStates.has(n.testState));
    keptEdges = edgesWithin(keptEdges, new Set(keptNodes.map((n) => n.id)));
  }

  if (view.untestedOnly) {
    keptNodes = keptNodes.filter(isUntested);
    keptEdges = edgesWithin(keptEdges, new Set(keptNodes.map((n) => n.id)));
  }

  if (view.hideReviewed) {
    keptNodes = keptNodes.filter((n) => n.aiReview?.status !== 'done');
    keptEdges = edgesWithin(keptEdges, new Set(keptNodes.map((n) => n.id)));
  }

  if (view.query.trim() !== '') {
    const matched = searchMatches(keptNodes, view.query);
    keptNodes = keptNodes.filter((n) => matched.has(n.id));
    keptEdges = edgesWithin(keptEdges, matched);
  }

  return { nodes: keptNodes, edges: keptEdges };
}

export interface ScopeMarks {
  /** 范围内 → 常驻紫环（与 viewing 紫脉冲——瞬时 3s——区分）。 */
  inScope: boolean;
  /** 已改 → 整球紫（填充）。 */
  edited: boolean;
  /** 越界 → 红警示角标 + tooltip 文案。 */
  outOfScope: boolean;
}

/**
 * 标记派生（ADR 0002 §7.2）：范围环（声明模块 ∪ 显式文件，表外文件只能
 * 显式点名）、已改紫、越界红角标三条独立通道。
 */
export function deriveScopeMarks(
  nodes: readonly ModuleNode[],
  scope: EditScopeDecl | null,
  edited: ReadonlySet<string>,
  outOfScope: ReadonlySet<string>
): Map<string, ScopeMarks> {
  const out = new Map<string, ScopeMarks>();
  for (const n of nodes) {
    const mod = moduleIdOf(n.id);
    const inScope =
      scope !== null && (scope.files.includes(n.id) || (mod !== null && scope.modules.includes(mod)));
    out.set(n.id, {
      inScope,
      edited: edited.has(n.id),
      outOfScope: outOfScope.has(n.id)
    });
  }
  return out;
}
