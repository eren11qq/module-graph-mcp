import type { Edge, ModuleNode, TestState } from '../shared/types.js';
import { moduleIdOf } from '../shared/module-table.js';
import type { FunctionalModuleId } from '../shared/module-table.js';
import { shortLabel } from './theme.js';

/**
 * Ticket 11 view-state pure functions (seams 1–3) plus the composition the
 * graph-view render pipeline calls. No DOM, no cytoscape — everything here is
 * data-in/data-out and covered by tests/graph-filters.test.ts.
 *
 * ADR 0002 §7.1: directory collapse is RETIRED — the toolbar now switches
 * 模块视图 | 文件视图; module grouping lives in module-view.ts (the render
 * pipeline composes: applyViewState filters file balls, then the view mode
 * decides how they are arranged).
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

/** 视图模式：模块视图（默认，按功能类成堆 + 模块级边）| 文件视图。 */
export type ViewMode = 'module' | 'file';

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
  /** 模块视图 | 文件视图（ADR 0002 §7.1），默认模块视图。 */
  viewMode: ViewMode;
  /** 文件视图聚焦的功能类（点某堆进入）；null = 全部文件（海报模式）。 */
  focusedModule: FunctionalModuleId | null;
}

function edgesWithin(edges: readonly Edge[], ids: ReadonlySet<string>): Edge[] {
  return edges.filter((e) => ids.has(e.from) && ids.has(e.to));
}

/**
 * The view pipeline: 图例状态过滤 → 只看未测 → hideReviewed → 文件视图聚焦
 * → 搜索。Later stages see earlier stages' survivors.
 *
 * Pure data-in/data-out (no DOM, no cytoscape). Module-view grouping happens
 * AFTER this filter in graph-view (module-view.ts), so a search match inside
 * a pile reveals the file itself.
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

  if (view.viewMode === 'file' && view.focusedModule !== null) {
    // 文件视图聚焦一个功能类：只留该功能类的小模块簇（表外文件无功能类，
    // 聚焦时一并隐藏——它们只能靠搜索或清除聚焦露出）。
    const ids = new Set<string>();
    for (const n of keptNodes) {
      if (moduleIdOf(n.id) === view.focusedModule) ids.add(n.id);
    }
    keptNodes = keptNodes.filter((n) => ids.has(n.id));
    keptEdges = edgesWithin(keptEdges, ids);
  }

  if (view.query.trim() !== '') {
    const matched = searchMatches(keptNodes, view.query);
    keptNodes = keptNodes.filter((n) => matched.has(n.id));
    keptEdges = edgesWithin(keptEdges, matched);
  }

  return { nodes: keptNodes, edges: keptEdges };
}
