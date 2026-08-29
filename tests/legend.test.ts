// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { TestState } from '../src/shared/types.js';
import { createLegend, type LegendCounts } from '../src/web/legend.js';

/**
 * The legend is dumb rendering: counts in, rows out; toggles reported to the
 * composition root. The a236598 class of bug (stale legend counts) is now a
 * sink-level property — this suite pins the render surface itself.
 */

function counts(over: Partial<LegendCounts> = {}): LegendCounts {
  return {
    states: { passing: 2, failing: 1, 'has-tests-unrun': 3, untested: 4 },
    reviews: { confident: 1, unsure: 2, error: 3 },
    hiddenStates: new Set<TestState>(),
    hideReviewed: false,
    ...over
  };
}

function harness() {
  const container = document.createElement('div');
  const toggledStates: TestState[] = [];
  let reviewToggles = 0;
  const legend = createLegend(container, {
    onToggleState: (state) => toggledStates.push(state),
    onToggleReviewed: () => reviewToggles++
  });
  return { legend, container, toggledStates, reviewToggles: () => reviewToggles };
}

describe('createLegend — render surface', () => {
  it('renders 4 state rows + review + edge + cycle rows with counts', () => {
    const { legend, container } = harness();
    legend.render(counts());
    const rows = container.querySelectorAll('.legend-row');
    expect(rows).toHaveLength(7);
    expect(container.querySelectorAll('.legend-row[data-state]')).toHaveLength(4);
    const passing = container.querySelector('[data-state="passing"]')!;
    expect(passing.querySelector('.cnt')!.textContent).toBe('2');
    expect(passing.querySelector('.dot')!.style.background).not.toBe('');
    expect(container.querySelector('.review-row')!.querySelectorAll('.dot')).toHaveLength(3);
    const reviewCnts = [...container.querySelectorAll('.review-row .cnt')].map((el) => el.textContent);
    expect(reviewCnts).toEqual(['1', '2', '3']);
    expect(container.textContent).toContain('依赖边（箭头 = 依赖方向）');
    expect(container.textContent).toContain('循环依赖');
  });

  it('marks hidden states and a hidden review ring with the off class', () => {
    const { legend, container } = harness();
    legend.render(counts({ hiddenStates: new Set<TestState>(['untested']), hideReviewed: true }));
    expect(container.querySelector('[data-state="untested"]')!.classList.contains('off')).toBe(true);
    expect(container.querySelector('[data-state="passing"]')!.classList.contains('off')).toBe(false);
    expect(container.querySelector('.review-row')!.classList.contains('off')).toBe(true);
  });

  it('rebuilds cleanly on re-render without duplicating rows', () => {
    const { legend, container } = harness();
    legend.render(counts());
    legend.render(counts({ states: { passing: 0, failing: 0, 'has-tests-unrun': 0, untested: 0 } }));
    expect(container.querySelectorAll('.legend-row')).toHaveLength(7);
    expect(container.querySelector('[data-state="passing"]')!.querySelector('.cnt')!.textContent).toBe('0');
  });
});

describe('createLegend — toggle hooks', () => {
  it('reports state toggles on click and Enter/Space, not on other keys', () => {
    const { legend, container, toggledStates } = harness();
    legend.render(counts());
    const failing = container.querySelector('[data-state="failing"]') as HTMLElement;
    failing.click();
    expect(toggledStates).toEqual(['failing']);
    failing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    failing.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(toggledStates).toEqual(['failing', 'failing', 'failing']);
    failing.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(toggledStates).toHaveLength(3);
  });

  it('reports the review-ring toggle on click', () => {
    const { legend, container, reviewToggles } = harness();
    legend.render(counts());
    (container.querySelector('.review-row') as HTMLElement).click();
    expect(reviewToggles()).toBe(1);
  });
});
