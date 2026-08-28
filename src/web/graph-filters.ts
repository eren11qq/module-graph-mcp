import type { Edge, ModuleNode, TestState } from '../shared/types.js';
import { shortLabel, THEME } from './theme.js';
import { TEST_STATES } from './test-states.js';

/**
 * Ticket 11 view-state pure functions (seams 1–3) plus the composition the
 * graph-view render pipeline calls. No DOM, no cytoscape — everything here is
 * data-in/data-out and covered by tests/graph-filters.test.ts.
 */

/** Namespace prefix for synthesized directory-level node ids. */
export const DIR_PREFIX = 'dir:';

/** Directory a synthesized dir-ball id points at, or null for a file id. */
export function dirBallDirOf(id: string): string | null {
  return id.startsWith(DIR_PREFIX) ? id.slice(DIR_PREFIX.length) : null;
}

/** Posix directory of a module id ('' for root-level files). */
function dirOf(id: string): string {
  const i = id.lastIndexOf('/');
  return i === -1 ? '' : id.slice(0, i);
}

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

/**
 * Seam 1: replace every file inside collapsedDirs with one directory-level
 * node (id `dir:<dir>`), aggregating state by severity and unioning the
 * children's type errors. Edges are rewired to the directory nodes,
 * intra-directory edges vanish, collapsed-onto pairs are deduped.
 */
export function collapseDirectories(
  nodes: readonly ModuleNode[],
  edges: readonly Edge[],
  collapsedDirs: ReadonlySet<string>
): { nodes: ModuleNode[]; edges: Edge[] } {
  if (collapsedDirs.size === 0) return { nodes: [...nodes], edges: [...edges] };

  const endpointOf = (id: string): string => {
    const dir = dirOf(id);
    return dir !== '' && collapsedDirs.has(dir) ? DIR_PREFIX + dir : id;
  };

  const dirNodes = new Map<string, ModuleNode>();
  const fileNodes: ModuleNode[] = [];
  for (const n of nodes) {
    const dir = dirOf(n.id);
    if (dir === '' || !collapsedDirs.has(dir)) {
      fileNodes.push(n);
      continue;
    }
    let agg = dirNodes.get(DIR_PREFIX + dir);
    if (!agg) {
      agg = {
        id: DIR_PREFIX + dir,
        path: `${dir}/`,
        language: 'ts',
        testState: 'passing',
        coveredBy: [],
        typeErrors: []
      };
      dirNodes.set(agg.id, agg);
    }
    if (TEST_STATES[n.testState].severity > TEST_STATES[agg.testState].severity) agg.testState = n.testState;
    agg.typeErrors.push(...n.typeErrors);
  }

  const outEdges = new Map<string, Edge>();
  for (const e of edges) {
    const from = endpointOf(e.from);
    const to = endpointOf(e.to);
    if (from === to) continue;
    outEdges.set(`${from}->${to}`, { from, to });
  }

  return { nodes: [...fileNodes, ...dirNodes.values()], edges: [...outEdges.values()] };
}

/** Directories holding ≥ minFiles of the given nodes (root level never folds). */
function collapsibleDirs(nodes: readonly ModuleNode[], minFiles: number): Set<string> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const dir = dirOf(n.id);
    if (dir === '') continue;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [dir, count] of counts) if (count >= minFiles) out.add(dir);
  return out;
}

function edgesWithin(edges: readonly Edge[], ids: ReadonlySet<string>): Edge[] {
  return edges.filter((e) => ids.has(e.from) && ids.has(e.to));
}

/** Everything the render pipeline needs; expandedDirs only matters while collapse is on. */
export interface ViewState {
  query: string;
  untestedOnly: boolean;
  collapseEnabled: boolean;
  /** Directories the user manually expanded (tap on a dir ball). */
  expandedDirs: ReadonlySet<string>;
  /**
   * Theme.html legend filter: states toggled off in the legend disappear from
   * the render list (empty set = everything visible).
   */
  hiddenStates: ReadonlySet<TestState>;
}

/**
 * The view pipeline: 图例状态过滤 → 只看未测 → 搜索 → directory collapse.
 * Later stages see earlier stages' survivors, so a search match inside a
 * collapsible directory reveals the file itself.
 *
 * Pure data-in/data-out (no DOM, no cytoscape); the one repo constant it
 * reads is THEME.collapse.minFiles, the single-source collapse threshold.
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

  if (view.query.trim() !== '') {
    const matched = searchMatches(keptNodes, view.query);
    keptNodes = keptNodes.filter((n) => matched.has(n.id));
    keptEdges = edgesWithin(keptEdges, matched);
  }

  if (view.collapseEnabled) {
    const collapsed = collapsibleDirs(keptNodes, THEME.collapse.minFiles);
    for (const dir of view.expandedDirs) collapsed.delete(dir);
    ({ nodes: keptNodes, edges: keptEdges } = collapseDirectories(keptNodes, keptEdges, collapsed));
  }

  return { nodes: keptNodes, edges: keptEdges };
}
