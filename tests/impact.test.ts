import { describe, expect, it } from 'vitest';
import {
  CHANGE_IMPACT_HEURISTICS,
  computeImpact,
  computeGraphStats,
  createGraphStats,
  DEFAULT_IMPACT_DEPTH,
  MAX_IMPACT_DEPTH,
  scoreChanges
} from '../src/server/impact.js';
import { buildHealthReport } from '../src/server/health-report.js';
import type { Edge, GraphSnapshot, ModuleNode } from '../src/shared/types.js';

/**
 * Pure blast-radius math (GitNexus port step 1), driven with plain fixtures.
 * Shapes mirror tests/health-report.test.ts's cycle inventory: diamond,
 * two-node cycle, self-loop, chain, empty graph.
 */

function node(id: string, over: Partial<ModuleNode> = {}): ModuleNode {
  return { id, path: id, language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [], ...over };
}

function snap(nodes: ModuleNode[], edges: Edge[], generatedAt = 42): GraphSnapshot {
  return { rootPath: '/proj', generatedAt, nodes, edges };
}

const DIAMOND = snap(
  [node('a'), node('b'), node('c'), node('d')],
  [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'b', to: 'd' },
    { from: 'c', to: 'd' }
  ]
);

const CYCLE = snap(
  [node('x'), node('y'), node('z')],
  [
    { from: 'x', to: 'y' },
    { from: 'y', to: 'x' },
    { from: 'z', to: 'z' }
  ]
);

const CHAIN = snap(
  [node('a1'), node('a2'), node('a3'), node('a4'), node('a5')],
  [
    { from: 'a1', to: 'a2' },
    { from: 'a2', to: 'a3' },
    { from: 'a3', to: 'a4' },
    { from: 'a4', to: 'a5' }
  ]
);

describe('computeImpact', () => {
  it('walks the diamond: downstream groups by depth, ids ascending inside a level', () => {
    const r = computeImpact(DIAMOND, 'a', { direction: 'downstream' });
    expect(r).toMatchObject({ ok: true, startId: 'a', direction: 'downstream', maxDepth: DEFAULT_IMPACT_DEPTH });
    if (!r.ok) return;
    expect(r.affected.map((n) => [n.depth, n.id])).toEqual([
      [1, 'b'],
      [1, 'c'],
      [2, 'd']
    ]);
  });

  it('upstream answers "who depends on it" with the diamond root at depth 2', () => {
    const r = computeImpact(DIAMOND, 'd', { direction: 'upstream' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.affected.map((n) => [n.depth, n.id])).toEqual([
      [1, 'b'],
      [1, 'c'],
      [2, 'a']
    ]);
  });

  it('both direction takes the minimum depth over either side', () => {
    const r = computeImpact(DIAMOND, 'b', { direction: 'both' });
    if (!r.ok) throw new Error('expected ok');
    // b's upstream is a (1), downstream is d (1); c reaches via a→c / d←c at 2.
    expect(r.affected.map((n) => [n.depth, n.id])).toEqual([
      [1, 'a'],
      [1, 'd'],
      [2, 'c']
    ]);
  });

  it('converges on a two-node cycle and drops self-loop noise', () => {
    const downX = computeImpact(CYCLE, 'x', { direction: 'downstream' });
    if (!downX.ok) throw new Error('expected ok');
    expect(downX.affected.map((n) => n.id)).toEqual(['y']);

    const bothX = computeImpact(CYCLE, 'x', { direction: 'both' });
    if (!bothX.ok) throw new Error('expected ok');
    expect(bothX.affected.map((n) => n.id)).toEqual(['y']);

    const selfZ = computeImpact(CYCLE, 'z', { direction: 'downstream' });
    if (!selfZ.ok) throw new Error('expected ok');
    expect(selfZ.affected).toEqual([]); // the start never re-enters affected
  });

  it('truncates at maxDepth; illegal depths fall back to the default; the cap holds', () => {
    const capped = computeImpact(CHAIN, 'a1', { direction: 'downstream', maxDepth: 2 });
    if (!capped.ok) throw new Error('expected ok');
    expect(capped.affected.map((n) => n.id)).toEqual(['a2', 'a3']);

    const fallback = computeImpact(CHAIN, 'a1', { direction: 'downstream', maxDepth: 0 });
    if (!fallback.ok) throw new Error('expected ok');
    expect(fallback.maxDepth).toBe(DEFAULT_IMPACT_DEPTH);
    expect(fallback.affected.map((n) => n.id)).toEqual(['a2', 'a3', 'a4']);

    const cappedAtTen = computeImpact(CHAIN, 'a1', { direction: 'downstream', maxDepth: 99 });
    if (!cappedAtTen.ok) throw new Error('expected ok');
    expect(cappedAtTen.maxDepth).toBe(MAX_IMPACT_DEPTH);
    expect(cappedAtTen.affected).toHaveLength(4);
  });

  it('maps node state onto every affected entry', () => {
    const s = snap(
      [node('src.ts', { testState: 'failing', typeErrors: [{ line: 1, code: 'TS2345', message: 'x' }] }), node('test/src.test.ts', { testState: 'passing' })],
      [{ from: 'test/src.test.ts', to: 'src.ts' }]
    );
    const r = computeImpact(s, 'test/src.test.ts', { direction: 'downstream' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.affected).toEqual([
      { depth: 1, id: 'src.ts', path: 'src.ts', testState: 'failing', typeErrorCount: 1 }
    ]);
  });

  it('reports a structured miss for an unknown start; the empty graph always misses', () => {
    expect(computeImpact(DIAMOND, 'nope')).toEqual({ ok: false, reason: 'unknown-start', startId: 'nope' });
    expect(computeImpact(snap([], []), 'a')).toEqual({ ok: false, reason: 'unknown-start', startId: 'a' });
  });
});

describe('computeGraphStats / createGraphStats', () => {
  it('derives degrees, cycle membership, high centrality and normalized centrality', () => {
    const stats = computeGraphStats(CYCLE);
    expect(stats.inDegree.get('x')).toBe(1);
    expect(stats.outDegree.get('x')).toBe(1);
    expect(stats.inCycle).toEqual(new Set(['x', 'y', 'z'])); // self-loop marks z, per findCycleNodeIds
    // n=3 → k=1: x and y both have degree 2, z has 2 (self-loop in+out)…
    // tie-break by id ascending: 'x' wins the single slot.
    expect(stats.highCentrality).toEqual(new Set(['x']));
    // n=3: denominator 2·2=4; x has 2 → 0.5; unknown ids read as 0.
    expect(stats.centrality('x')).toBe(0.5);
    expect(stats.centrality('nope')).toBe(0);
  });

  it('centrality is 0 for degenerate graphs (≤1 node)', () => {
    expect(computeGraphStats(snap([], [])).centrality('a')).toBe(0);
    expect(computeGraphStats(snap([node('a')], [])).centrality('a')).toBe(0);
  });

  it('the factory memoizes per generatedAt and recomputes after a structural change', () => {
    let at = 1;
    const statsFor = createGraphStats(() => snap(CHAIN.nodes, CHAIN.edges, at));
    const first = statsFor();
    expect(statsFor()).toBe(first); // same generatedAt → same instance

    at = 2;
    const second = statsFor();
    expect(second).not.toBe(first);
    expect(statsFor()).toBe(second);
  });

  it('stays consistent with the health report: extraction did not move the ranking', () => {
    const report = buildHealthReport(DIAMOND);
    expect(report.items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']); // centrality 3/2/2/1... a first
    expect(report.items[0]!.flags).toMatchObject({ highCentrality: true, onCycle: false });
  });
});

describe('scoreChanges — 变更证据链打分（候选 #6:纯函数,不再藏在工具体里）', () => {
  const rec = (id: string, changedAt = 100): { id: string; changedAt: number } => ({ id, changedAt });

  it('maps every record with inGraph presence; only in-graph changes are scored', () => {
    const r = scoreChanges(CYCLE, [rec('x'), rec('gone.ts', 200)], computeGraphStats(CYCLE));
    expect(r.changes).toEqual([
      { id: 'x', changedAt: 100, inGraph: true },
      { id: 'gone.ts', changedAt: 200, inGraph: false }
    ]);
    expect(r.impacts.map((i) => i.changeId)).toEqual(['x']);
  });

  it('波及在环上 ⇒ high with Chinese reasons; overallRisk takes the max', () => {
    const r = scoreChanges(CYCLE, [rec('x')], computeGraphStats(CYCLE));
    expect(r.impacts[0]!.riskLevel).toBe('high');
    expect(r.impacts[0]!.riskReasons.some((s) => s.startsWith('波及节点在依赖环上：y'))).toBe(true);
    expect(r.overallRisk).toBe('high');
  });

  it('a lone ball scores low with empty reasons and no impact beyond presence', () => {
    const only = snap([node('solo')], []);
    const r = scoreChanges(only, [rec('solo')], computeGraphStats(only));
    expect(r.impacts).toEqual([{ changeId: 'solo', affectedCount: 0, affected: [], riskLevel: 'low', riskReasons: [] }]);
    expect(r.overallRisk).toBe('low');
  });

  it('受影响 > 10 with no on-cycle/high-centrality ball ⇒ medium (plan-pinned threshold)', () => {
    // hub + 15 片叶子 (叶子度数 1);80 节度数 2 的无关链把 high-centrality 名额
    // (top-20% = 20 席) 全部吃掉:hub 自己在 top 里,但爆发半径只含叶子。
    const nodes = [node('hub'), ...Array.from({ length: 15 }, (_, i) => node(`leaf-${i}`))];
    const edges: Edge[] = nodes.slice(1).map((l) => ({ from: 'hub', to: l.id }));
    for (let i = 0; i < 80; i++) nodes.push(node(`n${String(i).padStart(2, '0')}`));
    for (let i = 0; i < 79; i++) edges.push({ from: `n${String(i).padStart(2, '0')}`, to: `n${String(i + 1).padStart(2, '0')}` });
    const s = snap(nodes, edges);
    const stats = computeGraphStats(s);
    const r = scoreChanges(s, [rec('hub')], stats);
    expect(r.impacts[0]!.affectedCount).toBe(15);
    expect(r.impacts[0]!.riskLevel).toBe('medium');
    expect(r.impacts[0]!.riskReasons).toEqual(['受影响节点 15 个（> 10）']);
  });

  it('empty records score an empty chain; the heuristics constant is the single text source', () => {
    const r = scoreChanges(DIAMOND, [], computeGraphStats(DIAMOND));
    expect(r).toEqual({ changes: [], impacts: [], overallRisk: 'low' });
    expect(CHANGE_IMPACT_HEURISTICS).toContain('overallRisk 取各变更的最大级');
  });
});
