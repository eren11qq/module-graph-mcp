import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as {
  private?: boolean;
  dependencies?: Record<string, string>;
  files?: string[];
};

/**
 * Publish contract (G1/G2): the manifest itself must pin down what the
 * certification probes caught drifting — a phantom runtime dependency and
 * an accidental tarball. Deliberately dumb: it only reads package.json.
 */
describe('publish contract', () => {
  it('declares typescript as a real runtime dependency (no phantom deps)', () => {
    expect(pkg.dependencies?.typescript).toBeDefined();
  });

  it('is shippable: not private, dist + README declared in files', () => {
    expect(pkg.private).not.toBe(true);
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('README.md');
  });
});
