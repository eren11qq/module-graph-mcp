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
  /** AI 评审环三色（border 通道）：绿 全 confident / 黄 有 unsure / 红 有 error。 */
  review: { confident: string; unsure: string; error: string };
  /**
   * 区域化海报板块（graph-areas.ts syncRegionPlates）：fill 自带透明度，
   * border 走虚线，label 为小号大写区名。安静版海报——低对比、不抢球。
   */
  plate: { fill: string; border: string; label: string };
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
  label: '#C9D6EC',
  nodeBorderW: 0,
  nodeBorderColor: 'rgba(0,0,0,0)',
  accent: '#4CC2FF',
  review: { confident: '#00C389', unsure: '#FFD24D', error: '#F85149' },
  plate: {
    fill: 'rgba(92,110,140,0.10)',
    border: 'rgba(92,110,140,0.38)',
    label: 'rgba(201,214,236,0.55)'
  },
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
  label: '#57534E',
  nodeBorderW: 1.4,
  nodeBorderColor: '#FFFFFF',
  accent: '#26221C',
  review: { confident: '#009E73', unsure: '#B45309', error: '#B42318' },
  plate: {
    fill: 'rgba(87,83,78,0.06)',
    border: 'rgba(87,83,78,0.30)',
    label: 'rgba(87,83,78,0.60)'
  },
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
  /** Verdict #1 fcose parameters (randomize:false preserves positions for tickets 04/05). */
  fcose: {
    nodeRepulsion: 7000,
    idealEdgeLength: 62,
    nodeSeparation: 120,
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
   * regionGapX/Y 是区与区包围盒之间的间距,platePad 是板块四边出血,
   * dockCols/Spacing 是孤球坞的确定性网格。
   */
  layout: {
    regionGapX: 120,
    regionGapY: 110,
    platePad: 34,
    dockCols: 3,
    dockSpacingX: 84,
    dockSpacingY: 84
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
  /** Ambient drift stops above this node count (pulse/spring stay on). */
  driftMaxNodes: 600,
  dragVelocityFactor: 0.35,
  dragVelocityMax: 260
} as const;

/** Shell chrome constants the TS side needs (the CSS side lives in styles.css). */
export const CHROME = {
  themeStorageKey: 'mg-theme',
  defaultTheme: 'dark' as ThemeKey,
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

/** Basename without extension — the ball label; hover tooltip carries the full relative path.
 *  A trailing slash (ticket 11 directory balls) is trimmed so the label is the dir name. */
export function shortLabel(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
