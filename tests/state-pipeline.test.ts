import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startHttpServer } from '../src/server/http.js';
import { IncrementalGraph } from '../src/server/incremental-graph.js';
import { startLiveReload, type LiveReloadOptions } from '../src/server/live-reload.js';
import { COVERAGE_REPORT_CANDIDATES } from '../src/server/coverage.js';
import type { GraphEvent } from '../src/shared/types.js';
import { getFreePort } from './helpers/net.js';
import { makeTempProject } from './helpers/temp-project.js';

/**
 * Ticket 08 wiring acceptance: the coverage mapper (06) and the typecheck
 * runner (07) are injected into the live pipeline and reach the page as
 * node_update patches — the data the detail panel renders.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fake local tsc so resolveTscBin() succeeds; the real spawn is seam-replaced. */
async function plantFakeTsc(root: string): Promise<void> {
  const bin = join(root, 'node_modules', 'typescript', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'tsc'), '// fake tsc for tests\n', 'utf8');
}

interface ClientHandle {
  events: GraphEvent[];
  waitFor(pred: (e: GraphEvent) => boolean, what: string): Promise<GraphEvent>;
  close(): void;
}

async function openClient(base: string): Promise<ClientHandle> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  const events: GraphEvent[] = [];
  const waiters: Array<{ pred: (e: GraphEvent) => boolean; resolve: (e: GraphEvent) => void }> = [];
  ws.on('message', (data: Buffer) => {
    const e = JSON.parse(data.toString('utf8')) as GraphEvent;
    events.push(e);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i]!.pred(e)) {
        waiters.splice(i, 1)[0]!.resolve(e);
        break;
      }
    }
  });
  await new Promise((res, rej) => {
    ws.once('open', () => res(undefined));
    ws.once('error', rej);
  });
  return {
    events,
    waitFor(pred, what) {
      const already = events.find(pred);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error(`waitFor timeout: ${what}`)), 8000);
      });
    },
    close: () => ws.close()
  };
}

const isNodeUpdate = (e: GraphEvent): e is Extract<GraphEvent, { type: 'node_update' }> =>
  e.type === 'node_update';

async function startStatesPipeline(root: string, opts: {
  runTypecheck?: NonNullable<LiveReloadOptions['runTypecheckFn']>;
} = {}): Promise<{ url: string; teardown(): Promise<void> }> {
  const graph = new IncrementalGraph(root);
  const started = await startHttpServer({
    preferredPort: await getFreePort(),
    publicDir: join('dist', 'server', 'public'),
    info: { rootPath: root, port: 0, version: 'test' },
    getSnapshot: () => graph.snapshot()
  });
  const live = startLiveReload({
    rootPath: root,
    hub: started.hub,
    log: () => {},
    debounceMs: 60,
    graph,
    typecheckDelayMs: 20,
    ...(opts.runTypecheck !== undefined ? { runTypecheckFn: opts.runTypecheck } : {})
  });
  await live.ready;
  const teardown = async (): Promise<void> => {
    await live.stop();
    started.server.closeAllConnections?.();
    started.server.close();
  };
  return { url: started.url, graph, live, teardown };
}

describe('state pipeline wiring (Ticket 08 over 06/07)', () => {
  it('coverage report appearance colors the node and fills coveredBy; disappearance remaps', async () => {
    const root = await makeTempProject({
      'a.ts': 'export const a = 1;\n',
      'a.test.ts': "import { a } from './a';\ntest('a', () => {});\n",
      'b.ts': 'export const b = 2;\n'
    });
    const { url, graph, teardown } = await startStatesPipeline(root);
    const client = await openClient(url);
    try {
      // Baseline: no report → a.ts is convention-covered (yellow), b.ts grey.
      const baseline = graph.snapshot();
      const baseA = baseline.nodes.find((n) => n.id === 'a.ts')!;
      const baseB = baseline.nodes.find((n) => n.id === 'b.ts')!;
      expect(baseA.testState).toBe('has-tests-unrun');
      expect(baseA.coveredBy).toEqual(['a.test.ts']);
      expect(baseB.testState).toBe('untested');

      // The test run writes the report (absolute file keys, istanbul shape).
      const report = {
        total: { lines: { total: 10, covered: 10, pct: 100 } },
        [`${root}/a.ts`]: { lines: { total: 2, covered: 2, pct: 100 } }
      };
      const reportRel = COVERAGE_REPORT_CANDIDATES[0]!;
      await mkdir(join(root, 'coverage'), { recursive: true });
      await writeFile(join(root, reportRel), JSON.stringify(report), 'utf8');

      // Report-only change must remap without any graph delta.
      const green = await client.waitFor(
        (e) => isNodeUpdate(e) && e.node.id === 'a.ts' && e.node.testState === 'passing',
        'a.ts passing'
      );
      if (!isNodeUpdate(green)) throw new Error('unreachable');
      expect(green.node.coveredBy).toEqual(['a.test.ts']);
      expect(typeof green.node.lastTestRunAt).toBe('number');
      expect(graph.snapshot().nodes.find((n) => n.id === 'a.ts')!.testState).toBe('passing');

      // Report disappears (coverage/ cleaned) → back to convention yellow.
      await unlink(join(root, reportRel));
      const yellow = await client.waitFor(
        (e) => isNodeUpdate(e) && e.node.id === 'a.ts' && e.node.testState === 'has-tests-unrun',
        'a.ts back to yellow'
      );
      if (!isNodeUpdate(yellow)) throw new Error('unreachable');
      expect(yellow.node.lastTestRunAt).toBeUndefined();
    } finally {
      client.close();
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('typecheck results arrive as node_update patches and clear on a clean run', async () => {
    const root = await makeTempProject({
      'a.ts': 'export const a: number = "oops";\n',
      'b.ts': 'export const b = 1;\n'
    });
    await plantFakeTsc(root);

    // Seeded runner: first call reports an error in a.ts, then a clean repo.
    let run = 0;
    const { url, graph, teardown } = await startStatesPipeline(root, {
      runTypecheck: async () => {
        run++;
        if (run === 1) {
          return {
            status: 'errors',
            errorsByFile: new Map([['a.ts', [{ line: 1, code: 'TS2322', message: 'Type string is not assignable to type number.' }]]]),
            totalErrors: 1
          };
        }
        return { status: 'ok', errorsByFile: new Map(), totalErrors: 0 };
      }
    });
    const client = await openClient(url);
    try {
      const withError = await client.waitFor(
        (e) => isNodeUpdate(e) && e.node.id === 'a.ts' && e.node.typeErrors.length === 1,
        'a.ts badge'
      );
      if (!isNodeUpdate(withError)) throw new Error('unreachable');
      expect(withError.node.typeErrors[0]).toEqual({
        line: 1,
        code: 'TS2322',
        message: 'Type string is not assignable to type number.'
      });
      expect(graph.snapshot().nodes.find((n) => n.id === 'a.ts')!.typeErrors.length).toBe(1);

      // A new window schedules the next (clean) run, which clears the badge.
      await writeFile(join(root, 'b.ts'), 'export const b = 2;\n', 'utf8');
      const cleared = await client.waitFor(
        (e) => isNodeUpdate(e) && e.node.id === 'a.ts' && e.node.typeErrors.length === 0,
        'a.ts badge cleared'
      );
      if (!isNodeUpdate(cleared)) throw new Error('unreachable');
      expect(run).toBeGreaterThanOrEqual(2);
      // b.ts was never touched by either run.
      expect(graph.snapshot().nodes.find((n) => n.id === 'b.ts')!.typeErrors).toEqual([]);
    } finally {
      client.close();
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a source-file save also remaps coverage (source windows refresh state layers)', async () => {
    const root = await makeTempProject({
      'a.ts': 'export const a = 1;\n',
      'a.test.ts': "import { a } from './a';\n"
    });
    const { url, graph, teardown } = await startStatesPipeline(root);
    const client = await openClient(url);
    try {
      await mkdir(join(root, 'coverage'), { recursive: true });
      const reportRel = COVERAGE_REPORT_CANDIDATES[0]!;
      await writeFile(
        join(root, reportRel),
        JSON.stringify({ total: {}, [`${root}/a.ts`]: { lines: { total: 1, covered: 1, pct: 100 } } }),
        'utf8'
      );
      await client.waitFor((e) => isNodeUpdate(e) && e.node.id === 'a.ts', 'report mapping');
      expect(graph.snapshot().nodes.find((n) => n.id === 'a.ts')!.testState).toBe('passing');

      // Touch a SOURCE file: window fires, remap keeps a.ts green (no flicker).
      await writeFile(join(root, 'a.ts'), 'export const a = 2;\n', 'utf8');
      await sleep(300);
      const after = graph.snapshot().nodes.find((n) => n.id === 'a.ts')!;
      expect(after.testState).toBe('passing');
      expect(graph.snapshot().nodes.find((n) => n.id === 'a.test.ts')!.testState).toBe('untested');
    } finally {
      client.close();
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reportTestRun flips in-report files red/green and broadcasts (agent test-run channel)', async () => {
    const root = await makeTempProject({
      'a.ts': 'export const a = 1;\n',
      'a.test.ts': "import { a } from './a';\ntest('a', () => {});\n",
      'b.ts': 'export const b = 2;\n'
    });
    const { url, graph, live, teardown } = await startStatesPipeline(root);
    const client = await openClient(url);
    try {
      // A report makes a.ts pass; b.ts is not in the report.
      await mkdir(join(root, 'coverage'), { recursive: true });
      const reportRel = COVERAGE_REPORT_CANDIDATES[0]!;
      await writeFile(
        join(root, reportRel),
        JSON.stringify({ total: {}, [`${root}/a.ts`]: { lines: { total: 1, covered: 1, pct: 100 } } }),
        'utf8'
      );
      await client.waitFor(
        (e) => isNodeUpdate(e) && e.node.id === 'a.ts' && e.node.testState === 'passing',
        'a.ts passing'
      );

      // The agent reports a failing run: in-report files flip red, the
      // out-of-report file keeps its convention color.
      live.reportTestRun(true);
      const red = await client.waitFor(
        (e) => isNodeUpdate(e) && e.node.id === 'a.ts' && e.node.testState === 'failing',
        'a.ts failing'
      );
      if (!isNodeUpdate(red)) throw new Error('unreachable');
      expect(graph.snapshot().nodes.find((n) => n.id === 'b.ts')!.testState).toBe('untested');

      // A clean-run report flips it back green.
      live.reportTestRun(false);
      await client.waitFor(
        (e) => isNodeUpdate(e) && e.node.id === 'a.ts' && e.node.testState === 'passing',
        'a.ts green again'
      );
    } finally {
      client.close();
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
