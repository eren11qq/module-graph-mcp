import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Edge, GraphDelta, GraphSnapshot, ModuleNode, TestState } from '../shared/types.js';
import { worstReviewVerdict } from './ai-review.js';
import { applyViewState, dirBallDirOf, type ViewState } from './graph-filters.js';
import { applyRegionLayout, assignRegions, syncRegionPlates, type RegionId } from './graph-areas.js';
import { findBackEdges, type LayoutGraphInput } from './back-edges.js';
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
}

export interface GraphView {
  setSnapshot(snapshot: GraphSnapshot): void;
  /** Ticket 05: apply one watcher window's net delta in place (no full re-render). */
  applyDelta(delta: GraphDelta): void;
  /** Ticket 06/07/08/12: single-node state patch (testState / typeErrors / aiReview / …). */
  applyNodeUpdate(node: ModuleNode): void;
  /** Ticket 11+theme view controls: 只看未测 / search / collapse / legend-hidden states. */
  setViewState(patch: Partial<ViewState>): void;
  /** Re-lock focus on a node and bring it into view (detail-panel jumps). */
  focusNode(id: string): void;
  /**
   * Code-review 2026-08-29: the agent just READ this module (module_activity
   * frame) — light the transient `viewing` pulse, self-expiring.
   */
  pulseViewing(id: string): void;
  /** Drop the current lock (Esc / close). */
  clearFocus(): void;
  resetView(): void;
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
  const expandedDirs = new Set<string>();
  let viewState: ViewState = {
    query: '',
    untestedOnly: false,
    collapseEnabled: false,
    expandedDirs,
    hiddenStates: new Set<TestState>(),
    hideReviewed: false
  };

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
    return {
      data: {
        id: n.id,
        label: shortLabel(n.path),
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
    expandedDirs.clear();

    currentNodes = new Map(next.nodes.map((n) => [n.id, n]));
    currentEdges = new Map(next.edges.map((e) => [edgeIdOf(e), e]));
    renderVisible();
  }

  /** True while any ticket-11 control reshapes the rendered graph. */
  function filtersActive(): boolean {
    return (
      viewState.query.trim() !== '' ||
      viewState.untestedOnly ||
      viewState.collapseEnabled ||
      viewState.hiddenStates.size > 0 ||
      viewState.hideReviewed
    );
  }

  /**
   * Full re-render of the visible graph: view pipeline (图例过滤 → 只看未测 →
   * 搜索 → 折叠) over currentNodes/currentEdges, then layout + element swap.
   * With every control off this renders the plain graph, so setSnapshot is
   * just bookkeeping + renderVisible.
   */
  function renderVisible(): void {
    const visible = applyViewState([...currentNodes.values()], [...currentEdges.values()], viewState);
    degrees = rebuildDegrees(visible.nodes, visible.edges);
    refreshRegions(visible.nodes, visible.edges);

    // Cycle arcs are computed once here and consumed by the edge styling
    // (dashed vermillion). Placement is fcose's job.
    const layoutInput: LayoutGraphInput = {
      nodes: visible.nodes.map((n) => ({ id: n.id, label: shortLabel(n.path) })),
      links: visible.edges.map((e) => ({ from: e.from, to: e.to }))
    };
    backEdgeIds = findBackEdges(layoutInput);

    const firstRender = !entered;
    entered = true;
    const elements: cytoscape.ElementDefinition[] = [
      ...visible.nodes.map((n) => {
        const def = nodeElement(n);
        if (firstRender) def.classes = `${def.classes} pre`.trim();
        return def;
      }),
      ...visible.edges.map((e) => edgeElement(e, backEdgeIds.has(edgeIdOf(e))))
    ];

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

    // 2) DOM mutations. Fresh balls get no preset position — the fcose
    //    re-run below pulls them into the simulation (randomize:false keeps
    //    existing balls where they are).
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
        cy.add(nodeElement(n));
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
  }

  function applyNodeUpdate(node: ModuleNode): void {
    currentNodes.set(node.id, node);
    // With controls on, a state change can change what is visible (未测
    // filter, dir-ball aggregation, legend-hidden states) — re-render
    // instead of patching one ball.
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
    if (el.empty()) return; // filtered out / aggregated away / not yet scanned
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
   * Single layout engine: force-directed fcose (randomize:false keeps balls
   * in place) + the 区域化海报 pass. The pass order is a hard constraint:
   * plates are removed first so they never enter fcose or the physics state
   * map; the rigid region translation sits BETWEEN fcose.run() and
   * physics.rebase(), because rebase snapshots whatever positions exist at
   * call time as the drift bases — translated spots in, poster preserved.
   * Plates come back last, once everything has settled.
   */
  function applyLayout(): void {
    cy.nodes('.region-plate').remove();
    if (cy.nodes().empty()) return;
    cy.layout({
      name: 'fcose',
      ...THEME.fcose,
      fit: true,
      padding: THEME.canvas.padding,
      animate: false
    } as cytoscape.LayoutOptions).run();
    applyRegionLayout(cy, regions);
    physics?.rebase();
    syncRegionPlates(cy, regions);
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
    opts.tooltipEl.textContent = evt.target.data('path');
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
    // Ticket 11: a collapsed directory ball expands just its own directory.
    const dir = dirBallDirOf(id);
    if (dir !== null) {
      expandedDirs.add(dir);
      renderVisible();
      return;
    }
    if (lockedId === id) {
      clearFocus();
      return;
    }
    lockedId = id;
    opts.onFocusChange(findNode(id));
    applyFocus(id);
  });
  cy.on('tap', (evt) => {
    if (evt.target === cy && lockedId !== null) clearFocus();
  });

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
      if (patch.collapseEnabled !== undefined && patch.collapseEnabled !== viewState.collapseEnabled) {
        viewState.collapseEnabled = patch.collapseEnabled;
        // Manual expansions belong to one collapse session only.
        expandedDirs.clear();
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
    setTheme(key: ThemeKey): void {
      setActiveTheme(key);
      cy.style(buildStylesheet());
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
        label: 'data(label)',
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
      selector: 'node.focused',
      style: {
        'border-width': 2.4,
        'border-color': p.accent
      }
    }
  ];
}
