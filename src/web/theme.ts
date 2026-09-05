import type { TestState } from '../shared/types.js';

/**
 * Visual constants layer — the landing spot for every ticket-00 verdict plus
 * the theme-tokens 定稿 (ticket 03+ theme.html prototype → production).
 *
 * Single theme: dark 暗色仪器盘. 架构评审第二轮 #5 (2026-09-05) 删除了 light
 * 亮色工作台 —— 双主题时代同一个色在 theme.ts 与 styles.css 各存一份、测试
 * 从不交叉,漂移无人报警;等值钉见 tests/theme-palette.test.ts。CSS 侧住在
 * styles.css 的 [data-theme="dark"] 块(外壳保留:将来若加回第二主题,色板 +
 * CSS 块 + 切换钮三件套按等值钉补齐即可);THIS file owns the cytoscape-side
 * palette, the motion parameters and the shell chrome constants. All
 * reversible decisions (verdicts §回滚开关) live here; flipping a constant
 * re-skins the page without touching the render engines.
 *
 * The test-state vocabulary (label/severity) lives in test-states.ts; the
 * state COLORS live in the palette below.
 */

/**
 * Canvas encoding palette — ball fills, edge/cycle colors, the accent used by
 * the focus ring and the AI-checking edge pulse, and the dim opacities for the
 * non-neighborhood. Everything the cy stylesheet reads.
 */
export interface CyPalette {
  states: Record<TestState, string>;
  edge: {
    color: string;
    alpha: number;
    cycleColor: string;
    cycleAlpha: number;
  };
  label: string;
  nodeBorderW: number;
  nodeBorderColor: string;
  /** Focus ring / checking ring / pulse overlay color. */
  accent: string;
  /**
   * Code-review 2026-08-29: module-activity viewing pulse (the agent READ the
   * module). Violet — distinct from the sky accent (checking) and from every
   * state fill, so "在看" and "在检查" never read as the same event.
   */
  viewing: string;
  /** AI 评审环三色（border 通道）：绿 全 confident / 黄 有 unsure / 红 有 error。 */
  review: { confident: string; unsure: string; error: string };
  /**
   * 区域题注（graph-areas.ts syncRegionPlates）：每堆小球合集上方的一个
   * 名字（「WEB · 16」），无底板无边框——背景材料按 2026-08-29 用户裁定
   * 整体移除，区域感只靠题注 + 罗盘位置表达。颜色从地面 ink 派生。
   */
  plate: { label: string };
  /**
   * ADR 0002 §7.2 改动标记（border/background 通道）：范围内 = 紫环常驻
   * 描边（与 viewing 紫脉冲——瞬时 3s——区分）；已改 = 整球紫填充。
   */
  scope: { ring: string; fill: string };
  /** 画布地面色（styles.css --bg 的 cy 侧镜像）：球标衬底的取色处。 */
  canvas: string;
  dimNode: number;
  dimEdge: number;
}

/**
 * 暗色仪器盘 — Okabe-Ito brightened on a deep navy ground: same hue spacing,
 * lifted L so the four states stay colorblind-safe on dark. 色值与 styles.css
 * 的 [data-theme="dark"] token 由 tests/theme-palette.test.ts 等值钉锁死。
 */
export const CY_PALETTE: CyPalette = {
  states: {
    passing: '#00C389',
    failing: '#FF7A45',
    'has-tests-unrun': '#5CC0FF',
    untested: '#5C6E8C'
  },
  edge: {
    color: '#3D5378',
    alpha: 0.75,
    cycleColor: '#FF7A45',
    cycleAlpha: 0.95
  },
  label: '#E7EEF9',
  nodeBorderW: 0,
  nodeBorderColor: 'rgba(0,0,0,0)',
  accent: '#4CC2FF',
  viewing: '#B18CFF',
  review: { confident: '#00C389', unsure: '#FFD24D', error: '#F85149' },
  plate: {
    label: 'rgba(231,238,249,0.7)'
  },
  scope: { ring: '#A78BFA', fill: '#5B3FA8' },
  canvas: '#0A0F1C',
  dimNode: 0.12,
  dimEdge: 0.05
};

/** The palette — read once per stylesheet build / legend render. */
export function cyPalette(): CyPalette {
  return CY_PALETTE;
}

/** Test-state color (reads the single palette). */
export function stateColor(state: TestState): string {
  return CY_PALETTE.states[state];
}

/** AI review-ring color (reads the single palette). */
export function reviewColor(verdict: 'confident' | 'unsure' | 'error'): string {
  return CY_PALETTE.review[verdict];
}

// 2026-08-31 等空隙裁定: 相邻球对的边到边目标空隙(px),唯一手调点。
// 存档在 THEME.layout.spacingGap,fcoseIdealEdgeLength 从这里取值。
// 约束: ≥ 40 —— 漂移最坏接近量 ≈ 10.2 会吃掉空隙(见 layout 注释)。
const SPACING_GAP = 52;
// 非邻接对斥力的基准值与尺寸放大顶格:大球按 (r/minR)² 吃面积,
// 枢纽球(≈3×min)斥力 ×9+,大球与大球之间才顶得出 spacingGap 的空隙。
// 2026-09-01 用户裁定: 20000→40000(×2),加大非邻接球对的排布间距——
// fit:true 等比缩小让整图球/字略小的权衡已知(硬间距另有全局分离通道兜底)。
const REPULSION_BASE = 40000;
const REPULSION_SIZE_CAP = 16;

export const THEME = {
  /** Verdict #4: uniform 1.5px neutral edges + triangle arrows; cycles dashed vermillion. */
  edge: {
    width: 1.5,
    arrowScale: 1.15,
    cycleWidth: 2.4
  },
  /** Verdict #3: r = 7 + √deg × 3.6 (deg clamped to ≥ 1). */
  node: {
    radiusBase: 7,
    radiusSqrtFactor: 3.6,
    labelFontSize: 10
  },
  interaction: {
    wheelSensitivity: 0.22,
    /** Zoom clamp: a filtered single-ball fit must not blow the ball up to fill the canvas. */
    maxZoom: 2.5,
    minZoom: 0.05
  },
  /**
   * Ticket 07: type-error badge is its own visual channel — a ring around
   * the ball, independent of the state fill (and of the focus ring, which
   * wins while a node is locked). Same color the code view uses for the
   * type-error row bar (--type-error); distinct from the fail fill.
   */
  typeError: { color: '#F85149', borderWidth: 3 },
  /**
   * Code-review 2026-08-29: AI 评审环。最初走 underlay 通道，实测渲染的是
   * 圆角方形而非正圆，改为 border 通道 —— 环随节点是正圆。声明顺序在
   * type-error 环之后（评审结论赢、type-error 让位）、聚焦环之前；checking
   * 亮边与 overlay 脉冲各占各的通道，互不覆盖。
   */
  reviewRing: {
    width: 3
  },
  /**
   * Verdict #1 fcose parameters (randomize:false preserves positions for
   * tickets 04/05). 2026-08-29 区域化裁定后调松堆内密度: repulsion ×1.5 +
   * 理想边长 ×1.26 —— 球堆内更散,区域罗盘槽位不受影响(平移后处理兜底)。
   * 2026-08-30 用户裁定:四力不可调,滑杆通道整体拆除,这里是唯一事实源。
   * 2026-08-31 等空隙裁定: idealEdgeLength 改为函数形式(布局存档同步升代)
   * —— 相邻球边到边空隙一律 spacingGap(对角挤贴量按半径补偿,见
   * uniformIdealEdgeLength);elasticity↑ gravity↓ —— 边缘链条不再被拉长。
   * 2026-08-31 二次裁定(大球之间也要保持距离): fcose 的 spring/repulsion
   * 都按包围盒边到边计量,nodeSeparation 只在 spectral 初始位参与、不限力 ——
   * 非邻接大球对的空隙唯一可用通道是节点级 nodeRepulsion 函数:按 (r/minR)²
   * 放大(顶格 16×),小球对维持基准、观感不变,枢纽对斥力 ×9+ 顶出空隙。
   * 跨区线仍由 regionGapX/Y 罗盘槽位决定,不在等长化范围。
   */
  fcose: {
    gravity: 0.25,
    nodeRepulsion: fcoseNodeRepulsion,
    edgeElasticity: 0.7,
    idealEdgeLength: fcoseIdealEdgeLength,
    nodeSeparation: 150,
    packComponents: true,
    randomize: false
  },
  canvas: {
    padding: 30
  },
  /**
   * 区域化海报(2026-08-29)compass geometry — graph-areas.ts 是唯一消费者:
   * regionGapX/Y 是区与区包围盒之间的间距;captionGap 是题注悬在堆顶边上
   * 方的高度。背景底板已按用户裁定移除,不再有板块出血/网格之外的概念。
   * Code-review 2026-08-29: ballGap 是同区域内相邻小球边到边的保底间距
   * (用户裁定 32):漂移最坏接近量 2×driftAmpMax×√2 ≈ 10.2 ≪ 32,静止与
   * 漂移中都留得出空隙;代价是区域包围盒变大、fit() 后整图略缩一档。
   * Code-review 2026-08-31: spacingGap 是簇内力布局(堆内边)的边到边目标
   * 空隙——fcose 函数式 idealEdgeLength = spacingGap + r1 + r2 的唯一手调
   * 点。必须 ≥ 40:漂移最坏接近量同上 ≈ 10.2,太小会被漂移吃掉。与
   * separateTouching(ballGap=32) 的保底推离是独立通道,正交不互替。
   */
  layout: {
    regionGapX: 120,
    regionGapY: 110,
    captionGap: 18,
    dockCols: 3,
    dockSpacingX: 84,
    dockSpacingY: 84,
    ballGap: 32,
    spacingGap: SPACING_GAP,
    /**
     * 聚类排列模式（ADR 0004）螺旋地盘几何 — layout-cluster.ts 唯一消费者。
     * GitNexus 原式的黄金角螺旋极角序：angle = i·goldenAngle。2026-09-01
     * 海报质量修正 (D4)：spiralScale 语义从「等面积环带缩放」降为**半径下限**
     * ——每簇按需求半径线性外扩直到满足领地间距约束，聚类多了不再向内填充。
     * 缩放依据：GitNexus 球小、理想边长 ≈40px，spiralScale 取 40·0.8；
     * 我们的球径更大且 GitNexus 的小球标定在本仓库失效（首版整图挤成一坨），
     * 下限取 32 起步（观感定值，改它只动排布半径）。
     * jitterScale 是成员出生抖动幅度系数（×√聚类人数），3px 起、贴边由
     * separateAllBalls(ballGap) 兜底。goldenAngle = π(3−√5) 常数钉死。
     *
     * 领地标定四常数（2026-09-01 D4/D2 标定，依据=球的实际面积）：
     * - looseFactor 1.5：簇需求半径 R = √(Σ成员半径²)×1.5 的松置系数——
     *   √(Σr²) 是等面积密铺下限，fcose 软排布+抖动出生后留 50% 余量。
     * - pairGapFactor 1.4 / minClusterGap 64：簇心距下限
     *   max((Ri+Rj)×1.4, Ri+Rj+64)——系数项让大簇留白随面积涨，下限项
     *   兜住小簇（R≈30 时 1.4 系数只给 24px 间隙，肉眼粘连）。
     * - territoryStep 8：外扩步进 px。过大图先观测再调小（纯常数）。
     * - fcose：聚类分支的求解覆盖（D1）——只加宽弹簧约束收紧全局拉力，
     *   regions 分支不读（THEME.fcose 共享对象一字不动）。numIter 600 是
     *   fcose 默认 2500 的 24%：出生点已是好种子，迭代砍 4 倍换簇形紧凑；
     *   gravity 1.2 是共享值 0.25 的 ~5×：防成员被跨簇弱边拽出门禁区。
     */
    cluster: {
      spiralScale: 32,
      jitterScale: 3,
      goldenAngle: 2.399963229728653,
      looseFactor: 1.5,
      pairGapFactor: 1.4,
      minClusterGap: 64,
      territoryStep: 8,
      fcose: {
        numIter: 600,
        gravity: 1.2
      }
    }
  },
  /**
   * 球上标签节流（2026-09-01 D5）：视口内球数 > viewportMax 时只给度数
   * 前 hubCount 的球上标签（.focused 球走 CSS 并行通道永远有）；≤ viewportMax
   * 全开。hover 信息不受影响（tooltip 通道独立于球上标签）。
   */
  labels: {
    hubCount: 24,
    viewportMax: 40
  },
  /**
   * 区域化海报 visual channels: tests 带的球整体缩一档、跨区线一律细+淡
   * (枢纽地位由节点尺寸+脊柱居中表达,不用线的音量表达)。每件事只让一个
   * 机制干:位置讲区、尺寸讲枢纽、线型讲区内/跨区。
   */
  areas: {
    testsScale: 0.85,
    crossEdgeWidth: 0.8,
    crossEdgeAlpha: 0.22
  }
} as const;

/**
 * Motion parameters (prototype theme.html §物理/动效): three physics layers —
 * ambient drift, release spring-back, hover pop — plus the AI-checking edge
 * pulse. Everything degrades under prefers-reduced-motion.
 */
export const MOTION = {
  /** Ambient drift amplitude range (px) per axis, per node. */
  driftAmpMin: 2,
  driftAmpMax: 3.6,
  /** Underdamped release spring: one-to-two wobble then settle. */
  springK: 60,
  springC: 6.5,
  hoverPopMult: 1.16,
  neighborPopMult: 1.06,
  popDurationMs: 170,
  /**
   * AI checking pulse: overlay-opacity oscillation ≈1.2 Hz (prototype's
   * sin(now/130) → 2π×130ms ≈ 817ms). Reduced motion pins a static overlay.
   */
  checkingPulsePeriodMs: 820,
  checkingPulseMin: 0.1,
  checkingPulseMax: 0.26,
  /**
   * Code-review 2026-08-29: module-activity viewing pulse — calmer and
   * shallower than the checking pulse (a read is less urgent than a review).
   * The class itself expires after viewingPulseMs (graph-view.pulseViewing).
   */
  viewingPulseMs: 3000,
  viewingPulsePeriodMs: 1200,
  viewingPulseMin: 0.06,
  viewingPulseMax: 0.18,
  /** Ambient drift stops above this node count (pulse/spring stay on). */
  driftMaxNodes: 600,
  dragVelocityFactor: 0.35,
  dragVelocityMax: 260
} as const;

/** Shell chrome constants the TS side needs (the CSS side lives in styles.css). */
export const CHROME = {
  /**
   * Code-review 2026-08-29: layout archive (layout-store.ts) — last-stable
   * positions keyed by rootPath, one JSON file under a single key.
   */
  layoutStorageKey: 'mg-layout',
  /** Entrance choreography replay window (body.enter). */
  entranceTotalMs: 1400,
  /** Statusbar event ticker dims back after this long. */
  eventDimMs: 2600,
  /** WS reconnect delay. */
  wsRetryMs: 3000
} as const;

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Node diameter from total degree: 2 × (7 + √deg × 3.6), deg clamped ≥ 1. */
export function diameterOf(deg: number): number {
  const clamped = Math.max(1, deg);
  return 2 * (THEME.node.radiusBase + Math.sqrt(clamped) * THEME.node.radiusSqrtFactor);
}

// 2026-08-31 等空隙: 缺失/异常半径的夹紧下限 = 最小真实球(deg=1)的半径。
// 定义在 THEME 之后 —— diameterOf 读取 THEME.node,THEME 求值期间不可调用。
const MIN_BALL_RADIUS = diameterOf(1) / 2;

/**
 * 等空隙理想边长(纯函数): 相邻球边到边空隙一律 ≥ gap —— 理想边长
 * = gap + r1 + r2(fcose 的 spring 已按包围盒边到边计量,半径项是对
 * 对角布置下方框 clips 低估圆面间距的补偿,竖直/水平方向即富余档)。
 * 半径缺失/非有限(0、NaN、负)一律夹到最小球半径。
 */
export function uniformIdealEdgeLength(gap: number, r1: number, r2: number): number {
  const floorRadius = (r: number): number =>
    Number.isFinite(r) ? Math.max(MIN_BALL_RADIUS, r) : MIN_BALL_RADIUS;
  return gap + floorRadius(r1) + floorRadius(r2);
}

/**
 * fcose 函数式 idealEdgeLength: 入参是 edge 对象,两端半径取自 nodeElement
 * 写入的 data('diameter')/2(与 physics.ts 同源,勿重算公式)。孤立对(无边)
 * 不受它管,由尺寸感知的 nodeRepulsion 兜底。
 */
function fcoseIdealEdgeLength(edge: cytoscape.EdgeSingular): number {
  return uniformIdealEdgeLength(
    SPACING_GAP,
    Number(edge.source().data('diameter')) / 2,
    Number(edge.target().data('diameter')) / 2
  );
}

/**
 * 聚类分支的等空隙理想边长(纯函数, 2026-09-01 D2): = ballGap(32) + 两端半径。
 * 不能沿用共享版 spacingGap(52)——簇内目标 73px 中心距直接顶爆「成员球心到
 * 簇心 ≤ R_i + 2×平均球半径」验收(海报要的是团,不是等距点阵)。球对硬间距
 * 仍由 separateAllBalls(ballGap) 兜底,弹簧只负责把簇内收拢。
 */
export function clusterIdealEdgeLength(edge: cytoscape.EdgeSingular): number {
  return uniformIdealEdgeLength(
    THEME.layout.ballGap,
    Number(edge.source().data('diameter')) / 2,
    Number(edge.target().data('diameter')) / 2
  );
}

/**
 * 聚类分支的 fcose 覆盖参数(D1): graph-view 聚类路径与测试管线共用的唯一
 * 事实源。只出 numIter/gravity/idealEdgeLength 三键,其余力参数随 THEME.fcose。
 */
export function clusterFcoseOverrides(): {
  numIter: number;
  gravity: number;
  idealEdgeLength: (edge: cytoscape.EdgeSingular) => number;
} {
  return {
    numIter: THEME.layout.cluster.fcose.numIter,
    gravity: THEME.layout.cluster.fcose.gravity,
    idealEdgeLength: clusterIdealEdgeLength
  };
}

/**
 * 尺寸感知斥力(纯函数): 大球与大球(邻接与否都算)之间要顶出空隙,斥力
 * 必须随球面积走 —— base × min(cap, (r/minR)²)。半径 ≥ minR,缺失/非有限
 * 夹到 minR(=×1,小球对观感与旧常数一致);枢纽球对(≈3×minR)≈ ×9。
 */
export function sizeAwareRepulsion(base: number, radius: number): number {
  const r = Number.isFinite(radius) ? Math.max(MIN_BALL_RADIUS, radius) : MIN_BALL_RADIUS;
  const boost = Math.min(REPULSION_SIZE_CAP, (r / MIN_BALL_RADIUS) ** 2);
  return base * boost;
}

/**
 * fcose 函数式 nodeRepulsion(节点级,成对取两端均值): 入参是 node 对象,
 * 半径同样取 data('diameter')/2 单一口径。
 */
function fcoseNodeRepulsion(node: cytoscape.NodeSingular): number {
  return sizeAwareRepulsion(REPULSION_BASE, Number(node.data('diameter')) / 2);
}

/** Basename without extension — the ball label; hover tooltip carries the full relative path.
 *  （尾斜杠目录球分支随 ticket 11 目录折叠于 ADR 0002/0003 退役,#6 清扫。） */
export function shortLabel(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
