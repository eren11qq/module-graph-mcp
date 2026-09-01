import { describe, expect, it } from 'vitest';
import { detectCommunities } from '../src/web/communities.js';

/**
 * 确定性 Louvain（聚类排列模式 2026-09-01，ADR 0004）：社区发现是聚类的
 * 唯一分团来源——双团必分、环图必合、孤儿=单例（D3）、同图两次运行全等、
 * 输出下标按（大小降序 + 最小 id）稳定排序。
 */

const clique = (prefix: string, size: number): string[] =>
  Array.from({ length: size }, (_, i) => `${prefix}${i}.ts`);

const fullEdges = (ids: string[]): { from: string; to: string }[] => {
  const links: { from: string; to: string }[] = [];
  for (const a of ids) {
    for (const b of ids) {
      if (a !== b) links.push({ from: a, to: b });
    }
  }
  return links;
};

function twoCliques(): { nodes: string[]; edges: { from: string; to: string }[] } {
  const left = clique('a', 5);
  const right = clique('b', 5);
  return {
    nodes: [...left, ...right],
    edges: [
      ...fullEdges(left),
      ...fullEdges(right),
      { from: 'a0.ts', to: 'b0.ts' } // 唯一弱桥：Louvain 应把它切开
    ]
  };
}

describe('detectCommunities (确定性 Louvain)', () => {
  it('splits two cliques joined by a single bridge edge', () => {
    const { nodes, edges } = twoCliques();
    const clusters = detectCommunities(nodes, edges);
    expect(new Set(clusters.values()).size).toBe(2);
    const left = new Set(nodes.filter((n) => n.startsWith('a')).map((n) => clusters.get(n)));
    expect(left.size).toBe(1);
    const right = new Set(nodes.filter((n) => n.startsWith('b')).map((n) => clusters.get(n)));
    expect(right.size).toBe(1);
    expect([...left][0]).not.toBe([...right][0]);
  });

  it('keeps fully-connected graphs in one community (triangle and K5)', () => {
    for (const size of [3, 5]) {
      const ids = clique('t', size);
      const clusters = detectCommunities(ids, fullEdges(ids));
      expect(new Set(clusters.values()).size).toBe(1);
      expect(clusters.get('t0.ts')).toBe(0);
    }
  });

  // 计划原文期待「环图单社区」，但环的模块度真相 (2+3 切分 Q(C5)=0.08 > 0)
  // 是分裂——忠实断言真实行为，不迁就假设（同「fcose 红了先查不放宽」纪律）。
  it('splits a 5-cycle into two arcs of 3 + 2 (modularity truth, not a bug)', () => {
    const ring = ['r0', 'r1', 'r2', 'r3', 'r4'];
    const edges: { from: string; to: string }[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      edges.push({ from: a, to: b }, { from: b, to: a });
    }
    const clusters = detectCommunities(ring, edges);
    const sizes = new Map<number, number>();
    for (const c of clusters.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    expect([...sizes.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 3],
      [1, 2]
    ]);
  });

  it('is deterministic: the same graph yields identical maps (and input order does not matter)', () => {
    const { nodes, edges } = twoCliques();
    const first = detectCommunities(nodes, edges);
    const second = detectCommunities(nodes, edges);
    expect([...second]).toEqual([...first]);
    // 打乱输入顺序（排序纪律的另一半证明）：结果不变。
    const shuffledNodes = [...nodes].reverse();
    const shuffledEdges = edges
      .map((e, i) => ({ e, k: (i * 7919) % edges.length }))
      .sort((a, b) => a.k - b.k)
      .map(({ e }) => ({ from: e.to, to: e.from })); // 反向 + 乱序 + 换向
    const third = detectCommunities(shuffledNodes, shuffledEdges);
    expect([...third]).toEqual([...first]);
  });

  it('orphans become singleton communities and still get an index (D3)', () => {
    const clusters = detectCommunities(['solo1.ts', 'solo2.ts', 'x.ts', 'y.ts'], [
      { from: 'x.ts', to: 'y.ts' },
      { from: 'y.ts', to: 'x.ts' }
    ]);
    expect(clusters.get('solo1.ts')).toBeDefined();
    expect(clusters.get('solo2.ts')).toBeDefined();
    expect(clusters.get('solo1.ts')).not.toBe(clusters.get('solo2.ts'));
    expect(clusters.get('x.ts')).toBe(clusters.get('y.ts'));
  });

  it('numbers clusters by (size desc, smallest member asc) — stable ordering', () => {
    const big = clique('c', 6);
    const small = clique('d', 2);
    const tiny = clique('e', 3);
    const clusters = detectCommunities([...big, ...small, ...tiny], [
      ...fullEdges(big),
      ...fullEdges(small),
      ...fullEdges(tiny)
    ]);
    expect(clusters.get('c0.ts')).toBe(0); // 6 人团 = 最大 → 0
    expect(clusters.get('e0.ts')).toBe(1); // 3 人次之 → 1
    expect(clusters.get('d0.ts')).toBe(2); // 2 人最小 → 2
    // 并列大小时按最小成员 id：两对 twins。
    const tied = detectCommunities(['f0', 'f1', 'g0', 'g1'], [
      { from: 'f0', to: 'f1' },
      { from: 'g0', to: 'g1' },
      { from: 'f1', to: 'f0' },
      { from: 'g1', to: 'g0' }
    ]);
    expect(new Set(tied.values()).size).toBe(2);
    expect(tied.get('f0')).toBeLessThan(tied.get('g0')!);
  });

  it('self-loops and dangling endpoints are dropped, not crashers', () => {
    const clusters = detectCommunities(['p', 'q'], [
      { from: 'p', to: 'p' }, // 自环
      { from: 'p', to: 'ghost' }, // 端点不在节点表
      { from: 'p', to: 'q' }
    ]);
    expect(clusters.size).toBe(2);
    expect(clusters.get('p')).toBeDefined();
    expect(clusters.get('q')).toBeDefined();
  });

  it('an empty graph yields an empty map', () => {
    expect(detectCommunities([], []).size).toBe(0);
  });
});
