import { describe, expect, it } from 'vitest';
import { applyViewState, deriveScopeMarks, isUntested, searchMatches } from '../src/web/graph-filters.js';
import type { EditScopeDecl, Edge, ModuleNode, TestState } from '../src/shared/types.js';

/**
 * Ticket 11 seam 1: collapse — pure function from (nodes, edges, collapsed
 * directory set) to the render list, aggregating same-directory files into
 * one directory-level node.
 */

function file(id: string, testState: ModuleNode['testState'] = 'untested'): ModuleNode {
  return { id, path: id, language: 'ts', testState, coveredBy: [], typeErrors: [] };
}

describe('isUntested — 只看未测 predicate (ticket 11 seam 3)', () => {
  it('is true exactly for testState === "untested"', () => {
    expect(isUntested(file('a.ts', 'untested'))).toBe(true);
    expect(isUntested(file('a.ts', 'passing'))).toBe(false);
    expect(isUntested(file('a.ts', 'failing'))).toBe(false);
    expect(isUntested(file('a.ts', 'has-tests-unrun'))).toBe(false);
  });
});

describe('searchMatches — query → matched ids (ticket 11 seam 2)', () => {
  const nodes = [file('src/core/emitter.ts'), file('src/store/state.ts'), file('tests/store/state.test.ts')];

  it('matches the full path, case-insensitively', () => {
    expect(searchMatches(nodes, 'STORE/STATE')).toEqual(new Set(['src/store/state.ts', 'tests/store/state.test.ts']));
  });

  it('matches the basename label without extension', () => {
    expect(searchMatches(nodes, 'EMITTER')).toEqual(new Set(['src/core/emitter.ts']));
  });

  it('substring-matches inside paths', () => {
    expect(searchMatches(nodes, 'state.')).toEqual(new Set(['src/store/state.ts', 'tests/store/state.test.ts']));
  });

  it('returns nothing for a blank query (no filter) and for non-matches', () => {
    expect(searchMatches(nodes, '   ')).toEqual(new Set());
    expect(searchMatches(nodes, 'no-such-module')).toEqual(new Set());
  });
});

describe('applyViewState — 过滤 → 搜索 pipeline (ticket 11)', () => {
  // Threshold is THEME.collapse.minFiles = 3: pkg has 3 direct files (folds),
  // solo has 2 (stays), main.ts is root-level (never folds).
  const nodes = [
    file('main.ts', 'passing'),
    file('pkg/a.ts', 'untested'),
    file('pkg/b.ts', 'untested'),
    file('pkg/c.ts', 'failing'),
    file('solo/d.ts', 'untested'),
    file('solo/e.ts', 'passing')
  ];
  const edges: Edge[] = [
    { from: 'main.ts', to: 'pkg/a.ts' },
    { from: 'pkg/a.ts', to: 'pkg/b.ts' },
    { from: 'pkg/c.ts', to: 'main.ts' },
    { from: 'solo/d.ts', to: 'solo/e.ts' }
  ];

  const view = (over: Partial<Parameters<typeof applyViewState>[2]> = {}): Parameters<typeof applyViewState>[2] => ({
    query: '',
    untestedOnly: false,
    hiddenStates: new Set<TestState>(),
    hideReviewed: false,
    ...over
  });

  it('is a no-op copy when every control is off', () => {
    expect(applyViewState(nodes, edges, view())).toEqual({ nodes, edges });
  });

  it('只看未测 keeps untested nodes and the edges between them', () => {
    expect(applyViewState(nodes, edges, view({ untestedOnly: true }))).toEqual({
      nodes: [file('pkg/a.ts'), file('pkg/b.ts'), file('solo/d.ts')],
      edges: [{ from: 'pkg/a.ts', to: 'pkg/b.ts' }]
    });
  });

  it('search keeps matched nodes and the edges between them', () => {
    expect(applyViewState(nodes, edges, view({ query: 'pkg/' }))).toEqual({
      nodes: [file('pkg/a.ts', 'untested'), file('pkg/b.ts', 'untested'), file('pkg/c.ts', 'failing')],
      edges: [{ from: 'pkg/a.ts', to: 'pkg/b.ts' }]
    });
  });

  it('combines 只看未测 and search conjunctively', () => {
    expect(applyViewState(nodes, edges, view({ untestedOnly: true, query: 'pkg/' })).nodes.map((n) => n.id)).toEqual([
      'pkg/a.ts',
      'pkg/b.ts'
    ]);
  });
});

describe('hiddenStates — 图例状态过滤 (theme.html legend filter)', () => {
  const nodes = [
    file('main.ts', 'passing'),
    file('pkg/a.ts', 'untested'),
    file('pkg/c.ts', 'failing'),
    file('solo/d.ts', 'has-tests-unrun')
  ];
  const edges: Edge[] = [
    { from: 'main.ts', to: 'pkg/a.ts' },
    { from: 'pkg/a.ts', to: 'pkg/c.ts' }
  ];

  const view = (hidden: TestState[], over: Partial<Parameters<typeof applyViewState>[2]> = {}): Parameters<typeof applyViewState>[2] => ({
    query: '',
    untestedOnly: false,
    hiddenStates: new Set<TestState>(hidden),
    hideReviewed: false,
    ...over
  });

  it('an empty hidden set keeps everything (default, backward compatible)', () => {
    expect(applyViewState(nodes, edges, view([]))).toEqual({ nodes, edges });
  });

  it('hides balls of the hidden states and the edges that touch them', () => {
    const out = applyViewState(nodes, edges, view(['untested']));
    expect(out.nodes.map((n) => n.id)).toEqual(['main.ts', 'pkg/c.ts', 'solo/d.ts']);
    expect(out.edges).toEqual([]);
  });

  it('supports hiding several states at once and combines with other stages', () => {
    const out = applyViewState(nodes, edges, view(['untested', 'passing']));
    expect(out.nodes.map((n) => n.id)).toEqual(['pkg/c.ts', 'solo/d.ts']);

    const searched = applyViewState(nodes, edges, view(['untested'], { query: 'pkg/' }));
    expect(searched.nodes.map((n) => n.id)).toEqual(['pkg/c.ts']);
  });

  it('hides a state entirely: only the untested fixtures remain when everything else is off-list', () => {
    const out = applyViewState(nodes, edges, view(['passing', 'failing', 'has-tests-unrun']));
    expect(out.nodes.map((n) => n.id)).toEqual(['pkg/a.ts']);
    expect(out.edges).toEqual([]);
  });
});

describe('hideReviewed — 评审环图例过滤 (code-review 2026-08-29)', () => {
  const done = (id: string): ModuleNode => ({
    ...file(id),
    aiReview: { status: 'done', verdicts: [], reviewedAt: 1 }
  });
  const checking = (id: string): ModuleNode => ({
    ...file(id),
    aiReview: { status: 'checking', verdicts: [] }
  });
  const nodes = [file('main.ts'), done('reviewed.ts'), checking('checking.ts')];
  const edges: Edge[] = [
    { from: 'main.ts', to: 'reviewed.ts' },
    { from: 'reviewed.ts', to: 'checking.ts' }
  ];

  const view = (over: Partial<Parameters<typeof applyViewState>[2]> = {}): Parameters<typeof applyViewState>[2] => ({
    query: '',
    untestedOnly: false,
    hiddenStates: new Set<TestState>(),
    hideReviewed: false,
    ...over
  });

  it('off by default: everything stays', () => {
    expect(applyViewState(nodes, edges, view())).toEqual({ nodes, edges });
  });

  it('on: hides done-reviewed balls (and their edges), keeps checking and unreviewed', () => {
    const out = applyViewState(nodes, edges, view({ hideReviewed: true }));
    expect(out.nodes.map((n) => n.id)).toEqual(['main.ts', 'checking.ts']);
    expect(out.edges).toEqual([]);
  });
});

describe('deriveScopeMarks — 范围环 / 已改紫 / 越界红角标 (ADR 0002 §7.2)', () => {
  const nodes = [
    file('src/server/mcp.ts'),
    file('src/web/main.ts'),
    file('package.json'),
    file('src/server/incremental-graph.ts')
  ];
  const scope: EditScopeDecl = { modules: ['mcp-service'], files: ['package.json'] };

  it('ring: files of declared modules plus explicit files; out-of-table only via explicit', () => {
    const marks = deriveScopeMarks(nodes, scope, new Set(), new Set());
    expect(marks.get('src/server/mcp.ts')!.inScope).toBe(true);
    expect(marks.get('package.json')!.inScope).toBe(true);
    expect(marks.get('src/web/main.ts')!.inScope).toBe(false);
    expect(marks.get('src/server/incremental-graph.ts')!.inScope).toBe(false);
  });

  it('no scope: nothing gets the ring', () => {
    const marks = deriveScopeMarks(nodes, null, new Set(), new Set());
    for (const m of marks.values()) expect(m.inScope).toBe(false);
  });

  it('edited and out-of-scope are independent channels', () => {
    const marks = deriveScopeMarks(
      nodes,
      scope,
      new Set(['src/server/mcp.ts', 'src/web/main.ts']),
      new Set(['src/web/main.ts'])
    );
    // in-scope AND edited: ring + purple fill.
    expect(marks.get('src/server/mcp.ts')).toEqual({ inScope: true, edited: true, outOfScope: false });
    // edited AND out-of-scope (越界也照实标记已改).
    expect(marks.get('src/web/main.ts')).toEqual({ inScope: false, edited: true, outOfScope: true });
    // untouched in-scope: ring only.
    expect(marks.get('package.json')).toEqual({ inScope: true, edited: false, outOfScope: false });
  });
});
