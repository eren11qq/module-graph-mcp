// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createSourceView } from '../src/web/code-view.js';
import type { AiReview, ModuleNode } from '../src/shared/types.js';

/**
 * Ticket 09/12: per-line source rendering (prototype `.cl` rows). Verdict
 * rows carry the three-color channel, type errors their own left bar, and
 * the two never override each other. The plaintext fallback must still
 * escape rather than inject HTML.
 */

const review = (status: AiReview['status'], verdicts: AiReview['verdicts']): AiReview => ({
  status,
  verdicts,
  reviewedAt: 1
});

const node = (over: Partial<ModuleNode> = {}): ModuleNode => ({
  id: 'a.ts',
  path: 'a.ts',
  language: 'ts',
  testState: 'untested',
  coveredBy: [],
  typeErrors: [],
  ...over
});

describe('source view plaintext fallback (P0-3)', () => {
  it('renders a .txt file without throwing and escapes it via textContent', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => ({ content: 'a <b> & "c"' }));

    await expect(view.show(node({ path: 'README.txt' }))).resolves.toBeUndefined();

    const rows = container.querySelectorAll('.cl');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('.cl-body')!.textContent).toBe('a <b> & "c"');
    // The angle bracket must be TEXT, not an injected element.
    expect(container.querySelector('b')).toBeNull();
  });

  it('still highlights registered languages (.ts), per line', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => ({ content: 'const x: number = 1;\nlet y = 2;' }));

    await view.show(node());

    const rows = container.querySelectorAll('.cl');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('span.hljs-keyword')).not.toBeNull();
    expect(rows[1]!.querySelector('span.hljs-keyword')).not.toBeNull();
  });

  it('loader failure resolves with an error note instead of rejecting', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => {
      throw new Error('ENOENT');
    });

    await expect(view.show(node({ path: 'gone.txt' }))).resolves.toBeUndefined();
    expect(container.querySelector('.code-error-note')?.textContent).toContain('ENOENT');
  });

  it('renders a truncation note when the server clipped an oversize file', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => ({ content: 'const a = 1;', truncated: true }));

    await view.show(node());

    expect(container.querySelector('.code-truncated-note')?.textContent).toContain('已截断');
    expect(container.querySelector('.cl')).not.toBeNull(); // rows still render
  });

  it('no truncation note for a normal load', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => ({ content: 'const a = 1;' }));

    await view.show(node());

    expect(container.querySelector('.code-truncated-note')).toBeNull();
  });
});

describe('AI verdict rows (ticket 12)', () => {
  it('done reviews paint the three-color channel with trailing markers', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => ({
      content: 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;'
    }));

    await view.show(
      node({
        aiReview: review('done', [
          { line: 1, verdict: 'confident' },
          { line: 2, verdict: 'unsure', message: '? 边界待确认' },
          { line: 3, verdict: 'error' }
        ])
      })
    );

    const rows = container.querySelectorAll('.cl');
    expect(rows).toHaveLength(4);

    expect(rows[0]!.classList.contains('v-pass')).toBe(true);
    expect(rows[0]!.querySelector('.mk')).toBeNull(); // confident rows stay clean

    expect(rows[1]!.classList.contains('v-unsure')).toBe(true);
    expect(rows[1]!.querySelector('.mk')?.textContent).toContain('? 边界待确认');

    expect(rows[2]!.classList.contains('v-error')).toBe(true);
    expect(rows[2]!.querySelector('.mk')?.textContent).toContain('✗ 逻辑不符'); // default mark

    expect(rows[3]!.className).toBe('cl'); // unmarked rows stay plain
  });

  it('checking with no verdicts yet renders plain rows', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => ({ content: 'const a = 1;\nconst b = 2;' }));

    await view.show(node({ aiReview: review('checking', []) }));

    for (const row of container.querySelectorAll('.cl')) {
      expect(row.className).toBe('cl');
    }
  });

  it('update_review partials paint during checking, line by line (code-review 2026-08-29)', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => ({ content: 'const a = 1;\nconst b = 2;\nconst c = 3;' }));

    await view.show(node({ aiReview: review('checking', [{ line: 2, verdict: 'error', message: '读错了' }]) }));

    const rows = container.querySelectorAll('.cl');
    expect(rows[0]!.className).toBe('cl');
    expect(rows[1]!.classList.contains('v-error')).toBe(true);
    expect(rows[1]!.querySelector('.mk')?.textContent).toContain('读错了');
    expect(rows[2]!.className).toBe('cl');
  });

  it('type-error bars coexist with verdict rows (two channels, no override)', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => ({ content: 'const a = 1;\nconst b = 2;' }));

    await view.show(
      node({
        typeErrors: [{ line: 1, code: 'TS2322', message: 'x' }],
        aiReview: review('done', [{ line: 1, verdict: 'unsure', message: '检查过' }])
      })
    );

    const row = container.querySelector('.cl')!;
    expect(row.classList.contains('t-err')).toBe(true);
    expect(row.classList.contains('v-unsure')).toBe(true);
    expect(row.querySelector('.mk')?.textContent).toContain('检查过');

    const other = container.querySelectorAll('.cl')[1]!;
    expect(other.classList.contains('t-err')).toBe(false);
  });
});

describe('lazy highlighter boundary (first-paint budget)', () => {
  it('a plaintext view never touches the lazy highlight chunk', async () => {
    let touched = false;
    vi.resetModules();
    vi.doMock('../src/web/highlight-setup.js', () => {
      touched = true;
      return { default: { highlight: () => ({ value: '' }) } };
    });
    try {
      const { createSourceView: create } = await import('../src/web/code-view.js');
      const container = document.createElement('div');
      const view = create(container, async () => ({ content: 'README text' }));
      await view.show(node({ path: 'README.txt' }));
      expect(container.querySelector('.cl-body')?.textContent).toBe('README text');
      expect(touched).toBe(false);
    } finally {
      vi.doUnmock('../src/web/highlight-setup.js');
    }
  });

  it('rows degrade to escaped plaintext when the lazy chunk fails to load', async () => {
    vi.resetModules();
    vi.doMock('../src/web/highlight-setup.js', () => {
      throw new Error('chunk load failed');
    });
    try {
      const { createSourceView: create } = await import('../src/web/code-view.js');
      const container = document.createElement('div');
      const view = create(container, async () => ({ content: 'const x = 1; <b>' }));
      // show() must resolve — the failure is degraded, not thrown.
      await expect(view.show(node())).resolves.toBeUndefined();
      const body = container.querySelector('.cl-body')!;
      expect(body.textContent).toBe('const x = 1; <b>');
      expect(container.querySelector('b')).toBeNull(); // escaped, not injected
    } finally {
      vi.doUnmock('../src/web/highlight-setup.js');
    }
  });
});
