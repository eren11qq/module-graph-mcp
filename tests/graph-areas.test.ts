import { describe, expect, it } from 'vitest';
import type { Core, NodeSingular } from 'cytoscape';
import {
  applyRegionLayout,
  assignRegions,
  computeRegionSlots,
  syncRegionPlates,
  type BBox,
  type RegionId
} from '../src/web/graph-areas.js';
import { THEME } from '../src/web/theme.js';

/**
 * 区域化海报 (2026-08-29) — the region module's interface is the test
 * surface: assignRegions/computeRegionSlots are pure and pinned exactly;
 * applyRegionLayout/syncRegionPlates run against a minimal recording fake
 * (real cytoscape cannot render under vitest, same reason graph-view.test
 * mocks it).
 */

const node = (id: string, path = id): { id: string; path: string } => ({ id, path });

describe('assignRegions (path table + degree-0 fallback)', () => {
  it('routes the repo tree through the prefix table', () => {
    const regions = assignRegions(
      [
        node('src/web/main.ts'),
        node('src/server/http.ts'),
        node('src/shared/types.ts'),
        node('tests/a.test.ts'),
        node('test-fixtures/sample-app/a.ts'),
        node('test-fixtures/sample-app/b.ts')
      ],
      [
        { from: 'src/web/main.ts', to: 'src/shared/types.ts' },
        { from: 'src/server/http.ts', to: 'src/shared/types.ts' },
        { from: 'tests/a.test.ts', to: 'src/web/main.ts' },
        { from: 'test-fixtures/sample-app/b.ts', to: 'test-fixtures/sample-app/a.ts' }
      ]
    );
    expect(regions.get('src/web/main.ts')).toBe('web');
    expect(regions.get('src/server/http.ts')).toBe('server');
    expect(regions.get('src/shared/types.ts')).toBe('spine');
    expect(regions.get('tests/a.test.ts')).toBe('tests');
    expect(regions.get('test-fixtures/sample-app/a.ts')).toBe('fixtures');
  });

  it('degree 0 wins over the path table — unconnected files dock', () => {
    const regions = assignRegions([node('src/web/cytoscape-fcose.d.ts'), node('vite.config.ts')], []);
    expect(regions.get('src/web/cytoscape-fcose.d.ts')).toBe('orphan');
    expect(regions.get('vite.config.ts')).toBe('orphan');
  });

  it('an incoming edge alone keeps a node out of the dock', () => {
    const regions = assignRegions(
      [node('src/server/http.ts'), node('src/shared/types.ts')],
      [{ from: 'src/server/http.ts', to: 'src/shared/types.ts' }]
    );
    expect(regions.get('src/shared/types.ts')).toBe('spine');
  });

  it('files outside the table with edges stay unassigned (fcose keeps them)', () => {
    const regions = assignRegions(
      [node('docs/sketch.js'), node('src/web/main.ts')],
      [{ from: 'docs/sketch.js', to: 'src/web/main.ts' }]
    );
    expect(regions.has('docs/sketch.js')).toBe(false);
    expect(regions.get('src/web/main.ts')).toBe('web');
  });

  it('directory balls region by their directory path', () => {
    const regions = assignRegions(
      [node('dir:src/web', 'src/web/'), node('dir:tests', 'tests/')],
      [{ from: 'dir:tests', to: 'dir:src/web' }]
    );
    expect(regions.get('dir:src/web')).toBe('web');
    expect(regions.get('dir:tests')).toBe('tests');
  });
});

describe('computeRegionSlots (fixed compass)', () => {
  const geo = { gapX: 120, gapY: 110 };
  const box = (x0: number, y0: number, x1: number, y1: number): BBox => ({ x0, y0, x1, y1 });

  function fullMap(): Map<RegionId, BBox> {
    return new Map<RegionId, BBox>([
      ['web', box(0, 0, 200, 100)],
      ['spine', box(250, 0, 350, 100)],
      ['server', box(400, 0, 600, 100)],
      ['tests', box(100, 200, 500, 300)],
      ['orphan', box(-40, 210, 10, 240)],
      ['fixtures', box(520, 200, 600, 260)]
    ]);
  }

  it('lays row 1 left-to-right on one center line: web | spine | server', () => {
    const m = fullMap();
    const slots = computeRegionSlots(m, geo);
    const w = slots.get('web')!;
    const s = slots.get('spine')!;
    const sv = slots.get('server')!;
    // Sequential placement: each slot lands gapX right after the previous
    // slot (not the previous original box).
    expect(s.x).toBe(w.x + (m.get('web')!.x1 - m.get('web')!.x0) + geo.gapX);
    expect(sv.x).toBe(s.x + (m.get('spine')!.x1 - m.get('spine')!.x0) + geo.gapX);
    // One shared center line across the row.
    const h = (r: RegionId): number => m.get(r)!.y1 - m.get(r)!.y0;
    expect(new Set([w.y + h('web'), s.y + h('spine'), sv.y + h('server')]).size).toBe(1);
    expect(w.x).toBeLessThan(s.x);
    expect(s.x).toBeLessThan(sv.x);
  });

  it('drops row 2 below row 1: tests top-aligned, dock/fixtures centered on the band', () => {
    const m = fullMap();
    const slots = computeRegionSlots(m, geo);
    const rowTop = Math.max(...(['web', 'spine', 'server'] as RegionId[]).map((r) => m.get(r)!.y1)) + geo.gapY;
    expect(slots.get('tests')!.y).toBe(rowTop);
    const bandCenter = rowTop + (m.get('tests')!.y1 - m.get('tests')!.y0) / 2;
    for (const r of ['orphan', 'fixtures'] as RegionId[]) {
      const h = m.get(r)!.y1 - m.get(r)!.y0;
      expect(slots.get(r)!.y + h / 2).toBeCloseTo(bandCenter, 6);
    }
  });

  it('row 2 is sequential and centered under row 1', () => {
    const m = fullMap();
    const slots = computeRegionSlots(m, geo);
    const wOf = (r: RegionId): number => m.get(r)!.x1 - m.get(r)!.x0;
    const o = slots.get('orphan')!;
    const t = slots.get('tests')!;
    const f = slots.get('fixtures')!;
    expect(t.x).toBe(o.x + wOf('orphan') + geo.gapX);
    expect(f.x).toBe(t.x + wOf('tests') + geo.gapX);
    const row1Mid = (m.get('web')!.x0 + m.get('server')!.x1) / 2;
    const row2Mid = (o.x + f.x + wOf('fixtures')) / 2;
    expect(row2Mid).toBeCloseTo(row1Mid, 6);
  });

  it('skips empty regions and is deterministic', () => {
    const m = fullMap();
    m.delete('orphan');
    const a = computeRegionSlots(m, geo);
    const b = computeRegionSlots(m, geo);
    expect(a.has('orphan')).toBe(false);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('row 2 without row 1 still yields non-overlapping slots', () => {
    const m = new Map<RegionId, BBox>([
      ['tests', box(0, 0, 400, 100)],
      ['fixtures', box(10, 10, 90, 60)]
    ]);
    const slots = computeRegionSlots(m, geo);
    expect(slots.get('tests')!.x).toBeLessThan(slots.get('fixtures')!.x);
  });
});

interface FakeNode {
  id: string;
  x: number;
  y: number;
  d: number;
}

interface PlateRec {
  data: Record<string, unknown>;
  position: { x: number; y: number };
}

/** Minimal recording cy: enough surface for the two non-pure exports. */
function fakeCy(nodes: FakeNode[]) {
  const addedDefs: Array<{ data: Record<string, unknown>; classes?: string }> = [];
  const fits: number[] = [];
  const plateById = new Map<string, PlateRec>();

  const handle = (n: FakeNode) =>
    ({
      id: () => n.id,
      position(p?: { x: number; y: number }) {
        if (p) {
          n.x = p.x;
          n.y = p.y;
        }
        return { x: n.x, y: n.y };
      },
      data: (k: string) => (k === 'diameter' ? n.d : undefined),
      hasClass: () => false
    }) as unknown as NodeSingular;

  const cy = {
    nodes(sel?: string) {
      if (sel === '.region-plate') {
        const ids = [...plateById.keys()];
        return {
          forEach(fn: (ele: { id(): string; remove(): void }) => void) {
            for (const id of ids) fn({ id: () => id, remove: () => plateById.delete(id) });
          }
        };
      }
      return {
        forEach(fn: (ele: NodeSingular) => void) {
          for (const n of nodes) fn(handle(n));
        },
        not: () => ({
          forEach(fn: (ele: NodeSingular) => void) {
            for (const n of nodes) fn(handle(n));
          }
        })
      };
    },
    batch(fn: () => void) {
      fn();
    },
    add(def: { data: Record<string, unknown>; classes?: string; position?: { x: number; y: number } }) {
      addedDefs.push(def);
      plateById.set(String(def.data.id), {
        data: { ...def.data },
        position: { ...(def.position ?? { x: 0, y: 0 }) }
      });
    },
    getElementById(id: string) {
      const p = plateById.get(id);
      return {
        nonempty: () => p !== undefined,
        data(k?: string) {
          return p !== undefined && k !== undefined ? p.data[k] : undefined;
        },
        position(np?: { x: number; y: number }) {
          if (p !== undefined && np !== undefined) p.position = { ...np };
          return p !== undefined ? p.position : { x: 0, y: 0 };
        }
      };
    },
    fit(_eles?: unknown, pad?: number) {
      fits.push(pad ?? 0);
    }
  };

  return { cy: cy as unknown as Core, addedDefs, fits, plateById };
}

describe('applyRegionLayout + syncRegionPlates (fake cy)', () => {
  it('translates regions rigidly, grids the orphans, leaves strays alone', () => {
    const nodes: FakeNode[] = [
      { id: 'src/web/a.ts', x: 0, y: 0, d: 20 },
      { id: 'src/web/b.ts', x: 100, y: 0, d: 20 },
      { id: 'src/shared/t.ts', x: 50, y: 50, d: 30 },
      { id: 'vite.config.ts', x: 999, y: 999, d: 21 },
      { id: 'vitest.config.ts', x: -999, y: 999, d: 21 },
      { id: 'docs/sketch.js', x: 500, y: 500, d: 21 }
    ];
    const regions = assignRegions(
      nodes.map((n) => ({ id: n.id, path: n.id })),
      [
        { from: 'src/web/a.ts', to: 'src/web/b.ts' },
        { from: 'src/shared/t.ts', to: 'src/web/a.ts' },
        // The stray must be CONNECTED to test the unassigned path — an
        // edgeless docs file would be degree 0 and dock as an orphan.
        { from: 'docs/sketch.js', to: 'src/web/a.ts' }
      ]
    );
    expect(regions.has('docs/sketch.js')).toBe(false);

    const { cy } = fakeCy(nodes);
    applyRegionLayout(cy, regions);

    // Rigid: the two web balls keep their exact mutual distance.
    const [a, b] = nodes;
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeCloseTo(100, 6);
    // The spine ball moved off its original spot (its one-ball region shifted).
    expect([nodes[2]!.x, nodes[2]!.y]).not.toEqual([50, 50]);
    // Orphans land on the dock grid: dockSpacingX apart, same row.
    const orphans = nodes.filter((n) => n.id.endsWith('.config.ts')).sort((x, y) => x.x - y.x);
    expect(orphans.length).toBe(2);
    expect(orphans[1]!.x - orphans[0]!.x).toBeCloseTo(THEME.layout.dockSpacingX, 6);
    expect(orphans[1]!.y).toBeCloseTo(orphans[0]!.y, 6);
    // Unassigned stray untouched.
    expect([nodes[5]!.x, nodes[5]!.y]).toEqual([500, 500]);
  });

  it('syncRegionPlates upserts one plate per non-empty region and fits once', () => {
    const nodes: FakeNode[] = [
      { id: 'src/web/a.ts', x: 0, y: 0, d: 20 },
      { id: 'src/web/b.ts', x: 100, y: 0, d: 20 },
      { id: 'tests/a.test.ts', x: 0, y: 300, d: 18 }
    ];
    const regions = assignRegions(
      nodes.map((n) => ({ id: n.id, path: n.id })),
      // Both web balls need edges — an edgeless ball docks as an orphan.
      [{ from: 'tests/a.test.ts', to: 'src/web/a.ts' }, { from: 'src/web/a.ts', to: 'src/web/b.ts' }]
    );
    const { cy, plateById, fits, addedDefs } = fakeCy(nodes);

    syncRegionPlates(cy, regions);

    const web = plateById.get('plate:web');
    expect(web).toBeDefined();
    expect(web!.data['label']).toBe('WEB · 2');
    // Caption hovers above the cluster's top edge (members' y0 = −10 incl.
    // radius), never on a ball — background is gone, the name IS the region.
    expect(web!.position.y).toBeCloseTo(-10 - THEME.layout.captionGap, 6);
    expect(plateById.get('plate:tests')!.data['label']).toBe('TESTS · 1');
    expect(plateById.has('plate:orphan')).toBe(false);
    expect(fits.length).toBe(1);
    expect(addedDefs).toHaveLength(2);

    // A second sync updates in place instead of piling up duplicates.
    syncRegionPlates(cy, regions);
    expect(addedDefs).toHaveLength(2);
    expect(plateById.size).toBe(2);
  });
});
