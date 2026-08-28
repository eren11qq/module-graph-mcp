import type { TestState } from '../shared/types.js';
import { STATE_ORDER, stateLabel } from './test-states.js';
import { CHROME } from './theme.js';

/**
 * Statusbar (the prototype's signature element): node/edge/cycle counts on
 * the left, the four-color coverage band in the middle, and the event ticker
 * on the right. bandWeights/passRatePct are pure and covered by tests; the
 * DOM half is a thin renderer over them.
 */

export interface BandSegment {
  state: TestState;
  /** flex-grow weight — a zero count renders zero width. */
  weight: number;
}

/** Pure: coverage-band flex weights in display order; zero counts stay zero. */
export function bandWeights(counts: Record<TestState, number>): BandSegment[] {
  return STATE_ORDER.map((state) => ({ state, weight: Math.max(0, counts[state] ?? 0) }));
}

/** Pure: pass-rate percentage of the band (0 for an empty graph). */
export function passRatePct(counts: Record<TestState, number>): number {
  const total = STATE_ORDER.reduce((sum, s) => sum + Math.max(0, counts[s] ?? 0), 0);
  if (total === 0) return 0;
  return Math.round((Math.max(0, counts.passing ?? 0) / total) * 100);
}

export interface StatusbarElements {
  sbLeft: HTMLElement;
  band: HTMLElement;
  bandCap: HTMLElement;
  evt: HTMLElement;
}

export interface Statusbar {
  setCounts(nodes: number, edges: number, cycles: number, rootPath: string): void;
  /** Re-render the coverage band from per-state counts over the full graph. */
  setBand(counts: Record<TestState, number>): void;
  /** Flash one line of text in the event ticker; dims back automatically. */
  flashEvent(text: string): void;
}

export function createStatusbar(els: StatusbarElements): Statusbar {
  let dimTimer: ReturnType<typeof setTimeout> | null = null;

  function setCounts(nodes: number, edges: number, cycles: number, rootPath: string): void {
    els.sbLeft.replaceChildren();
    const parts: Array<[string, string, boolean]> = [
      [String(nodes), ' 节点', false],
      [String(edges), ' 边', false],
      [String(cycles), ' 循环依赖', cycles > 0]
    ];
    for (const [num, label, warn] of parts) {
      const span = document.createElement('span');
      if (warn) span.className = 'cyc';
      const b = document.createElement('b');
      b.textContent = num;
      span.append(b, document.createTextNode(label));
      els.sbLeft.append(span);
    }
    const root = document.createElement('span');
    root.className = 'sb-root';
    root.textContent = `根 ${rootPath}`;
    root.title = rootPath;
    els.sbLeft.append(root);
  }

  function setBand(counts: Record<TestState, number>): void {
    els.band.replaceChildren();
    for (const seg of bandWeights(counts)) {
      if (seg.weight === 0) continue;
      const span = document.createElement('span');
      span.className = `s-${seg.state}`;
      span.style.flexGrow = String(seg.weight);
      span.title = `${stateLabel(seg.state)} ${seg.weight}`;
      els.band.append(span);
    }
    els.bandCap.replaceChildren();
    const cap = document.createElement('span');
    cap.textContent = '通过率 ';
    const b = document.createElement('b');
    b.textContent = `${passRatePct(counts)}%`;
    els.bandCap.append(cap, b);
  }

  function flashEvent(text: string): void {
    els.evt.textContent = text;
    els.evt.classList.remove('dim');
    if (dimTimer !== null) clearTimeout(dimTimer);
    dimTimer = setTimeout(() => els.evt.classList.add('dim'), CHROME.eventDimMs);
  }

  return { setCounts, setBand, flashEvent };
}
