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
    emptyOutDir: true
  }
});
