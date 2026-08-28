import { describe, expect, it } from 'vitest';
import { buildTools, type GraphSnapshotSource } from '../src/server/mcp.js';
import type { ModuleNode } from '../src/shared/types.js';

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

function fakeGraph(): GraphSnapshotSource & { notes: Map<string, string | undefined> } {
  // Mirror the engine's aliasing contract: snapshot() hands out the SAME
  // node objects setNote() mutates, so post-mutation reads see the note.
  const nodesById = new Map(FIXTURE_NODES.map((n) => [n.id, { ...n }]));
  const notes = new Map<string, string | undefined>();
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
    notes
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
  it('exposes the four tools with their input schemas', () => {
    const { tools } = build();
    expect(Object.keys(tools).sort()).toEqual([
      'get_module_details',
      'get_module_graph',
      'list_untested',
      'report_note'
    ]);
    expect(tools.get_module_details!.inputSchema.required).toEqual(['path']);
    expect(tools.report_note!.inputSchema.required).toEqual(['path', 'text']);
    expect(tools.list_untested!.inputSchema.properties).toEqual({});
  });

  it('get_module_graph returns the full snapshot', () => {
    const { tools } = build();
    const body = payload(tools.get_module_graph.execute({}));
    expect(body.rootPath).toBe('/proj');
    expect(body.nodes).toHaveLength(3);
    expect(body.edges).toEqual(FIXTURE_SNAPSHOT.edges);
  });

  it('get_module_details returns metadata, adjacency and the source text', () => {
    const { tools } = build();
    const body = payload(tools.get_module_details.execute({ path: 'index.ts' }));
    expect(body.id).toBe('index.ts');
    expect(body.outgoingDependencies).toEqual(['core/app.ts']);
    expect(body.incomingDependents).toEqual([]);
    expect(body.source).toEqual({ path: 'index.ts', sizeBytes: SOURCE_TEXT.length, content: SOURCE_TEXT });
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
