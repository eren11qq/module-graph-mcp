import type { TestState } from '../shared/types.js';
import { STATE_ORDER, stateColor, stateLabel } from './test-states.js';
import { reviewColor } from './theme.js';

/**
 * The legend: the state vocabulary's display surface AND a filter (click a
 * row to hide/show that state; the review-ring row hides reviewed nodes).
 * Dumb rendering — it owns no state, only paint. Counts arrive computed;
 * toggles are reported to the composition root, which owns the filter knobs
 * and the view-state funnel.
 */

export interface LegendCounts {
  states: Record<TestState, number>;
  reviews: Record<'confident' | 'unsure' | 'error', number>;
  hiddenStates: ReadonlySet<TestState>;
  hideReviewed: boolean;
}

export interface LegendHooks {
  onToggleState(state: TestState): void;
  onToggleReviewed(): void;
}

export interface Legend {
  render(counts: LegendCounts): void;
}

export function createLegend(container: HTMLElement, hooks: LegendHooks): Legend {
  /** Click + Enter/Space activation for a button-ish legend row. */
  function activate(row: HTMLDivElement, toggle: () => void): void {
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        toggle();
      }
    });
  }

  function render(counts: LegendCounts): void {
    container.replaceChildren();

    for (const state of STATE_ORDER) {
      const row = document.createElement('div');
      row.className = 'legend-row' + (counts.hiddenStates.has(state) ? ' off' : '');
      row.dataset.state = state;
      row.setAttribute('role', 'button');
      row.tabIndex = 0;

      const swatch = document.createElement('span');
      swatch.className = 'dot';
      swatch.style.background = stateColor(state);
      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = stateLabel(state);
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = String(counts.states[state]);

      activate(row, () => hooks.onToggleState(state));
      row.append(swatch, label, cnt);
      container.append(row);
    }

    const edgeRow = document.createElement('div');
    edgeRow.className = 'legend-row edge-row';
    edgeRow.style.marginTop = '8px';
    const line = document.createElement('span');
    line.className = 'legend-line';
    const edgeLabel = document.createElement('span');
    edgeLabel.textContent = '依赖边（箭头 = 依赖方向）';
    edgeRow.append(line, edgeLabel);

    const cycleRow = document.createElement('div');
    cycleRow.className = 'legend-row edge-row';
    const cycleLine = document.createElement('span');
    cycleLine.className = 'legend-line dashed';
    const cycleLabel = document.createElement('span');
    cycleLabel.textContent = '循环依赖';
    cycleRow.append(cycleLine, cycleLabel);

    // 评审环行：三色小样本 + 各档计数，点击隐藏/显示已评审节点。
    const reviewRow = document.createElement('div');
    reviewRow.className = 'legend-row review-row' + (counts.hideReviewed ? ' off' : '');
    reviewRow.setAttribute('role', 'button');
    reviewRow.tabIndex = 0;
    for (const verdict of ['confident', 'unsure', 'error'] as const) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = reviewColor(verdict);
      dot.title = `评审环 ${verdict}`;
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = String(counts.reviews[verdict]);
      reviewRow.append(dot, cnt);
    }
    const reviewLabel = document.createElement('span');
    reviewLabel.className = 'name';
    reviewLabel.textContent = 'AI 评审环';
    reviewRow.append(reviewLabel);
    activate(reviewRow, () => hooks.onToggleReviewed());

    container.append(reviewRow, edgeRow, cycleRow);
  }

  return { render };
}
