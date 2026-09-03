import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Edge, EditScopeDecl, EditVerificationWire, GraphDelta, GraphSnapshot, ModuleNode, TestState } from '../shared/types.js';
import { worstReviewVerdict } from './ai-review.js';
import { applyViewState, deriveScopeMarks, type ViewState } from './graph-filters.js';
import { assignRegions, solveRegionsPoster, syncRegionPlates, type RegionId } from './graph-areas.js';
import type { GraphModel } from './graph-model.js';
import { findBackEdges, type LayoutGraphInput } from './back-edges.js';
import { fnv1a, solveClusterPoster } from './layout-cluster.js';
import { createLayoutStore, type LayoutMode, type LayoutPoint, type LayoutStore } from './layout-store.js';
import {
  MOTION,
  THEME,
  activeThemeKey,
  cyPalette,
  diameterOf,
  prefersReducedMotion,
  setTheme as setActiveTheme,
  shortLabel,
  type ThemeKey
} from './theme.js';
import { STATE_ORDER } from './test-states.js';
import { createPhysics, type Physics } from './physics.js';

cytoscape.use(fcose);

export interface GraphViewOptions {
  /** Locked focus changed (null = nothing locked); drives the detail panel. */
  onFocusChange(node: ModuleNode | null): void;
  /** Hover tooltip element; receives the node's relative path. */
  tooltipEl: HTMLElement;
  /** Prototype node physics (drift / spring-back / hover pop / checking pulse). */
  physics?: boolean;
  /**
   * Code-review 2026-08-29: layout archive seam — defaults to the localStorage
   * store; tests inject a fake. Position authority = last stable layout.
   */
  store?: LayoutStore;
  /**
   * 聚类排列模式 2026-09-01 (ADR 0004): mode flips on snapshot arrival (per-root
   * 存档值) and on setLayoutMode — the topbar segmented control mirrors this.
   */
  onLayoutModeChange?(mode: LayoutMode): void;
}

export interface GraphView {
  setSnapshot(snapshot: GraphSnapshot): void;
  /** Ticket 05: apply one watcher window's net delta in place (no full re-render). */
  applyDelta(delta: GraphDelta): void;
  /** Ticket 06/07/08/12: single-node state patch (testState / typeErrors / aiReview / …). */
  applyNodeUpdate(node: ModuleNode): void;
  /** Ticket 11+theme view controls: 只看未测 / search / legend-hidden states. */
  setViewState(patch: Partial<ViewState>): void;
  /** Re-lock focus on a node and bring it into view (detail-panel jumps). */
  focusNode(id: string): void;
  /**
   * Code-review 2026-08-29: the agent just READ this module (module_activity
   * frame) — light the transient `viewing` pulse, self-expiring.
   */
  pulseViewing(id: string): void;
  /** ADR 0002 §7.2: 编辑范围落地/清除（edit_scope 事件）——重置已改/越界标记。 */
  setEditScope(scope: EditScopeDecl | null): void;
  /** ADR 0002 §7.2: 核对结果（edit_verification 事件）——已改紫 / 越界红角标。 */
  setEditVerification(verification: EditVerificationWire): void;
  /** Drop the current lock (Esc / close). */
  clearFocus(): void;
  resetView(): void;
  /**
   * Code-review 2026-08-29: forget the archived layout for this root and
   * re-render — balls re-enter fcose with no preset positions (从头解一次).
   */
  resetLayout(): void;
  /** 聚类排列模式 2026-09-01: current arrangement mode (topbar state). */
  getLayoutMode(): LayoutMode;
  /** Persist a root's layout mode and re-render the whole poster with it. */
  setLayoutMode(mode: LayoutMode): void;
  /** Restyle to another theme without touching positions or data. */
  setTheme(key: ThemeKey): void;
  /** Cycle arcs currently rendered — the statusbar's 循环依赖 counter. */
  cycleCount(): number;
}

/** @types/cytoscape omits `target-arrow-opacity`; cytoscape itself supports it. */
type EdgeStylePatch = { 'target-arrow-opacity'?: number };

function edgeStyle(
  style: cytoscape.StylesheetStyle['style'] & EdgeStylePatch
): cytoscape.StylesheetStyle['style'] {
  return style as cytoscape.StylesheetStyle['style'];
}

/** Same cast for node rules: data() mappers + transitions outrun the typings. */
function nodeStyle(
  style: cytoscape.StylesheetStyle['style'] & EdgeStylePatch
): cytoscape.StylesheetStyle['style'] {
  return style as cytoscape.StylesheetStyle['style'];
}

const edgeIdOf = (e: Edge): string => `${e.from}->${e.to}`;

// FNV-1a 抖动源 2026-09-01 起住在 layout-cluster.ts（聚类出生与新球种子共用
// 一处定义），此处只 import。

export function createGraphView(container: HTMLElement, opts: GraphViewOptions): GraphView {
  const cy = cytoscape({
    container,
    wheelSensitivity: THEME.interaction.wheelSensitivity,
    maxZoom: THEME.interaction.maxZoom,
    minZoom: THEME.interaction.minZoom,
    boxSelectionEnabled: false,
    style: buildStylesheet()
  });

  const physics: Physics | null = opts.physics ? createPhysics(cy) : null;

  // 布局存档 (Code-review 2026-08-29): 位置的唯一权威 = 上一次稳定布局。
  // 存档读写都走 layout-store;currentRoot 随 snapshot 到来(setSnapshot 现在
  // 不再丢弃 rootPath),存档按 rootPath 分仓。
  const store: LayoutStore = opts.store ?? createLayoutStore();
  let currentRoot: string | null = null;
  // 排列模式 (ADR 0004): per-root, resolved from the archive when the snapshot
  // arrives. 2026-09-01 用户裁定 R2 (D1 翻转): 缺省 = 'cluster'——快照前与
  // 旧档无记录时都以聚类海报开场,区域模式留在顶栏开关可切。Solving in cluster
  // mode ignores archived positions (确定性优先于拖拽保留, D2/COMPROMISES) —
  // the seeds are the deterministic birth points computed by layout-cluster.
  let layoutMode: LayoutMode = 'cluster';

  /**
   * Archived positions for the current root (empty when store/root absent).
   * 聚类模式求解零种子 (ADR 0004 修正点 1): 返回空 Map 让每个球都从头
   * 出生,存档只在切回区域模式时回放。
   */
  function currentLayout(): Map<string, LayoutPoint> {
    if (currentRoot === null || layoutMode === 'cluster') return new Map();
    return store.load(currentRoot);
  }

  /**
   * Persist the just-settled layout. Runs AFTER physics.rebase() inside
   * applyLayout — bases() hands out the translated resting spots (drift has
   * not ticked yet), and region plates are not back in the graph yet, so
   * they can never leak into the archive. A filtered render is a distorted
   * view of the full graph, not a layout of record — skip it.
   */
  function persistLayout(): void {
    if (currentRoot === null || filtersActive()) return;
    const points = new Map<string, { x: number; y: number }>();
    if (physics !== null) {
      for (const [id, p] of physics.bases()) points.set(id, p);
    } else {
      cy.nodes().forEach((n: cytoscape.NodeSingular) => {
        const p = n.position();
        points.set(n.id(), { x: p.x, y: p.y });
      });
    }
    if (points.size > 0) store.save(currentRoot, points);
  }

  let currentNodes = new Map<string, ModuleNode>();
  let currentEdges = new Map<string, Edge>();
  let degrees = new Map<string, { in: number; out: number }>();
  let backEdgeIds = new Set<string>();
  // 区域化海报 (graph-areas): node id → compass region, always derived from
  // the VISIBLE graph (the pipelined one in renderVisible, the full map on
  // the incremental applyDelta path).
  let regions = new Map<string, RegionId>();
  let lockedId: string | null = null;
  let entered = false; // entrance choreography (pre → fade-in) runs once, on first load
  // Ticket 11 + theme.html legend filter: the view owns the mutable copies;
  // the pipeline sees ReadonlySets.
  let viewState: ViewState = {
    query: '',
    untestedOnly: false,
    hiddenStates: new Set<TestState>(),
    hideReviewed: false
  };

  // ADR 0002 §7.2 改动标记状态（edit_scope / edit_verification 事件驱动）。
  let editScope: EditScopeDecl | null = null;
  let editedIds = new Set<string>();
  let outOfScopeIds = new Set<string>();

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  function bumpDegree(id: string, side: 'in' | 'out', by: 1 | -1): void {
    const d = degrees.get(id) ?? { in: 0, out: 0 };
    d[side] = Math.max(0, d[side] + by);
    degrees.set(id, d);
  }

  function rebuildDegrees(nextNodes: ModuleNode[], nextEdges: Edge[]): Map<string, { in: number; out: number }> {
    const next = new Map<string, { in: number; out: number }>();
    for (const n of nextNodes) next.set(n.id, { in: 0, out: 0 });
    for (const e of nextEdges) {
      const from = next.get(e.from);
      const to = next.get(e.to);
      if (from) from.out++;
      if (to) to.in++;
    }
    return next;
  }

  /** 区域成员 (graph-areas): 路径前缀 + 度 0 兜底,对传入的可见图计算。 */
  function refreshRegions(nodes: ModuleNode[], edges: Edge[]): void {
    regions = assignRegions(nodes, edges);
  }

  /** Ball size from degree; tests-band balls shrink one notch (区域化海报). */
  function diameterFor(id: string, totalDeg: number): number {
    const d = diameterOf(totalDeg);
    return regions.get(id) === 'tests' ? d * THEME.areas.testsScale : d;
  }

  function nodeElement(n: ModuleNode): cytoscape.ElementDefinition {
    const deg = degrees.get(n.id) ?? { in: 0, out: 0 };
    const classes: string[] = [];
    // Ticket 12: a node the agent is reviewing carries the checking class —
    // the stylesheet draws the bright edge, physics.ts pulses the overlay.
    if (n.aiReview?.status === 'checking') classes.push('checking');
    // ADR 0002 §7.2: 范围环 / 已改紫 / 越界红角标——三条独立 class 通道，
    // 与测试球色、类型错误环、评审环、viewing 紫脉冲互不冲突。
    const marks = deriveScopeMarks([n], editScope, editedIds, outOfScopeIds).get(n.id);
    if (marks?.inScope) classes.push('in-scope');
    if (marks?.edited) classes.push('edited');
    if (marks?.outOfScope) classes.push('out-of-scope');
    return {
      data: {
        id: n.id,
        label: shortLabel(n.path) + (marks?.outOfScope ? ' \u26D4' : ''),
        path: n.path,
        state: n.testState,
        diameter: diameterFor(n.id, deg.in + deg.out),
        typeErrorCount: n.typeErrors.length,
        // Code-review 2026-08-29: '' = 无环；confident/unsure/error = 评审环
        // 色档（underlay 通道，见 buildStylesheet）。
        reviewVerdict: worstReviewVerdict(n.aiReview),
        oo: 0
      },
      classes: classes.join(' ')
    };
  }

  function edgeElement(e: Edge, cycle: boolean): cytoscape.ElementDefinition {
    // Cycle styling rides the CLASS channel (edge.cycle): the data-field
    // bracket selector `[cycle]` matches mere field presence, so cycle:false
    // would light every edge up as a cycle.
    // 区域化海报: cross-region lines get `edge-cross` (thin+faint) — both
    // endpoints must be regioned; unassigned strays keep the plain style.
    const rf = regions.get(e.from);
    const rt = regions.get(e.to);
    const cross = rf !== undefined && rt !== undefined && rf !== rt;
    return {
      data: { id: edgeIdOf(e), source: e.from, target: e.to },
      classes: [cycle ? 'cycle' : '', cross ? 'edge-cross' : ''].join(' ').trim()
    };
  }

  /** Cycle-arc set over the current graph, kept in sync by setSnapshot/applyDelta. */
  function refreshCycleFlags(): void {
    backEdgeIds = findBackEdges({
      nodes: [...currentNodes.keys()].map((id) => ({ id })),
      links: [...currentEdges.values()].map((e) => ({ from: e.from, to: e.to }))
    });
  }

  function setSnapshot(next: GraphSnapshot): void {
    lockedId = null;
    opts.onFocusChange(null);
    // 布局存档分仓键 (Code-review 2026-08-29): the snapshot is where the view
    // first learns which repo it is showing. 排列模式同样按 rootPath 落定
    // (ADR 0004/D1)——切仓库 = 切回该仓库自己记住的模式。
    currentRoot = next.rootPath;
    layoutMode = store.getMode(next.rootPath);
    opts.onLayoutModeChange?.(layoutMode);

    currentNodes = new Map(next.nodes.map((n) => [n.id, n]));
    currentEdges = new Map(next.edges.map((e) => [edgeIdOf(e), e]));
    renderVisible();
  }

  /** True while any ticket-11 control reshapes the rendered graph. */
  function filtersActive(): boolean {
    return (
      viewState.query.trim() !== '' ||
      viewState.untestedOnly ||
      viewState.hiddenStates.size > 0 ||
      viewState.hideReviewed
    );
  }

  /**
   * 海报元素（唯一视图，ADR 0003）：文件球 + 文件级边。fcose 排布、区域
   * 罗盘平移照旧；焦点与环标记走 nodeElement 的 class 通道。
   */
  function posterElements(
    visible: { nodes: ModuleNode[]; edges: Edge[] },
    saved: Map<string, LayoutPoint>,
    firstRender: boolean
  ): cytoscape.ElementDefinition[] {
    const layoutInput: LayoutGraphInput = {
      nodes: visible.nodes.map((n) => ({ id: n.id, label: shortLabel(n.path) })),
      links: visible.edges.map((e) => ({ from: e.from, to: e.to }))
    };
    backEdgeIds = findBackEdges(layoutInput);
    return [
      ...visible.nodes.map((n) => {
        const def = nodeElement(n);
        const spot = saved.get(n.id);
        if (spot !== undefined) def.position = { x: spot.x, y: spot.y };
        if (firstRender) def.classes = `${def.classes} pre`.trim();
        return def;
      }),
      ...visible.edges.map((e) => edgeElement(e, backEdgeIds.has(edgeIdOf(e))))
    ];
  }

  /**
   * Full re-render of the visible graph: view pipeline (图例过滤 → 只看未测 →
   * 隐藏已评审 → 搜索) over currentNodes/currentEdges, then layout + element
   * swap. With every control off this renders the plain graph, so setSnapshot
   * is just bookkeeping + renderVisible.
   */
  function renderVisible(): void {
    const visible = applyViewState([...currentNodes.values()], [...currentEdges.values()], viewState);
    degrees = rebuildDegrees(visible.nodes, visible.edges);
    refreshRegions(visible.nodes, visible.edges);

    const firstRender = !entered;
    entered = true;
    // 布局存档恢复 (Code-review 2026-08-29): the element swap used to wipe
    // every position (every filter toggle re-solved from scratch). Restoring
    // the archived spots into the fresh defs makes fcose randomize:false
    // start from the last stable layout — 老球落回原位,新球才交给力模拟。
    const elements = posterElements(visible, currentLayout(), firstRender);

    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    if (lockedId !== null) {
      // A wholesale element swap wipes class-based styling: restore the
      // focus visuals if the locked ball survived, unlock if it did not.
      if (visible.nodes.some((n) => n.id === lockedId)) applyFocus(lockedId);
      else clearFocus();
    }
    applyLayout();
    computeHubIds();
    updateLabelThrottle();
    if (firstRender) {
      // 入场编排: the graph body fades in after the shell (pre → transition).
      window.setTimeout(() => {
        cy.batch(() => cy.nodes().removeClass('pre'));
      }, 60);
    }
  }

  function applyDelta(delta: GraphDelta): void {
    if (
      delta.addedNodes.length === 0 &&
      delta.removedNodeIds.length === 0 &&
      delta.addedEdges.length === 0 &&
      delta.removedEdges.length === 0
    ) {
      return;
    }

    // 1) Bookkeeping: the internal graph mirrors the target state first, so
    //    cycle detection and fresh-node placement see the final picture.
    for (const e of delta.removedEdges) {
      currentEdges.delete(edgeIdOf(e));
      bumpDegree(e.from, 'out', -1);
      bumpDegree(e.to, 'in', -1);
    }
    for (const id of delta.removedNodeIds) {
      currentNodes.delete(id);
      degrees.delete(id);
    }
    for (const n of delta.addedNodes) {
      currentNodes.set(n.id, n);
      if (!degrees.has(n.id)) degrees.set(n.id, { in: 0, out: 0 });
    }
    for (const e of delta.addedEdges) {
      currentEdges.set(edgeIdOf(e), e);
      if (!degrees.has(e.from)) degrees.set(e.from, { in: 0, out: 0 });
      if (!degrees.has(e.to)) degrees.set(e.to, { in: 0, out: 0 });
      bumpDegree(e.from, 'out', 1);
      bumpDegree(e.to, 'in', 1);
    }
    refreshCycleFlags();
    // A node's region is a pure function of (path, incident edges), so a
    // region can only flip through an edge add/remove — the fresh map here
    // covers both the new elements below and the region pass in applyLayout.
    refreshRegions([...currentNodes.values()], [...currentEdges.values()]);

    // Ticket 11: while any view control reshapes the graph, the incremental
    // DOM path no longer matches what should be visible — fall back to a
    // full render of the pipelined graph (which also clears a focus whose
    // node left the visible set).
    if (filtersActive()) {
      renderVisible();
      return;
    }

    // 2) DOM mutations. A re-entering ball (watcher flicker removed and
    //    re-added it) is not fresh: the archive hands its old spot straight
    //    back (Code-review 2026-08-29). A genuinely fresh ball gets a SEED
    //    beside its existing neighbors instead of a blank (0,0): fcose then
    //    fine-tunes from a sane spot rather than yanking it across the canvas.
    const saved = currentLayout();
    // 新球种子落点 (Code-review 2026-08-29): 两阶段——先在 batch 之前收种子,
    // 此时同批新球尚未入 cy,「已存在邻居」自然只含老球,新球之间互不耦合。
    // 邻居 = currentEdges(已是目标态)中 touch 它且对端元素 nonempty 的边;
    // 无任何已存在邻居(全新孤立球)→ 不设种子,交给 fcose/孤儿坞。种子 =
    // 邻居质心 + FNV-1a(path) 确定性偏移(角度 0–359°,半径 30–70px,避开
    // 球径 ~20–40px)。存档有位置的球永远存档优先。
    const seeds = new Map<string, { x: number; y: number }>();
    for (const n of delta.addedNodes) {
      if (saved.has(n.id)) continue;
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (const e of currentEdges.values()) {
        const otherId = e.from === n.id ? e.to : e.to === n.id ? e.from : null;
        if (otherId === null) continue;
        const el = cy.getElementById(otherId);
        if (el.empty()) continue; // 同批新球尚未入 cy,不算已存在邻居
        const p = el.position();
        sumX += p.x;
        sumY += p.y;
        count++;
      }
      if (count === 0) continue;
      const hash = fnv1a(n.path);
      const angle = ((hash % 360) * Math.PI) / 180;
      const radius = 30 + ((hash >>> 8) % 40);
      seeds.set(n.id, {
        x: sumX / count + Math.cos(angle) * radius,
        y: sumY / count + Math.sin(angle) * radius
      });
    }
    let removedFocused = false;
    cy.batch(() => {
      for (const e of delta.removedEdges) {
        cy.getElementById(edgeIdOf(e)).remove();
      }
      for (const id of delta.removedNodeIds) {
        cy.getElementById(id).remove();
        if (lockedId === id) removedFocused = true;
      }
      for (const n of delta.addedNodes) {
        const def = nodeElement(n);
        const spot = saved.get(n.id);
        if (spot !== undefined) def.position = { x: spot.x, y: spot.y };
        else {
          const seed = seeds.get(n.id);
          if (seed !== undefined) def.position = { x: seed.x, y: seed.y };
        }
        cy.add(def);
      }
      for (const e of delta.addedEdges) {
        cy.add(edgeElement(e, backEdgeIds.has(edgeIdOf(e))));
      }
      // Cycle styling (class channel) and ball sizes on touched elements.
      cy.edges().forEach((ed) => {
        ed.toggleClass('cycle', backEdgeIds.has(ed.id()));
      });
      const touched = new Set<string>();
      for (const e of delta.addedEdges) {
        touched.add(e.from);
        touched.add(e.to);
      }
      for (const e of delta.removedEdges) {
        touched.add(e.from);
        touched.add(e.to);
      }
      for (const n of delta.addedNodes) touched.add(n.id);
      for (const id of touched) {
        const el = cy.getElementById(id);
        if (el.nonempty()) {
          const deg = degrees.get(id) ?? { in: 0, out: 0 };
          el.data('diameter', diameterFor(id, deg.in + deg.out));
        }
      }
    });

    // A removed locked node clears the detail panel and the dimming.
    if (removedFocused) clearFocus();

    applyLayout();
    // 图结构变了 → hub 集重算（zoom/pan 不重算，这是缓存的刷新点之一）。
    computeHubIds();
    updateLabelThrottle();
  }

  function applyNodeUpdate(node: ModuleNode): void {
    currentNodes.set(node.id, node);
    // With controls on, a state change can change what is visible (未测
    // filter, legend-hidden states) — re-render instead of patching one ball.
    if (filtersActive()) {
      renderVisible();
      return;
    }
    const el = cy.getElementById(node.id);
    if (el.nonempty()) {
      el.data('state', node.testState);
      // Ticket 07: keep the badge channel in sync (ring disappears at 0).
      el.data('typeErrorCount', node.typeErrors.length);
      // Code-review 2026-08-29: keep the review-ring channel in sync ('' at
      // checking/re-open, worst verdict once done).
      el.data('reviewVerdict', worstReviewVerdict(node.aiReview));
      // Ticket 12: checking class drives the edge pulse; done removes it.
      if (node.aiReview?.status === 'checking') el.addClass('checking');
      else el.removeClass('checking');
    }
    // The detail panel re-renders via main.ts when the node is focused.
  }

  function clearFocus(): void {
    lockedId = null;
    opts.onFocusChange(null);
    applyFocus(null);
  }

  // Code-review 2026-08-29: transient "the agent is reading this" pulse.
  // Each repeat read resets the expiry; a snapshot re-render simply outlives
  // the class (the pending timer removes a class the fresh element lacks,
  // which is a no-op).
  const viewingTimers = new Map<string, number>();

  function pulseViewing(id: string): void {
    const el = cy.getElementById(id);
    if (el.empty()) return; // filtered out / not yet scanned
    el.addClass('viewing');
    const prev = viewingTimers.get(id);
    if (prev !== undefined) window.clearTimeout(prev);
    viewingTimers.set(
      id,
      window.setTimeout(() => {
        viewingTimers.delete(id);
        cy.getElementById(id).removeClass('viewing');
      }, MOTION.viewingPulseMs)
    );
  }

  /**
   * Layout orchestration (candidate #4, 2026-09-03): each poster channel is
   * ONE deep solve function — solveClusterPoster (layout-cluster) owns the
   * four-stage cluster pipeline incl. the global min-distance guarantee,
   * solveRegionsPoster (graph-areas) owns fcose + compass translation + the
   * same guarantee. The pass ORDER lives inside the channel, not here.
   * What remains is the view-side contract: plates never enter fcose or the
   * physics state map (removed first, re-added last — regions only), and
   * physics.rebase()/persistLayout() always run AFTER the solve so the
   * separation landings become the drift bases and the write-through
   * archive (ADR 0004 D3/D5).
   */
  function applyLayout(): void {
    cy.nodes('.region-plate').remove();
    if (cy.nodes().empty()) return;
    if (layoutMode === 'cluster') {
      solveClusterPoster(cy);
      physics?.rebase();
      persistLayout();
      return;
    }
    solveRegionsPoster(cy, regions);
    physics?.rebase();
    persistLayout();
    syncRegionPlates(cy, regions);
  }

  // -------------------------------------------------------------------------
  // 标签节流 (2026-09-01 D5)：默认档（视口内球数 > viewportMax）只给度数
  // 前 hubCount 的球上标签，聚焦球靠 CSS `.focused` 通道并行显示（hover 信息
  // 本就有独立 tooltip）；视口内 ≤ viewportMax 全开。hub 集只在图结构变化
  // （renderVisible/applyDelta）时重算缓存在 hubIds，zoom/pan 只重判视口。
  // -------------------------------------------------------------------------

  let hubIds = new Set<string>();

  /** 可见球（题注板除外）→ 度数降序、id 升序决胜，取前 hubCount。 */
  function computeHubIds(): void {
    const ranked: { id: string; deg: number }[] = [];
    cy.nodes().forEach((n: cytoscape.NodeSingular) => {
      if (n.hasClass('region-plate')) return;
      const d = degrees.get(n.id());
      if (d === undefined) return;
      ranked.push({ id: n.id(), deg: d.in + d.out });
    });
    ranked.sort((a, b) => (b.deg - a.deg) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    hubIds = new Set(ranked.slice(0, THEME.labels.hubCount).map((r) => r.id));
  }

  /** 视口感知的标签开关：class 通道批量切换，无 rAF 状态、事件同步跑。 */
  function updateLabelThrottle(): void {
    const z = cy.zoom();
    const pan = cy.pan();
    const xMin = -pan.x / z;
    const xMax = (cy.width() - pan.x) / z;
    const yMin = -pan.y / z;
    const yMax = (cy.height() - pan.y) / z;
    const balls: { id: string; x: number; y: number }[] = [];
    cy.nodes().forEach((n: cytoscape.NodeSingular) => {
      // 题注板的标签不走节流通道（.region-plate 规则自带 label）。
      if (n.hasClass('region-plate')) return;
      const p = n.position();
      balls.push({ id: n.id(), x: p.x, y: p.y });
    });
    const inViewport = balls.filter(
      (b) => b.x >= xMin && b.x <= xMax && b.y >= yMin && b.y <= yMax
    );
    const wanted =
      inViewport.length <= THEME.labels.viewportMax
        ? new Set(inViewport.map((b) => b.id))
        : hubIds;
    cy.batch(() => {
      for (const b of balls) {
        cy.getElementById(b.id).toggleClass('labeled', wanted.has(b.id));
      }
    });
  }


  // -------------------------------------------------------------------------
  // Focus: hover = one-hop neighborhood stays lit, rest dims; click = lock
  // (tap again or tap background to unlock). Verdict #5.
  // -------------------------------------------------------------------------

  function applyFocus(focusId: string | null): void {
    cy.batch(() => {
      cy.elements().removeClass('dimmed focused');
      if (focusId === null) return;
      const focus = cy.getElementById(focusId);
      if (focus.empty()) return;
      const hood = focus.closedNeighborhood();
      // 区域板块是背景铬,不参与聚焦调暗。
      cy.elements().not(hood).not('.region-plate').addClass('dimmed');
      hood.edges().addClass('focused');
      focus.addClass('focused');
    });
  }

  // currentNodes (not a frozen snapshot) is the single source of truth here:
  // applyDelta/applyNodeUpdate keep it in sync, so taps on nodes that arrived
  // after the initial snapshot still resolve (detail panel must open).
  function findNode(id: string): ModuleNode | null {
    return currentNodes.get(id) ?? null;
  }

  cy.on('mouseover', 'node', (evt) => {
    if (evt.target.hasClass('region-plate')) return; // 题注不弹 tooltip
    if (lockedId === null) applyFocus(evt.target.id());
    if (physics !== null) {
      physics.popNode(evt.target, MOTION.hoverPopMult);
      evt.target
        .closedNeighborhood()
        .nodes()
        .forEach((n: cytoscape.NodeSingular) => {
          if (n.id() !== evt.target.id()) physics.popNode(n, MOTION.neighborPopMult);
        });
    }
    // ADR 0002 §7.2: 越界球 tooltip 带警示文案。
    const path = String(evt.target.data('path') ?? '');
    opts.tooltipEl.textContent = evt.target.hasClass('out-of-scope') ? `${path} · 越界改动` : path;
    opts.tooltipEl.style.opacity = '1';
  });
  cy.on('mousemove', 'node', (evt) => {
    const p = evt.renderedPosition ?? evt.target.renderedPosition();
    opts.tooltipEl.style.left = `${p.x + 14}px`;
    opts.tooltipEl.style.top = `${p.y - 10}px`;
  });
  cy.on('mouseout', 'node', () => {
    if (lockedId === null) applyFocus(null);
    physics?.restorePop();
    opts.tooltipEl.style.opacity = '0';
  });

  cy.on('tap', 'node', (evt) => {
    const id = evt.target.id();
    if (lockedId === id) {
      clearFocus();
      return;
    }
    lockedId = id;
    opts.onFocusChange(findNode(id));
    applyFocus(id);
  });
  cy.on('tap', (evt) => {
    if (evt.target !== cy) return;
    if (lockedId !== null) clearFocus();
  });

  // 布局存档 · 拖放即保存 (Code-review 2026-08-29, Obsidian Persistent Graph
  // 语义): the drop point becomes the physics drift base AND the archive
  // entry in one move — user intent is always authoritative over the last
  // auto-solve. Independent of the physics option (persistence is not a
  // motion feature); plates carry events:'no' so they can't be dragged in.
  // 聚类模式拖拽照旧写档 (ADR 0004/D2 搁置): 求解不读存档,手摆位只活到
  // 下一次重渲,切回区域模式即复活——COMPROMISES 12 在册。
  cy.on('dragfree', 'node', (evt) => {
    if (currentRoot === null) return;
    if (typeof evt.target.hasClass === 'function' && evt.target.hasClass('region-plate')) return; // 题注不可拖
    const p = evt.target.position();
    store.update(currentRoot, evt.target.id(), { x: p.x, y: p.y });
  });

  // 标签节流 (2026-09-01 D5)：zoom/pan 只重判视口（同步 batch，无 rAF 状态）,
  // hub 集不随缩放变（结构刷新点在 renderVisible/applyDelta）。
  cy.on('zoom', () => updateLabelThrottle());
  cy.on('pan', () => updateLabelThrottle());

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  function focusNode(id: string): void {
    const node = cy.getElementById(id);
    // A detail-panel jump must not lock a ball the active filter hides —
    // the panel would show a node with no ball on canvas.
    if (node.empty()) return;
    cy.center(node);
    lockedId = id;
    opts.onFocusChange(findNode(id));
    applyFocus(id);
  }

  function resetView(): void {
    if (cy.elements().nonempty()) cy.fit(undefined, THEME.canvas.padding);
  }

  function resetLayout(): void {
    if (currentRoot !== null) store.clear(currentRoot);
    // 存档清空后每个球都拿不回旧位 → 全量重渲,fcose 从头解一次。
    renderVisible();
  }

  function getLayoutMode(): LayoutMode {
    return layoutMode;
  }

  /**
   * 切换排列模式 (ADR 0004): 持久化 per-root 模式 + 全量重排。两模式互为
   * 种子（D5 单档 write-through）——上一次求解的落点就是这一次的重排起点,
   * 切换瞬间的视觉跳变是预期行为。同值点击不重渲。
   */
  function setLayoutMode(mode: LayoutMode): void {
    if (mode === layoutMode) return;
    layoutMode = mode;
    if (currentRoot !== null) store.setMode(currentRoot, mode);
    opts.onLayoutModeChange?.(mode);
    renderVisible();
  }

  const onResize = (): void => {
    cy.resize();
  };
  window.addEventListener('resize', onResize);
  // Physics owns a self-continuing rAF loop; stop it when the page goes away
  // (destroy() existed unwired until the 2026-08-29 review).
  window.addEventListener('pagehide', () => physics?.destroy(), { once: true });

  return {
    setSnapshot,
    applyDelta,
    applyNodeUpdate,
    pulseViewing,
    setViewState(patch: Partial<ViewState>): void {
      let changed = false;
      if (patch.query !== undefined && patch.query !== viewState.query) {
        viewState.query = patch.query;
        changed = true;
      }
      if (patch.untestedOnly !== undefined && patch.untestedOnly !== viewState.untestedOnly) {
        viewState.untestedOnly = patch.untestedOnly;
        changed = true;
      }
      if (patch.hiddenStates !== undefined) {
        viewState.hiddenStates = new Set(patch.hiddenStates);
        changed = true;
      }
      if (patch.hideReviewed !== undefined && patch.hideReviewed !== viewState.hideReviewed) {
        viewState.hideReviewed = patch.hideReviewed;
        changed = true;
      }
      if (changed) renderVisible();
    },
    focusNode,
    clearFocus,
    resetView,
    resetLayout,
    getLayoutMode,
    setLayoutMode,
    setTheme(key: ThemeKey): void {
      setActiveTheme(key);
      cy.style(buildStylesheet());
    },
    setEditScope(scope: EditScopeDecl | null): void {
      editScope = scope;
      // 新范围 = 新基线：已改/越界标记清零，等下一次 report_edits 再点亮。
      editedIds = new Set();
      outOfScopeIds = new Set();
      renderVisible();
    },
    setEditVerification(verification: EditVerificationWire): void {
      editedIds = new Set(verification.edited);
      outOfScopeIds = new Set(verification.outOfScope);
      renderVisible();
    },
    cycleCount(): number {
      return backEdgeIds.size;
    }
  };
}

/**
 * The cy stylesheet, themed: colors read from the ACTIVE palette at build
 * time; setTheme() rebuilds it (cy.style) so a re-skin never touches
 * positions or data. Rule order matters — later rules win.
 */
function buildStylesheet(): cytoscape.StylesheetStyle[] {
  const p = cyPalette();
  const te = THEME.typeError[activeThemeKey()];
  const reduced = prefersReducedMotion();

  const stateRules: cytoscape.StylesheetStyle[] = STATE_ORDER.map((state) => ({
    selector: `node[state = "${state}"]`,
    style: { 'background-color': p.states[state] }
  }));

  // Code-review 2026-08-29: AI 评审环 — border 通道。underlay 实测渲染的
  // 是圆角方形而非正圆，改走 border 后环随节点是正圆；声明位置在 type-error
  // 环之后（评审结论赢、type-error 让位），focused 环仍在最后。checking 中
  // 无环：begin_review 会把 data 复位成 ''。
  const reviewRingRules: cytoscape.StylesheetStyle[] = (
    ['confident', 'unsure', 'error'] as const
  ).map((verdict) => ({
    selector: `node[reviewVerdict = "${verdict}"]`,
    style: {
      'border-width': THEME.reviewRing.width,
      'border-color': p.review[verdict],
      'border-opacity': 1
    }
  }));

  return [
    {
      selector: 'node',
      style: nodeStyle({
        width: 'data(diameter)',
        height: 'data(diameter)',
        // 标签节流 (2026-09-01 D5)：默认无标签——.labeled（JS 节流通道：视口
        // ≤40 全开 / 超档度数前 24）与 .focused（hover/锁定并行通道）在下方
        // 各自把 label 接回来；题注板用自己的 .region-plate 规则。
        label: '',
        'font-size': THEME.node.labelFontSize,
        // Vibrancy (small text over a busy canvas): slightly heavier weight
        // + a ground-colored chip behind the glyphs — the label stays legible
        // over plates, edges and neighboring balls without out-shouting them.
        'font-weight': 500,
        color: p.label,
        'text-valign': 'bottom',
        'text-margin-y': 3,
        'text-wrap': 'ellipsis',
        'text-max-width': 70,
        'text-background-color': p.canvas,
        'text-background-opacity': 0.6,
        'text-background-padding': 2,
        'text-background-shape': 'roundrectangle',
        'background-color': p.states.untested,
        'border-width': p.nodeBorderW,
        'border-color': p.nodeBorderColor,
        'overlay-color': p.accent,
        'overlay-opacity': 'data(oo)',
        'overlay-padding': 9,
        'transition-property': 'opacity, border-width',
        'transition-duration': reduced ? 0 : 180,
        'transition-timing-function': 'ease-out'
      } as EdgeStylePatch)
    },
    {
      // 区域题注 (graph-areas syncRegionPlates): per user ruling 2026-08-29
      // the background plate is GONE — a region is a name floating above its
      // pile and nothing else. The carrier node is 1×1 and invisible; only
      // the caption renders, no fill, no border, no chip. events:'no' so
      // taps fall through to the background.
      selector: '.region-plate',
      style: nodeStyle({
        shape: 'round-rectangle',
        width: 1,
        height: 1,
        label: 'data(label)',
        'background-opacity': 0,
        'border-width': 0,
        color: p.plate.label,
        'font-size': 10,
        'font-weight': 600,
        'text-transform': 'uppercase',
        'text-valign': 'top',
        'z-compound-depth': 'bottom',
        events: 'no',
        'overlay-opacity': 0
      } as EdgeStylePatch)
    },
    {
      // 标签节流通道 (2026-09-01 D5)：JS 按视口/hub 集挂 .labeled，未挂即无字。
      selector: 'node.labeled',
      style: {
        label: 'data(label)'
      }
    },
    ...stateRules,
    {
      selector: 'edge',
      style: edgeStyle({
        width: THEME.edge.width,
        'line-color': p.edge.color,
        'line-opacity': p.edge.alpha,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': THEME.edge.arrowScale,
        'target-arrow-color': p.edge.color,
        'target-arrow-opacity': p.edge.alpha,
        'overlay-opacity': 0,
        'transition-property': 'opacity',
        'transition-duration': reduced ? 0 : 140
      })
    },
    {
      // 区域化海报: cross-region lines all thin+faint — the hub story is
      // told by node size and spine position, not by line volume. Declared
      // after the base edge rule (it wins) and before edge.cycle so a
      // cross-region cycle keeps the vermillion alarm.
      selector: 'edge.edge-cross',
      style: edgeStyle({
        width: THEME.areas.crossEdgeWidth,
        'line-opacity': THEME.areas.crossEdgeAlpha,
        'target-arrow-opacity': THEME.areas.crossEdgeAlpha
      })
    },
    {
      // Verdict #4: cycle edges 2.4px dashed vermillion (class channel —
      // see edgeElement; the `[cycle]` data selector would match false).
      selector: 'edge.cycle',
      style: edgeStyle({
        width: THEME.edge.cycleWidth,
        'line-style': 'dashed',
        'line-color': p.edge.cycleColor,
        'target-arrow-color': p.edge.cycleColor,
        'line-opacity': p.edge.cycleAlpha,
        'target-arrow-opacity': p.edge.cycleAlpha
      })
    },
    {
      // Code-review 2026-08-29: module-activity viewing pulse — violet
      // border + violet breathing overlay (physics drives `oo` only when the
      // node is NOT checking). Declared before node.checking so a module
      // under active review keeps the stronger checking visuals.
      selector: 'node.viewing',
      style: {
        'border-width': 1.2,
        'border-color': p.viewing,
        'border-opacity': 1,
        'overlay-color': p.viewing
      }
    },
    {
      // Ticket 12: AI 检查中 — theme-accent bright edge; the breathing
      // overlay pulse is data-driven by physics.ts (static when reduced).
      selector: 'node.checking',
      style: {
        'border-width': 1.6,
        'border-color': p.accent,
        'border-opacity': 1
      }
    },
    {
      // Ticket 07: type-error badge — an error ring on balls with ≥1 type
      // error, its own channel next to the state fill. Declared before the
      // focus rule so the transient focus ring wins while a node is locked.
      selector: 'node[typeErrorCount > 0]',
      style: {
        'border-width': te.borderWidth,
        'border-color': te.color,
        'border-opacity': 1
      }
    },
    // 评审环声明在 type-error 之后：被评审的球以评审结论为主视觉，
    // type-error 环让位（信息仍在详情面板与源码行）。
    ...reviewRingRules,
    {
      // ADR 0002 §7.2: 范围 = 常驻紫环。声明在评审环之后（范围纪律优先，
      // 范围环赢过类型错误/评审环），checking/viewing/focused 等瞬态规则
      // 仍在其后——正在检查/聚焦的球保持强视觉。
      selector: 'node.in-scope',
      style: {
        'border-width': 1.4,
        'border-color': p.scope.ring,
        'border-opacity': 1
      }
    },
    {
      // ADR 0002 §7.2: 已改 = 整球紫填充（background 通道，覆盖状态球色；
      // 状态仍可从图例/详情面板读取）。
      selector: 'node.edited',
      style: {
        'background-color': p.scope.fill
      }
    },
    {
      // 入场编排: nodes mount invisible and fade in once, on first load.
      selector: 'node.pre',
      style: { opacity: 0 }
    },
    {
      selector: 'node.dimmed',
      style: { opacity: p.dimNode }
    },
    {
      selector: 'edge.dimmed',
      style: { opacity: p.dimEdge }
    },
    {
      // Verdict #4: highlight = accent recolor.
      selector: 'edge.focused',
      style: edgeStyle({
        'line-color': p.accent,
        'target-arrow-color': p.accent,
        'line-opacity': 1,
        'target-arrow-opacity': 1
      })
    },
    {
      // focused 是标签的第二通道 (D5)：被聚焦/锁定的球哪怕不在 hub 集也亮字。
      selector: 'node.focused',
      style: {
        'border-width': 2.4,
        'border-color': p.accent,
        label: 'data(label)'
      }
    }
  ];
}
