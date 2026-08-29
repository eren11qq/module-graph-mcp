// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createDetailPanel } from '../src/web/detail-panel.js';
import { reviewColor } from '../src/web/theme.js';
import type { ModuleNode } from '../src/shared/types.js';

/**
 * Code-review 2026-08-29: the meta row's AI badge — one glance tells whether
 * a module is being / has been AI-reviewed. The badge colors reuse the
 * review-ring palette (worst verdict) so panel and graph never disagree.
 */

const node = (over: Partial<ModuleNode> = {}): ModuleNode => ({
  id: 'a.ts',
  path: 'src/a.ts',
  language: 'ts',
  testState: 'untested',
  coveredBy: [],
  typeErrors: [],
  ...over
});

const ctx = { outgoing: [], incoming: [], onJump: () => {} };
const loader = async () => ({ content: 'export const a = 1;\n' });

describe('detail panel AI badge (code-review 2026-08-29)', () => {
  it('no badge for a module that was never AI-reviewed', () => {
    const container = document.createElement('div');
    createDetailPanel(container, loader).show(node(), ctx);
    expect(container.querySelector('.ai-badge')).toBeNull();
  });

  it('checking review shows AI 检查中, placed between the state badge and the degrees', () => {
    const container = document.createElement('div');
    createDetailPanel(container, loader).show(
      node({ aiReview: { status: 'checking', verdicts: [] } }),
      ctx
    );

    const meta = container.querySelector('.detail-meta')!;
    const ai = meta.querySelector('.ai-badge')!;
    expect(ai.textContent).toBe('AI 检查中');
    expect(meta.children[0]!.className).toBe('detail-badge'); // state badge
    expect(meta.children[1]).toBe(ai);
    expect(meta.children[2]!.className).toBe('detail-degrees');
    expect((ai as HTMLElement).style.color).toContain('var(--accent)');
  });

  it('done review shows AI 已检查 colored by the worst verdict', () => {
    const container = document.createElement('div');
    createDetailPanel(container, loader).show(
      node({
        aiReview: {
          status: 'done',
          verdicts: [
            { line: 1, verdict: 'confident' },
            { line: 2, verdict: 'error' }
          ],
          reviewedAt: 1
        }
      }),
      ctx
    );

    const ai = container.querySelector('.ai-badge')! as HTMLElement;
    expect(ai.textContent).toBe('AI 已检查');
    expect(ai.style.color).toBe(reviewColor('error'));
    expect(ai.style.borderColor).toBe(reviewColor('error'));
  });

  it('a clean review colors the badge with the confident tone', () => {
    const container = document.createElement('div');
    createDetailPanel(container, loader).show(
      node({ aiReview: { status: 'done', verdicts: [], reviewedAt: 1 } }),
      ctx
    );
    const ai = container.querySelector('.ai-badge')! as HTMLElement;
    expect(ai.style.color).toBe(reviewColor('confident'));
  });
});
