// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphView } from '../src/web/graph-view.js';
import type { Edge, GraphDelta, GraphSnapshot, ModuleNode, TestState } from '../src/shared/types.js';
import type { LayoutStore } from '../src/web/layout-store.js';
import { diameterOf } from '../src/web/theme.js';

/**
 * P1-1 acceptance: after a graph_delta adds nodes, tapping a newcomer must
 * open the detail panel — findNode resolves against the live node map, not
 * the frozen initial snapshot. Cytoscape is faked (its canvas renderer cannot
 * run under happy-dom); the fake covers exactly the API graph-view uses.
 */

interface FakeCy {
  __fire(key: string, evt: unknown): void;
}

const h = vi.hoisted(() => {
  const instances: FakeCy[] = [];
  const styles: unknown[] = [];
  return { instances, styles };
});

/** Shared setup for every describe: fresh view + its fake cytoscape instance. */
function mountView(opts?: { store?: LayoutStore }): {
  onFocusChange: ReturnType<typeof vi.fn>;
  view: ReturnType<typeof createGraphView>;
  cy: FakeCy;
} {
  h.instances.length = 0;
  h.styles.length = 0;
  const onFocusChange = vi.fn();
  const view = createGraphView(document.createElement('div'), {
    onFocusChange,
    tooltipEl: document.createElement('div'),
    ...opts
  });
  return { onFocusChange, view, cy: h.instances[0]! };
}

vi.mock('cytoscape', () => {
  type Pos = { x: number; y: number };
  type Ele = {
    id(): string;
    data(key?: unknown, value?: unknown): unknown;
    position(next?: Pos): Pos;
    remove(): void;
    nonempty(): boolean;
    empty(): boolean;
    addClass(...names: string[]): Ele;
    removeClass(...names: string[]): Ele;
    toggleClass(name: string, force?: boolean): Ele;
    hasClass(name: string): boolean;
    closedNeighborhood(): { edges(): { addClass(): void; removeClass(): void }; addClass(): void };
  };
  type Def = { data: Record<string, unknown>; classes?: string; position?: Pos };

  const EMPTY_ELE: Ele = {
    id: () => '',
    data: () => undefined,
    position: () => ({ x: 0, y: 0 }),
    remove() {},
    nonempty: () => false,
    empty: () => true,
    addClass: () => EMPTY_ELE,
    removeClass: () => EMPTY_ELE,
    toggleClass: () => EMPTY_ELE,
    hasClass: () => false,
    closedNeighborhood: () => ({ edges: () => ({ addClass() {}, removeClass() {} }), addClass() {} })
  };

  function makeCy(): FakeCy & Record<string, unknown> {
    const defs = new Map<string, Def>();
    const eles = new Map<string, Ele>();

    const makeEle = (def: Def): Ele => {
      const d: Record<string, unknown> = { ...def.data };
      const classes = new Set<string>(
        typeof def.classes === 'string' ? def.classes.split(/\s+/).filter(Boolean) : []
      );
      let pos: Pos = def.position ? { ...def.position } : { x: 0, y: 0 };
      const ele: Ele = {
        id: () => String(d.id),
        data(key?: unknown, value?: unknown) {
          if (key === undefined) return d;
          if (typeof key === 'object') {
            Object.assign(d, key);
            return d;
          }
          if (value !== undefined) d[key as string] = value;
          return d[key as string];
        },
        position(next?: Pos) {
          if (next !== undefined) pos = { ...next };
          return pos;
        },
        remove() {
          defs.delete(String(d.id));
          eles.delete(String(d.id));
        },
        nonempty: () => true,
        empty: () => false,
        addClass(...names: string[]) {
          for (const n of names) classes.add(n);
          return ele;
        },
        removeClass(...names: string[]) {
          for (const n of names) classes.delete(n);
          return ele;
        },
        toggleClass(name: string, force?: boolean) {
          const want = force ?? !classes.has(name);
          if (want) classes.add(name);
          else classes.delete(name);
          return ele;
        },
        hasClass: (name: string) => classes.has(name),
        closedNeighborhood: () => ({ edges: () => ({ addClass() {}, removeClass() {} }), addClass() {} })
      };
      return ele;
    };

    // Elements are persistent instances (like real cytoscape): data() writes
    // via one getElementById handle must be visible through the next one.
    const eleOf = (id: string): Ele => {
      let e = eles.get(id);
      if (e === undefined) {
        const def = defs.get(id);
        e = def ? makeEle(def) : EMPTY_ELE;
        eles.set(id, e);
      }
      return e;
    };

    const isNode = (d: Def): boolean => d.data.source === undefined;
    const nodeDefs = (): Def[] => [...defs.values()].filter(isNode);
    const edgeDefs = (): Def[] => [...defs.values()].filter((d) => !isNode(d));

    // Uniform collection over a snapshot of element handles — covers every
    // traversal graph-view uses (empty/nonempty/forEach/not/addClass/
    // removeClass/remove), selector args are class filters.
    const collection = (list: Ele[]) => ({
      empty: () => list.length === 0,
      nonempty: () => list.length > 0,
      forEach(fn: (e: Ele) => void) {
        for (const e of [...list]) fn(e);
      },
      addClass(...names: string[]) {
        for (const e of list) e.addClass(...names);
        return collection(list);
      },
      removeClass(...names: string[]) {
        for (const e of list) e.removeClass(...names);
        return collection(list);
      },
      remove() {
        for (const e of [...list]) e.remove();
      },
      not(sel: string) {
        // applyFocus chains not(hood-object) before not('.region-plate') —
        // the fake has no neighborhoods, so object args pass unfiltered.
        if (typeof sel !== 'string') return collection(list);
        const cls = sel.startsWith('.') ? sel.slice(1) : sel;
        return collection(list.filter((e) => !e.hasClass(cls)));
      }
    });

    const handlers = new Map<string, Array<(evt: unknown) => void>>();
    const register = (key: string, handler: (evt: unknown) => void): void => {
      const list = handlers.get(key) ?? [];
      list.push(handler);
      handlers.set(key, list);
    };

    const cy = {
      batch(fn: () => void) {
        fn();
      },
      add(def: Def | Def[]) {
        for (const e of Array.isArray(def) ? def : [def]) {
          defs.set(String(e.data.id), e);
          eles.delete(String(e.data.id));
        }
      },
      elements() {
        return collection(
          [...nodeDefs(), ...edgeDefs()].map((d) => eleOf(String(d.data.id)))
        );
      },
      nodes(selector?: string) {
        let list = nodeDefs().map((d) => eleOf(String(d.data.id)));
        if (selector !== undefined) {
          const cls = selector.startsWith('.') ? selector.slice(1) : selector;
          list = list.filter((e) => e.hasClass(cls));
        }
        return collection(list);
      },
      edges() {
        return collection(edgeDefs().map((d) => eleOf(String(d.data.id))));
      },
      getElementById(id: string): Ele {
        return eleOf(id);
      },
      on(event: string, selectorOrHandler: string | ((evt: unknown) => void), maybeHandler?: (evt: unknown) => void) {
        const key = typeof selectorOrHandler === 'string' ? `${event}|${selectorOrHandler}` : event;
        register(key, (maybeHandler ?? selectorOrHandler) as (evt: unknown) => void);
      },
      layout() {
        return { run() {} };
      },
      fit() {},
      resize() {},
      center() {},
      destroy() {},
      __fire(key: string, evt: unknown) {
        for (const handler of handlers.get(key) ?? []) handler(evt);
      }
    };
    h.instances.push(cy as unknown as FakeCy);
    return cy;
  }

  return {
    default: Object.assign(((opts?: { style?: unknown }) => {
      const cy = makeCy();
      h.styles.push(opts?.style);
      return cy;
    }) as unknown as Record<string, unknown>, { use() {} })
  };
});

vi.mock('cytoscape-fcose', () => ({ default: {} }));

function node(id: string, testState: ModuleNode['testState'] = 'untested'): ModuleNode {
  return { id, path: `src/${id}`, language: 'ts', testState, coveredBy: [], typeErrors: [] };
}

function snapshotWith(nodes: ModuleNode[], edges: Edge[] = []): GraphSnapshot {
  return { rootPath: '/proj', generatedAt: 1, nodes, edges };
}

describe('graph-view findNode stays in sync with deltas (P1-1)', () => {
  let onFocusChange: ReturnType<typeof vi.fn>;
  let view: ReturnType<typeof createGraphView>;
  let cy: FakeCy;

  beforeEach(() => {
    ({ onFocusChange, view, cy } = mountView());
  });

  const tap = (id: string): void => {
    cy.__fire('tap|node', { target: { id: () => id } });
  };

  it('resolves taps on nodes from the initial snapshot', () => {
    const a = node('a.ts');
    view.setSnapshot(snapshotWith([a]));
    tap('a.ts');
    expect(onFocusChange).toHaveBeenLastCalledWith(a);
  });

  it('opens the detail panel for a node that arrived via applyDelta (ticket acceptance)', () => {
    const a = node('a.ts');
    const b = node('b.ts');
    view.setSnapshot(snapshotWith([a]));
    view.applyDelta({ addedNodes: [b], removedNodeIds: [], addedEdges: [], removedEdges: [] });

    tap('b.ts');
    expect(onFocusChange).toHaveBeenLastCalledWith(b);
  });

  it('reflects applyNodeUpdate patches on the next tap', () => {
    const a = node('a.ts');
    view.setSnapshot(snapshotWith([a]));
    const updated = node('a.ts', 'passing');
    view.applyNodeUpdate(updated);

    tap('a.ts');
    expect(onFocusChange).toHaveBeenLastCalledWith(updated);
  });

  it('clears focus when the locked node is removed by a delta', () => {
    const a = node('a.ts');
    const b = node('b.ts');
    view.setSnapshot(snapshotWith([a, b]));
    tap('a.ts');
    onFocusChange.mockClear();

    view.applyDelta({ addedNodes: [], removedNodeIds: ['a.ts'], addedEdges: [], removedEdges: [] });
    expect(onFocusChange).toHaveBeenLastCalledWith(null);
  });
});

describe('type-error badge channel (P2-1, ticket 07)', () => {
  let onFocusChange: ReturnType<typeof vi.fn>;
  let view: ReturnType<typeof createGraphView>;
  let cy: FakeCy;

  beforeEach(() => {
    ({ onFocusChange, view, cy } = mountView());
  });

  const dataOf = (id: string, key: string): unknown =>
    (
      cy as unknown as {
        getElementById(id: string): { data(key?: string): unknown };
      }
    ).getElementById(id).data(key);

  it('node data carries typeErrorCount from the snapshot', () => {
    const bad: ModuleNode = {
      ...node('bad.ts'),
      typeErrors: [
        { line: 1, code: 'TS2322', message: 'x' },
        { line: 2, code: 'TS2304', message: 'y' }
      ]
    };
    view.setSnapshot(snapshotWith([bad, node('ok.ts')]));
    expect(dataOf('bad.ts', 'typeErrorCount')).toBe(2);
    expect(dataOf('ok.ts', 'typeErrorCount')).toBe(0);
  });

  it('applyNodeUpdate clears the count when errors are fixed', () => {
    const bad: ModuleNode = { ...node('bad.ts'), typeErrors: [{ line: 1, code: 'TS2322', message: 'x' }] };
    view.setSnapshot(snapshotWith([bad]));
    view.applyNodeUpdate({ ...bad, typeErrors: [] });
    expect(dataOf('bad.ts', 'typeErrorCount')).toBe(0);
  });

  it('installs the badge stylesheet rule as its own channel', () => {
    expect(h.styles[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selector: 'node[typeErrorCount > 0]' })
      ])
    );
  });
});

describe('AI 检查 checking 类同步 (ticket 12)', () => {
  let onFocusChange: ReturnType<typeof vi.fn>;
  let view: ReturnType<typeof createGraphView>;
  let cy: FakeCy;

  beforeEach(() => {
    ({ onFocusChange, view, cy } = mountView());
  });

  const ele = (id: string): { hasClass(name: string): boolean } =>
    (cy as unknown as { getElementById(id: string): { hasClass(name: string): boolean } }).getElementById(id);

  it('applyNodeUpdate adds `checking` while the agent reviews, removes it when done', () => {
    const a = node('a.ts');
    view.setSnapshot(snapshotWith([a]));

    view.applyNodeUpdate({ ...a, aiReview: { status: 'checking', verdicts: [] } });
    expect(ele('a.ts').hasClass('checking')).toBe(true);

    view.applyNodeUpdate({
      ...a,
      aiReview: { status: 'done', verdicts: [{ line: 1, verdict: 'unsure' }], reviewedAt: 1 }
    });
    expect(ele('a.ts').hasClass('checking')).toBe(false);
  });

  it('a snapshot carrying aiReview=checking mounts the ball already pulsing', () => {
    const a: ModuleNode = { ...node('a.ts'), aiReview: { status: 'checking', verdicts: [] } };
    view.setSnapshot(snapshotWith([a]));
    expect(ele('a.ts').hasClass('checking')).toBe(true);
  });

  it('installs the checking stylesheet rule and counts rendered cycle arcs', () => {
    expect(h.styles[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ selector: 'node.checking' })])
    );

    view.setSnapshot(
      snapshotWith(
        [node('a.ts'), node('b.ts')],
        [
          { from: 'a.ts', to: 'b.ts' },
          { from: 'b.ts', to: 'a.ts' }
        ]
      )
    );
    expect(view.cycleCount()).toBe(1);
  });
});

describe('AI 评审环 data channel (code-review 2026-08-29)', () => {
  let onFocusChange: ReturnType<typeof vi.fn>;
  let view: ReturnType<typeof createGraphView>;
  let cy: FakeCy;

  beforeEach(() => {
    ({ onFocusChange, view, cy } = mountView());
  });

  const dataOf = (id: string, key: string): unknown =>
    (
      cy as unknown as {
        getElementById(id: string): { data(key?: string): unknown };
      }
    ).getElementById(id).data(key);

  it('snapshot data carries the worst verdict as reviewVerdict', () => {
    const err: ModuleNode = {
      ...node('err.ts'),
      aiReview: {
        status: 'done',
        verdicts: [
          { line: 1, verdict: 'unsure' },
          { line: 2, verdict: 'error' }
        ],
        reviewedAt: 1
      }
    };
    const ok: ModuleNode = { ...node('ok.ts'), aiReview: { status: 'done', verdicts: [], reviewedAt: 1 } };
    view.setSnapshot(snapshotWith([err, ok]));
    expect(dataOf('err.ts', 'reviewVerdict')).toBe('error');
    expect(dataOf('ok.ts', 'reviewVerdict')).toBe('confident');
  });

  it('applyNodeUpdate clears the ring while checking and re-colors once done', () => {
    const a = node('a.ts');
    view.setSnapshot(snapshotWith([a]));
    view.applyNodeUpdate({ ...a, aiReview: { status: 'checking', verdicts: [] } });
    expect(dataOf('a.ts', 'reviewVerdict')).toBe('');
    view.applyNodeUpdate({
      ...a,
      aiReview: { status: 'done', verdicts: [{ line: 1, verdict: 'unsure' }], reviewedAt: 1 }
    });
    expect(dataOf('a.ts', 'reviewVerdict')).toBe('unsure');
  });

  it('installs the review-ring rules on the border channel, after type-error and before focus', () => {
    const styles = h.styles[0] as Array<{ selector: string }>;
    const indexOf = (sel: string): number => styles.findIndex((r) => r.selector === sel);
    const typeErrorAt = indexOf('node[typeErrorCount > 0]');
    const focusedAt = indexOf('node.focused');
    expect(typeErrorAt).toBeGreaterThan(-1);
    expect(focusedAt).toBeGreaterThan(typeErrorAt);
    // Later rules win (graph-view buildStylesheet): the verdict ring must
    // outrank the type-error ring (type-error yields) yet lose to the
    // transient focus ring.
    for (const verdict of ['confident', 'unsure', 'error']) {
      const at = indexOf(`node[reviewVerdict = "${verdict}"]`);
      expect(at).toBeGreaterThan(typeErrorAt);
      expect(at).toBeLessThan(focusedAt);
    }
  });
});

describe('view controls: 只看未测 / 搜索 / 目录折叠 (ticket 11 seam 4)', () => {
  // pkg holds 3 direct files (folds at THEME.collapse.minFiles = 3), solo
  // holds 2 (stays), main.ts is root-level (never folds).
  function controlFixture(): GraphSnapshot {
    return snapshotWith(
      [
        node('main.ts', 'passing'),
        node('pkg/a.ts'),
        node('pkg/b.ts'),
        node('pkg/c.ts', 'failing'),
        node('solo/d.ts'),
        node('solo/e.ts', 'passing')
      ],
      [
        { from: 'main.ts', to: 'pkg/a.ts' },
        { from: 'pkg/a.ts', to: 'pkg/b.ts' },
        { from: 'pkg/c.ts', to: 'main.ts' },
        { from: 'solo/d.ts', to: 'solo/e.ts' }
      ]
    );
  }

  let onFocusChange: ReturnType<typeof vi.fn>;
  let view: ReturnType<typeof createGraphView>;
  let cy: FakeCy;

  beforeEach(() => {
    ({ onFocusChange, view, cy } = mountView());
  });

  const tap = (id: string): void => {
    cy.__fire('tap|node', { target: { id: () => id } });
  };
  type EleHandle = { nonempty(): boolean; data(key?: string): unknown; hasClass(name: string): boolean };
  const ele = (id: string): EleHandle =>
    (cy as unknown as { getElementById(id: string): EleHandle }).getElementById(id);
  const visible = (id: string): boolean => ele(id).nonempty();
  const dataOf = (id: string, key: string): unknown => ele(id).data(key);

  it('只看未测 hides non-untested balls and the edges that touch them', () => {
    view.setSnapshot(controlFixture());
    view.setViewState({ untestedOnly: true });
    expect(visible('pkg/a.ts')).toBe(true);
    expect(visible('pkg/b.ts')).toBe(true);
    expect(visible('main.ts')).toBe(false);
    expect(visible('pkg/c.ts')).toBe(false);
    expect(visible('main.ts->pkg/a.ts')).toBe(false);
    expect(visible('pkg/a.ts->pkg/b.ts')).toBe(true);
  });

  it('delta keeps 只看未测 honest: an untested newcomer renders, a passing one does not', () => {
    view.setSnapshot(controlFixture());
    view.setViewState({ untestedOnly: true });
    view.applyDelta({
      addedNodes: [node('pkg/new.ts')],
      removedNodeIds: [],
      addedEdges: [{ from: 'pkg/a.ts', to: 'pkg/new.ts' }],
      removedEdges: []
    });
    expect(visible('pkg/new.ts')).toBe(true);
    view.applyDelta({ addedNodes: [node('more.ts', 'passing')], removedNodeIds: [], addedEdges: [], removedEdges: [] });
    expect(visible('more.ts')).toBe(false);
  });

  it('node_update out of 未测 removes the ball while 只看未测 is on', () => {
    view.setSnapshot(controlFixture());
    view.setViewState({ untestedOnly: true });
    view.applyNodeUpdate(node('pkg/a.ts', 'passing'));
    expect(visible('pkg/a.ts')).toBe(false);
  });

  it('hideReviewed removes reviewed balls (and their edges) until toggled off', () => {
    view.setSnapshot(controlFixture());
    const reviewed: ModuleNode = { ...node('main.ts'), aiReview: { status: 'done', verdicts: [], reviewedAt: 1 } };
    const checking: ModuleNode = { ...node('pkg/c.ts', 'failing'), aiReview: { status: 'checking', verdicts: [] } };
    view.applyNodeUpdate(reviewed);
    view.applyNodeUpdate(checking);

    view.setViewState({ hideReviewed: true });
    expect(visible('main.ts')).toBe(false);
    expect(visible('main.ts->pkg/a.ts')).toBe(false);
    // checking 中的节点与未评审节点保留。
    expect(visible('pkg/c.ts')).toBe(true);
    expect(visible('pkg/a.ts')).toBe(true);

    view.setViewState({ hideReviewed: false });
    expect(visible('main.ts')).toBe(true);
    expect(visible('main.ts->pkg/a.ts')).toBe(true);
  });

  it('search shows only matching balls (case-insensitive); clearing restores the graph', () => {
    view.setSnapshot(controlFixture());
    view.setViewState({ query: 'PKG/B' });
    expect(visible('pkg/b.ts')).toBe(true);
    expect(visible('pkg/a.ts')).toBe(false);
    expect(visible('main.ts')).toBe(false);
    view.setViewState({ query: '' });
    expect(visible('main.ts')).toBe(true);
    expect(visible('pkg/a.ts')).toBe(true);
  });

  it('collapse folds a ≥ minFiles dir into one ball with aggregated data and rewired edges', () => {
    view.setSnapshot(controlFixture());
    view.setViewState({ collapseEnabled: true });
    expect(visible('dir:pkg')).toBe(true);
    expect(visible('pkg/a.ts')).toBe(false);
    expect(visible('solo/d.ts')).toBe(true);
    expect(visible('main.ts')).toBe(true);
    expect(dataOf('dir:pkg', 'path')).toBe('pkg/');
    expect(dataOf('dir:pkg', 'label')).toBe('pkg');
    expect(dataOf('dir:pkg', 'state')).toBe('failing');
    expect(visible('main.ts->dir:pkg')).toBe(true);
    expect(visible('dir:pkg->main.ts')).toBe(true);
    expect(visible('pkg/a.ts->pkg/b.ts')).toBe(false);
    expect(visible('solo/d.ts->solo/e.ts')).toBe(true);
  });

  it('tapping a dir ball expands just that directory and opens no detail panel', () => {
    view.setSnapshot(controlFixture());
    view.setViewState({ collapseEnabled: true });
    onFocusChange.mockClear();
    tap('dir:pkg');
    expect(visible('pkg/a.ts')).toBe(true);
    expect(visible('pkg/c.ts')).toBe(true);
    expect(visible('dir:pkg')).toBe(false);
    expect(onFocusChange).not.toHaveBeenCalled();
  });

  it('search reveals a matching file inside a collapsible directory', () => {
    view.setSnapshot(controlFixture());
    view.setViewState({ collapseEnabled: true });
    view.setViewState({ query: 'pkg/a' });
    expect(visible('pkg/a.ts')).toBe(true);
    expect(visible('dir:pkg')).toBe(false);
  });

  it('filtering away the locked node clears the focus lock', () => {
    view.setSnapshot(controlFixture());
    tap('solo/e.ts');
    expect(onFocusChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'solo/e.ts' }));
    view.setViewState({ untestedOnly: true });
    expect(onFocusChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps the lock visuals when a re-render keeps the locked ball visible', () => {
    view.setSnapshot(controlFixture());
    tap('pkg/a.ts');
    view.setViewState({ query: 'pkg/a' });
    expect(visible('pkg/a.ts')).toBe(true);
    expect(ele('pkg/a.ts').hasClass('focused')).toBe(true);
  });

  it('focusNode ignores a ball hidden by the active filter; visible balls still jump', () => {
    view.setSnapshot(controlFixture());
    view.setViewState({ untestedOnly: true });
    onFocusChange.mockClear();
    view.focusNode('main.ts'); // passing → hidden by the filter
    expect(onFocusChange).not.toHaveBeenCalled();
    view.focusNode('pkg/a.ts'); // untested → visible
    expect(onFocusChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pkg/a.ts' }));
    expect(ele('pkg/a.ts').hasClass('focused')).toBe(true);
  });
});

describe('区域化海报 wiring (2026-08-29)', () => {
  // The shared node() helper prefixes paths with src/ — the region table
  // reads real repo paths, so region tests carry explicit ones.
  function pathNode(path: string): ModuleNode {
    return { id: path, path, language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [] };
  }

  function regionFixture(): GraphSnapshot {
    return snapshotWith(
      [
        pathNode('src/web/main.ts'),
        pathNode('src/web/util.ts'),
        pathNode('src/server/http.ts'),
        pathNode('src/shared/types.ts'),
        pathNode('tests/main.test.ts'),
        pathNode('vite.config.ts') // degree 0 → orphan dock
      ],
      [
        { from: 'src/web/main.ts', to: 'src/shared/types.ts' },
        { from: 'src/server/http.ts', to: 'src/shared/types.ts' },
        { from: 'src/web/main.ts', to: 'src/web/util.ts' },
        { from: 'tests/main.test.ts', to: 'src/web/main.ts' },
        { from: 'src/server/http.ts', to: 'src/web/util.ts' }
      ]
    );
  }

  let view: ReturnType<typeof createGraphView>;
  let cy: FakeCy;

  beforeEach(() => {
    ({ view, cy } = mountView());
  });

  type EleHandle = { nonempty(): boolean; data(key?: string): unknown; hasClass(name: string): boolean };
  const ele = (id: string): EleHandle =>
    (cy as unknown as { getElementById(id: string): EleHandle }).getElementById(id);

  it('mounts a plate per non-empty region, captioned and classed', () => {
    view.setSnapshot(regionFixture());
    expect(ele('plate:web').nonempty()).toBe(true);
    expect(ele('plate:web').hasClass('region-plate')).toBe(true);
    expect(ele('plate:web').data('label')).toBe('WEB · 2');
    expect(ele('plate:spine').data('label')).toBe('SHARED · 1');
    expect(ele('plate:orphan').nonempty()).toBe(true);
    expect(ele('plate:orphan').data('label')).toBe('ORPHANS · 1');
  });

  it('marks cross-region edges edge-cross, leaves intra-region edges plain', () => {
    view.setSnapshot(regionFixture());
    expect(ele('src/web/main.ts->src/shared/types.ts').hasClass('edge-cross')).toBe(true);
    expect(ele('src/server/http.ts->src/web/util.ts').hasClass('edge-cross')).toBe(true);
    expect(ele('src/web/main.ts->src/web/util.ts').hasClass('edge-cross')).toBe(false);
  });

  it('shrinks tests-band balls one notch and leaves the rest full size', () => {
    view.setSnapshot(regionFixture());
    expect(ele('tests/main.test.ts').data('diameter')).toBeCloseTo(diameterOf(1) * 0.85, 6);
    // src/web/main.ts: 2 out + 1 in.
    expect(ele('src/web/main.ts').data('diameter')).toBe(diameterOf(3));
  });

  it('a delta that connects the last orphan retires its plate and rescales the ball', () => {
    view.setSnapshot(regionFixture());
    expect(ele('plate:orphan').nonempty()).toBe(true);

    view.applyDelta({
      addedNodes: [],
      removedNodeIds: [],
      addedEdges: [{ from: 'vite.config.ts', to: 'src/web/main.ts' }],
      removedEdges: []
    });

    expect(ele('vite.config.ts').data('diameter')).toBe(diameterOf(1));
    expect(ele('plate:orphan').nonempty()).toBe(false);
    // vite.config.ts is outside the path table: connected, it becomes an
    // unassigned stray (no region, no plate move) — web stays at 2.
    expect(ele('plate:web').data('label')).toBe('WEB · 2');
  });

  it('installs the plate and edge-cross stylesheet rules', () => {
    view.setSnapshot(regionFixture());
    expect(h.styles[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selector: '.region-plate' }),
        expect.objectContaining({ selector: 'edge.edge-cross' })
      ])
    );
  });
});

describe('layout persistence (Code-review 2026-08-29)', () => {
  // A functional fake: save/update/clear mutate the same map load() hands
  // out, so restore-after-save sequences behave like the real store.
  function makeStore(seed: Record<string, { x: number; y: number }> = {}): LayoutStore & {
    load: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  } {
    const map = new Map(Object.entries(seed));
    const load = vi.fn(() => new Map(map));
    const save = vi.fn((_root: string, positions: ReadonlyMap<string, { x: number; y: number }>) => {
      map.clear();
      for (const [k, v] of positions) map.set(k, { ...v });
    });
    const update = vi.fn((_root: string, id: string, p: { x: number; y: number }) => {
      map.set(id, { ...p });
    });
    const clear = vi.fn(() => map.clear());
    return { load, save, update, clear } as unknown as LayoutStore & {
      load: ReturnType<typeof vi.fn>;
      save: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
    };
  }

  type EleHandle = { nonempty(): boolean; data(key?: string): unknown };
  const eleOf = (cy: FakeCy, id: string): EleHandle =>
    (cy as unknown as { getElementById(id: string): EleHandle }).getElementById(id);
  const posOf = (cy: FakeCy, id: string): { x: number; y: number } =>
    (eleOf(cy, id) as unknown as { position(): { x: number; y: number } }).position();

  // Position assertions need nodes that NO post-pass touches: with an edge
  // they dodge the orphan dock, and `src/*.ts` paths miss the region table,
  // so the rigid compass translation leaves strays alone.
  const strayEdge = (a: ModuleNode, b: ModuleNode): GraphSnapshot =>
    snapshotWith([a, b], [{ from: a.id, to: b.id }]);

  it('a snapshot restores archived positions into the fresh elements', () => {
    const store = makeStore({ 'a.ts': { x: 111, y: 222 } });
    const { view, cy } = mountView({ store });
    view.setSnapshot(strayEdge(node('a.ts'), node('b.ts')));
    expect(posOf(cy, 'a.ts')).toEqual({ x: 111, y: 222 });
    // No archive entry → no preset position (fake default), fcose owns it.
    expect(posOf(cy, 'b.ts')).toEqual({ x: 0, y: 0 });
  });

  it('applyLayout archives the settled layout under the snapshot root', () => {
    const store = makeStore();
    const { view } = mountView({ store });
    view.setSnapshot(snapshotWith([node('a.ts'), node('b.ts')]));
    expect(store.save).toHaveBeenCalledTimes(1);
    const [root, positions] = store.save.mock.calls[0] as [string, Map<string, { x: number; y: number }>];
    expect(root).toBe('/proj');
    expect([...positions.keys()].sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('drag-free persists the drop point (拖放即保存)', () => {
    const store = makeStore();
    const { view, cy } = mountView({ store });
    view.setSnapshot(snapshotWith([node('a.ts')]));
    cy.__fire('dragfree|node', { target: { id: () => 'a.ts', position: () => ({ x: 50, y: 60 }) } });
    expect(store.update).toHaveBeenCalledWith('/proj', 'a.ts', { x: 50, y: 60 });
  });

  it('filter toggles re-render from the archive and never overwrite it', () => {
    const store = makeStore();
    const { view, cy } = mountView({ store });
    // c keeps a.ts connected while the passing ball is hidden, so a.ts stays
    // clear of the orphan dock on the filtered re-render.
    view.setSnapshot(
      snapshotWith(
        [node('a.ts'), node('b.ts', 'passing'), node('c.ts')],
        [
          { from: 'a.ts', to: 'b.ts' },
          { from: 'a.ts', to: 'c.ts' }
        ]
      )
    );
    // Drag a.ts, then hide the passing ball → element swap. a.ts is rebuilt
    // from the archive, and the filtered layout is NOT saved over it.
    cy.__fire('dragfree|node', { target: { id: () => 'a.ts', position: () => ({ x: 50, y: 60 }) } });
    view.setViewState({ hiddenStates: new Set<TestState>(['passing']) });
    expect(posOf(cy, 'a.ts')).toEqual({ x: 50, y: 60 });
    expect(store.save).toHaveBeenCalledTimes(1); // only the unfiltered snapshot solve
  });

  it('resetLayout clears the archive and re-solves from scratch', () => {
    const store = makeStore({ 'a.ts': { x: 111, y: 222 } });
    const { view, cy } = mountView({ store });
    view.setSnapshot(strayEdge(node('a.ts'), node('b.ts')));
    expect(posOf(cy, 'a.ts')).toEqual({ x: 111, y: 222 });
    view.resetLayout();
    expect(store.clear).toHaveBeenCalledWith('/proj');
    expect(posOf(cy, 'a.ts')).toEqual({ x: 0, y: 0 });
  });
});
