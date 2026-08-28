import { CoverageMapper, COVERAGE_REPORT_CANDIDATES } from './coverage.js';
import type { IncrementalGraph } from './incremental-graph.js';
import { resolveTscBin, runTypecheck, type TypecheckResult } from './typecheck.js';
import type { WsHub } from './http.js';
import type { ModuleNode } from '../shared/types.js';

/**
 * Ticket 06+07+08 wiring: injects the two state layers (test coverage
 * colors, type-error badges) into the graph nodes and pushes `node_update`
 * patches for whatever changed.
 *
 * - Coverage remaps from scratch on every call; it is cheap (one small JSON
 *   read + string ops), so it runs after every watcher window — including
 *   windows that only touched the coverage report (the watcher is taught to
 *   react to it via extraWatchFiles).
 * - tsc runs are expensive, so they are coalesced: at most one run in
 *   flight, at most one queued rerun, and a spawn is never issued when the
 *   watched root has no local tsc.
 * - Both layers never throw into the graph pipeline: failures are logged
 *   and degrade (stale badges stay until a clean run replaces them).
 */

export interface StatePipelineOptions {
  rootPath: string;
  graph: IncrementalGraph;
  hub: WsHub;
  log(msg: string): void;
  /** Test seam; defaults to the real runTypecheck. */
  runTypecheckFn?: (rootPath: string) => Promise<TypecheckResult>;
  /** Delay before spawning tsc after a window, to batch rapid saves. */
  typecheckDelayMs?: number;
}

const TYPECHECK_DELAY_MS = 1_000;

export class StatePipeline {
  private readonly coverage: CoverageMapper;
  private typecheckInFlight = false;
  private typecheckPending = false;
  private typecheckTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: StatePipelineOptions) {
    this.coverage = new CoverageMapper(opts.rootPath);
  }

  /** Root-relative report candidates the watcher should also react to. */
  static readonly watchedReportFiles = COVERAGE_REPORT_CANDIDATES;

  /**
   * Re-derive test states for every node and patch the changed ones.
   * Cheap and idempotent — safe to call after every window.
   */
  async refreshCoverage(): Promise<void> {
    try {
      const files = this.opts.graph.nodeIds();
      const result = await this.coverage.refresh(files);
      const updated: ModuleNode[] = [];
      for (const [id, info] of result.states) {
        const node = this.opts.graph.node(id);
        if (!node) continue;
        const coveredByChanged =
          node.coveredBy.length !== info.coveredBy.length ||
          node.coveredBy.some((f, i) => f !== info.coveredBy[i]);
        const runAtChanged = node.lastTestRunAt !== result.reportMtimeMs;
        if (node.testState !== info.testState || coveredByChanged || runAtChanged) {
          node.testState = info.testState;
          node.coveredBy = info.coveredBy;
          node.lastTestRunAt = result.reportMtimeMs;
          updated.push(node);
        }
      }
      if (updated.length > 0) {
        for (const node of updated) this.opts.hub.broadcast({ type: 'node_update', node });
        this.opts.log(`coverage     : remapped ${files.length} files → ${updated.length} node${updated.length === 1 ? '' : 's'} updated (${result.reportFound ? `report ${result.reportPath}` : 'no report'})`);
      }
    } catch (err) {
      this.opts.log(`coverage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Queue a typecheck run after the save burst settles. Coalesced: a run in
   * flight + new changes ⇒ exactly one rerun afterwards.
   */
  scheduleTypecheck(): void {
    if (resolveTscBin(this.opts.rootPath) === undefined) return;
    if (this.typecheckTimer !== null) return; // already scheduled
    this.typecheckTimer = setTimeout(() => {
      this.typecheckTimer = null;
      void this.runTypecheckNow();
    }, this.opts.typecheckDelayMs ?? TYPECHECK_DELAY_MS);
  }

  private async runTypecheckNow(): Promise<void> {
    if (this.typecheckInFlight) {
      this.typecheckPending = true;
      return;
    }
    this.typecheckInFlight = true;
    try {
      const run = this.opts.runTypecheckFn ?? runTypecheck;
      const result = await run(this.opts.rootPath);
      this.applyTypecheck(result);
    } catch (err) {
      this.opts.log(`typecheck failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.typecheckInFlight = false;
      if (this.typecheckPending) {
        this.typecheckPending = false;
        this.scheduleTypecheck();
      }
    }
  }

  private applyTypecheck(result: TypecheckResult): void {
    if (result.status === 'timeout' || result.status === 'parse-failed') {
      // Degraded run: stale badges are more useful than blanked ones.
      this.opts.log(`typecheck ${result.status}: ${result.note ?? ''}`);
      return;
    }
    if (result.status === 'unavailable') {
      this.opts.log(`typecheck unavailable: ${result.note ?? ''}`);
      return;
    }

    const updated: ModuleNode[] = [];
    for (const id of this.opts.graph.nodeIds()) {
      const node = this.opts.graph.node(id);
      if (!node) continue;
      const next = result.status === 'errors' ? (result.errorsByFile.get(id) ?? []) : [];
      if (!typeErrorsEqual(node.typeErrors, next)) {
        node.typeErrors = next;
        updated.push(node);
      }
    }
    if (updated.length > 0) {
      for (const node of updated) this.opts.hub.broadcast({ type: 'node_update', node });
      this.opts.log(`typecheck     : ${result.status}, ${result.totalErrors} error${result.totalErrors === 1 ? '' : 's'} → ${updated.length} node${updated.length === 1 ? '' : 's'} updated`);
    }
  }
}

function typeErrorsEqual(
  a: Array<{ line: number; code: string; message: string }>,
  b: Array<{ line: number; code: string; message: string }>
): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i]!;
    return entry.line === other.line && entry.code === other.code && entry.message === other.message;
  });
}
