import { IncrementalGraph, isEmptyDelta } from './incremental-graph.js';
import { FileWatcher, DEFAULT_DEBOUNCE_MS, type WatchedChange } from './file-watcher.js';
import { StatePipeline } from './state-pipeline.js';
import type { TypecheckResult } from './typecheck.js';
import type { WsHub } from './http.js';
/**
 * Ticket 04 + 05: live graph pipeline.
 *
 * Watcher events are debounced into windows; each window is applied to the
 * IncrementalGraph (which re-parses only the touched files) and the net
 * delta is broadcast to every connected page as a `graph_delta` frame —
 * payload stays tiny regardless of repository size. A full-snapshot frame
 * is only pushed for the initial baseline.
 *
 * Failure semantics: when a window cannot be applied (lexer-level failure),
 * the last good snapshot stays in the engine, pages keep rendering it, and a
 * lightweight `scan_error` notice is broadcast instead. Recovery is
 * automatic: the next file event re-runs the window.
 */
export interface LiveReloadOptions {
  rootPath: string;
  hub: WsHub;
  log(msg: string): void;
  debounceMs?: number;
  /**
   * Graph engine to drive. Production passes the process-wide instance so
   * the startup baseline and every watcher window share one engine; tests
   * inject instrumented engines. Defaults to a fresh IncrementalGraph.
   */
  graph?: IncrementalGraph;
  /** Test seam; defaults to true. Disable to keep the pipeline graph-only. */
  states?: boolean;
  /** Test seam passed through to StatePipeline (defaults to real runTypecheck). */
  runTypecheckFn?: (rootPath: string) => Promise<TypecheckResult>;
  typecheckDelayMs?: number;
}

export interface LiveReloadHandle {
  /**
   * Resolves once the baseline scan is done (or degraded: a failed scan logs
   * and serves an empty graph — the watcher still starts and the next file
   * event rebuilds) and the watcher is listening. Rejects only if the
   * watcher itself cannot start.
   */
  ready: Promise<void>;
  stop(): Promise<void>;
}

export function startLiveReload(opts: LiveReloadOptions): LiveReloadHandle {
  const graph = opts.graph ?? new IncrementalGraph(opts.rootPath);
  let windowCount = 0;
  const statesEnabled = opts.states ?? true;
  const states = statesEnabled
    ? new StatePipeline({
        rootPath: opts.rootPath,
        graph,
        hub: opts.hub,
        log: opts.log,
        runTypecheckFn: opts.runTypecheckFn,
        typecheckDelayMs: opts.typecheckDelayMs
      })
    : null;

  // Window serialization: the watcher fires onQuiesce fire-and-forget, so a
  // slow window (awaiting applyEvents) can still be running when the next
  // debounce timer expires. Without this chain two applyEvents runs would
  // interleave read/write on the same IncrementalGraph and corrupt the graph.
  let windowChain: Promise<void> = Promise.resolve();
  const applyWindow = async (changes: WatchedChange[]): Promise<void> => {
    windowCount++;
    try {
      const delta = await graph.applyEvents(changes);
      if (!isEmptyDelta(delta)) {
        opts.hub.broadcast({ type: 'graph_delta', delta });
        opts.log(`delta        : +${delta.addedNodes.length}/-${delta.removedNodeIds.length} nodes, +${delta.addedEdges.length}/-${delta.removedEdges.length} edges → ${opts.hub.size} client${opts.hub.size === 1 ? '' : 's'} (window #${windowCount})`);
      }
      // State layers run even for empty graph deltas: a coverage-report-only
      // window must still remap colors (ticket 06/07 wiring).
      if (states) {
        await states.refreshCoverage();
        states.scheduleTypecheck();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.hub.broadcast({ type: 'scan_error', message });
      opts.log(`apply failed : ${message} (keeping the last good snapshot)`);
    }
  };

  const watcher = new FileWatcher({
    root: opts.rootPath,
    debounceMs: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    extraWatchFiles: states ? StatePipeline.watchedReportFiles : undefined,
    onQuiesce: (changes) => {
      windowChain = windowChain
        .then(() => applyWindow(changes))
        .catch(() => {}); // applyWindow reports failures itself; the chain must never reject
    },
    log: opts.log
  });

  const ready = (async (): Promise<void> => {
    try {
      await graph.fullScan();
      const snap = graph.snapshot();
      opts.log(`baseline     : ${snap.nodes.length} modules, ${snap.edges.length} edges (incremental engine)`);
      // Correct any page that connected before the baseline landed — its WS
      // handshake carried the empty pre-baseline snapshot.
      opts.hub.broadcast({ type: 'snapshot', snapshot: snap });
    } catch (err) {
      // Degrade, don't die: the engine keeps the empty graph, the watcher
      // still starts, and the next watcher window rebuilds everything via
      // its catch-up walk. The process stays usable for info-only consumers.
      opts.log(`baseline failed: ${err instanceof Error ? err.message : String(err)} (serving an empty graph until the next file event)`);
    }
    if (states) {
      await states.refreshCoverage();
      states.scheduleTypecheck();
    }
    await watcher.start();
    opts.log(`watcher      : watching ${opts.rootPath} (debounced ${opts.debounceMs ?? DEFAULT_DEBOUNCE_MS}ms, delta push per window)`);
  })();

  return {
    ready,
    stop: () => watcher.stop()
  };
}
