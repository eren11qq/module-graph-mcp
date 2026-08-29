import type { Core, NodeSingular } from 'cytoscape';
import { THEME } from './theme.js';

/**
 * 区域化海报(2026-08-29 grilling Q1–Q9): the readability pass that turns the
 * single fcose cloud into a fixed-compass poster — web 左、shared 脊柱居中、
 * server 右、tests 底带、样例岛右下、孤球坞左下。
 *
 * fcose stays the only layout engine (MODULE-DESIGN 裁决): nothing here
 * computes a layout — each region's fcose arrangement is picked up whole and
 * RIGIDLY TRANSLATED to its compass slot. The one exception is the orphan
 * dock: degree-0 balls have no edges, hence no arrangement to preserve, so
 * they are re-placed on a deterministic grid.
 *
 * Order is a hard constraint owned by graph-view.applyLayout: plates removed
 * → fcose → THIS translation → physics.rebase() → plates re-added. rebase
 * snapshots the translated spots as the drift bases, so ambient motion
 * orbits the poster instead of pulling it apart, and the plates never enter
 * fcose or the physics state map.
 *
 * Region membership is client-side only — node ids are directory-encoded
 * POSIX paths, so the prefix table below needs no protocol or shared-type
 * change. Files outside the table with edges stay where fcose put them: the
 * table covers today's tree, and a pile-up of unassigned balls is the signal
 * to extend it.
 */

export type RegionId = 'web' | 'server' | 'spine' | 'tests' | 'fixtures' | 'orphan';

/** Row 1: web left → shared spine center → server right. */
const MAIN_ROW: readonly RegionId[] = ['web', 'spine', 'server'];
/** Row 2: orphan dock left → tests band center → fixtures island right. */
const OUTER_ROW: readonly RegionId[] = ['orphan', 'tests', 'fixtures'];

/** Path-prefix table over relative POSIX paths (dir balls carry `dir/` paths). */
const PATH_REGIONS: ReadonlyArray<readonly [prefix: string, region: RegionId]> = [
  ['src/web/', 'web'],
  ['src/server/', 'server'],
  ['src/shared/', 'spine'],
  ['test-fixtures/', 'fixtures'],
  ['tests/', 'tests']
];

/** Plate captions ("WEB · 16"), uppercase via the stylesheet. */
export const REGION_LABELS: Record<RegionId, string> = {
  web: 'WEB',
  server: 'SERVER',
  spine: 'SHARED',
  tests: 'TESTS',
  fixtures: 'FIXTURES',
  orphan: 'ORPHANS'
};

/** Node-id prefix of the background plates (syncRegionPlates). */
export const PLATE_PREFIX = 'plate:';

/**
 * Assign every node a region: the path-prefix table first, then the degree-0
 * fallback — an unconnected file goes to the orphan dock whatever its path
 * (a .d.ts under src/web has no work to do). Pure and covered by tests.
 */
export function assignRegions(
  nodes: ReadonlyArray<{ id: string; path: string }>,
  edges: ReadonlyArray<{ from: string; to: string }>
): Map<string, RegionId> {
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of edges) {
    const from = degree.get(e.from);
    if (from !== undefined) degree.set(e.from, from + 1);
    const to = degree.get(e.to);
    if (to !== undefined) degree.set(e.to, to + 1);
  }

  const out = new Map<string, RegionId>();
  for (const n of nodes) {
    if ((degree.get(n.id) ?? 0) === 0) {
      out.set(n.id, 'orphan');
      continue;
    }
    const region = regionOfPath(n.path);
    if (region !== undefined) out.set(n.id, region);
  }
  return out;
}

function regionOfPath(path: string): RegionId | undefined {
  for (const [prefix, region] of PATH_REGIONS) {
    if (path.startsWith(prefix)) return region;
  }
  return undefined;
}

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Target top-left corner of a region's bounding box, in graph coordinates. */
export interface Slot {
  x: number;
  y: number;
}

/**
 * Pure compass geometry: given each region's current bounding box, return
 * where its box should sit. Row 1 lays web/spine/server out left-to-right on
 * a shared center line (the spine lands between its two worlds because the
 * sequence puts it there); row 2 centers below row 1 as dock → tests →
 * fixtures, the tests band top-aligned and the other two centered on it.
 * Regions missing from the map consume no slot. Covered by tests.
 */
export function computeRegionSlots(
  bboxes: ReadonlyMap<RegionId, BBox>,
  geo: { gapX: number; gapY: number }
): Map<RegionId, Slot> {
  const slots = new Map<RegionId, Slot>();
  const main = MAIN_ROW.filter((r) => bboxes.has(r));
  const outer = OUTER_ROW.filter((r) => bboxes.has(r));

  let rowLeft = 0;
  let rowRight = 0;
  if (main.length > 0) {
    rowLeft = Math.min(...main.map((r) => bboxes.get(r)!.x0));
    rowRight = Math.max(...main.map((r) => bboxes.get(r)!.x1));
    const rowCenterY =
      main.reduce((s, r) => s + (bboxes.get(r)!.y0 + bboxes.get(r)!.y1) / 2, 0) / main.length;
    let cursor = rowLeft;
    for (const r of main) {
      const b = bboxes.get(r)!;
      slots.set(r, { x: cursor, y: rowCenterY - (b.y1 - b.y0) / 2 });
      cursor += b.x1 - b.x0 + geo.gapX;
    }
  }

  if (outer.length > 0) {
    const widthOf = (r: RegionId): number => bboxes.get(r)!.x1 - bboxes.get(r)!.x0;
    const row2Width = outer.reduce((s, r) => s + widthOf(r), 0) + geo.gapX * (outer.length - 1);
    const row2CenterX =
      main.length > 0
        ? (rowLeft + rowRight) / 2
        : outer.reduce((s, r) => s + (bboxes.get(r)!.x0 + bboxes.get(r)!.x1) / 2, 0) / outer.length;
    const rowTop =
      main.length > 0
        ? Math.max(...main.map((r) => bboxes.get(r)!.y1)) + geo.gapY
        : Math.min(...outer.map((r) => bboxes.get(r)!.y0));
    // The tests band top-aligns at rowTop; dock and fixtures center on it.
    const tests = bboxes.get('tests');
    const bandCenterY = tests ? rowTop + (tests.y1 - tests.y0) / 2 : rowTop;
    let cursor = row2CenterX - row2Width / 2;
    for (const r of outer) {
      const b = bboxes.get(r)!;
      const y = r === 'tests' ? rowTop : bandCenterY - (b.y1 - b.y0) / 2;
      slots.set(r, { x: cursor, y });
      cursor += b.x1 - b.x0 + geo.gapX;
    }
  }

  return slots;
}

/**
 * The post-pass itself: rigidly translate each region's fcose arrangement to
 * its compass slot. Runs between fcose.run() and physics.rebase() — see the
 * module comment for why that order is load-bearing.
 */
export function applyRegionLayout(cy: Core, regions: ReadonlyMap<string, RegionId>): void {
  const byRegion = groupByRegion(cy, regions);
  if (byRegion.size === 0) return;

  // 孤儿坞不保形:零连线没有可保的排列,先把散落的孤球收成确定性网格
  // (按 id 排序),锚在它们当前包围盒的左上;随后的罗盘平移对网格与
  // 其它区域一视同仁。
  const orphans = byRegion.get('orphan');
  if (orphans) {
    const sorted = [...orphans].sort((a, b) => (a.id() < b.id() ? -1 : 1));
    let anchorX = Infinity;
    let anchorY = Infinity;
    for (const n of sorted) {
      const p = n.position();
      anchorX = Math.min(anchorX, p.x);
      anchorY = Math.min(anchorY, p.y);
    }
    sorted.forEach((n, i) => {
      n.position({
        x: anchorX + (i % THEME.layout.dockCols) * THEME.layout.dockSpacingX,
        y: anchorY + Math.floor(i / THEME.layout.dockCols) * THEME.layout.dockSpacingY
      });
    });
  }

  const bboxes = new Map<RegionId, BBox>();
  for (const [r, list] of byRegion) bboxes.set(r, bboxOf(list));
  const slots = computeRegionSlots(bboxes, { gapX: THEME.layout.regionGapX, gapY: THEME.layout.regionGapY });

  cy.batch(() => {
    for (const [r, list] of byRegion) {
      const slot = slots.get(r);
      if (!slot) continue;
      const b = bboxes.get(r)!;
      const dx = slot.x - b.x0;
      const dy = slot.y - b.y0;
      if (dx === 0 && dy === 0) continue;
      for (const n of list) {
        const p = n.position();
        n.position({ x: p.x + dx, y: p.y + dy });
      }
    }
  });
}

/**
 * Upsert the background plates so every region reads as a place, not just a
 * position: one non-interactive `region-plate` node per non-empty region,
 * sized to its members' bounding box plus padding, captioned "WEB · 16".
 * Ends with a fit so the whole poster (plates included) is on screen.
 */
export function syncRegionPlates(cy: Core, regions: ReadonlyMap<string, RegionId>): void {
  const byRegion = groupByRegion(cy, regions);

  const wanted = new Set<RegionId>(byRegion.keys());
  cy.nodes('.region-plate').forEach((plate) => {
    if (!wanted.has(plate.id().slice(PLATE_PREFIX.length) as RegionId)) plate.remove();
  });
  if (byRegion.size === 0) return;

  cy.batch(() => {
    for (const [r, list] of byRegion) {
      const b = bboxOf(list);
      const data = {
        id: PLATE_PREFIX + r,
        w: b.x1 - b.x0 + THEME.layout.platePad * 2,
        h: b.y1 - b.y0 + THEME.layout.platePad * 2,
        label: `${REGION_LABELS[r]} · ${list.length}`
      };
      const position = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
      const existing = cy.getElementById(data.id);
      if (existing.nonempty()) {
        existing.data(data);
        existing.position(position);
      } else {
        cy.add({ data, classes: 'region-plate', position });
      }
    }
  });
  cy.fit(undefined, THEME.canvas.padding);
}

function groupByRegion(
  cy: Core,
  regions: ReadonlyMap<string, RegionId>
): Map<RegionId, NodeSingular[]> {
  const byRegion = new Map<RegionId, NodeSingular[]>();
  cy.nodes()
    .not('.region-plate')
    .forEach((n: NodeSingular) => {
      const r = regions.get(n.id());
      if (r === undefined) return;
      const list = byRegion.get(r);
      if (list) list.push(n);
      else byRegion.set(r, [n]);
    });
  return byRegion;
}

/** Ball-extent bounding box: positions are centers, so fold in the radius. */
function bboxOf(list: readonly NodeSingular[]): BBox {
  const box: BBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const n of list) {
    const p = n.position();
    const r = (Number(n.data('diameter')) || 0) / 2;
    box.x0 = Math.min(box.x0, p.x - r);
    box.y0 = Math.min(box.y0, p.y - r);
    box.x1 = Math.max(box.x1, p.x + r);
    box.y1 = Math.max(box.y1, p.y + r);
  }
  return box;
}
