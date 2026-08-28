/**
 * Visual constants layer — the landing spot for every ticket-00 verdict.
 * All reversible decisions (verdicts §回滚开关) live here; flipping a
 * constant re-skins the page without touching the render engines.
 * The test-state vocabulary (color/label/severity) lives in test-states.ts.
 */

export const THEME = {
  /** Verdict #4: uniform 1.5px neutral edges + triangle arrows; cycles dashed vermillion. */
  edge: {
    color: '#94A3B8',
    width: 1.5,
    alpha: 0.75,
    arrowScale: 1.15,
    cycle: {
      color: '#D55E00',
      width: 2.4,
      alpha: 0.95
    },
    highlightColor: '#2563EB'
  },
  /** Verdict #3: r = 7 + √deg × 3.6 (deg clamped to ≥ 1). */
  node: {
    radiusBase: 7,
    radiusSqrtFactor: 3.6,
    labelColor: '#8B949E',
    labelFontSize: 10
  },
  interaction: {
    /** Verdict #5: non-neighborhood dims to α 0.13 on hover. */
    dimOpacity: 0.13,
    wheelSensitivity: 0.22
  },
  /**
   * Ticket 07: type-error badge is its own visual channel — a ring around
   * the ball, independent of the Okabe-Ito state fill (and independent of
   * the focus ring, which wins while a node is locked). Same red the code
   * view and detail panel use for type errors.
   */
  typeError: {
    color: '#f85149',
    borderWidth: 3
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
  }
} as const;

/** Node diameter from total degree: 2 × (7 + √deg × 3.6), deg clamped ≥ 1. */export function diameterOf(deg: number): number {
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
