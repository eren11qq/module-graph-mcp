import { describe, expect, it } from 'vitest';
import { applyViewState, collapseDirectories, isUntested, searchMatches, DIR_PREFIX } from '../src/web/graph-filters.js';
import type { Edge, ModuleNode, TestState } from '../src/shared/types.js';

/**
 * Ticket 11 seam 1: collapse — pure function from (nodes, edges, collapsed
 * directory set) to the render list, aggregating same-directory files into
 * one directory-level node.
 */

function file(id: string, testState: ModuleNode['testState'] = 'untested'): ModuleNode {
  return { id, path: id, language: 'ts', testState, coveredBy: [], typeErrors: [] };
}

describe('collapseDirectories (ticket 11 seam 1)', () => {
  it('replaces the files of a collapsed directory with one dir: node', () => {
    const nodes = [file('main.ts'), file('pkg/a.ts'), file('pkg/b.ts')];
    const { nodes: out } = collapseDirectories(nodes, [], new Set(['pkg']));
    expect(out.map((n) => n.id)).toEqual(['main.ts', `${DIR_PREFIX}pkg`]);
  });

  it('leaves other directories and root-level files untouched', () => {
    const nodes = [file('main.ts'), file('pkg/a.ts'), file('other/c.ts')];
    const { nodes: out } = collapseDirectories(nodes, [], new Set(['pkg']));
    expect(out.map((n) => n.id)).toEqual(['main.ts', 'other/c.ts', `${DIR_PREFIX}pkg`]);
  });

  it('aggregates the directory state by severity: failing > untested > has-tests-unrun > passing', () => {
    const cases: Array<[ModuleNode['testState'], ModuleNode['testState'], ModuleNode['testState']]> = [
      ['failing', 'passing', 'failing'],
      ['untested', 'has-tests-unrun', 'untested'],
      ['passing', 'passing', 'passing'],
      ['has-tests-unrun', 'passing', 'has-tests-unrun']
    ];
    for (const [a, b, want] of cases) {
      const { nodes: out } = collapseDirectories([file('pkg/a.ts', a), file('pkg/b.ts', b)], [], new Set(['pkg']));
      expect(out[0]!.testState, `${a}+${b}`).toBe(want);
    }
  });

  it('carries the union of the children type errors (badge count channel)', () => {
    const a: ModuleNode = {
      ...file('pkg/a.ts'),
      typeErrors: [
        { line: 1, code: 'TS2322', message: 'x' },
        { line: 2, code: 'TS2304', message: 'y' }
      ]
    };
    const b: ModuleNode = { ...file('pkg/b.ts'), typeErrors: [{ line: 9, code: 'TS2307', message: 'z' }] };
    const { nodes: out } = collapseDirectories([a, b], [], new Set(['pkg']));
    expect(out[0]!.typeErrors).toHaveLength(3);
  });

  it('exposes the directory path with a trailing slash as the node path', () => {
    const { nodes: out } = collapseDirectories([file('src/pkg/a.ts')], [], new Set(['src/pkg']));
    expect(out[0]!.path).toBe('src/pkg/');
  });

  it('rewires edges to the directory nodes and drops intra-directory edges', () => {
    const nodes = [file('main.ts'), file('pkg/a.ts'), file('pkg/b.ts'), file('lib/c.ts')];
    const edges: Edge[] = [
      { from: 'main.ts', to: 'pkg/a.ts' },
      { from: 'pkg/a.ts', to: 'pkg/b.ts' },
      { from: 'pkg/b.ts', to: 'lib/c.ts' }
    ];
    const { edges: out } = collapseDirectories(nodes, edges, new Set(['pkg']));
    expect(out).toEqual([
      { from: 'main.ts', to: `${DIR_PREFIX}pkg` },
      { from: `${DIR_PREFIX}pkg`, to: 'lib/c.ts' }
    ]);
  });

  it('dedupes edges that collapse onto the same pair', () => {
    const nodes = [file('main.ts'), file('pkg/a.ts'), file('pkg/b.ts')];
    const edges: Edge[] = [
      { from: 'main.ts', to: 'pkg/a.ts' },
      { from: 'main.ts', to: 'pkg/b.ts' }
    ];
    const { edges: out } = collapseDirectories(nodes, edges, new Set(['pkg']));
    expect(out).toEqual([{ from: 'main.ts', to: `${DIR_PREFIX}pkg` }]);
  });

  it('is a no-op copy for an empty collapsed set', () => {
    const nodes = [file('main.ts'), file('pkg/a.ts')];
    const edges: Edge[] = [{ from: 'main.ts', to: 'pkg/a.ts' }];
    const out = collapseDirectories(nodes, edges, new Set());
    expect(out.nodes).toEqual(nodes);
    expect(out.edges).toEqual(edges);
    expect(out.nodes).not.toBe(nodes);
  });
});

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

describe('applyViewState — 过滤 → 搜索 → 折叠 pipeline (ticket 11)', () => {
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
    collapseEnabled: false,
    expandedDirs: new Set<string>(),
    hiddenStates: new Set<TestState>(),
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

  it('collapse folds dirs holding ≥ minFiles survivors; smaller dirs and root files stay', () => {
    const out = applyViewState(nodes, edges, view({ collapseEnabled: true }));
    expect(out.nodes.map((n) => n.id)).toEqual(['main.ts', 'solo/d.ts', 'solo/e.ts', `${DIR_PREFIX}pkg`]);
    expect(out.edges).toEqual([
      { from: 'main.ts', to: `${DIR_PREFIX}pkg` },
      { from: `${DIR_PREFIX}pkg`, to: 'main.ts' },
      { from: 'solo/d.ts', to: 'solo/e.ts' }
    ]);
  });

  it('manually expanded directories stay expanded', () => {
    const out = applyViewState(nodes, edges, view({ collapseEnabled: true, expandedDirs: new Set(['pkg']) }));
    expect(out.nodes.map((n) => n.id)).toContain('pkg/a.ts');
    expect(out.nodes.map((n) => n.id)).not.toContain(`${DIR_PREFIX}pkg`);
  });

  it('search sees files inside collapsible dirs (filter runs before fold)', () => {
    const out = applyViewState(nodes, edges, view({ collapseEnabled: true, query: 'pkg/a' }));
    expect(out.nodes.map((n) => n.id)).toEqual(['pkg/a.ts']);
    expect(out.edges).toEqual([]);
  });

  it('folding counts only the survivors of the earlier filters', () => {
    // 只看未测 removes failing pkg/c.ts → pkg holds 2 survivors < minFiles → no fold.
    const out = applyViewState(nodes, edges, view({ untestedOnly: true, collapseEnabled: true }));
    expect(out.nodes.map((n) => n.id)).toEqual(['pkg/a.ts', 'pkg/b.ts', 'solo/d.ts']);
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
    collapseEnabled: false,
    expandedDirs: new Set<string>(),
    hiddenStates: new Set<TestState>(hidden),
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
    const out = applyViewState(nodes, edges, view(['untested', 'passing'], { collapseEnabled: true }));
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
