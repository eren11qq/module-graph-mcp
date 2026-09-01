import type { Core, EdgeSingular, NodeSingular } from 'cytoscape';
import { THEME, clusterFcoseOverrides, diameterOf } from './theme.js';

/**
 * 聚类排列通道（聚类排列模式 2026-09-01，ADR 0004）：GitNexus 式确定性
 * 海报。管线四段（graph-view.applyLayout 聚类分支编排）：
 * ① seedClusterLayout — Louvain 社区按面积需求半径领黄金角螺旋地盘，成员
 *    在领地中心「出生」（fnv1a 确定性抖动）；
 * ② refineClusterBodies — 逐簇独立 eles 精修（2026-09-01 海报质量 R1 实测
 *    换轨：整图一次求解会把各团经弱桥糊回一坨，簇内弹簧才决定团形）；
 * ③ anchorClusterTerritories — 按真实团形重标定领地（planTerritories）并
 *    刚体平移归位（2026-09-01 R3）；
 * ④ separateAllBalls — 全场球对最小距离硬保证（graph-view 调，D3 裁定）。
 * 无盘、无板、无孤儿坞（hull/折叠 = 非目标）。
 *
 * 出生点即种子：全链是 (聚类归属, path) 的纯函数、不读存档（D5 单档
 * write-through 的另一半——求解完照常回写），所以同一张图无论重解多少次
 * 都逐位全等（separateAllBalls 是按 id 排序的确定性推送，不破确定性）。
 */

/**
 * FNV-1a 32-bit — 新球种子的确定性抖动源 (Code-review 2026-08-29，聚类模式
 * 起为 graph-view 与本文共用)。同一 path 永远哈希出同一角度/半径，种子是
 * 路径的可复现函数，不引入随机数。
 */
export function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 领地标定（纯函数，2026-09-01 D4）：给每簇需求半径 R_i，返回按 index 序的
 * 地盘中心。黄金角 π(3−√5) 极角序铺得匀；半径从下限 spiralScale·√(i+1)
 * 起步，逐簇（index 序）线性外扩 +territoryStep，直到与所有已放簇的中心距
 * ≥ max((Ri+Rj)×pairGapFactor, Ri+Rj+minClusterGap)——系数项让大簇留白随
 * 面积涨，下限项救小簇（旧等面积向日葵只看序号、不看簇大小，小簇两两粘连）。
 */
export function planTerritories(requiredRadii: readonly number[]): { x: number; y: number }[] {
  const { goldenAngle, spiralScale, pairGapFactor, minClusterGap, territoryStep } =
    THEME.layout.cluster;
  const centers: { x: number; y: number }[] = [];
  requiredRadii.forEach((r, i) => {
    const angle = i * goldenAngle;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    let radius = spiralScale * Math.sqrt(i + 1);
    let clash = true;
    while (clash) {
      clash = false;
      const x = radius * ux;
      const y = radius * uy;
      for (let j = 0; j < centers.length; j++) {
        const need = Math.max(
          (r + requiredRadii[j]!) * pairGapFactor,
          r + requiredRadii[j]! + minClusterGap
        );
        if (Math.hypot(centers[j]!.x - x, centers[j]!.y - y) < need) {
          radius += territoryStep;
          clash = true;
          break;
        }
      }
    }
    centers.push({ x: radius * ux, y: radius * uy });
  });
  return centers;
}

/** 成员出生点（纯函数）：领地中心 + fnv1a(path) 确定性抖动，幅度随聚类大小开方。 */
export function birthPoint(path: string, center: { x: number; y: number }, clusterSize: number): { x: number; y: number } {
  const hash = fnv1a(path);
  const angle = ((hash % 360) * Math.PI) / 180;
  const ratio = ((hash >>> 8) % 100) / 100;
  const jitter = THEME.layout.cluster.jitterScale * Math.sqrt(clusterSize) * ratio;
  return { x: center.x + Math.cos(angle) * jitter, y: center.y + Math.sin(angle) * jitter };
}

/**
 * 测试球路径判定 (D3)：与 graph-areas.ts PATH_REGIONS 同口径（tests/ 与
 * test-fixtures/ 两条前缀）。刻意本地小函数、不 import graph-areas——聚类
 * 通道与区域罗盘是两条独立管线，判定口径若漂移靠测试钉死，不靠耦合。
 */
export function isTestPath(path: string): boolean {
  return path.startsWith('tests/') || path.startsWith('test-fixtures/');
}

/**
 * 测试球归属 (纯函数, 2026-09-01 D3)：Louvain 输入只含 src 球（测试球与其
 * 全部连边不进输入，communities.ts 零改动），事后按多数票挂靠。票源优先 =
 * out 边（这坨测试在 import 谁）指向的 src 球所在社区，重边按条计票；
 * 无 out 票 → 全部邻居（in∪out）多数票；仍无票 → 单例社区（下标从现有
 * 最大值 +1 起、按 id 升序逐个分配）。平票取最小 clusterIndex——全链路
 * 无随机，同输入逐位可复现。
 */
export function assignTestBalls(
  testIds: readonly string[],
  srcClusters: ReadonlyMap<string, number>,
  links: ReadonlyArray<{ from: string; to: string }>
): Map<string, number> {
  const sorted = [...testIds].sort((a, b) => (a < b ? -1 : 1));
  let nextSingleton = 0;
  for (const index of srcClusters.values()) nextSingleton = Math.max(nextSingleton, index + 1);
  const out = new Map<string, number>();
  const votesOf = (id: string, outOnly: boolean): Map<number, number> => {
    const counts = new Map<number, number>();
    for (const e of links) {
      let other: string | null = null;
      if (e.from === id) other = e.to;
      else if (!outOnly && e.to === id) other = e.from;
      if (other === null || other === id) continue;
      const index = srcClusters.get(other);
      if (index === undefined) continue;
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    return counts;
  };
  for (const id of sorted) {
    let votes = votesOf(id, true);
    if (votes.size === 0) votes = votesOf(id, false);
    if (votes.size === 0) {
      out.set(id, nextSingleton++);
      continue;
    }
    let bestIndex = Infinity;
    let bestCount = -1;
    for (const [index, count] of votes) {
      if (count > bestCount || (count === bestCount && index < bestIndex)) {
        bestIndex = index;
        bestCount = count;
      }
    }
    out.set(id, bestIndex);
  }
  return out;
}

/**
 * 出生阶段：把每个聚类的成员球放到各自领地中心附近。必须在 fcose
 * 之前跑——randomize:false 拿这些出生点当求解起点（种子即起点）。
 * 2026-09-01 D4：中心不再看序号吃等面积向日葵，而是按每簇需求半径
 * R = √(Σ成员半径²)×looseFactor 标定（planTerritories）。半径缺失/异常
 * 按最小真实球径兜底（同 separateTouching 的 `Number(...)||0` 防御口径）。
 * clusters 覆盖全部成员，迭代按聚类下标升序（= 大小降序稳定序）。
 */
export function seedClusterLayout(cy: Core, clusters: ReadonlyMap<string, number>): void {
  const byCluster = groupByCluster(cy, clusters);
  const requiredRadii = byCluster.map((list) => {
    const sumSquares = list.reduce((s, n) => {
      const r = (Number(n.data('diameter')) || diameterOf(1)) / 2;
      return s + r * r;
    }, 0);
    return Math.sqrt(sumSquares) * THEME.layout.cluster.looseFactor;
  });
  const centers = planTerritories(requiredRadii);
  cy.batch(() => {
    byCluster.forEach((list, index) => {
      const center = centers[index]!;
      for (const n of list) {
        const path = String(n.data('path') ?? n.id());
        n.position(birthPoint(path, center, list.length));
      }
    });
  });
}

/** 单簇几何测量结果：成员（id 升序）、质心、外接圆半径、领地需求半径。 */
export interface ClusterBlob {
  index: number;
  ids: string[];
  centroid: { x: number; y: number };
  radius: number;
  required: number;
}

/** 聚类下标 → 成员 id 列表（升序）。纯 map 函数，不读 cy。 */
function groupIdsByCluster(clusters: ReadonlyMap<string, number>): Map<number, string[]> {
  const byIndex = new Map<number, string[]>();
  clusters.forEach((index, id) => {
    const list = byIndex.get(index);
    if (list) list.push(id);
    else byIndex.set(index, [id]);
  });
  for (const list of byIndex.values()) list.sort((a, b) => (a < b ? -1 : 1));
  return byIndex;
}

/** 球半径单一口径：data('diameter')/2，缺失/异常按最小真实球径兜底。 */
function radiusOf(cy: Core, id: string): number {
  return (Number(cy.getElementById(id).data('diameter')) || diameterOf(1)) / 2;
}

/**
 * 从当前落点测量每簇 blob（纯读，不改图）：质心 = 成员球心均值（id 升序
 * 累加，浮点序确定）；radius = 最远成员球心距 + 该成员球半径（外接圆，
 * 覆盖球体本身）；required = (radius + ballGap)·√2——领地规划的输入。
 */
export function measureClusterBlobs(
  cy: Core,
  clusters: ReadonlyMap<string, number>
): ClusterBlob[] {
  const blobs: ClusterBlob[] = [];
  groupIdsByCluster(clusters).forEach((ids, index) => {
    let sx = 0;
    let sy = 0;
    for (const id of ids) {
      const p = cy.getElementById(id).position();
      sx += p.x;
      sy += p.y;
    }
    const centroid = { x: sx / ids.length, y: sy / ids.length };
    let radius = 0;
    for (const id of ids) {
      const p = cy.getElementById(id).position();
      radius = Math.max(radius, Math.hypot(p.x - centroid.x, p.y - centroid.y) + radiusOf(cy, id));
    }
    blobs.push({
      index,
      ids,
      centroid,
      radius,
      required: (radius + THEME.layout.ballGap) * Math.SQRT2
    });
  });
  return blobs.sort((a, b) => a.index - b.index);
}

/**
 * 簇体精修（2026-09-01 海报质量修正 R1，实测裁定）：整图一次 fcose 求解
 * 当不了「保种精修」——跨簇弱边会把各团互相拽开，求解完只把每个连通分量
 * 的包围盒中心送回原位（fcose auxiliary.relocateComponent），领地结构整
 * 体在弱桥两侧糊回一坨（headless 实测）。所以这里把每个社区作为独立 eles
 * 子集单解一次：团形由簇内弹簧（clusterIdealEdgeLength）+ 簇心引力决定，
 * relocate 把团心送回出生领地心；跨簇边不进任何一次求解——它们只画线不
 * 拽球，团与团的关系完全交给领地规划。无内部边的单例跳过。
 */
export function refineClusterBodies(
  cy: Core,
  clusters: ReadonlyMap<string, number>
): void {
  const internalEdges = new Map<number, string[]>();
  cy.edges().forEach((e: EdgeSingular) => {
    const index = clusters.get(e.source().id());
    if (index === undefined || clusters.get(e.target().id()) !== index) return;
    const list = internalEdges.get(index);
    if (list) list.push(e.id());
    else internalEdges.set(index, [e.id()]);
  });
  groupIdsByCluster(clusters).forEach((ids, index) => {
    const edges = internalEdges.get(index) ?? [];
    if (ids.length < 2 && edges.length === 0) return;
    // eles 子集必须走 filter+union——cytoscape 的 getElementById 只吃单个
    // 字符串 id（数组被 `'' + id` 强转成 "a,b" 查不到 → 空集合 → layout
    // 静默空跑，headless 实测逐位不动）。
    const member = new Set(ids);
    const edge = new Set(edges);
    const eles = cy
      .nodes()
      .filter((n: NodeSingular) => member.has(n.id()))
      .union(cy.edges().filter((e: EdgeSingular) => edge.has(e.id())));
    cy.layout({
      name: 'fcose',
      ...THEME.fcose,
      ...clusterFcoseOverrides(),
      eles,
      fit: false,
      padding: THEME.canvas.padding,
      animate: false
    } as cytoscape.LayoutOptions).run();
  });
}

/**
 * 领地标定落地（R3/D4 的实测版）：出生领地的需求半径 √(Σr²)×1.5 是
 * 等面积下限，fcose 团形实测大一档（理想边长 floor = ballGap + 两端半径，
 * 二跳成员天然站到 ~2×56px 处）。因此以精修后的真实团形为准——测量每簇
 * 外接圆（含球体、各带 ballGap 垫圈、√2 方阵化），重新跑 planTerritories，
 * 把整簇从当前质心**刚体平移**到新高地中心。团形是求解的产物，位置是
 * 规划的产物——两件事各归各的机制（同区域罗盘「fcose 软排布 + 刚性平移
 * 兜底」的结构），确定性由纯算术保持。
 */
export function anchorClusterTerritories(
  cy: Core,
  clusters: ReadonlyMap<string, number>
): void {
  const blobs = measureClusterBlobs(cy, clusters);
  const centers = planTerritories(blobs.map((b) => b.required));
  cy.batch(() => {
    blobs.forEach((blob, i) => {
      const target = centers[i]!;
      const dx = target.x - blob.centroid.x;
      const dy = target.y - blob.centroid.y;
      for (const id of blob.ids) {
        const p = cy.getElementById(id).position();
        cy.getElementById(id).position({ x: p.x + dx, y: p.y + dy });
      }
    });
  });
}

/** 聚类下标 → 成员（按 id 升序、剔除题注板）。返回数组下标 = 聚类编号。 */
function groupByCluster(cy: Core, clusters: ReadonlyMap<string, number>): NodeSingular[][] {
  const buckets: NodeSingular[][] = [];
  cy.nodes()
    .not('.region-plate')
    .forEach((n: NodeSingular) => {
      const index = clusters.get(n.id());
      if (index === undefined) return;
      while (buckets.length <= index) buckets.push([]);
      buckets[index]!.push(n);
    });
  for (const list of buckets) list.sort((a, b) => (a.id() < b.id() ? -1 : 1));
  return buckets;
}
