// @vitest-environment node
import { describe, expect, it } from 'vitest';
import cytoscape from 'cytoscape';
import type { NodeSingular } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import {
  anchorClusterTerritories,
  assignTestBalls,
  birthPoint,
  clustersOfRenderedGraph,
  fnv1a,
  isTestPath,
  measureClusterBlobs,
  planTerritories,
  refineClusterBodies,
  seedClusterLayout,
  solveClusterPoster
} from '../src/web/layout-cluster.js';
import { separateAllBalls, separateTouching } from '../src/web/graph-areas.js';
import { THEME } from '../src/web/theme.js';

/**
 * 聚类排列通道（ADR 0004）。纯几何函数直接钉公式；管线用真实 cytoscape
 * （headless，无容器即无渲染器）+ 真实 fcose——「同图两次全量重解位置全等」
 * 是这个文件存在的理由：聚类模式求解不读存档，跨重载全等只剩求解链本身，
 * fcose 若藏内部随机必须在这里被抓到（修正点 4，红了先查源、不许放宽）。
 *
 * 2026-09-01 海报质量三修：
 * - clusterCenter 公式钉 → planTerritories 领地标定钉（D4）。
 * - 管线换轨：单次全局 fcose「保种精修」实测破产——fcose 的
 *   randomize:false 只回送每个连通分量的包围盒中心，跨簇弱边把各团拽回
 *   一坨（numIter 0/2500、gravity 0.25/1.2 全数复现整坨漂移）。现行通道
 *   是逐簇精修 + 按真实团形标定领地 + 刚体归位（layout-cluster 头注释）。
 * - 验收 2 数值随之改钉：计划式「成员到簇心 ≤ R_i + 2×平均球半径」把
 *   R_i 定义在等面积下限（√(Σr²)×1.5）；但 ballGap-32 冻结 + r12 球把
 *   相邻球心距顶到 ≥56px，二跳成员天然站到 ~85px 外（下限由间距机制决定，
 *   非布局质量）。改钉两条真实约束：簇内每边 ≤ 理想边长+2×ballGap（团不
 *   被撕开）、团外接圆 ≤ 等面积半径×3（团不炸开）——两者都能抓回归。
 */

cytoscape.use(fcose);

const {
  spiralScale,
  goldenAngle,
  jitterScale,
  looseFactor,
  minClusterGap,
  pairGapFactor,
  territoryStep
} = THEME.layout.cluster;

describe('planTerritories (面积标定的领地排布)', () => {
  it('uses the golden angle constant π(3−√5)', () => {
    expect(goldenAngle).toBeCloseTo(Math.PI * (3 - Math.sqrt(5)), 12);
  });

  it('the first territory sits on the radius floor at polar angle 0', () => {
    const [c] = planTerritories([10]);
    expect(c.x).toBeCloseTo(spiralScale, 9);
    expect(c.y).toBeCloseTo(0, 9);
  });

  it('polar order is index·goldenAngle — expansion only pushes the radius out', () => {
    const centers = planTerritories([5, 60, 25, 100]);
    centers.forEach((c, i) => {
      const expected = (((i * goldenAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const actual = ((Math.atan2(c.y, c.x) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(Math.hypot(c.x, c.y)).toBeGreaterThanOrEqual(spiralScale * Math.sqrt(i + 1) - 1e-9);
      expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
    });
  });

  it('expands in whole territoryStep increments off the floor (deterministic ladder)', () => {
    const centers = planTerritories([200, 10]);
    const r1 = Math.hypot(centers[1]!.x, centers[1]!.y);
    const steps = (r1 - spiralScale * Math.sqrt(2)) / territoryStep;
    expect(steps).toBeGreaterThanOrEqual(0);
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
  });

  it('every pair satisfies the center-distance constraint max((Ri+Rj)·1.4, Ri+Rj+64)', () => {
    const radii = [5, 60, 25, 100, 32, 48];
    const centers = planTerritories(radii);
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const sum = radii[i]! + radii[j]!;
        const need = Math.max(sum * pairGapFactor, sum + minClusterGap);
        const d = Math.hypot(centers[i]!.x - centers[j]!.x, centers[i]!.y - centers[j]!.y);
        expect(d).toBeGreaterThanOrEqual(need - 1e-9);
      }
    }
  });

  it('tiny clusters still get the absolute 64px floor (1.4 系数在 R≈10 时只有 28px)', () => {
    const centers = planTerritories([10, 10]);
    const d = Math.hypot(centers[0]!.x - centers[1]!.x, centers[0]!.y - centers[1]!.y);
    expect(d).toBeGreaterThanOrEqual(10 + 10 + 64 - 1e-9);
  });

  it('is deterministic: the same radii hand back the same centers', () => {
    expect(planTerritories([7, 70, 33])).toEqual(planTerritories([7, 70, 33]));
  });
});

describe('isTestPath (测试球判定, D3 口径)', () => {
  it('tests/ 与 test-fixtures/ 前缀是球上的 tests 带,其余都是 src', () => {
    expect(isTestPath('tests/main.test.ts')).toBe(true);
    expect(isTestPath('test-fixtures/sample-app/index.ts')).toBe(true);
    expect(isTestPath('src/web/main.ts')).toBe(false);
    expect(isTestPath('main.test.ts')).toBe(false);
  });
});

describe('assignTestBalls (测试球多数票挂靠, D3)', () => {
  const src = new Map([
    ['a.ts', 0],
    ['b.ts', 0],
    ['c.ts', 1]
  ]);

  it('out 边(import 指向)的社区多数票定归属', () => {
    const links = [
      { from: 'tests/t.ts', to: 'a.ts' },
      { from: 'tests/t.ts', to: 'b.ts' },
      { from: 'tests/t.ts', to: 'c.ts' }
    ];
    expect(assignTestBalls(['tests/t.ts'], src, links).get('tests/t.ts')).toBe(0);
  });

  it('平票取最小 clusterIndex', () => {
    const links = [
      { from: 'tests/t.ts', to: 'c.ts' },
      { from: 'tests/t.ts', to: 'a.ts' }
    ];
    expect(assignTestBalls(['tests/t.ts'], src, links).get('tests/t.ts')).toBe(0);
  });

  it('无 out 边 → 全部邻居(in∪out)多数票', () => {
    const links = [
      { from: 'a.ts', to: 'tests/t.ts' },
      { from: 'c.ts', to: 'tests/t.ts' },
      { from: 'c.ts', to: 'tests/d.ts' }
    ];
    const out = assignTestBalls(['tests/t.ts', 'tests/d.ts'], src, links);
    expect(out.get('tests/t.ts')).toBe(0); // 邻居 a(0) + c(1) 平票 → 最小 index
    expect(out.get('tests/d.ts')).toBe(1);
  });

  it('无任何 src 邻居 → 单例社区,下标从现有最大值 +1 起、按 id 升序分配', () => {
    const link = { from: 'other-test/x', to: 'nope' };
    const out = assignTestBalls(['tests/z.ts', 'tests/y.ts'], src, [link]);
    expect(out.get('tests/y.ts')).toBe(2); // id 升序: y 先拿 2
    expect(out.get('tests/z.ts')).toBe(3);
  });

  it('is deterministic: same inputs → the same map, entry order included', () => {
    const link = { from: 'tests/t.ts', to: 'c.ts' };
    const a = assignTestBalls(['tests/t.ts', 'tests/u.ts'], src, [link]);
    const b = assignTestBalls(['tests/u.ts', 'tests/t.ts'], src, [link]);
    expect([...a]).toEqual([...b]);
  });
});

describe('fnv1a + birthPoint (确定性出生)', () => {
  it('fnv1a is stable for the same text and separates near-paths', () => {
    expect(fnv1a('src/a.ts')).toBe(fnv1a('src/a.ts'));
    expect(fnv1a('src/a.ts')).not.toBe(fnv1a('src/b.ts'));
    expect(fnv1a('')).toBe(2166136261); // 初值（32-bit FNV offset basis）
  });

  it('the same path + center + size births at the identical point', () => {
    const c = { x: 10, y: -20 };
    expect(birthPoint('src/web/graph-view.ts', c, 7)).toEqual(
      birthPoint('src/web/graph-view.ts', c, 7)
    );
  });

  it('birth points stay inside jitterScale·√size of their center', () => {
    const c = { x: 5, y: 5 };
    for (const path of ['a.ts', 'b/c.ts', 'deep/dir/name.tsx', 'x'.repeat(64)]) {
      const p = birthPoint(path, c, 9);
      expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(jitterScale * Math.sqrt(9) + 1e-9);
    }
  });
});

describe('separateTouching (保底分离内核)', () => {
  it('separateTouching is idempotent: a satisfied layout does not move', () => {
    const cy = buildRealCy(
      [
        { id: 'u', x: -500, y: 0 },
        { id: 'v', x: 500, y: 0 }
      ],
      []
    );
    const list = [cy.getElementById('u') as unknown as NodeSingular, cy.getElementById('v') as unknown as NodeSingular];
    const before = list.map((n) => ({ ...n.position() }));
    separateTouching(list, THEME.layout.ballGap);
    expect(list.map((n) => ({ ...n.position() }))).toEqual(before);
    cy.destroy();
  });

  it('overlap is resolved to edge-to-edge ≥ gap inside a cluster', () => {
    const cy = buildRealCy(
      [
        { id: 'u', x: 0, y: 0 },
        { id: 'v', x: 5, y: 0 } // 深贴合
      ],
      []
    );
    const list = [cy.getElementById('u') as unknown as NodeSingular, cy.getElementById('v') as unknown as NodeSingular];
    for (const n of list) n.data('diameter', 40);
    separateTouching(list, THEME.layout.ballGap);
    const pu = (cy.getElementById('u') as unknown as NodeSingular).position() as { x: number; y: number };
    const pv = (cy.getElementById('v') as unknown as NodeSingular).position() as { x: number; y: number };
    expect(Math.hypot(pv.x - pu.x, pv.y - pu.y)).toBeGreaterThanOrEqual(40 + THEME.layout.ballGap - 1e-6);
    cy.destroy();
  });
});

// ---------------------------------------------------------------------------
// 真实 headless 管线
// ---------------------------------------------------------------------------

interface Seed {
  id: string;
  x: number;
  y: number;
  /** 球路缺省 src/<id>——isTestPath 全 false；测试球图景显式给 tests/ 路径。 */
  path?: string;
}

const BALL_DIAMETER = 24;

function buildRealCy(nodes: Seed[], links: { from: string; to: string }[]): cytoscape.Core {
  const cy = cytoscape({ headless: true });
  cy.add(
    nodes.map((n) => ({
      data: { id: n.id, path: n.path ?? `src/${n.id}`, diameter: BALL_DIAMETER },
      position: { x: n.x, y: n.y }
    }))
  );
  cy.add(links.map((e) => ({ data: { id: `${e.from}->${e.to}`, source: e.from, target: e.to } })));
  return cy;
}

// candidate #4 (2026-09-03): 手抄的 clustersOfGraph / solveClusterChannel 已删——
// 管线测试从此跑生产函数本身（layout-cluster.solveClusterPoster /
// clustersOfRenderedGraph），「同序」注释不复存在，序漂移会被测试直接抓到。

function positionsOf(cy: cytoscape.Core): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  cy.nodes().forEach((n) => {
    const p = n.position();
    out.push([n.id(), p.x, p.y]);
  });
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * 玩具仓库图：两个密集功能团 (web×5 / server×5) 各通过 hub 指向 shared 对，
 * shared 对互连成环，另有一颗孤儿。两团 + 1 shared 团 + 孤儿单例。
 */
function toyRepo(): { nodes: Seed[]; links: { from: string; to: string }[] } {
  const ids = [
    'web1', 'web2', 'web3', 'web4', 'web5',
    'srv1', 'srv2', 'srv3', 'srv4', 'srv5',
    'shared1', 'shared2',
    'orphan'
  ];
  const nodes: Seed[] = ids.map((id, i) => ({ id, x: (i % 5) * 10, y: i * 7 }));
  const links: { from: string; to: string }[] = [];
  const clique = (arr: string[]) => {
    for (const a of arr) for (const b of arr) if (a !== b) links.push({ from: a, to: b });
  };
  clique(['web1', 'web2', 'web3']);
  clique(['srv1', 'srv2', 'srv3']);
  for (const tail of ['web4', 'web5']) {
    for (const head of ['web1', 'web2']) links.push({ from: tail, to: head }, { from: head, to: tail });
  }
  for (const tail of ['srv4', 'srv5']) {
    for (const head of ['srv1', 'srv2']) links.push({ from: tail, to: head }, { from: head, to: tail });
  }
  for (const w of ['web1', 'srv1']) links.push({ from: w, to: 'shared1' });
  for (const w of ['web2', 'srv2']) links.push({ from: w, to: 'shared2' });
  links.push({ from: 'shared1', to: 'shared2' }, { from: 'shared2', to: 'shared1' });
  return { nodes, links };
}

describe('聚类通道真实管线（headless cytoscape + fcose）', () => {
  it('converges: positions are finite and EVERY ball pair (cross-cluster + orphans included) keeps ballGap (D3)', () => {
    const { nodes, links } = toyRepo();
    const cy = buildRealCy(nodes, links);
    solveClusterPoster(cy);
    for (const [, x, y] of positionsOf(cy)) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
    // 2026-09-01 用户裁定 D3: 断言从同聚类对扩到全对——球径 24 → 边到边 = 中心距 − 24。
    const pts = positionsOf(cy);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const gap = Math.hypot(pts[i]![1] - pts[j]![1], pts[i]![2] - pts[j]![2]) - BALL_DIAMETER;
        expect(gap).toBeGreaterThanOrEqual(THEME.layout.ballGap - 1e-3);
      }
    }
    cy.destroy();
  });

  it('clusters stay separated: every pair of cluster bboxes keeps a ≥ 64px gap (验收 1)', () => {
    const { nodes, links } = toyRepo();
    const cy = buildRealCy(nodes, links);
    const clusters = solveClusterPoster(cy);
    // 球径 24 → 球心包围盒 ±12；两盒间隙 = 分离轴上的欧氏净距。
    const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    cy.nodes().forEach((n) => {
      const index = clusters.get(n.id());
      if (index === undefined) return;
      const p = n.position();
      const b = boxes.get(index) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      b.x0 = Math.min(b.x0, p.x - BALL_DIAMETER / 2);
      b.y0 = Math.min(b.y0, p.y - BALL_DIAMETER / 2);
      b.x1 = Math.max(b.x1, p.x + BALL_DIAMETER / 2);
      b.y1 = Math.max(b.y1, p.y + BALL_DIAMETER / 2);
      boxes.set(index, b);
    });
    expect(boxes.size).toBeGreaterThanOrEqual(3); // web/srv/shared 至少三团 + orphan
    const idx = [...boxes.keys()].sort((a, b) => a - b);
    for (let i = 0; i < idx.length; i++) {
      for (let j = i + 1; j < idx.length; j++) {
        const a = boxes.get(idx[i]!)!;
        const b = boxes.get(idx[j]!)!;
        const dx = Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
        const dy = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(minClusterGap - 1e-3);
      }
    }
    cy.destroy();
  });

  it('each cluster is one tight blob: intra edges ≤ ideal+2×ballGap, circumradius ≤ 3× area radius (验收 2 校准版)', () => {
    const { nodes, links } = toyRepo();
    const cy = buildRealCy(nodes, links);
    const clusters = solveClusterPoster(cy);
  // 簇内理想边长 = ballGap + 两端半径(12+12)=56；实测团内落边 ≤91（二跳对），
  // 上限 ideal + 2×ballGap = 120：抓「团被撕开」的回归，余量吃确定性浮点。
  const ideal = THEME.layout.ballGap + BALL_DIAMETER;
    for (const e of links) {
      if (clusters.get(e.from) !== clusters.get(e.to)) continue;
      const a = cy.getElementById(e.from).position();
      const b = cy.getElementById(e.to).position();
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      expect(d).toBeLessThanOrEqual(ideal + 2 * THEME.layout.ballGap);
    }
    // 团不炸开：外接圆（含球体）≤ 等面积需求半径 ×3。
    for (const blob of measureClusterBlobs(cy, clusters)) {
      const areaRadius = Math.sqrt(blob.ids.length * (BALL_DIAMETER / 2) ** 2) * looseFactor;
      expect(blob.radius).toBeLessThanOrEqual(areaRadius * 3);
    }
    cy.destroy();
  });

  it('测试球贴归属团：票入的社区团内、离团心不过两跳 (验收 3)', () => {
    const { nodes, links } = toyRepo();
    const webTester: Seed = { id: 'main.test.ts', x: 0, y: 0, path: 'tests/main.test.ts' };
    const allNodes = [...nodes, webTester];
    const testerLinks = [
      { from: 'main.test.ts', to: 'web1' },
      { from: 'main.test.ts', to: 'web2' }
    ];
    const cy = buildRealCy(allNodes, [...links, ...testerLinks]);
    const clusters = solveClusterPoster(cy);
    // 票面 = web 团：src-only Louvain 里 web1/web2 的社区。
    expect(clusters.get('main.test.ts')).toBe(clusters.get('web1'));
    const blobs = measureClusterBlobs(cy, clusters);
    const blob = blobs.find((b) => b.index === clusters.get('main.test.ts'))!;
    const p = cy.getElementById('main.test.ts').position();
    // 连回簇内边一起解——它被弹簧带在团形里，离质心不超过团的尺度。
    expect(Math.hypot(p.x - blob.centroid.x, p.y - blob.centroid.y)).toBeLessThanOrEqual(blob.radius);
    cy.destroy();
  });

  it('钉死修正点 4：同图两次全量重解，落点逐位全等（fresh instances）', () => {
    const { nodes, links } = toyRepo();
    const a = buildRealCy(nodes, links);
    const b = buildRealCy(nodes, links);
    solveClusterPoster(a);
    solveClusterPoster(b);
    expect(JSON.stringify(positionsOf(b))).toBe(JSON.stringify(positionsOf(a)));
    a.destroy();
    b.destroy();
  });

  it('同实例回到出生点再重解，结果与第一次逐位全等（fcose 无隐藏状态）', () => {
    const { nodes, links } = toyRepo();
    const cy = buildRealCy(nodes, links);
    const clusters = clustersOfRenderedGraph(cy);
    const first = (() => {
      seedClusterLayout(cy, clusters);
      const seeds = positionsOf(cy);
      refineClusterBodies(cy, clusters);
      anchorClusterTerritories(cy, clusters);
      separateAllBalls(cy, THEME.layout.ballGap);
      return { seeds, settled: positionsOf(cy) };
    })();
    // 重播出生（seedClusterLayout 是纯函数——直接把点按回原位），再解一次。
    for (const [id, x, y] of first.seeds) (cy.getElementById(id) as unknown as NodeSingular).position({ x, y });
    refineClusterBodies(cy, clusters);
    anchorClusterTerritories(cy, clusters);
    separateAllBalls(cy, THEME.layout.ballGap);
    expect(JSON.stringify(positionsOf(cy))).toBe(JSON.stringify(first.settled));
    cy.destroy();
  });
});
