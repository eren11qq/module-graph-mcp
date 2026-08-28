import { describe, expect, it } from 'vitest';
import { bandWeights, passRatePct } from '../src/web/statusbar.js';
import { STATE_ORDER } from '../src/web/test-states.js';
import type { TestState } from '../src/shared/types.js';

/**
 * The statusbar's signature element (theme.html 定稿): the four-color
 * coverage band. Weights and the pass-rate caption are pure functions, so
 * they're tested at that seam.
 */

const counts = (over: Partial<Record<TestState, number>> = {}): Record<TestState, number> => ({
  passing: 0,
  failing: 0,
  'has-tests-unrun': 0,
  untested: 0,
  ...over
});

describe('bandWeights — 覆盖率比例带权重 (ticket 12 theme shell)', () => {
  it('emits segments in display order with weight = count', () => {
    const w = bandWeights(counts({ passing: 6, failing: 2, 'has-tests-unrun': 1, untested: 3 }));
    expect(w.map((s) => s.state)).toEqual([...STATE_ORDER]);
    expect(w.map((s) => s.weight)).toEqual([6, 2, 1, 3]);
  });

  it('keeps zero counts at weight zero (the segment renders no width)', () => {
    const w = bandWeights(counts({ passing: 4 }));
    expect(w.find((s) => s.state === 'passing')!.weight).toBe(4);
    for (const state of ['failing', 'has-tests-unrun', 'untested'] as const) {
      expect(w.find((s) => s.state === state)!.weight).toBe(0);
    }
  });

  it('treats negative counts as zero (bad input never bends the band)', () => {
    const w = bandWeights(counts({ passing: -5, failing: 2 }));
    expect(w.find((s) => s.state === 'passing')!.weight).toBe(0);
    expect(w.find((s) => s.state === 'failing')!.weight).toBe(2);
  });
});

describe('passRatePct — 通过率标注', () => {
  it('is the passing share of all four states, rounded', () => {
    expect(passRatePct(counts({ passing: 6, failing: 2, 'has-tests-unrun': 1, untested: 3 }))).toBe(50);
    expect(passRatePct(counts({ passing: 1, failing: 2, untested: 1 }))).toBe(25);
    expect(passRatePct(counts({ passing: 3 }))).toBe(100);
  });

  it('is 0 for an empty or all-negative graph', () => {
    expect(passRatePct(counts())).toBe(0);
    expect(passRatePct(counts({ passing: -1 }))).toBe(0);
  });
});
