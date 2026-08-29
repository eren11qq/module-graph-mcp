import { describe, expect, it, vi } from 'vitest';
import { buildTools, type GraphSnapshotSource } from '../src/server/mcp.js';
import type { AiReview, ModuleNode } from '../src/shared/types.js';

/**
 * The MCP tool seam tested directly: buildTools over a fake graph source and
 * an injected source-read envelope. No spawned process — the transport-level
 * behavior (framing, caps, handshake) lives in tests/mcp-e2e.test.ts.
 */

const FIXTURE_NODES: ModuleNode[] = [
  { id: 'index.ts', path: 'index.ts', language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [] },
  { id: 'core/app.ts', path: 'core/app.ts', language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [] },
  { id: 'utils/logger.ts', path: 'utils/logger.ts', language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [] }
];

const FIXTURE_SNAPSHOT = {
  rootPath: '/proj',
  generatedAt: 42,
  nodes: FIXTURE_NODES,
  edges: [
    { from: 'index.ts', to: 'core/app.ts' },
    { from: 'core/app.ts', to: 'utils/logger.ts' }
  ]
};

function fakeGraph(): GraphSnapshotSource & { notes: Map<string, string | undefined>; reviews: Map<string, AiReview | undefined> } {
  // Mirror the engine's aliasing contract: snapshot() hands out the SAME
  // node objects setNote()/setReview() mutate, so post-mutation reads see
  // the change.
  const nodesById = new Map(FIXTURE_NODES.map((n) => [n.id, { ...n }]));
  const notes = new Map<string, string | undefined>();
  const reviews = new Map<string, AiReview | undefined>();
  return {
    snapshot: () => ({
      rootPath: '/proj',
      generatedAt: 42,
      nodes: [...nodesById.values()],
      edges: [...FIXTURE_SNAPSHOT.edges]
    }),
    setNote: (id, note) => {
      const node = nodesById.get(id);
      if (node === undefined) return false;
      node.note = note;
      notes.set(id, note);
      return true;
    },
    setReview: (id, review) => {
      const node = nodesById.get(id);
      if (node === undefined) return false;
      node.aiReview = review;
      reviews.set(id, review);
      return true;
    },
    notes,
    reviews
  };
}

const SOURCE_TEXT = 'export const stub = 1;\n';

function build() {
  const graph = fakeGraph();
  const broadcasts: Array<{ type: string; node?: { id: string; note?: string } }> = [];
  const tools = buildTools(graph, {
    broadcast: (event) => broadcasts.push(event as { type: string; node?: { id: string; note?: string } }),
    readSourceFile: (rootPath, requested) => {
      expect(rootPath).toBe('/proj');
      return { ok: true, path: requested, content: SOURCE_TEXT, sizeBytes: SOURCE_TEXT.length };
    }
  });
  return { graph, broadcasts, tools };
}

function payload(result: { content: Array<{ text: string }>; isError?: boolean }): any {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

describe('buildTools over a fake graph (Ticket 10, direct)', () => {
  it('exposes the nine tools with their input schemas', () => {
    const { tools } = build();
    expect(Object.keys(tools).sort()).toEqual([
      'begin_review',
      'end_review',
      'get_dashboard_info',
      'get_module_details',
      'get_module_graph',
      'list_untested',
      'report_note',
      'report_test_run',
      'update_review'
    ]);
    expect(tools.get_module_details!.inputSchema.required).toEqual(['path']);
    expect(tools.report_note!.inputSchema.required).toEqual(['path', 'text']);
    expect(tools.begin_review!.inputSchema.required).toEqual(['path']);
    expect(tools.update_review!.inputSchema.required).toEqual(['path', 'verdicts']);
    expect(tools.end_review!.inputSchema.required).toEqual(['path', 'verdicts']);
    expect(tools.report_test_run!.inputSchema.required).toEqual(['failed']);
    expect(tools.get_dashboard_info!.inputSchema.properties).toEqual({});
    expect(tools.list_untested!.inputSchema.properties).toEqual({});
  });

  it('get_module_graph returns the full snapshot', () => {
    const { tools } = build();
    const body = payload(tools.get_module_graph.execute({}));
    expect(body.rootPath).toBe('/proj');
    expect(body.nodes).toHaveLength(3);
    expect(body.edges).toEqual(FIXTURE_SNAPSHOT.edges);
  });

  it('get_module_graph flags a mid-baseline-scan reply instead of faking completeness', () => {
    const graph = fakeGraph();
    const tools = buildTools(graph, { isBaselineDone: () => false });
    const body = payload(tools.get_module_graph.execute({}));
    expect(body.scanning).toBe(true);
    expect(body.note).toContain('baseline scan');

    const done = buildTools(fakeGraph(), { isBaselineDone: () => true });
    const settled = payload(done.get_module_graph.execute({}));
    expect(settled.scanning).toBeUndefined();
  });

  it('get_dashboard_info reports url/root/counts and flags a mid-scan server', () => {
    const graph = fakeGraph();
    const tools = buildTools(graph, {
      httpInfo: () => ({ url: 'http://127.0.0.1:24282', port: 24282, rootPath: '/proj', version: '0.1.0' }),
      isBaselineDone: () => false
    });
    const body = payload(tools.get_dashboard_info.execute({}));
    expect(body).toMatchObject({
      dashboardUrl: 'http://127.0.0.1:24282',
      port: 24282,
      rootPath: '/proj',
      version: '0.1.0',
      nodeCount: 3,
      edgeCount: 2,
      scanning: true
    });
  });

  it('get_dashboard_info degrades gracefully without the http wiring', () => {
    const { tools } = build();
    const body = payload(tools.get_dashboard_info.execute({}));
    expect(body.rootPath).toBe('/proj');
    expect(body.nodeCount).toBe(3);
    expect(body.dashboardUrl).toBeUndefined();
    expect(body.note).toContain('not wired');
  });

  it('get_module_details returns metadata, adjacency and the source text', () => {
    const { tools } = build();
    const body = payload(tools.get_module_details.execute({ path: 'index.ts' }));
    expect(body.id).toBe('index.ts');
    expect(body.outgoingDependencies).toEqual(['core/app.ts']);
    expect(body.incomingDependents).toEqual([]);
    expect(body.source).toEqual({
      path: 'index.ts',
      sizeBytes: SOURCE_TEXT.length,
      content: SOURCE_TEXT,
      truncated: false
    });
  });

  it('get_module_details surfaces the truncated flag for oversize files', () => {
    const tools = buildTools(fakeGraph(), {
      readSourceFile: () => ({ ok: true, path: 'big.ts', content: 'head…', sizeBytes: 600 * 1024, truncated: true })
    });
    const body = payload(tools.get_module_details.execute({ path: 'index.ts' }));
    expect(body.source).toEqual({ path: 'big.ts', sizeBytes: 600 * 1024, content: 'head…', truncated: true });
  });

  it('a ./-prefixed path resolves to the plain module id', () => {
    const { tools } = build();
    const body = payload(tools.get_module_details.execute({ path: './core/app.ts' }));
    expect(body.id).toBe('core/app.ts');
  });

  it('an unknown path errors with a suggestion line of at most five candidates', () => {
    const { tools } = build();
    const result = tools.get_module_details.execute({ path: 'src/index.ts' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('module not found: "src/index.ts"');
    expect(text).toContain('did you mean:');
    const suggestions = text
      .split('did you mean:')[1]!
      .split('\n')[0]!
      .replace(/\?$/, '')
      .split(',')
      .map((s) => s.trim());
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(5);
    expect(suggestions).toContain('index.ts');
  });

  it('report_note attaches, broadcasts one node_update, and clears on empty text', () => {
    const { graph, broadcasts, tools } = build();
    const attached = payload(tools.report_note.execute({ path: 'core/app.ts', text: '  needs refactor  ' }));
    expect(attached).toMatchObject({ ok: true, id: 'core/app.ts', cleared: false, note: 'needs refactor' });
    expect(graph.notes.get('core/app.ts')).toBe('needs refactor');
    expect(broadcasts).toEqual([
      { type: 'node_update', node: { ...FIXTURE_NODES[1], note: 'needs refactor' } }
    ]);

    const cleared = payload(tools.report_note.execute({ path: 'core/app.ts', text: '' }));
    expect(cleared).toMatchObject({ ok: true, id: 'core/app.ts', cleared: true, note: null });
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]!.node!.note).toBeUndefined();
  });

  it('report_note caps the note at 2000 chars and rejects unknown paths', () => {
    const { graph, broadcasts, tools } = build();
    payload(tools.report_note.execute({ path: 'index.ts', text: 'x'.repeat(2500) }));
    expect(graph.notes.get('index.ts')!.length).toBe(2000);

    const before = broadcasts.length;
    const result = tools.report_note.execute({ path: 'app.tsx', text: 'x' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('module not found');
    expect(text).toContain('did you mean: core/app.ts');
    expect(broadcasts.length).toBe(before);
  });

  it('list_untested returns the exact untested inventory plus totals', () => {
    const { tools } = build();
    const body = payload(tools.list_untested.execute({}));
    expect(body.totalModules).toBe(3);
    expect(body.untestedCount).toBe(3);
    expect(body.modules.map((m: { id: string }) => m.id).sort()).toEqual([
      'core/app.ts',
      'index.ts',
      'utils/logger.ts'
    ]);
  });

  it('a non-string path is rejected before the graph is consulted', () => {
    const { tools } = build();
    for (const bad of [undefined, '', '   ', 42]) {
      const result = tools.get_module_details.execute({ path: bad });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('path is required');
    }
  });
});

describe('begin_review / end_review — the AI check channel (Ticket 12)', () => {
  function buildReview() {
    const built = build();
    const nodeEvents = (): ModuleNode[] =>
      built.broadcasts
        .filter((e) => e.type === 'node_update')
        .map((e) => (e as { node: ModuleNode }).node);
    return { ...built, nodeEvents };
  }

  it('begin_review marks the node checking and broadcasts one node_update', () => {
    const { tools, graph, nodeEvents } = buildReview();
    const body = payload(tools.begin_review.execute({ path: 'core/app.ts' }));
    expect(body).toMatchObject({ ok: true, id: 'core/app.ts' });
    expect(body.aiReview).toEqual({ status: 'checking', verdicts: [] });
    expect(graph.reviews.get('core/app.ts')).toEqual({ status: 'checking', verdicts: [] });

    const events = nodeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('core/app.ts');
    expect(events[0]!.aiReview).toEqual({ status: 'checking', verdicts: [] });
  });

  it('end_review stores verdicts + reviewedAt + summary and broadcasts', () => {
    const { tools, graph, nodeEvents } = buildReview();
    const verdicts = [
      { line: 3, verdict: 'confident' },
      { line: 7, verdict: 'unsure', message: '边界条件待确认' },
      { line: 11, verdict: 'error', message: '与注释语义相反' }
    ];
    const body = payload(
      tools.end_review.execute({ path: 'core/app.ts', verdicts, summary: '两个问题需要跟进' })
    );
    expect(body).toMatchObject({ ok: true, id: 'core/app.ts', verdictCount: 3 });

    const stored = graph.reviews.get('core/app.ts');
    expect(stored!.status).toBe('done');
    expect(stored!.verdicts).toEqual(verdicts);
    expect(stored!.summary).toBe('两个问题需要跟进');
    expect(typeof stored!.reviewedAt).toBe('number');

    const events = nodeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.aiReview!.status).toBe('done');
  });

  it('end_review on an unknown path errors with suggestions and never broadcasts', () => {
    const { broadcasts, tools } = buildReview();
    const result = tools.end_review.execute({
      path: 'app.tsx',
      verdicts: [{ line: 1, verdict: 'error' }]
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('module not found');
    expect(result.content[0].text).toContain('did you mean: core/app.ts');
    expect(broadcasts).toHaveLength(0);
  });

  it('sanitizes verdicts: bad entries dropped, last-per-line wins, 500 cap, message truncation', () => {
    const { tools, graph } = buildReview();
    const verdicts: unknown[] = [
      'garbage', // non-object → dropped
      { line: 0, verdict: 'error' }, // line < 1 → dropped
      { line: 2.5, verdict: 'error' }, // non-integer → dropped
      { line: 4, verdict: 'catastrophic' }, // unknown verdict → dropped
      { line: 5, verdict: 'unsure' },
      { line: 5, verdict: 'error', message: '  ' }, // blank message dropped; last-wins
      { line: 6, verdict: 'confident', message: 'x'.repeat(400) } // message truncated
    ];
    for (let i = 0; i < 600; i++) verdicts.push({ line: 100 + i, verdict: 'confident' });

    const body = payload(tools.end_review.execute({ path: 'index.ts', verdicts }));
    expect(body.verdictCount).toBe(500);

    const stored = graph.reviews.get('index.ts')!;
    expect(stored.status).toBe('done');
    expect(stored.verdicts[0]).toEqual({ line: 5, verdict: 'error' }); // last-wins, no message
    const line6 = stored.verdicts.find((v) => v.line === 6)!;
    expect(line6.message!.length).toBe(200);
    // Capped entries are the FIRST 500 by line after sorting:
    // 5, 6, then 100..699 → the 500th is line 597.
    expect(stored.verdicts[stored.verdicts.length - 1]!.line).toBe(597);
  });

  it('rejects non-array verdicts and non-string paths on both tools', () => {
    const { tools, broadcasts } = buildReview();
    const badVerdicts = tools.end_review.execute({ path: 'index.ts', verdicts: 'nope' });
    expect(badVerdicts.isError).toBe(true);
    expect(badVerdicts.content[0].text).toContain('verdicts is required');

    for (const bad of [undefined, '', '   ', 42]) {
      expect(tools.begin_review.execute({ path: bad }).isError).toBe(true);
      expect(tools.end_review.execute({ path: bad, verdicts: [] }).isError).toBe(true);
    }
    expect(broadcasts).toHaveLength(0);
  });

  it('caps the summary at 500 chars and tolerates an empty verdict list', () => {
    const { tools, graph } = buildReview();
    const body = payload(
      tools.end_review.execute({ path: 'utils/logger.ts', verdicts: [], summary: 's'.repeat(600) })
    );
    expect(body.verdictCount).toBe(0);
    expect(graph.reviews.get('utils/logger.ts')!.summary!.length).toBe(500);
  });
});

describe('update_review — partial verdicts while checking (code-review 2026-08-29)', () => {
  function buildReview() {
    const built = build();
    const nodeEvents = (): ModuleNode[] =>
      built.broadcasts
        .filter((e) => e.type === 'node_update')
        .map((e) => (e as { node: ModuleNode }).node);
    return { ...built, nodeEvents };
  }

  it('errors before begin_review and never broadcasts', () => {
    const { tools, broadcasts } = buildReview();
    const result = tools.update_review.execute({
      path: 'core/app.ts',
      verdicts: [{ line: 1, verdict: 'error' }]
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('begin_review first');
    expect(broadcasts).toHaveLength(0);
  });

  it('merges batches into the pending review, last-per-line wins, sorted, capped', () => {
    const { tools, graph, nodeEvents } = buildReview();
    tools.begin_review.execute({ path: 'core/app.ts' });

    const first = payload(
      tools.update_review.execute({
        path: 'core/app.ts',
        verdicts: [
          { line: 9, verdict: 'unsure', message: '待确认' },
          { line: 3, verdict: 'confident' }
        ]
      })
    );
    expect(first).toMatchObject({ ok: true, id: 'core/app.ts', verdictCount: 2 });
    expect(graph.reviews.get('core/app.ts')).toEqual({
      status: 'checking',
      verdicts: [
        { line: 3, verdict: 'confident' },
        { line: 9, verdict: 'unsure', message: '待确认' }
      ]
    });

    // Second batch: line 3 flips (last wins), line 9 untouched, line 1 added.
    const second = payload(
      tools.update_review.execute({
        path: 'core/app.ts',
        verdicts: [{ line: 3, verdict: 'error', message: '读错了' }]
      })
    );
    expect(second.verdictCount).toBe(2);
    expect(graph.reviews.get('core/app.ts')!.verdicts).toEqual([
      { line: 3, verdict: 'error', message: '读错了' },
      { line: 9, verdict: 'unsure', message: '待确认' }
    ]);

    // Every update pushes one node_update. The fake broadcast stores the node
    // REFERENCE (aliasing contract), so all events alias the live node and
    // show the latest review — on the real wire each frame serializes per
    // send. Count + latest payload is the honest assertion here.
    const events = nodeEvents();
    expect(events).toHaveLength(3); // begin + two updates
    expect(events.at(-1)!.aiReview).toEqual({
      status: 'checking',
      verdicts: [
        { line: 3, verdict: 'error', message: '读错了' },
        { line: 9, verdict: 'unsure', message: '待确认' }
      ]
    });
  });

  it('sanitizes update batches like end_review (bad entries dropped, 500-cap total)', () => {
    const { tools, graph } = buildReview();
    tools.begin_review.execute({ path: 'index.ts' });
    tools.update_review.execute({
      path: 'index.ts',
      verdicts: [
        'garbage',
        { line: 0, verdict: 'error' },
        { line: 2, verdict: 'confident', message: 'x'.repeat(400) }
      ]
    });
    const stored = graph.reviews.get('index.ts')!;
    expect(stored.verdicts).toEqual([{ line: 2, verdict: 'confident', message: 'x'.repeat(200) }]);

    // 600 more lines across two batches: total stays capped at 500.
    for (let i = 0; i < 300; i++) {
      tools.update_review.execute({ path: 'index.ts', verdicts: [{ line: 100 + i, verdict: 'confident' }] });
      tools.update_review.execute({ path: 'index.ts', verdicts: [{ line: 500 + i, verdict: 'confident' }] });
    }
    expect(graph.reviews.get('index.ts')!.verdicts).toHaveLength(500);
  });

  it('end_review after updates replaces the pending verdicts and lands done', () => {
    const { tools, graph, nodeEvents } = buildReview();
    tools.begin_review.execute({ path: 'index.ts' });
    tools.update_review.execute({ path: 'index.ts', verdicts: [{ line: 1, verdict: 'unsure' }] });
    payload(tools.end_review.execute({ path: 'index.ts', verdicts: [], summary: 'clean' }));

    const stored = graph.reviews.get('index.ts')!;
    expect(stored.status).toBe('done');
    expect(stored.verdicts).toEqual([]);
    expect(stored.summary).toBe('clean');
    expect(nodeEvents().at(-1)!.aiReview!.status).toBe('done');
  });

  it('rejects non-array verdicts and unknown paths', () => {
    const { tools, broadcasts } = buildReview();
    tools.begin_review.execute({ path: 'index.ts' });
    const bad = tools.update_review.execute({ path: 'index.ts', verdicts: 'nope' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('verdicts is required');

    const missing = tools.update_review.execute({ path: 'app.tsx', verdicts: [] });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('module not found');
    expect(broadcasts.filter((e) => e.type === 'node_update')).toHaveLength(1); // only the begin
  });
});

describe('report_test_run — the agent test-run channel', () => {
  it('forwards the flag to the wired pipeline and confirms receipt', () => {
    const graph = fakeGraph();
    const calls: boolean[] = [];
    const tools = buildTools(graph, { reportTestRun: (failed) => calls.push(failed) });
    expect(payload(tools.report_test_run.execute({ failed: true }))).toEqual({
      ok: true,
      failed: true,
      note: 'coverage remap triggered'
    });
    expect(payload(tools.report_test_run.execute({ failed: false }))).toEqual({
      ok: true,
      failed: false,
      note: 'coverage remap triggered'
    });
    expect(calls).toEqual([true, false]);
  });

  it('tolerates a missing pipeline and rejects a non-boolean flag', () => {
    const { tools } = build(); // no reportTestRun dep wired
    const body = payload(tools.report_test_run.execute({ failed: true }));
    expect(body.note).toBe('no state pipeline wired; flag not applied');

    const bad = tools.report_test_run.execute({ failed: 'yes' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('failed is required');
  });
});

describe('begin_review checking timeout (code-review 2026-08-29)', () => {
  const TIMEOUT_MS = 10 * 60 * 1000;

  function buildTimed() {
    const built = build();
    const nodeEvents = (): ModuleNode[] =>
      built.broadcasts
        .filter((e) => e.type === 'node_update')
        .map((e) => (e as { node: ModuleNode }).node);
    const nonNodeEvents = (): Array<{ type: string; id?: string; path?: string }> =>
      built.broadcasts.filter((e) => e.type !== 'node_update') as Array<{ type: string; id?: string; path?: string }>;
    return { ...built, nodeEvents, nonNodeEvents };
  }

  it('falls back after 10 minutes: checking clears, node_update + review_timeout broadcast', () => {
    vi.useFakeTimers();
    try {
      const { tools, graph, nodeEvents, nonNodeEvents } = buildTimed();
      tools.begin_review.execute({ path: 'core/app.ts' });
      expect(graph.reviews.get('core/app.ts')).toEqual({ status: 'checking', verdicts: [] });

      vi.advanceTimersByTime(TIMEOUT_MS - 1);
      expect(graph.reviews.get('core/app.ts')).toEqual({ status: 'checking', verdicts: [] });

      vi.advanceTimersByTime(1);
      expect(graph.reviews.get('core/app.ts')).toBeUndefined();
      expect(nodeEvents().at(-1)!.aiReview).toBeUndefined();
      expect(nonNodeEvents()).toEqual([{ type: 'review_timeout', id: 'core/app.ts', path: 'core/app.ts' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('end_review disarms the timeout; a re-begin restarts the window', () => {
    vi.useFakeTimers();
    try {
      const { tools, graph, nonNodeEvents } = buildTimed();

      // end_review clears the pending timer: no timeout ever fires.
      tools.begin_review.execute({ path: 'index.ts' });
      tools.end_review.execute({ path: 'index.ts', verdicts: [] });
      vi.advanceTimersByTime(TIMEOUT_MS * 2);
      expect(graph.reviews.get('index.ts')!.status).toBe('done');
      expect(nonNodeEvents()).toEqual([]);

      // A re-begin replaces the timer: the old deadline must not retire the
      // fresh checking state.
      tools.begin_review.execute({ path: 'core/app.ts' });
      vi.advanceTimersByTime(TIMEOUT_MS - 1000);
      tools.begin_review.execute({ path: 'core/app.ts' });
      vi.advanceTimersByTime(1001);
      expect(graph.reviews.get('core/app.ts')).toEqual({ status: 'checking', verdicts: [] });
      vi.advanceTimersByTime(TIMEOUT_MS - 1);
      expect(graph.reviews.get('core/app.ts')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('update_review re-arms the timer: the old deadline is disarmed, the fresh window governs', () => {
    vi.useFakeTimers();
    try {
      const { tools, graph, nonNodeEvents } = buildTimed();
      tools.begin_review.execute({ path: 'core/app.ts' });

      // Push an update 1s before the ORIGINAL deadline. This replaces
      // node.aiReview with a new checking object — without the re-arm the
      // old timer would no-op and the module would sit in checking forever.
      vi.advanceTimersByTime(TIMEOUT_MS - 1000);
      tools.update_review.execute({ path: 'core/app.ts', verdicts: [{ line: 4, verdict: 'unsure' }] });

      vi.advanceTimersByTime(1001); // crosses the original deadline
      expect(graph.reviews.get('core/app.ts')).toEqual({
        status: 'checking',
        verdicts: [{ line: 4, verdict: 'unsure' }]
      });
      expect(nonNodeEvents()).toEqual([]);

      // The re-armed window started at the update (t = TIMEOUT-1000): the new
      // deadline is 2*TIMEOUT-1000, not the original 1*TIMEOUT.
      vi.advanceTimersByTime(TIMEOUT_MS - 1002);
      expect(graph.reviews.get('core/app.ts')).toEqual({
        status: 'checking',
        verdicts: [{ line: 4, verdict: 'unsure' }]
      });
      vi.advanceTimersByTime(1);
      expect(graph.reviews.get('core/app.ts')).toBeUndefined();
      expect(nonNodeEvents()).toEqual([{ type: 'review_timeout', id: 'core/app.ts', path: 'core/app.ts' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('end_review after an update still disarms the timeout entirely', () => {
    vi.useFakeTimers();
    try {
      const { tools, graph, nonNodeEvents } = buildTimed();
      tools.begin_review.execute({ path: 'index.ts' });
      tools.update_review.execute({ path: 'index.ts', verdicts: [{ line: 2, verdict: 'confident' }] });
      tools.end_review.execute({ path: 'index.ts', verdicts: [] });
      vi.advanceTimersByTime(TIMEOUT_MS * 2);
      expect(graph.reviews.get('index.ts')!.status).toBe('done');
      expect(nonNodeEvents()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
