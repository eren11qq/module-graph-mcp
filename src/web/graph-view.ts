import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Edge, GraphDelta, GraphSnapshot, ModuleNode } from '../shared/types.js';
import { applyViewState, dirBallDirOf, type ViewState } from './graph-filters.js';
import { findBackEdges, type LayoutGraphInput } from './hierarchy-layout.js';
import { THEME, diameterOf, shortLabel } from './theme.js';
import { STATE_ORDER, stateColor } from './test-states.js';

cytoscape.use(fcose);

export interface GraphViewOptions {
  /** Locked focus changed (null = nothing locked); drives the detail panel. */
  onFocusChange(node: ModuleNode | null): void;
  /** Hover tooltip element; receives the node's relative path. */
  tooltipEl: HTMLElement;
}

export interface GraphView {
  setSnapshot(snapshot: GraphSnapshot): void;
  /** Ticket 05: apply one watcher window's net delta in place (no full re-render). */
  applyDelta(delta: GraphDelta): void;
  /** Ticket 06/07/08: single-node state patch (testState / typeErrors / …). */
  applyNodeUpdate(node: ModuleNode): void;
  /** Ticket 11 view controls: 只看未测 / search / directory collapse (one surface). */
  setViewState(patch: Partial<ViewState>): void;
  /** Re-lock focus on a node and bring it into view (detail-panel jumps). */
  focusNode(id: string): void;
  /** Drop the current lock (Esc / close). */
  clearFocus(): void;
  resetView(): void;
}



/** @types/cytoscape omits `target-arrow-opacity`; cytoscape itself supports it. */
type EdgeStylePatch = { 'target-arrow-opacity'?: number };

function edgeStyle(
  style: cytoscape.StylesheetStyle['style'] & EdgeStylePatch
): cytoscape.StylesheetStyle['style'] {
  return style as cytoscape.StylesheetStyle['style'];
}

const edgeIdOf = (e: Edge): string => `${e.from}->${e.to}`;

export function createGraphView(container: HTMLElement, opts: GraphViewOptions): GraphView {
  const cy = cytoscape({
    container,
    wheelSensitivity: THEME.interaction.wheelSensitivity,
    boxSelectionEnabled: false,
    style: buildStylesheet()
  });

  let currentNodes = new Map<string, ModuleNode>();
  let currentEdges = new Map<string, Edge>();
  let degrees = new Map<string, { in: number; out: number }>();
  let backEdgeIds = new Set<string>();
  let lockedId: string | null = null;
  // Ticket 11 view controls; expandedDirs only matters while collapse is on.
  // The pipeline sees a ReadonlySet; the view owns the mutable copy.
  const expandedDirs = new Set<string>();
  let viewState: ViewState = { query: '', untestedOnly: false, collapseEnabled: false, expandedDirs };

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

  function nodeElement(n: ModuleNode): cytoscape.ElementDefinition {
    const deg = degrees.get(n.id) ?? { in: 0, out: 0 };
    return {
      data: {
        id: n.id,
        label: shortLabel(n.path),
        path: n.path,
        state: n.testState,
        diameter: diameterOf(deg.in + deg.out),
        typeErrorCount: n.typeErrors.length
      }
    };
  }

  function edgeElement(e: Edge, cycle: boolean): cytoscape.ElementDefinition {
    return {
      data: { id: edgeIdOf(e), source: e.from, target: e.to, cycle }
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
    return viewState.query.trim() !== '' || viewState.untestedOnly || viewState.collapseEnabled;
  }

  /**
   * Full re-render of the visible graph: view pipeline (只看未测 → 搜索 →
   * 折叠) over currentNodes/currentEdges, then layout + element swap. With
   * every control off this renders the plain graph, so setSnapshot is just
   * bookkeeping + renderVisible.
   */
  function renderVisible(): void {
    const visible = applyViewState([...currentNodes.values()], [...currentEdges.values()], viewState);
    degrees = rebuildDegrees(visible.nodes, visible.edges);

    // Cycle arcs are computed once here and consumed by the edge styling
    // (dashed vermillion). Placement is fcose's job.
    const layoutInput: LayoutGraphInput = {
      nodes: visible.nodes.map((n) => ({ id: n.id, label: shortLabel(n.path) })),
      links: visible.edges.map((e) => ({ from: e.from, to: e.to }))
    };
    backEdgeIds = findBackEdges(layoutInput);

    const elements: cytoscape.ElementDefinition[] = [
      ...visible.nodes.map(nodeElement),
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
      // Cycle styling and ball sizes on touched elements.
      cy.edges().forEach((ed) => {
        const want = backEdgeIds.has(ed.id());
        if (ed.data('cycle') !== want) ed.data('cycle', want);
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
          el.data('diameter', diameterOf(deg.in + deg.out));
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
    // filter, dir-ball aggregation) — re-render instead of patching one ball.
    if (filtersActive()) {
      renderVisible();
      return;
    }
    const el = cy.getElementById(node.id);
    if (el.nonempty()) {
      el.data('state', node.testState);
      // Ticket 07: keep the badge channel in sync (ring disappears at 0).
      el.data('typeErrorCount', node.typeErrors.length);
    }
    // The detail panel re-renders via main.ts when the node is focused.
  }

  function clearFocus(): void {
    lockedId = null;
    opts.onFocusChange(null);
    applyFocus(null);
  }

  /** Single layout engine: force-directed fcose (randomize:false keeps balls in place). */
  function applyLayout(): void {
    if (cy.nodes().empty()) return;
    cy.layout({
      name: 'fcose',
      ...THEME.fcose,
      fit: true,
      padding: THEME.canvas.padding,
      animate: false
    } as cytoscape.LayoutOptions).run();
  }

  // -------------------------------------------------------------------------
  // Focus: hover = one-hop neighborhood stays lit, rest dims to α 0.13;
  // click = lock (tap again or tap background to unlock). Verdict #5.
  // -------------------------------------------------------------------------

  function applyFocus(focusId: string | null): void {
    cy.batch(() => {
      cy.elements().removeClass('dimmed focused');
      if (focusId === null) return;
      const focus = cy.getElementById(focusId);
      if (focus.empty()) return;
      const hood = focus.closedNeighborhood();
      cy.elements().not(hood).addClass('dimmed');
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

  return {
    setSnapshot,
    applyDelta,
    applyNodeUpdate,
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
      if (changed) renderVisible();
    },
    focusNode,
    clearFocus,
    resetView
  };
}

function buildStylesheet(): cytoscape.StylesheetStyle[] {
  const stateRules: cytoscape.StylesheetStyle[] = STATE_ORDER.map((state) => ({
    selector: `node[state = "${state}"]`,
    style: { 'background-color': stateColor(state) }
  }));

  return [
    {
      selector: 'node',
      style: {
        width: 'data(diameter)',
        height: 'data(diameter)',
        label: 'data(label)',
        'font-size': THEME.node.labelFontSize,
        color: THEME.node.labelColor,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'background-color': stateColor('untested'),
        'border-width': 0,
        'overlay-opacity': 0
      }
    },
    ...stateRules,
    {
      selector: 'edge',
      style: edgeStyle({
        width: THEME.edge.width,
        'line-color': THEME.edge.color,
        'line-opacity': THEME.edge.alpha,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': THEME.edge.arrowScale,
        'target-arrow-color': THEME.edge.color,
        'target-arrow-opacity': THEME.edge.alpha,
        'overlay-opacity': 0
      })
    },
    {
      // Verdict #4: cycle edges 2.4px dashed #D55E00 (the peeled back arcs).
      selector: 'edge[cycle]',
      style: edgeStyle({
        width: THEME.edge.cycle.width,
        'line-style': 'dashed',
        'line-color': THEME.edge.cycle.color,
        'target-arrow-color': THEME.edge.cycle.color,
        'line-opacity': THEME.edge.cycle.alpha,
        'target-arrow-opacity': THEME.edge.cycle.alpha
      })
    },
    {
      // Ticket 07: type-error badge — an error ring on balls with ≥1 type
      // error, its own channel next to the state fill. Declared before the
      // focus rule so the transient focus ring wins while a node is locked.
      selector: 'node[typeErrorCount > 0]',
      style: {
        'border-width': THEME.typeError.borderWidth,
        'border-color': THEME.typeError.color,
        'border-opacity': 1
      }
    },
    {
      selector: '.dimmed',
      style: { opacity: THEME.interaction.dimOpacity }
    },
    {
      // Verdict #4: highlight = accent-blue recolor.
      selector: 'edge.focused',
      style: edgeStyle({
        'line-color': THEME.edge.highlightColor,
        'target-arrow-color': THEME.edge.highlightColor,
        'line-opacity': 1,
        'target-arrow-opacity': 1
      })
    },
    {
      selector: 'node.focused',
      style: {
        'border-width': 2,
        'border-color': THEME.edge.highlightColor
      }
    }
  ];
}
