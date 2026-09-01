/**
 * 确定性 Louvain 社区发现（聚类排列模式 2026-09-01）：把可见 import 图切成
 * 若干社区，交给 layout-cluster.ts 安排地盘中心。GitNexus 同款思路——社区
 * 只在空间上表达，不新增任何视觉通道。
 *
 * 零依赖自研（ADR 0004）：Leiden 无 npm 发布、GitNexus 也是 vendor，而
 * Louvain 两阶段（局部模块度增益移动 + 社区聚合重跑）百行可审计且完全
 * 可控确定性。确定性纪律钉死三条：节点按 id 排序迭代、并列收益用固定种子
 * mulberry32 择一、权重为整数（浮点加法组合序无关）。同图同结果——聚类
 * 模式的求解不读存档还能跨重载全等，全靠这里没有任何隐式随机。
 *
 * resolution 固定 1.0（教科书原值，COMPROMISES 在册）；孤儿（零连线）天然
 * 成为单例社区照常进输出（D3），管线零特判。
 */

export interface CommunityEdge {
  from: string;
  to: string;
}

/** 种子常量钉死：改它 = 全图聚类重洗牌，等同换代。 */
const PRNG_SEED = 0x9e3779b9;

/** 阶段 1 每层最多扫这么多遍；Louvain 实测 3–5 遍收敛，10 倍余量兜病态图。 */
const MAX_PASSES_PER_LEVEL = 50;

/** 聚合层数上限：每层节点数必降，理论上到不了，纯防御。 */
const MAX_LEVELS = 20;

/** 收益比较的浮点容差：整数权重下真实差值 ≫ eps，只有真并列落进带内。 */
const EPS = 1e-12;

/** mulberry32——全模块唯一随机源，只为并列收益的确定性择一服务。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Adjacency = Map<string, Map<string, number>>;

/**
 * 主入口：节点 id 集合 + 有向 import 边（内部做无向投影、去自环、并重边）
 * → Map<nodeId, clusterIndex>。聚类按下标 0..k-1 稳定输出：大小降序、
 * 并列取成员最小 id 升序——螺旋领地与视觉顺序由此锁定。
 */
export function detectCommunities(
  nodeIds: Iterable<string>,
  edges: ReadonlyArray<CommunityEdge>
): Map<string, number> {
  const nodes = [...new Set(nodeIds)].sort();
  const inGraph = new Set(nodes);

  // 无向邻接（权重 = 重边条数，整数保证）；自环丢弃——自依赖不影响社区归属。
  const adj: Adjacency = new Map(nodes.map((id) => [id, new Map<string, number>()]));
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (!inGraph.has(e.from) || !inGraph.has(e.to)) continue;
    const a = adj.get(e.from)!;
    const b = adj.get(e.to)!;
    a.set(e.to, (a.get(e.to) ?? 0) + 1);
    b.set(e.from, (b.get(e.from) ?? 0) + 1);
  }
  const degree = new Map(nodes.map((id) => [id, sumWeights(adj.get(id)!)]));
  // m2 = 2m = 全图度数总和；无边时所有球各自单例，直接进输出排序。
  const m2 = nodes.reduce((s, id) => s + degree.get(id)!, 0);

  // 每层记录 node → comm 的归属（comm 标签用成员 id，层间可组合回原点）。
  const levels: Map<string, string>[] = [];
  if (m2 > 0) {
    const rnd = mulberry32(PRNG_SEED);
    let currentNodes = nodes;
    let currentAdj = adj;
    let currentDegree = degree;
    for (let level = 0; level < MAX_LEVELS; level++) {
      const comm = new Map(currentNodes.map((id) => [id, id]));
      // 每社区初始度 = 单成员度（社区各自为政起步）。
      const sigma = new Map(currentNodes.map((id) => [id, currentDegree.get(id)!]));
      const moved = refine(currentNodes, currentAdj, currentDegree, comm, sigma, m2, rnd);
      levels.push(comm);
      if (!moved) break;
      const next = aggregate(comm, currentAdj, currentDegree);
      currentNodes = next.nodes;
      currentAdj = next.adj;
      currentDegree = next.degree;
    }
  }

  return finalize(nodes, levels);
}

function sumWeights(neighbors: Map<string, number>): number {
  let s = 0;
  for (const w of neighbors.values()) s += w;
  return s;
}

/**
 * 阶段 1（局部移动）：按 id 序扫节点，把「移入收益 − 留守收益」最大且为正
 * 的邻居社区当作去处；真并列用种子 PRNG 择一。收益公式是 Blondel 原版 ΔQ
 * 剥掉常数因子后的排序等价形：gain(C) = kC − deg·σC/m2（kC = 与 C 的连边
 * 权和、σC = C 内部员度数总和）。BLONDEL 细绳 (2026-09-01 调试实录)：σ 一
 * 律按「i 已虚拟脱离现群」计——留守基线用 σ_from − deg，否则两坨只靠弱桥
 * 相连的超节点也会算出「合并比独活好」的假增益，把一切吸进单社区。
 * 反复整遍直到无人移动或到遍数上限。
 */
function refine(
  nodes: string[],
  adj: Adjacency,
  degree: Map<string, number>,
  comm: Map<string, string>,
  sigma: Map<string, number>,
  m2: number,
  rnd: () => number
): boolean {
  let anyMoved = false;
  for (let pass = 0; pass < MAX_PASSES_PER_LEVEL; pass++) {
    let moved = false;
    for (const n of nodes) {
      const neighbors = adj.get(n)!;
      if (neighbors.size === 0) continue; // 单例无邻可投
      const from = comm.get(n)!;
      const deg = degree.get(n)!;
      const kInto = new Map<string, number>(); // 候选社区 = 有连边的邻居社区
      for (const [nb, w] of neighbors) {
        const c = comm.get(nb)!;
        kInto.set(c, (kInto.get(c) ?? 0) + w);
      }
      const sigmaFromExcl = (sigma.get(from) ?? 0) - deg;
      const stay = (kInto.get(from) ?? 0) - (deg * sigmaFromExcl) / m2;
      let bestGain = stay;
      let winners: string[] = [];
      // Map 键先排序再比，候选枚举序与输入边序无关——确定性第二道钉。
      for (const c of [...kInto.keys()].sort()) {
        if (c === from) continue;
        const gain = kInto.get(c)! - (deg * (sigma.get(c) ?? 0)) / m2;
        if (gain > bestGain + EPS) {
          bestGain = gain;
          winners = [c];
        } else if (Math.abs(gain - bestGain) <= EPS) {
          winners.push(c);
        }
      }
      if (winners.length === 0 || bestGain <= stay + EPS) continue;
      const to = winners[Math.min(winners.length - 1, Math.floor(rnd() * winners.length))]!;
      sigma.set(from, (sigma.get(from) ?? 0) - deg);
      sigma.set(to, (sigma.get(to) ?? 0) + deg);
      comm.set(n, to);
      moved = true;
      anyMoved = true;
    }
    if (!moved) break;
  }
  return anyMoved;
}

/**
 * 阶段 2（聚合）：每社区缩成一个超节点（id = 社区标签），跨社区边权求和、
 * 超节点度 = 成员度总和（含社区内部边的 2×，与标准 Louvain 一致）。
 */
function aggregate(
  comm: Map<string, string>,
  adj: Adjacency,
  degree: Map<string, number>
): { nodes: string[]; adj: Adjacency; degree: Map<string, number> } {
  const labels = [...new Set([...comm.values()])].sort();
  const superAdj: Adjacency = new Map(labels.map((id) => [id, new Map<string, number>()]));
  for (const [n, neighbors] of adj) {
    const cn = comm.get(n)!;
    for (const [nb, w] of neighbors) {
      const cb = comm.get(nb)!;
      if (cn === cb) continue;
      const forward = superAdj.get(cn)!;
      forward.set(cb, (forward.get(cb) ?? 0) + w);
    }
  }
  const superDegree = new Map(labels.map((id) => [id, 0]));
  for (const [n, c] of comm) {
    superDegree.set(c, (superDegree.get(c) ?? 0) + degree.get(n)!);
  }
  return { nodes: labels, adj: superAdj, degree: superDegree };
}

/** 逐层组合归属回到原始节点，按（大小降序 + 最小 id）重编号稳定输出。 */
function finalize(nodes: string[], levels: Map<string, string>[]): Map<string, number> {
  const byCluster = new Map<string, string[]>();
  for (const n of nodes) {
    let label = n;
    for (const level of levels) {
      const next = level.get(label);
      if (next === undefined) break; // 已收敛成终标签
      label = next;
    }
    const list = byCluster.get(label);
    if (list) list.push(n);
    else byCluster.set(label, [n]);
  }
  const ordered = [...byCluster.values()].sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length;
    return a[0]! < b[0]! ? -1 : 1;
  });
  const out = new Map<string, number>();
  ordered.forEach((members, index) => {
    for (const m of members) out.set(m, index);
  });
  return out;
}
