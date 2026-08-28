import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Integrity anchor for the promoted prototype mock fixture (ticket-00 close-out).
 * The fixture is now the single source of truth for the demo graph shape.
 */
interface MockNode {
  id: string;
  label: string;
  dir: string;
  state: string;
  outDeg: number;
  inDeg: number;
  deg: number;
}
interface MockLink {
  id: string;
  from: string;
  to: string;
}
interface MockGraphFixture {
  source: string;
  note?: string;
  compiled: { nodes: MockNode[]; links: MockLink[] };
}

describe('module-graph.mock.json fixture integrity', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../test-fixtures/module-graph.mock.json', import.meta.url), 'utf8'),
  ) as MockGraphFixture;

  it('carries the expected 30 nodes / 45 edges provenance header', () => {
    expect(fixture.source).toBe('prototype/mock-graph.js');
    expect(fixture.compiled.nodes).toHaveLength(30);
    expect(fixture.compiled.links).toHaveLength(45);
  });

  it('states are within the four-value enum and degrees are consistent', () => {
    for (const n of fixture.compiled.nodes) {
      expect(['pass', 'fail', 'skip', 'none']).toContain(n.state);
      expect(n.deg).toBe(n.outDeg + n.inDeg);
      expect(n.deg).toBeGreaterThanOrEqual(0);
    }
    const orphans = fixture.compiled.nodes
      .filter((n) => n.deg === 0)
      .map((n) => n.id)
      .sort();
    // Zero-degree nodes are exactly the utils nothing imports and that import nothing.
    expect(orphans).toEqual([
      'src/utils/assert.ts',
      'src/utils/debounce.ts',
      'src/utils/logger.ts',
    ]);
  });

  it('links reference known nodes and contain exactly one bidirectional cycle', () => {
    const ids = new Set(fixture.compiled.nodes.map((n) => n.id));
    const seen = new Set<string>();
    const pair = ['src/store/graph-store.ts', 'src/core/indexer.ts'];
    let cycleArcs = 0;
    for (const l of fixture.compiled.links) {
      expect(ids.has(l.from), l.from).toBe(true);
      expect(ids.has(l.to), l.to).toBe(true);
      const key = `${l.from}=>${l.to}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      if (pair.includes(l.from) && pair.includes(l.to)) cycleArcs += 1;
    }
    expect(cycleArcs).toBe(2); // graph-store ⇄ indexer
  });
});
