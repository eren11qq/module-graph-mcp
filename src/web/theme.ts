import type { TestState } from '../shared/types.js';

/**
 * Visual constants layer — the landing spot for every ticket-00 verdict plus
 * the theme-tokens 定稿 (ticket 03+ theme.html prototype → production).
 *
 * Two themes: dark 暗色仪器盘 (default, brightened Okabe-Ito) and light 亮色
 * 工作台 (paper neutrals, classic Okabe-Ito). The CSS side of each theme lives
 * in styles.css under [data-theme="…"]; THIS file owns the cytoscape-side
 * palette, the motion parameters and the shell chrome constants. All
 * reversible decisions (verdicts §回滚开关) live here; flipping a constant
 * re-skins the page without touching the render engines.
 *
 * The test-state vocabulary (label/severity) lives in test-states.ts; the
 * state COLORS are theme-scoped and live in the palettes below.
 */

export type ThemeKey = 'dark' | 'light';

/**
 * Canvas encoding palette of ONE theme: ball fills, edge/cycle colors, the
 * accent used by the focus ring and the AI-checking edge pulse, and the dim
 * opacities for the non-neighborhood. Everything the cy stylesheet reads.
 */
export interface CyPalette {
  states: Record<TestState, string>;
  edge: { color: string; alpha: number; cycleColor: string; cycleAlpha: number };
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
 * dark 暗色仪器盘 — Okabe-Ito brightened on a deep navy ground: same hue
 * spacing, lifted L so the four states stay colorblind-safe on dark.
 */
const DARK: CyPalette = {
  states: {
    passing: '#00C389',
    failing: '#FF7A45',
    'has-tests-unrun': '#5CC0FF',
    untested: '#5C6E8C'
  },
  edge: { color: '#3D5378', alpha: 0.75, cycleColor: '#FF7A45', cycleAlpha: 0.95 },
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

/** light 亮色工作台 — classic Okabe-Ito on warm paper. */
const LIGHT: CyPalette = {
  states: {
    passing: '#009E73',
    failing: '#D55E00',
    'has-tests-unrun': '#56B4E9',
    untested: '#ADB5BD'
  },
  edge: { color: '#A9A294', alpha: 0.75, cycleColor: '#C2410C', cycleAlpha: 0.95 },
  label: '#44403C',
  nodeBorderW: 1.4,
  nodeBorderColor: '#FFFFFF',
  accent: '#26221C',
  viewing: '#6D28D9',
  review: { confident: '#009E73', unsure: '#B45309', error: '#B42318' },
  plate: {
    label: 'rgba(38,34,28,0.66)'
  },
  scope: { ring: '#7C3AED', fill: '#D8C7F5' },
  canvas: '#F6F4EF',
  dimNode: 0.12,
  dimEdge: 0.05
};

export const CY_PALETTES: Record<ThemeKey, CyPalette> = { dark: DARK, light: LIGHT };

let activeTheme: ThemeKey = 'dark';

/** Switch the active theme (canvas side; the CSS side follows body[data-theme]). */
export function setTheme(key: ThemeKey): void {
  activeTheme = key;
}

export function activeThemeKey(): ThemeKey {
  return activeTheme;
}

/** Palette of the ACTIVE theme — read once per stylesheet build / legend render. */
export function cyPalette(): CyPalette {
  return CY_PALETTES[activeTheme];
}

/** Theme-scoped test-state color (delegates to the active palette). */
export function stateColor(state: TestState): string {
  return CY_PALETTES[activeTheme].states[state];
}

/** Theme-scoped AI review-ring color (delegates to the active palette). */
export function reviewColor(verdict: 'confident' | 'unsure' | 'error'): string {
  return CY_PALETTES[activeTheme].review[verdict];
}

// 2026-08-31 等空隙裁定: 相邻球对的边到边目标空隙(px),唯一手调点。
// 存档在 THEME.layout.spacingGap,fcoseIdealEdgeLength 从这里取值。
// 约束: ≥ 40 —— 漂移最坏接近量 ≈ 10.2 会吃掉空隙(见 layout 注释)。
const SPACING_GAP = 52;
// 非邻接对斥力的基准值与尺寸放大顶格:大球按 (r/minR)² 吃面积,
// 枢纽球(≈3×min)斥力 ×9+,大球与大球之间才顶得出 spacingGap 的空隙。
const REPULSION_BASE = 20000;
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
   * type-error row bar. Theme-scoped: distinct from both themes' fail fill.
   */
  typeError: {
    dark: { color: '#F85149', borderWidth: 3 },
    light: { color: '#B42318', borderWidth: 3 }
  },
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
   * Ticket 11: directory collapse — a directory holding ≥ minFiles direct
   * files folds into one directory-level ball while the toggle is on.
   */
  collapse: {
    minFiles: 3
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
    spacingGap: SPACING_GAP
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
  themeStorageKey: 'mg-theme',
  defaultTheme: 'dark' as ThemeKey,
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
 *  A trailing slash (ticket 11 directory balls) is trimmed so the label is the dir name. */
export function shortLabel(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
