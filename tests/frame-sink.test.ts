// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { GraphDelta, GraphEvent, GraphSnapshot, ModuleNode, TestState } from '../src/shared/types.js';
import type { DetailContext, DetailPanel } from '../src/web/detail-panel.js';
import { createFrameSink, type LegendFilters } from '../src/web/frame-sink.js';
import { createGraphModel } from '../src/web/graph-model.js';
import type { LegendCounts } from '../src/web/legend.js';
import type { GraphView } from '../src/web/graph-view.js';
import type { Statusbar } from '../src/web/statusbar.js';

/**
 * The frame choreography tested on its interface: frames in, folds + view
 * calls + derived-UI refreshes out. The a236598 bug (stale legend counts on
 * node_update/delta) and its fix (one coalesced derived refresh per batch)
 * are pinned here, plus malformed-frame dropping and focus honesty.
 */

function node(over: Partial<ModuleNode> = {}): ModuleNode {
  return { id: 'a.ts', path: 'src/a.ts', language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [], ...over };
}

function snapshot(nodes: ModuleNode[], edges: Array<{ from: string; to: string }> = []): GraphSnapshot {
  return { rootPath: '/proj', generatedAt: 1, nodes, edges };
}

const flush = (): Promise<void> => Promise.resolve();

function harness() {
  const model = createGraphModel();
  const viewCalls: string[] = [];
  const view: GraphView = {
    setSnapshot: () => viewCalls.push('setSnapshot'),
    applyDelta: () => viewCalls.push('applyDelta'),
    applyNodeUpdate: () => viewCalls.push('applyNodeUpdate'),
    pulseViewing: (id: string) => viewCalls.push(`viewing:${id}`),
    setViewState: () => viewCalls.push('setViewState'),
    focusNode: (id: string) => viewCalls.push(`focus:${id}`),
    clearFocus: () => viewCalls.push('clearFocus'),
    resetView: () => {},
    setTheme: () => {},
    cycleCount: () => 2
  };
  const counts: Array<[number, number, number, string]> = [];
  const bands: Array<Record<TestState, number>> = [];
  const flashes: string[] = [];
  const statusbar: Statusbar = {
    setCounts: (nodes, edges, cycles, rootPath) => counts.push([nodes, edges, cycles, rootPath]),
    setBand: (band) => bands.push({ ...band }),
    flashEvent: (text) => flashes.push(text)
  };
  const legendRenders: LegendCounts[] = [];
  const legend = {
    render: (c: LegendCounts) =>
      legendRenders.push({ ...c, states: { ...c.states }, reviews: { ...c.reviews }, hiddenStates: new Set(c.hiddenStates) })
  };
  const shown: Array<{ node: ModuleNode; ctx: DetailContext }> = [];
  let clears = 0;
  const detail: DetailPanel = {
    show: (n, ctx) => shown.push({ node: { ...n }, ctx }),
    clear: () => clears++
  };
  const scanNotice = document.createElement('div');
  const filters: LegendFilters = { hiddenStates: new Set<TestState>(), hideReviewed: false };

  const sink = createFrameSink({
    model,
    view,
    statusbar,
    legend,
    detail,
    scanNotice,
    filters: () => ({ hiddenStates: new Set(filters.hiddenStates), hideReviewed: filters.hideReviewed })
  });
  return { sink, model, viewCalls, counts, bands, flashes, legendRenders, shown, clears: () => clears, scanNotice, filters };
}

describe('FrameSink — snapshot frames', () => {
  it('folds, updates the view, flashes, and refreshes derived UI once per batch', async () => {
    const { sink, model, viewCalls, flashes, counts, bands, legendRenders } = harness();
    sink.apply({
      type: 'snapshot',
      snapshot: snapshot([node(), node({ id: 'b.ts', path: 'src/b.ts' })], [{ from: 'a.ts', to: 'b.ts' }])
    });

    expect(model.nodes()).toHaveLength(2);
    expect(viewCalls).toEqual(['setSnapshot']);
    expect(flashes).toEqual(['快照 2 节点 / 1 边']);
    // Derived refresh is coalesced onto the microtask, not inside the frame.
    expect(counts).toHaveLength(0);
    expect(legendRenders).toHaveLength(0);

    await flush();
    expect(counts).toEqual([[2, 1, 2, '/proj']]);
    expect(bands.at(-1)).toEqual({ passing: 0, failing: 0, 'has-tests-unrun': 0, untested: 2 });
    expect(legendRenders).toHaveLength(1);
  });

  it('plays the entrance once, on the first snapshot only', () => {
    const { sink } = harness();
    sink.apply({ type: 'snapshot', snapshot: snapshot([node()]) });
    expect(document.body.classList.contains('enter')).toBe(true);
  });
});

describe('FrameSink — malformed frames', () => {
  it('drops them whole and keeps the last good frame', async () => {
    const { sink, model, viewCalls } = harness();
    sink.apply({ type: 'snapshot', snapshot: snapshot([node()]) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      sink.apply({ type: 'snapshot' } as unknown as GraphEvent);
      sink.apply({ type: 'graph_delta', delta: {} as unknown as GraphDelta });
      sink.apply({ type: 'node_update', node: { id: 'x' } as unknown as ModuleNode });
    } finally {
      warn.mockRestore();
    }
    await flush();
    expect(viewCalls).toEqual(['setSnapshot']);
    expect(model.node('x')).toBeUndefined();
  });
});

describe('FrameSink — derived-UI coalescing', () => {
  it('a node_update burst refreshes counts/legend once; flashes stay per-frame', async () => {
    const { sink, flashes, counts, bands, legendRenders } = harness();
    sink.apply({ type: 'snapshot', snapshot: snapshot([node(), node({ id: 'b.ts', path: 'src/b.ts' })]) });
    await flush();
    const countsBefore = counts.length;
    const rendersBefore = legendRenders.length;

    sink.apply({ type: 'node_update', node: node({ testState: 'passing' }) });
    sink.apply({ type: 'node_update', node: node({ id: 'b.ts', path: 'src/b.ts', testState: 'failing' }) });
    sink.apply({
      type: 'node_update',
      node: node({ testState: 'passing', aiReview: { status: 'done', verdicts: [{ line: 1, verdict: 'confident' }] } })
    });

    // Ticker immediacy survives the coalescing; the derived refresh does not.
    expect(flashes).toHaveLength(4);
    expect(counts).toHaveLength(countsBefore);
    expect(legendRenders).toHaveLength(rendersBefore);

    await flush();
    expect(counts).toHaveLength(countsBefore + 1);
    expect(bands.at(-1)).toEqual({ passing: 1, failing: 1, 'has-tests-unrun': 0, untested: 0 });
    expect(legendRenders).toHaveLength(rendersBefore + 1);
    expect(legendRenders.at(-1)!.states).toEqual({ passing: 1, failing: 1, 'has-tests-unrun': 0, untested: 0 });
    expect(legendRenders.at(-1)!.reviews).toEqual({ confident: 1, unsure: 0, error: 0 });
  });

  it('refreshDerived is available for non-frame mutations and reads the filters', () => {
    const { sink, filters, legendRenders } = harness();
    sink.apply({ type: 'snapshot', snapshot: snapshot([node()]) });
    const rendersBefore = legendRenders.length;

    filters.hiddenStates.add('untested');
    filters.hideReviewed = true;
    sink.refreshDerived();

    expect(legendRenders).toHaveLength(rendersBefore + 1);
    expect(legendRenders.at(-1)!.hiddenStates.has('untested')).toBe(true);
    expect(legendRenders.at(-1)!.hideReviewed).toBe(true);
  });
});

describe('FrameSink — focus honesty', () => {
  it('the panel follows focus, frames keep it honest, removal clears it', async () => {
    const { sink, model, viewCalls, shown, clears } = harness();
    sink.apply({ type: 'snapshot', snapshot: snapshot([node(), node({ id: 'b.ts', path: 'src/b.ts' })], [{ from: 'a.ts', to: 'b.ts' }]) });
    await flush();
    shown.length = 0;

    sink.setFocus(model.node('a.ts')!);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.ctx.incoming).toEqual([]);
    expect(shown[0]!.ctx.outgoing).toEqual(['b.ts']);
    shown[0]!.ctx.onJump('b.ts');
    expect(viewCalls).toContain('focus:b.ts');

    // A delta that patches the focused node re-shows it with fresh fields.
    sink.apply({
      type: 'graph_delta',
      delta: { addedNodes: [node({ testState: 'passing' })], removedNodeIds: [], addedEdges: [], removedEdges: [] }
    });
    expect(shown).toHaveLength(2);
    expect(shown[1]!.node.testState).toBe('passing');

    // A delta that removes the focused node clears the panel, once.
    sink.apply({
      type: 'graph_delta',
      delta: { addedNodes: [], removedNodeIds: ['a.ts'], addedEdges: [], removedEdges: [] }
    });
    expect(clears()).toBe(1);

    // Later frames must not resurrect a panel whose node is gone.
    sink.apply({
      type: 'graph_delta',
      delta: { addedNodes: [node({ id: 'c.ts', path: 'src/c.ts' })], removedNodeIds: [], addedEdges: [], removedEdges: [] }
    });
    expect(shown).toHaveLength(2);
  });

  it('a node_update refreshes the panel only for the focused id', async () => {
    const { sink, shown } = harness();
    sink.apply({ type: 'snapshot', snapshot: snapshot([node(), node({ id: 'b.ts', path: 'src/b.ts' })]) });
    await flush();
    shown.length = 0;
    sink.setFocus(node());
    const afterFocus = shown.length; // setFocus itself shows the panel
    expect(afterFocus).toBe(1);

    sink.apply({ type: 'node_update', node: node({ id: 'b.ts', path: 'src/b.ts', note: 'not focused' }) });
    expect(shown).toHaveLength(afterFocus);
    sink.apply({ type: 'node_update', node: node({ note: 'focused' }) });
    expect(shown).toHaveLength(afterFocus + 1);
    expect(shown.at(-1)!.node.note).toBe('focused');
  });

  it('clearFocus drops the panel', () => {
    const { sink, shown, clears } = harness();
    sink.setFocus(node());
    expect(shown).toHaveLength(1);
    sink.setFocus(null);
    expect(clears()).toBe(1);
    expect(shown).toHaveLength(1);
  });
});

describe('FrameSink — ticker and notice events', () => {
  it('scan_error surfaces the notice; the next snapshot retires it', () => {
    const { sink, scanNotice } = harness();
    sink.apply({ type: 'snapshot', snapshot: snapshot([node()]) });
    expect(scanNotice.hidden).toBe(true);

    sink.apply({ type: 'scan_error', message: 'boom' });
    expect(scanNotice.hidden).toBe(false);
    expect(scanNotice.textContent).toContain('boom');

    sink.apply({ type: 'snapshot', snapshot: snapshot([node()]) });
    expect(scanNotice.hidden).toBe(true);
  });

  it('review_timeout lands in the ticker', () => {
    const { sink, flashes } = harness();
    sink.apply({ type: 'review_timeout', id: 'a.ts', path: 'src/a.ts' });
    expect(flashes.at(-1)).toContain('AI 检查超时回落');
  });
});

describe('FrameSink — module_activity frames (code-review 2026-08-29)', () => {
  it('lights the viewing pulse and flashes the ticker without touching model or derived UI', async () => {
    const { sink, model, viewCalls, flashes, legendRenders } = harness();
    sink.apply({ type: 'snapshot', snapshot: snapshot([node()]) });
    await flush();
    const legendAfterSnapshot = legendRenders.length;

    sink.apply({ type: 'module_activity', id: 'a.ts', path: 'src/a.ts', activity: 'viewing', at: Date.now() });
    expect(viewCalls).toContain('viewing:a.ts');
    expect(flashes.at(-1)).toBe('AI 正在查看 a');
    // Transient frame: nothing folded, no derived-UI refresh scheduled.
    expect(model.node('a.ts')?.aiReview).toBeUndefined();
    expect(legendRenders).toHaveLength(legendAfterSnapshot);
  });

  it('drops malformed activity frames whole', () => {
    const { sink, viewCalls } = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      sink.apply({ type: 'module_activity', id: 42 } as unknown as GraphEvent);
    } finally {
      warn.mockRestore();
    }
    expect(viewCalls.filter((c) => String(c).startsWith('viewing'))).toHaveLength(0);
  });
});
