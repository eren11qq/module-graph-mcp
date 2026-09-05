import type { TestState } from '../shared/types.js';
import { stateColor } from './theme.js';

/**
 * Single source of truth for the four-color test-state vocabulary: dashboard
 * label, legend order and aggregation severity live in one table. The COLORS
 * live in theme.ts's CY_PALETTE (single theme since review #5); this module
 * re-exports them. Adding a state is one entry here (plus the TestState union
 * in shared/types.ts and the palette entry in theme.ts + its CSS twin, which
 * the equality pin in tests/theme-palette.test.ts keeps in lockstep).
 */

export const TEST_STATES: Record<TestState, { label: string; severity: number }> = {
  passing: { label: '通过', severity: 0 },
  failing: { label: '失败', severity: 3 },
  'has-tests-unrun': { label: '有测试未跑', severity: 1 },
  untested: { label: '未测', severity: 2 }
};

/** Legend and stylesheet enumeration order (verdict #2 display order). */
export const STATE_ORDER: readonly TestState[] = ['passing', 'failing', 'has-tests-unrun', 'untested'];

export { stateColor };

export function stateLabel(state: TestState): string {
  return TEST_STATES[state].label;
}
