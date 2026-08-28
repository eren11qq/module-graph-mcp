import type { TestState } from '../shared/types.js';

/**
 * Single source of truth for the four-color test-state vocabulary: palette
 * color, dashboard label, legend order and aggregation severity live in one
 * table. Adding a state is one entry here (plus the TestState union in
 * shared/types.ts) — not edits scattered across theme, filters and view.
 */

export const TEST_STATES: Record<TestState, { color: string; label: string; severity: number }> = {
  passing: { color: '#009E73', label: '通过', severity: 0 },
  failing: { color: '#D55E00', label: '失败', severity: 3 },
  'has-tests-unrun': { color: '#56B4E9', label: '有测试未跑', severity: 1 },
  untested: { color: '#ADB5BD', label: '未测', severity: 2 }
};

/** Legend and stylesheet enumeration order (verdict #2 display order). */
export const STATE_ORDER: readonly TestState[] = ['passing', 'failing', 'has-tests-unrun', 'untested'];

export function stateColor(state: TestState): string {
  return TEST_STATES[state].color;
}

export function stateLabel(state: TestState): string {
  return TEST_STATES[state].label;
}
