import { defineConfig } from 'vite';

/**
 * Dashboard frontend build (ticket 03).
 *
 * Vite's project root is src/web; the bundle lands directly in the directory
 * the server process serves statically (src/server/index.ts serves
 * dist/server/public next to the compiled JS), keeping the single-process
 * delivery model intact.
 */
export default defineConfig({
  root: 'src/web',
  publicDir: false,
  build: {
    outDir: '../../dist/server/public',
    emptyOutDir: true,
    // The entry chunk is dominated by cytoscape + fcose, which MUST load
    // before the first paint (the graph IS the landing view) — and "load"
    // here means a local-disk read over 127.0.0.1, not a network transfer.
    // Everything genuinely lazy already split out (highlight.js via
    // src/web/highlight-setup.ts, enforced by tests/bundle-split.test.ts).
    // The limit sits just above the measured entry (610 kB) so the warning
    // stays meaningful: it fires on an accidental regression, not on shape.
    chunkSizeWarningLimit: 700
  }
});
