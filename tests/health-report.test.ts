import { describe, expect, it } from 'vitest';
import { buildHealthReport, findCycleNodeIds, HEALTH_WEIGHTS } from '../src/server/health-report.js';
import type { Edge, GraphSnapshot, ModuleNode } from '../src/shared/types.js';

/**
 * Trust-loop roadmap PR-3: the health report is a deterministic contract —
 * these tests pin the cycle detection (including the four shapes the plan
 * names: acyclic / self-loop / two-node cycle / cycle with in-flow) and the
 * exact weight arithmetic, cutoff rule and tie-break.
 */

function edge(from: string, to: string): Edge {
  return { from, to };
}

describe('findCycleNodeIds', () => {
  it('acyclic graphs mark nothing', () => {
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
    expect(findCycleNodeIds(edges)).toEqual(new Set());
  });

  it('empty input marks nothing', () => {
    expect(findCycleNodeIds([])).toEqual(new Set());
  });

  it('a self-loop marks only the looping node', () => {
    expect(findCycleNodeIds([edge('a', 'a'), edge('a', 'b')])).toEqual(new Set(['a']));
  });

  it('a two-node cycle marks both members', () => {
    expect(findCycleNodeIds([edge('a', 'b'), edge('b', 'a')])).toEqual(new Set(['a', 'b']));
  });

  it('in-flow into a cycle stays out of the set (cycle members only)', () => {
    // d → b → c → b: d feeds the cycle but is not on it.
    const edges = [edge('d', 'b'), edge('b', 'c'), edge('c', 'b'), edge('c', 'e')];
    expect(findCycleNodeIds(edges)).toEqual(new Set(['b', 'c']));
  });

  it('a three-node cycle marks all three, including via a diamond entry', () => {
    const edges = [edge('x', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    expect(findCycleNodeIds(edges)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('the sample-app shape marks exactly emitter and state', () => {
    const edges = [
      edge('core/app.ts', 'core/emitter.ts'),
      edge('core/app.ts', 'utils/format.ts'),
      edge('core/emitter.ts', 'store/state.ts'),
      edge('index.ts', 'core/app.ts'),
      edge('index.ts', 'core/emitter.ts'),
      edge('index.ts', 'store/history.ts'),
      edge('store/history.ts', 'utils/logger.ts'),
      edge('store/state.ts', 'core/emitter.ts')
    ];
    expect(findCycleNodeIds(edges)).toEqual(new Set(['core/emitter.ts', 'store/state.ts']));
  });
});

// ---------------------------------------------------------------------------
// buildHealthReport: fixtures assembled from literals (the engine satisfies
// GraphSnapshot structurally; tests keep control of every field).
// ---------------------------------------------------------------------------

function node(overrides: Partial<ModuleNode> & { id: string }): ModuleNode {
  return {
    path: overrides.id,
    language: 'ts',
    testState: 'untested',
    coveredBy: [],
    typeErrors: [],
    ...overrides
  };
}

function snapshot(nodes: ModuleNode[], edges: Edge[]): Pick<GraphSnapshot, 'rootPath' | 'generatedAt' | 'nodes' | 'edges'> {
  return { rootPath: '/fixture', generatedAt: 42, nodes, edges };
}

describe('buildHealthReport', () => {
  it('sums the fixed weight table; same input → same report', () => {
    const snap = snapshot(
      [node({ id: 'a.ts', testState: 'ok' }), node({ id: 'b.ts' })],
      [edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts')]
    );
    const first = buildHealthReport(snap);
    const second = buildHealthReport(snap);
    expect(second).toEqual(first);

    // 2 nodes → top 20% = max(1, ceil(0.4)) = 1 high-centrality module:
    // both have degree 2, the id tie-break picks a.ts. a.ts is 'ok' (tested),
    // so its score is centrality + cycle; b.ts stays untested.
    const a = first.items.find((i) => i.id === 'a.ts')!;
    const b = first.items.find((i) => i.id === 'b.ts')!;
    expect(a.score).toBe(HEALTH_WEIGHTS.highCentrality + HEALTH_WEIGHTS.onCycle);
    expect(b.score).toBe(HEALTH_WEIGHTS.untested + HEALTH_WEIGHTS.onCycle);
    expect(a.flags.highCentrality).toBe(true);
    expect(b.flags.highCentrality).toBe(false);
  });

  it('type errors and review error verdicts carry their weights; ties break by id', () => {
    const snap = snapshot(
      [
        node({ id: 'z.ts', typeErrors: [{ line: 1, code: '2304', message: 'x' }] }),
        node({ id: 'a.ts' }),
        node({
          id: 'm.ts',
          testState: 'ok',
          aiReview: { status: 'done', verdicts: [{ line: 2, verdict: 'error', message: 'bug' }], reviewedAt: 1 }
        }),
        node({ id: 'clean.ts', testState: 'ok', aiReview: { status: 'done', verdicts: [], reviewedAt: 1 } })
      ],
      []
    );
    const report = buildHealthReport(snap);
    // Rank cutoff (ceil(4*0.2)=1) picks a.ts by id asc. Scores:
    // a.ts = centrality 3 + untested 2 = 5, z.ts = untested 2 + type errors 2 = 4,
    // m.ts = review error 2, clean.ts = 0.
    expect(report.items.map((i) => i.id)).toEqual(['a.ts', 'z.ts', 'm.ts', 'clean.ts']);
    expect(report.items[0]!.flags.highCentrality).toBe(true);
    const m = report.items.find((i) => i.id === 'm.ts')!;
    expect(m.flags.reviewError).toBe(true);
    expect(m.flags.untested).toBe(false);
    const clean = report.items.find((i) => i.id === 'clean.ts')!;
    expect(clean.score).toBe(0);
    expect(clean.flags.reviewError).toBe(false);
  });

  it('a checking review does not count as a review error', () => {
    const snap = snapshot([node({ id: 'a.ts', aiReview: { status: 'checking', verdicts: [{ line: 1, verdict: 'error' }] } })], []);
    const report = buildHealthReport(snap);
    expect(report.items[0]!.flags.reviewError).toBe(false);
    // A lone node owns the rank cutoff by construction, hence centrality + untested.
    expect(report.items[0]!.score).toBe(HEALTH_WEIGHTS.highCentrality + HEALTH_WEIGHTS.untested);
  });

  it('the brief carries the top 5 plus the remaining count, in Chinese, byte-stable', () => {
    const ids = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    const snap = snapshot(ids.map((id) => node({ id })), []);
    const report = buildHealthReport(snap);
    const lines = report.brief.split('\n');
    expect(lines[0]).toBe('模块健康简报：共 7 个模块，按风险分排序');
    expect(lines).toHaveLength(7); // header + top 5 + 剩余
    expect(lines[6]).toBe('其余 2 个模块风险较低，见 items。');
    // Degree-0 ties: the rank cutoff picks a.ts and b.ts as high centrality (id asc).
    expect(lines[1]).toContain('a.ts（5 分：高中心度、未测）');
  });

  it('an empty graph yields an empty, well-formed report', () => {
    const report = buildHealthReport(snapshot([], []));
    expect(report.items).toEqual([]);
    expect(report.totalModules).toBe(0);
    expect(report.brief).toBe('模块健康简报：共 0 个模块，按风险分排序');
    expect(report.weights).toEqual(HEALTH_WEIGHTS);
  });
});
