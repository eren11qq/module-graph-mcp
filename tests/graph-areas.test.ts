import { describe, expect, it } from 'vitest';
import cytoscape from 'cytoscape';
import type { Core, NodeSingular } from 'cytoscape';
import {
  applyRegionLayout,
  assignRegions,
  computeRegionSlots,
  separateAllBalls,
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
 * mocks it). 例外：separateAllBalls 是面向 headless 的纯坐标通道，
 * 直接用真实 cytoscape 钉「全场硬保证」语义（2026-09-01 D3）。
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

describe('orphan dock anchor (Code-review 2026-08-29)', () => {
  /** Two web balls + two orphans; orphans start on the given scatter. */
  function runWithOrphansAt(scatter: ReadonlyArray<{ x: number; y: number }>): FakeNode[] {
    const nodes: FakeNode[] = [
      { id: 'src/web/a.ts', x: 0, y: 0, d: 20 },
      { id: 'src/web/b.ts', x: 100, y: 0, d: 20 },
      { id: 'vite.config.ts', x: scatter[0]!.x, y: scatter[0]!.y, d: 21 },
      { id: 'vitest.config.ts', x: scatter[1]!.x, y: scatter[1]!.y, d: 21 }
    ];
    const regions = assignRegions(
      nodes.map((n) => ({ id: n.id, path: n.id })),
      [{ from: 'src/web/a.ts', to: 'src/web/b.ts' }]
    );
    const { cy } = fakeCy(nodes);
    applyRegionLayout(cy, regions);
    return nodes;
  }

  it('dock output is independent of the fcose scatter — main-mass anchor', () => {
    const a = runWithOrphansAt([
      { x: 999, y: 999 },
      { x: -500, y: 300 }
    ]);
    const b = runWithOrphansAt([
      { x: 42, y: -700 },
      { x: 10, y: 10 }
    ]);
    // The anchor is a pure function of the non-orphan mass now, so the whole
    // poster — dock included — comes out bitwise identical scatter or not.
    expect(b.map((n) => ({ id: n.id, x: n.x, y: n.y }))).toEqual(
      a.map((n) => ({ id: n.id, x: n.x, y: n.y }))
    );
  });

  it('all-orphan graph falls back to the own-scatter anchor; grid shape kept', () => {
    const nodes: FakeNode[] = [
      { id: 'a.config.ts', x: 50, y: 40, d: 20 },
      { id: 'b.config.ts', x: -900, y: 12, d: 20 },
      { id: 'c.config.ts', x: 7, y: 800, d: 20 },
      { id: 'd.config.ts', x: 300, y: -12, d: 20 }
    ];
    const regions = assignRegions(
      nodes.map((n) => ({ id: n.id, path: n.id })),
      []
    );
    const { cy } = fakeCy(nodes);
    applyRegionLayout(cy, regions);
    const sorted = [...nodes].sort((x, y) => (x.id < y.id ? -1 : 1));
    // dockCols = 3: a/b/c on the first row, d wraps to row 2 column 0. The
    // compass translation moves the whole dock rigidly, so only shape
    // invariants are assertable here.
    expect(sorted[1]!.x - sorted[0]!.x).toBeCloseTo(THEME.layout.dockSpacingX, 6);
    expect(sorted[2]!.x - sorted[1]!.x).toBeCloseTo(THEME.layout.dockSpacingX, 6);
    expect(sorted[1]!.y).toBeCloseTo(sorted[0]!.y, 6);
    expect(sorted[3]!.x).toBeCloseTo(sorted[0]!.x, 6);
    expect(sorted[3]!.y - sorted[0]!.y).toBeCloseTo(THEME.layout.dockSpacingY, 6);
  });
});

describe('region gap channel (Code-review 2026-08-29)', () => {
  function webPair(ax: number, ay: number, bx: number, by: number): FakeNode[] {
    return [
      { id: 'src/web/a.ts', x: ax, y: ay, d: 20 },
      { id: 'src/web/b.ts', x: bx, y: by, d: 20 }
    ];
  }
  const webEdge = [{ from: 'src/web/a.ts', to: 'src/web/b.ts' }];
  const runPass = (nodes: FakeNode[]): void => {
    const regions = assignRegions(
      nodes.map((n) => ({ id: n.id, path: n.id })),
      webEdge
    );
    const { cy } = fakeCy(nodes);
    applyRegionLayout(cy, regions);
  };

  it('touching same-region balls are pushed apart to exactly r1+r2+ballGap', () => {
    const nodes = webPair(0, 0, 25, 0); // 25 center-to-center = touching + some
    runPass(nodes);
    const need = 10 + 10 + THEME.layout.ballGap;
    expect(Math.hypot(nodes[0]!.x - nodes[1]!.x, nodes[0]!.y - nodes[1]!.y)).toBeCloseTo(need, 6);
  });

  it('already-spaced balls are not moved at all (single region, gap satisfied)', () => {
    const nodes = webPair(0, 0, 100, 0); // edge-to-edge 80 > 32 → zero work
    runPass(nodes);
    // One main-row region lands with zero translation, and the gap pass is a
    // no-op here — the pair must sit EXACTLY where it started.
    expect([nodes[0]!.x, nodes[0]!.y]).toEqual([0, 0]);
    expect([nodes[1]!.x, nodes[1]!.y]).toEqual([100, 0]);
  });

  it('fully overlapping balls split deterministically along the x-axis', () => {
    const nodes = webPair(40, 40, 40, 40);
    runPass(nodes);
    const need = 10 + 10 + THEME.layout.ballGap;
    expect(Math.hypot(nodes[0]!.x - nodes[1]!.x, nodes[0]!.y - nodes[1]!.y)).toBeCloseTo(need, 6);
    // id order decides the direction: a.ts goes -x, b.ts +x; same row.
    expect(nodes[0]!.x).toBeLessThan(nodes[1]!.x);
    expect(nodes[0]!.y).toBeCloseTo(nodes[1]!.y, 6);
  });

  it('the gap pass is idempotent — a second apply moves nothing', () => {
    const nodes = webPair(0, 0, 25, 0);
    runPass(nodes);
    const after = nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
    runPass(nodes);
    expect(nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }))).toEqual(after);
  });
});

// ---------------------------------------------------------------------------
// separateAllBalls (2026-09-01 D3): 全场最小距离硬保证——真实 headless
// 通道，跨聚类对与游离球（stray）也在内。题注板 (.region-plate) 必须被排除。
// ---------------------------------------------------------------------------

function realCy(nodes: { id: string; x: number; y: number; d?: number }[]): Core {
  const cy = cytoscape({ headless: true });
  cy.add(
    nodes.map((n) => ({
      data: { id: n.id, path: n.id, diameter: n.d ?? 24 },
      position: { x: n.x, y: n.y }
    }))
  );
  return cy;
}

function edgeGap(cy: Core, a: string, b: string): number {
  const pa = (cy.getElementById(a) as unknown as NodeSingular).position() as { x: number; y: number };
  const pb = (cy.getElementById(b) as unknown as NodeSingular).position() as { x: number; y: number };
  const ra = (Number((cy.getElementById(a) as unknown as NodeSingular).data('diameter')) || 0) / 2;
  const rb = (Number((cy.getElementById(b) as unknown as NodeSingular).data('diameter')) || 0) / 2;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) - ra - rb;
}

describe('separateAllBalls (全场最小距离硬保证 D3)', () => {
  it('stray vs region ball is pushed apart cross-boundary (the old intra-only gap)', () => {
    // stray（不在 PATH_REGIONS 的游离球）贴在 web 区球上——旧通道从不分离它。
    const cy = realCy([
      { id: 'src/web/a.ts', x: 0, y: 0 },
      { id: 'stray.ts', x: 10, y: 0 }
    ]);
    separateAllBalls(cy, THEME.layout.ballGap);
    expect(edgeGap(cy, 'src/web/a.ts', 'stray.ts')).toBeGreaterThanOrEqual(
      THEME.layout.ballGap - 1e-3
    );
    cy.destroy();
  });

  it('excludes region plates: a ball never gets pushed off a plate caption', () => {
    const cy = realCy([{ id: 'src/server/s.ts', x: 0, y: 0 }]);
    cy.add({ data: { id: 'plate:server', path: 'plate', diameter: 200 }, classes: 'region-plate', position: { x: 8, y: 0 } });
    // 题注板与球重合也不许推动球（板被剔除，剩下单球 < 2 → 直接返回）。
    separateAllBalls(cy, THEME.layout.ballGap);
    const p = (cy.getElementById('src/server/s.ts') as unknown as NodeSingular).position() as { x: number; y: number };
    expect(p).toEqual({ x: 0, y: 0 });
    cy.destroy();
  });

  it('is idempotent: an already-spaced field does not move', () => {
    const cy = realCy([
      { id: 'a', x: -500, y: 0 },
      { id: 'b', x: 500, y: 0 },
      { id: 'c', x: 0, y: -500 }
    ]);
    const before = ['a', 'b', 'c'].map((id) => ({ ...(cy.getElementById(id) as unknown as NodeSingular).position() }));
    separateAllBalls(cy, THEME.layout.ballGap);
    const after = ['a', 'b', 'c'].map((id) => ({ ...(cy.getElementById(id) as unknown as NodeSingular).position() }));
    expect(after).toEqual(before);
    cy.destroy();
  });

  it('dense pile of ~50 overlapped balls all satisfy ≥ ballGap within the round cap', () => {
    // 稠密堆级联推开是轮数上限的极限测试——钉死收敛（D3 不许放宽 ≥gap；
    // 无容差渐近不收,容差 + 200 轮上限让它 141 轮早退,见 graph-areas.ts 注释）。
    // 2D 紧贴网格（8px 步距 < 24+32 的需求距），非退化共线，逼出跨方向级联。
    const nodes: { id: string; x: number; y: number }[] = [];
    for (let i = 0; i < 50; i++)
      nodes.push({ id: `n${i}`.padStart(3, '0'), x: (i % 5) * 8, y: Math.floor(i / 5) * 8 });
    const cy = realCy(nodes);
    separateAllBalls(cy, THEME.layout.ballGap);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(edgeGap(cy, nodes[i]!.id, nodes[j]!.id)).toBeGreaterThanOrEqual(
          THEME.layout.ballGap - 1e-3
        );
      }
    }
    cy.destroy();
  });
});
