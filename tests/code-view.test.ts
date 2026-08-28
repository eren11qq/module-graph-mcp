// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createSourceView } from '../src/web/code-view.js';

/**
 * P0-3 acceptance: a `.txt` file (inside the source-reader whitelist) used to
 * crash show() — `languageOf` fell back to the unregistered 'plaintext' and
 * hljs.highlight threw "Unknown language". It must now render as escaped
 * plain text without throwing.
 */
describe('source view plaintext fallback (P0-3)', () => {
  it('renders a .txt file without throwing and escapes it via textContent', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => ({ content: 'a <b> & "c"' }));

    await expect(view.show({ path: 'README.txt', typeErrors: [] })).resolves.toBeUndefined();

    const code = container.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('a <b> & "c"');
    expect(code?.innerHTML).not.toContain('<b>');
  });

  it('still highlights registered languages (.ts) as before', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => ({ content: 'const x: number = 1;' }));

    await view.show({ path: 'a.ts', typeErrors: [] });

    const code = container.querySelector('pre.code-pre.language-typescript code');
    expect(code?.querySelector('span.hljs-keyword')).not.toBeNull();
  });

  it('loader failure resolves with an error note instead of rejecting', async () => {
    const container = document.createElement('div');
    const view = createSourceView(container, async () => {
      throw new Error('ENOENT');
    });

    await expect(view.show({ path: 'gone.txt', typeErrors: [] })).resolves.toBeUndefined();
    expect(container.querySelector('.code-error-note')?.textContent).toContain('ENOENT');
  });
});
