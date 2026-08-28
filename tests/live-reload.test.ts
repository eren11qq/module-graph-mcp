import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startHttpServer } from '../src/server/http.js';
import { IncrementalGraph } from '../src/server/incremental-graph.js';
import { startLiveReload, type LiveReloadHandle } from '../src/server/live-reload.js';
import type { GraphEvent, GraphSnapshot } from '../src/shared/types.js';
import { getFreePort } from './helpers/net.js';
import { makeTempProject } from './helpers/temp-project.js';

// ---------------------------------------------------------------------------
// Harness: temp project + real HTTP/WS server + live-reload pipeline on an
// IncrementalGraph with a counting parse seam. Every pipeline owns its
// teardown so tests cannot leak events into each other.
// ---------------------------------------------------------------------------

let parseCounts = new Map<string, number>();
let armed = false;
let failNextParse = false;

function trackParses(graph: IncrementalGraph): void {
  const original = graph.parseSpecifiers.bind(graph);
  graph.parseSpecifiers = async (rel: string) => {
    if (armed) parseCounts.set(rel, (parseCounts.get(rel) ?? 0) + 1);
    if (failNextParse && armed) {
      failNextParse = false;
      throw new Error('simulated parse failure');
    }
    return original(rel);
  };
}

/**
 * Wire the ticket-04/05 pipeline the same way src/server/index.ts does.
 */
async function startTestPipeline(root: string, debounceMs = 60): Promise<{
  url: string;

  initial: GraphSnapshot;
  graph: IncrementalGraph;
  teardown(): Promise<void>;
}> {
  parseCounts = new Map();
  armed = false;
  failNextParse = false;

  const graph = new IncrementalGraph(root);
  trackParses(graph);

  const started = await startHttpServer({
    preferredPort: await getFreePort(),
    publicDir: 'src/server/public',
    info: { rootPath: root, port: 0, version: 'test' },
    getSnapshot: () => graph.snapshot()
  });

  const live: LiveReloadHandle = startLiveReload({
    rootPath: root,
    hub: started.hub,
    log: () => {},
    debounceMs,
    graph
  });
  await live.ready;
  armed = true; // only count parses after the baseline scan

  const teardown = async (): Promise<void> => {
    await live.stop();
    started.server.closeAllConnections?.();
    started.server.close();
  };

  return { url: started.url, initial: graph.snapshot(), graph, teardown };
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

const isDelta = (e: GraphEvent): e is Extract<GraphEvent, { type: 'graph_delta' }> =>
  e.type === 'graph_delta';

// ---------------------------------------------------------------------------
// Checklist coverage (tickets 04 + 05): windowing, sync, output isolation,
// failure keep-frame — now over delta pushes from the incremental engine.
// ---------------------------------------------------------------------------

describe('live delta pipeline (Ticket 04/05)', () => {
  it('aggregates a burst into exactly one delta push and only parses touched files', async () => {
    const root = await makeTempProject();
    const { url, graph, teardown } = await startTestPipeline(root);
    const client = await openClient(url);
    try {
      // Rapid burst: create two files, modify one, delete one.
      await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
      await writeFile(join(root, 'b.ts'), "import { a } from './a.js';\nexport const b = a;\n", 'utf8');
      await writeFile(join(root, 'a.ts'), 'export const a = 2;\n', 'utf8');
      await unlink(join(root, 'a.ts'));

      const frame = await client.waitFor((e) => isDelta(e), 'post-burst delta');
      if (!isDelta(frame)) throw new Error('unreachable');

      // One quiet window = one NET delta frame: a.ts (created and deleted
      // inside the window) nets out entirely; b.ts survives without edges.
      expect(frame.delta.addedNodes.map((n) => n.id)).toEqual(['b.ts']);
      expect(frame.delta.removedNodeIds).toEqual([]);
      expect(frame.delta.addedEdges).toEqual([]);
      expect(frame.delta.removedEdges).toEqual([]);
      expect(graph.snapshot().nodes.map((n) => n.id)).toEqual(['b.ts']);

      // Exactly the touched files were parsed, each once: a.ts collapsed to
      // its last event (unlink) so it is never parsed at all.
      expect(parseCounts.get('b.ts')).toBe(1);
      expect(parseCounts.size).toBe(1);
    } finally {
      client.close();
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps multiple browser windows in sync: both clients receive identical deltas', async () => {
    const root = await makeTempProject();
    const { url, graph, teardown } = await startTestPipeline(root);
    const clientA = await openClient(url);
    const clientB = await openClient(url);
    try {
      await writeFile(join(root, 'shared.ts'), 'export const s = 1;\n', 'utf8');

      const [frameA, frameB] = await Promise.all([
        clientA.waitFor((e) => isDelta(e), 'window A delta'),
        clientB.waitFor((e) => isDelta(e), 'window B delta')
      ]);
      if (!isDelta(frameA) || !isDelta(frameB)) throw new Error('unreachable');

      expect(frameB.delta).toEqual(frameA.delta);
      expect(frameA.delta.addedNodes.map((n) => n.id)).toEqual(['shared.ts']);
    } finally {
      clientA.close();
      clientB.close();
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores node_modules and dist changes: no parse, no broadcast', async () => {
    const root = await makeTempProject();
    const { url, graph, initial, teardown } = await startTestPipeline(root);
    const client = await openClient(url);
    try {
      await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(root, 'node_modules', 'pkg', 'x.ts'), 'export const x = 1;\n', 'utf8');
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'dist', 'out.js'), 'console.log(1);\n', 'utf8');
      await writeFile(join(root, 'notes.txt'), 'not a source file\n', 'utf8');

      // Well past the debounce window: nothing may have fired.
      await new Promise((r) => setTimeout(r, 600));
      expect(parseCounts.size).toBe(0);
      expect(client.events.some(isDelta)).toBe(false);
      expect(initial.generatedAt).toBeGreaterThan(0);
    } finally {
      client.close();
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the last good frame on parse failure with a scan_error notice, then catches up', async () => {
    const root = await makeTempProject({
      'stable.ts': 'export const stable = 1;\n'
    });
    const { url, graph, initial, teardown } = await startTestPipeline(root);
    const client = await openClient(url);
    try {
      // Next parse (triggered by a real file event) simulates a failure.
      failNextParse = true;
      await writeFile(join(root, 'broken.ts'), 'export const broken = 1;\n', 'utf8');

      const failure = await client.waitFor((e) => e.type === 'scan_error', 'scan_error notice');
      expect((failure as { message: string }).message).toBe('simulated parse failure');
      // Last good frame preserved: still the baseline snapshot.
      expect(graph.snapshot().generatedAt).toBe(initial.generatedAt);

      // Recovery: a later change applies successfully and the page catches up.
      await writeFile(join(root, 'recovered.ts'), 'export const r = 1;\n', 'utf8');
      const frame = await client.waitFor(
        (e) => isDelta(e) && e.delta.addedNodes.some((n) => n.id === 'recovered.ts'),
        'recovery delta'
      );
      if (!isDelta(frame)) throw new Error('unreachable');
      expect(frame.delta.addedNodes.map((n) => n.id).sort()).toEqual(['broken.ts', 'recovered.ts']);
      expect(graph.snapshot().nodes.map((n) => n.id).sort()).toEqual(['broken.ts', 'recovered.ts', 'stable.ts']);
    } finally {
      client.close();
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes windows: a slow window blocks the next one until it finishes (P0-2)', async () => {
    const root = await makeTempProject();
    const { graph, teardown } = await startTestPipeline(root);
    const markers: string[] = [];
    const originalApply = graph.applyEvents.bind(graph);
    let call = 0;
    graph.applyEvents = async (events) => {
      const n = ++call;
      markers.push(`start:${n}`);
      if (n === 1) await new Promise((r) => setTimeout(r, 250));
      try {
        return await originalApply(events);
      } finally {
        markers.push(`end:${n}`);
      }
    };
    try {
      await writeFile(join(root, 'slow.ts'), 'export const slow = 1;\n', 'utf8');
      // Window 1 fires after ~60ms and parks inside applyEvents for 250ms.
      await new Promise((r) => setTimeout(r, 150));
      // Window 2 becomes due while window 1 is still applying.
      await writeFile(join(root, 'fast.ts'), 'export const fast = 1;\n', 'utf8');
      // No interleave: window 2 may only start after window 1 finished.
      await vi.waitFor(() => expect(markers).toEqual(['start:1', 'end:1', 'start:2', 'end:2']), {
        timeout: 5000
      });
    } finally {
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sends a real baseline snapshot as the handshake frame, not null (P1-4)', async () => {
    const root = await makeTempProject({ 'a.ts': 'export const a = 1;\n' });
    const { url, graph, teardown } = await startTestPipeline(root);
    const client = await openClient(url);
    try {
      await client.waitFor((e) => e.type === 'snapshot', 'handshake snapshot');
      const first = client.events[0]!;
      expect(first.type).toBe('snapshot');
      const snap = (first as Extract<GraphEvent, { type: 'snapshot' }>).snapshot;
      expect(snap).not.toBeNull();
      expect(snap.nodes.map((n) => n.id)).toContain('a.ts');
      expect(snap.rootPath).toBe(graph.snapshot().rootPath);
    } finally {
      client.close();
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the windowed pipeline agrees with a from-scratch full rebuild (parity)', async () => {
    const root = await makeTempProject();
    const { graph, teardown } = await startTestPipeline(root);
    try {
      await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
      await writeFile(join(root, 'b.ts'), "import { a } from './a.js';\nexport const b = a;\n", 'utf8');
      await graph.applyEvents([
        { path: join(root, 'a.ts'), kind: 'add' },
        { path: join(root, 'b.ts'), kind: 'add' }
      ]);
      const incremental = graph.snapshot();
      const reference = new IncrementalGraph(root);
      await reference.fullScan();
      expect(incremental.nodes).toEqual(reference.snapshot().nodes);
      expect(incremental.edges).toEqual(reference.snapshot().edges);
    } finally {
      await teardown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
