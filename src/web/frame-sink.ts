import type { GraphEvent, ModuleNode, TestState } from '../shared/types.js';
import { worstReviewVerdict } from './ai-review.js';
import type { DetailPanel } from './detail-panel.js';
import { isGraphDelta, isGraphSnapshot, isModuleNode } from './frame-guards.js';
import type { GraphModel } from './graph-model.js';
import type { GraphView } from './graph-view.js';
import type { Legend, LegendCounts } from './legend.js';
import type { Statusbar } from './statusbar.js';
import { stateLabel } from './test-states.js';
import { CHROME, shortLabel } from './theme.js';

/**
 * The frame choreography, one place (architecture review 2026-08-29,
 * candidate #2). Every wire frame used to be folded and fanned out by hand
 * in main.ts — three near-identical "fold → view → derived UI" routines and
 * six renderLegend call sites; missing one was a shipped bug (a236598).
 *
 * apply(event) is the single seam for the WHOLE wire vocabulary: fold into
 * the model, update the view, refresh the derived UI (statusbar counts,
 * coverage band, legend, focused detail panel). Untrusted frames are guarded
 * here — a malformed frame is dropped whole and the last good frame stays.
 *
 * Derived refresh is coalesced per microtask: a burst of N node_update
 * frames (e.g. a coverage remap) rebuilds the legend once, not N times, and
 * the per-state counts are computed once per refresh. Ticker flashes stay
 * synchronous — event immediacy is not part of the bargain.
 */

/** Ownership of the filter knobs stays with the composition root; the sink
    reads them at render time (main.ts mirrors nothing into the sink). */
export interface LegendFilters {
  hiddenStates: ReadonlySet<TestState>;
  hideReviewed: boolean;
}

export interface FrameSinkDeps {
  model: GraphModel;
  view: GraphView;
  statusbar: Statusbar;
  legend: Legend;
  detail: DetailPanel;
  scanNotice: HTMLElement;
  filters(): LegendFilters;
}

export interface FrameSink {
  apply(event: GraphEvent): void;
  /** Derived-UI refresh for non-frame mutations (view-state toggles, theme). */
  refreshDerived(): void;
  /** The detail panel follows focus; frames keep the focused panel honest. */
  setFocus(node: ModuleNode | null): void;
}

export function createFrameSink(opts: FrameSinkDeps): FrameSink {
  const { model, view, statusbar, legend, detail, scanNotice } = opts;

  let focusedId: string | null = null;
  let entrancePlayed = false;

  /** 入场编排: shell + graph fade in once, on the very first snapshot only. */
  function playEntrance(): void {
    if (entrancePlayed) return;
    entrancePlayed = true;
    document.body.classList.add('enter');
    window.setTimeout(() => document.body.classList.remove('enter'), CHROME.entranceTotalMs);
  }

  function stateCounts(nodes: readonly ModuleNode[]): Record<TestState, number> {
    const counts: Record<TestState, number> = {
      passing: 0,
      failing: 0,
      'has-tests-unrun': 0,
      untested: 0
    };
    for (const n of nodes) counts[n.testState]++;
    return counts;
  }

  function reviewCounts(nodes: readonly ModuleNode[]): LegendCounts['reviews'] {
    const counts: LegendCounts['reviews'] = { confident: 0, unsure: 0, error: 0 };
    for (const n of nodes) {
      const v = worstReviewVerdict(n.aiReview);
      if (v !== '') counts[v]++;
    }
    return counts;
  }

  function refreshDerived(): void {
    const nodes = model.nodes();
    const counts = stateCounts(nodes);
    statusbar.setCounts(nodes.length, model.edges().length, view.cycleCount(), model.rootPath() ?? '…');
    statusbar.setBand(counts);
    const filters = opts.filters();
    legend.render({
      states: counts,
      reviews: reviewCounts(nodes),
      hiddenStates: filters.hiddenStates,
      hideReviewed: filters.hideReviewed
    });
  }

  // Frames arrive in bursts; one refresh per microtask batch keeps the
  // legend honest at once-per-batch cost instead of once-per-frame.
  let derivedScheduled = false;
  function scheduleDerived(): void {
    if (derivedScheduled) return;
    derivedScheduled = true;
    queueMicrotask(() => {
      derivedScheduled = false;
      refreshDerived();
    });
  }

  function showDetail(node: ModuleNode): void {
    const { incoming, outgoing } = model.neighbors(node.id);
    detail.show(node, {
      incoming,
      outgoing,
      onJump: (id) => view.focusNode(id)
    });
  }

  function apply(event: GraphEvent): void {
    switch (event.type) {
      case 'snapshot': {
        if (!isGraphSnapshot(event.snapshot)) {
          console.warn('ws: dropped malformed snapshot frame');
          return;
        }
        model.foldSnapshot(event.snapshot);
        view.setSnapshot(event.snapshot);
        scanNotice.hidden = true;
        statusbar.flashEvent(`快照 ${model.nodes().length} 节点 / ${model.edges().length} 边`);
        playEntrance();
        scheduleDerived();
        return;
      }

      case 'graph_delta': {
        // A malformed frame is dropped whole; the last good frame stays.
        if (!isGraphDelta(event.delta)) {
          console.warn('ws: dropped malformed graph_delta frame');
          return;
        }
        model.foldDelta(event.delta);
        view.applyDelta(event.delta);
        statusbar.flashEvent(
          `推送 +${event.delta.addedNodes.length}−${event.delta.removedNodeIds.length} 节点 · +${event.delta.addedEdges.length}−${event.delta.removedEdges.length} 边`
        );
        // A successful delta means the view caught up with disk — retire the
        // stale-frame notice (same contract as a snapshot).
        scanNotice.hidden = true;
        // Keep the detail panel honest when the locked node's edges changed.
        if (focusedId !== null) {
          const stillThere = model.node(focusedId);
          if (stillThere) showDetail(stillThere);
          else {
            focusedId = null;
            detail.clear();
          }
        }
        scheduleDerived();
        return;
      }

      case 'node_update': {
        if (!isModuleNode(event.node)) {
          console.warn('ws: dropped malformed node_update frame');
          return;
        }
        const node = event.node;
        model.foldNodeUpdate(node);
        view.applyNodeUpdate(node);
        if (node.aiReview?.status === 'checking') {
          statusbar.flashEvent(`AI 检查 ${shortLabel(node.id)} …`);
        } else if (node.aiReview?.status === 'done') {
          statusbar.flashEvent(`AI 检查完成 · ${shortLabel(node.id)}`);
        } else {
          statusbar.flashEvent(`更新 ${shortLabel(node.id)} · ${stateLabel(node.testState)}`);
        }
        if (focusedId === node.id) {
          const fresh = model.node(node.id);
          if (fresh) showDetail(fresh);
        }
        scheduleDerived();
        return;
      }

      case 'scan_error': {
        // Light notice: the last good frame stays on screen until a rescan succeeds.
        const message = typeof event.message === 'string' ? event.message : 'unknown error';
        scanNotice.textContent = `最近一次重扫失败（${message}），当前显示上一帧快照；文件恢复后将自动追平。`;
        scanNotice.hidden = false;
        return;
      }

      case 'review_timeout': {
        // 服务端强制回落了一个没人收尾的检查——脉冲已由配对的 node_update
        // 停止，这里只在 ticker 里说明原因。
        const id = typeof event.id === 'string' ? event.id : '';
        statusbar.flashEvent(`AI 检查超时回落 · ${shortLabel(id)}`);
        return;
      }
    }
  }

  return {
    apply,
    refreshDerived,
    setFocus(node: ModuleNode | null): void {
      focusedId = node?.id ?? null;
      if (node) showDetail(node);
      else detail.clear();
    }
  };
}
