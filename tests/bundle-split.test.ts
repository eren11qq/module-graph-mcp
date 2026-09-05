import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * First-paint budget, asserted against the BUILD ARTIFACT (same philosophy
 * as the evals maxBytes gate: the budget is enforced in CI, not remembered
 * by hand). The entry chunk is what the browser must download before the
 * graph can paint; highlight.js is only needed when someone opens a file in
 * the detail panel, so it must ship as a lazy chunk — never in the entry.
 *
 * Prerequisite: `npm run build` before `npm test` (see CLAUDE.md); this file
 * reads the vite output in dist/server/public.
 */

const PUBLIC_DIR = join('dist', 'server', 'public');
const ASSETS_DIR = join(PUBLIC_DIR, 'assets');

function requireBuild(): void {
  if (!existsSync(join(PUBLIC_DIR, 'index.html'))) {
    throw new Error('dist/server/public/index.html missing — run `npm run build` before `npm test`');
  }
}

/** The hashed entry script referenced by the built index.html. */
function entryScriptName(): string {
  requireBuild();
  const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const m = /<script[^>]*src="\/assets\/([^"]+\.js)"/.exec(html);
  if (m === null) throw new Error('built index.html references no /assets/*.js entry script');
  return m[1]!;
}

const readAsset = (name: string): string => readFileSync(join(ASSETS_DIR, name), 'utf8');

describe('web bundle split (first-paint budget)', () => {
  it('entry chunk contains no highlight.js registration', () => {
    const entry = readAsset(entryScriptName());
    // Property names survive vite minification — this marker is what the
    // lazy chunk owns instead (see src/web/highlight-setup.ts).
    expect(entry).not.toContain('registerLanguage');
  });

  it('highlight.js ships in a separate chunk that is not the entry', () => {
    const entryName = entryScriptName();
    const lazy = readdirSync(ASSETS_DIR)
      .filter((f) => f.endsWith('.js') && f !== entryName)
      .filter((f) => readAsset(f).includes('registerLanguage'));
    expect(lazy.length).toBeGreaterThanOrEqual(1);
  });
});
