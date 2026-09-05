// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphView, type GraphView } from '../src/web/graph-view.js';
import { createGraphModel, type GraphModel } from '../src/web/graph-model.js';
import type { Edge, GraphDelta, GraphSnapshot, ModuleNode, TestState } from '../src/shared/types.js';
import type { LayoutMode, LayoutStore } from '../src/web/layout-store.js';
import { diameterOf, THEME } from '../src/web/theme.js';

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
  const layouts: unknown[] = [];
  return { instances, styles, layouts };
});

/** Shared setup for every describe: fresh model+view + their fake cytoscape instance. */
function mountView(opts?: {
  store?: LayoutStore;
  onLayoutModeChange?: (mode: LayoutMode) => void;
}): {
  onFocusChange: ReturnType<typeof vi.fn>;
  model: GraphModel;
  view: GraphView;
  cy: FakeCy;
} {
  h.instances.length = 0;
  h.styles.length = 0;
  h.layouts.length = 0;
  const onFocusChange = vi.fn();
  const model = createGraphModel();
  const view = createGraphView(document.createElement('div'), {
    model,
    onFocusChange,
    tooltipEl: document.createElement('div'),
    ...opts
  });
  // 候选 #4 (2026-09-05): applyX 已在注入的 model 上自己 fold——配对替身
  // 死亡,测试直接用裸 view,「调用即正确」在测试面同样成立。
  return { onFocusChange, model, view, cy: h.instances[0]! };
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
    source(): { id(): string };
    target(): { id(): string };
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
    // 聚类通道 (ADR 0004) reads edge endpoints off the collection — a node-
    // like stub is all detectCommunities needs.
    source: () => ({ id: () => '' }),
    target: () => ({ id: () => '' }),
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
        source: () => ({ id: () => String(d.source ?? '') }),
        target: () => ({ id: () => String(d.target ?? '') }),
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
      __els: list,
      empty: () => list.length === 0,
      nonempty: () => list.length > 0,
      filter(fn: (e: Ele) => boolean) {
        return collection(list.filter(fn));
      },
      union(other: { __els?: Ele[] }) {
        return collection([...list, ...(other?.__els ?? [])]);
      },
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

    // 视口状态 (D5 标签节流)：默认模拟「fit 之后全场入镜」——一个足以覆盖
    // 领地坐标的大盒。测试改 __view 再 __fire('zoom'/'pan') 复现缩放/平移。
    // 模型视口 = [(-panX)/zoom, (width-panX)/zoom] ⇒ pan +5e6 罩住 ±5e6 全域。
    const view = { zoom: 1, panX: 5_000_000, panY: 5_000_000, width: 10_000_000, height: 10_000_000 };
    const cy = {
      __view: view,
      batch(fn: () => void) {
        fn();
      },
      zoom: () => view.zoom,
      pan: () => ({ x: view.panX, y: view.panY }),
      width: () => view.width,
      height: () => view.height,
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
      layout(opts?: unknown) {
        // Code-review 2026-08-29: record the options so tuning tests can pin
        // exactly what reached fcose.
        h.layouts.push(opts);
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

describe('graph-view fold-then-apply (候选 #4, 2026-09-05)', () => {
  it('applySnapshot 单独调用即落账 model——caller 不再 fold', () => {
    const { model, view } = mountView();
    view.applySnapshot(
      snapshotWith([node('a.ts'), node('b.ts')], [{ from: 'a.ts', to: 'b.ts' }])
    );
    expect(model.nodes()).toHaveLength(2);
    expect(model.edges()).toHaveLength(1);
    expect(model.rootPath()).toBe('/proj');
  });

  it('applyDelta 单独调用即把 model 推到目标态', () => {
    const { model, view } = mountView();
    view.applySnapshot(snapshotWith([node('a.ts'), node('b.ts')]));
    view.applyDelta({
      addedNodes: [node('c.ts')],
      removedNodeIds: ['a.ts'],
      addedEdges: [{ from: 'b.ts', to: 'c.ts' }],
      removedEdges: []
    });
    expect(model.node('a.ts')).toBeUndefined();
    expect(model.node('c.ts')?.testState).toBe('untested');
    expect(model.edges()).toEqual([{ from: 'b.ts', to: 'c.ts' }]);
  });

  it('applyNodeUpdate 单独调用即补钉 model', () => {
    const { model, view } = mountView();
    view.applySnapshot(snapshotWith([node('a.ts')]));
    const updated = node('a.ts', 'passing');
    view.applyNodeUpdate(updated);
    expect(model.node('a.ts')).toBe(updated);
  });
});

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
    view.applySnapshot(snapshotWith([a]));
    tap('a.ts');
    expect(onFocusChange).toHaveBeenLastCalledWith(a);
  });

  it('opens the detail panel for a node that arrived via applyDelta (ticket acceptance)', () => {
    const a = node('a.ts');
    const b = node('b.ts');
    view.applySnapshot(snapshotWith([a]));
    view.applyDelta({ addedNodes: [b], removedNodeIds: [], addedEdges: [], removedEdges: [] });

    tap('b.ts');
    expect(onFocusChange).toHaveBeenLastCalledWith(b);
  });

  it('reflects applyNodeUpdate patches on the next tap', () => {
    const a = node('a.ts');
    view.applySnapshot(snapshotWith([a]));
    const updated = node('a.ts', 'passing');
    view.applyNodeUpdate(updated);

    tap('a.ts');
    expect(onFocusChange).toHaveBeenLastCalledWith(updated);
  });

  it('clears focus when the locked node is removed by a delta', () => {
    const a = node('a.ts');
    const b = node('b.ts');
    view.applySnapshot(snapshotWith([a, b]));
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
    view.applySnapshot(snapshotWith([bad, node('ok.ts')]));
    expect(dataOf('bad.ts', 'typeErrorCount')).toBe(2);
    expect(dataOf('ok.ts', 'typeErrorCount')).toBe(0);
  });

  it('applyNodeUpdate clears the count when errors are fixed', () => {
    const bad: ModuleNode = { ...node('bad.ts'), typeErrors: [{ line: 1, code: 'TS2322', message: 'x' }] };
    view.applySnapshot(snapshotWith([bad]));
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
    view.applySnapshot(snapshotWith([a]));

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
    view.applySnapshot(snapshotWith([a]));
    expect(ele('a.ts').hasClass('checking')).toBe(true);
  });

  it('installs the checking stylesheet rule and counts rendered cycle arcs', () => {
    expect(h.styles[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ selector: 'node.checking' })])
    );

    view.applySnapshot(
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
    view.applySnapshot(snapshotWith([err, ok]));
    expect(dataOf('err.ts', 'reviewVerdict')).toBe('error');
    expect(dataOf('ok.ts', 'reviewVerdict')).toBe('confident');
  });

  it('applyNodeUpdate clears the ring while checking and re-colors once done', () => {
    const a = node('a.ts');
    view.applySnapshot(snapshotWith([a]));
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

describe('view controls: 只看未测 / 搜索 / 图例过滤 (ticket 11 seam 4)', () => {
  // Fixture 拓扑:pkg 三枚直挂文件、solo 两枚、main.ts 根层(目录折叠
  // 已随 ADR 0002 退役,这里只作过滤/搜索的选取面)。
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
    view.applySnapshot(controlFixture());
    view.setViewState({ untestedOnly: true });
    expect(visible('pkg/a.ts')).toBe(true);
    expect(visible('pkg/b.ts')).toBe(true);
    expect(visible('main.ts')).toBe(false);
    expect(visible('pkg/c.ts')).toBe(false);
    expect(visible('main.ts->pkg/a.ts')).toBe(false);
    expect(visible('pkg/a.ts->pkg/b.ts')).toBe(true);
  });

  it('delta keeps 只看未测 honest: an untested newcomer renders, a passing one does not', () => {
    view.applySnapshot(controlFixture());
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
    view.applySnapshot(controlFixture());
    view.setViewState({ untestedOnly: true });
    view.applyNodeUpdate(node('pkg/a.ts', 'passing'));
    expect(visible('pkg/a.ts')).toBe(false);
  });

  it('hideReviewed removes reviewed balls (and their edges) until toggled off', () => {
    view.applySnapshot(controlFixture());
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
    view.applySnapshot(controlFixture());
    view.setViewState({ query: 'PKG/B' });
    expect(visible('pkg/b.ts')).toBe(true);
    expect(visible('pkg/a.ts')).toBe(false);
    expect(visible('main.ts')).toBe(false);
    view.setViewState({ query: '' });
    expect(visible('main.ts')).toBe(true);
    expect(visible('pkg/a.ts')).toBe(true);
  });

  it('filtering away the locked node clears the focus lock', () => {
    view.applySnapshot(controlFixture());
    tap('solo/e.ts');
    expect(onFocusChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'solo/e.ts' }));
    view.setViewState({ untestedOnly: true });
    expect(onFocusChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps the lock visuals when a re-render keeps the locked ball visible', () => {
    view.applySnapshot(controlFixture());
    tap('pkg/a.ts');
    view.setViewState({ query: 'pkg/a' });
    expect(visible('pkg/a.ts')).toBe(true);
    expect(ele('pkg/a.ts').hasClass('focused')).toBe(true);
  });

  it('focusNode ignores a ball hidden by the active filter; visible balls still jump', () => {
    view.applySnapshot(controlFixture());
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

  // 2026-09-01 R2 缺省翻转为聚类：罗盘管线不再默认接管，本套件显式递一份
  // 记着 'regions' 的 store（对齐新语义：只有显式 regions 记录才走区域）。
  const regionsStore = (): LayoutStore => ({
    load: () => new Map(),
    save: () => {},
    update: () => {},
    clear: () => {},
    getMode: () => 'regions',
    setMode: () => {}
  });

  beforeEach(() => {
    ({ view, cy } = mountView({ store: regionsStore() }));
  });

  type EleHandle = { nonempty(): boolean; data(key?: string): unknown; hasClass(name: string): boolean };
  const ele = (id: string): EleHandle =>
    (cy as unknown as { getElementById(id: string): EleHandle }).getElementById(id);

  it('mounts a plate per non-empty region, captioned and classed', () => {
    view.applySnapshot(regionFixture());
    expect(ele('plate:web').nonempty()).toBe(true);
    expect(ele('plate:web').hasClass('region-plate')).toBe(true);
    expect(ele('plate:web').data('label')).toBe('WEB · 2');
    expect(ele('plate:spine').data('label')).toBe('SHARED · 1');
    expect(ele('plate:orphan').nonempty()).toBe(true);
    expect(ele('plate:orphan').data('label')).toBe('ORPHANS · 1');
  });

  it('marks cross-region edges edge-cross, leaves intra-region edges plain', () => {
    view.applySnapshot(regionFixture());
    expect(ele('src/web/main.ts->src/shared/types.ts').hasClass('edge-cross')).toBe(true);
    expect(ele('src/server/http.ts->src/web/util.ts').hasClass('edge-cross')).toBe(true);
    expect(ele('src/web/main.ts->src/web/util.ts').hasClass('edge-cross')).toBe(false);
  });

  it('shrinks tests-band balls one notch and leaves the rest full size', () => {
    view.applySnapshot(regionFixture());
    expect(ele('tests/main.test.ts').data('diameter')).toBeCloseTo(diameterOf(1) * 0.85, 6);
    // src/web/main.ts: 2 out + 1 in.
    expect(ele('src/web/main.ts').data('diameter')).toBe(diameterOf(3));
  });

  it('a delta that connects the last orphan retires its plate and rescales the ball', () => {
    view.applySnapshot(regionFixture());
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
    view.applySnapshot(regionFixture());
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
  function makeStore(
    seed: Record<string, { x: number; y: number }> = {},
    mode?: LayoutMode
  ): LayoutStore & {
    load: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    getMode: ReturnType<typeof vi.fn>;
    setMode: ReturnType<typeof vi.fn>;
  } {
    const map = new Map(Object.entries(seed));
    const modes = new Map<string, LayoutMode>();
    if (mode !== undefined) modes.set('/proj', mode);
    const load = vi.fn((_root: string) => new Map(map));
    const save = vi.fn((_root: string, positions: ReadonlyMap<string, { x: number; y: number }>) => {
      map.clear();
      for (const [k, v] of positions) map.set(k, { ...v });
    });
    const update = vi.fn((_root: string, id: string, p: { x: number; y: number }) => {
      map.set(id, { ...p });
    });
    const clear = vi.fn((_root: string) => map.clear());
    const getMode = vi.fn((_root: string): LayoutMode => modes.get('/proj') ?? 'regions');
    const setMode = vi.fn((_root: string, m: LayoutMode) => modes.set('/proj', m));
    return { load, save, update, clear, getMode, setMode } as unknown as LayoutStore & {
      load: ReturnType<typeof vi.fn>;
      save: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
      getMode: ReturnType<typeof vi.fn>;
      setMode: ReturnType<typeof vi.fn>;
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
    view.applySnapshot(strayEdge(node('a.ts'), node('b.ts')));
    expect(posOf(cy, 'a.ts')).toEqual({ x: 111, y: 222 });
    // No archive entry → no preset position (fake default), fcose owns it.
    expect(posOf(cy, 'b.ts')).toEqual({ x: 0, y: 0 });
  });

  it('applyLayout archives the settled layout under the snapshot root', () => {
    const store = makeStore();
    const { view } = mountView({ store });
    view.applySnapshot(snapshotWith([node('a.ts'), node('b.ts')]));
    expect(store.save).toHaveBeenCalledTimes(1);
    const [root, positions] = store.save.mock.calls[0] as [
      string,
      Map<string, { x: number; y: number }>
    ];
    expect(root).toBe('/proj');
    expect([...positions.keys()].sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('drag-free persists the drop point (拖放即保存)', () => {
    const store = makeStore();
    const { view, cy } = mountView({ store });
    view.applySnapshot(snapshotWith([node('a.ts')]));
    cy.__fire('dragfree|node', { target: { id: () => 'a.ts', position: () => ({ x: 50, y: 60 }) } });
    expect(store.update).toHaveBeenCalledWith('/proj', 'a.ts', { x: 50, y: 60 });
  });

  it('filter toggles re-render from the archive and never overwrite it', () => {
    const store = makeStore();
    const { view, cy } = mountView({ store });
    // c keeps a.ts connected while the passing ball is hidden, so a.ts stays
    // clear of the orphan dock on the filtered re-render.
    view.applySnapshot(
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
    view.applySnapshot(strayEdge(node('a.ts'), node('b.ts')));
    expect(posOf(cy, 'a.ts')).toEqual({ x: 111, y: 222 });
    view.resetLayout();
    expect(store.clear).toHaveBeenCalledWith('/proj');
    // 存档清空 → 旧位 {111,222} 拿不回，两只 stray 重逢 (0,0)。2026-09-01 D3
    // 全场硬保证：重合对按 id 序沿 x 拆开，a.ts 吃 −need/2（need = d + ballGap）。
    const need = diameterOf(1) + THEME.layout.ballGap;
    expect(posOf(cy, 'a.ts').x).toBeCloseTo(-need / 2, 6);
    expect(posOf(cy, 'a.ts').y).toBeCloseTo(0, 6);
  });
});

describe('固定布局力 (2026-08-30 用户裁定: 四力不可调,滑杆通道已拆除)', () => {
  const lastLayout = (): Record<string, unknown> =>
    h.layouts[h.layouts.length - 1] as Record<string, unknown>;

  it('every solve pins the fixed THEME.fcose constants', () => {
    // 显式 regions store：2026-09-01 海报质量修正后聚类分支自带 fcose 覆盖
    // （numIter 600 / gravity 1.2 / clusterIdealEdgeLength，钉在 聚类接线 套件）,
    // 本套件钉的是共享 THEME.fcose——只有 regions 路径逐字吃到它。
    const store: LayoutStore = {
      load: () => new Map(),
      save: () => {},
      update: () => {},
      clear: () => {},
      getMode: () => 'regions',
      setMode: () => {}
    };
    const { view } = mountView({ store });
    view.applySnapshot(snapshotWith([node('a.ts'), node('b.ts')], [{ from: 'a.ts', to: 'b.ts' }]));
    view.resetLayout();
    expect(lastLayout()).toEqual(
      expect.objectContaining({
        name: 'fcose',
        gravity: 0.25,
        edgeElasticity: 0.7,
        nodeSeparation: 150,
        randomize: false
      })
    );
    // 2026-08-31 等空隙裁定: idealEdgeLength 从常数 78 换代为函数形式
    // (spacingGap + 两端半径,纯函数断言在 theme-palette.test.ts)。
    expect(typeof lastLayout().idealEdgeLength).toBe('function');
    // 同日二次裁定(大球间距): nodeRepulsion 换代为尺寸感知函数,
    // base×min(16,(r/minR)²) 的纯函数断言在 theme-palette.test.ts。
    expect(typeof lastLayout().nodeRepulsion).toBe('function');
  });
});

describe('新球种子落点 (Code-review 2026-08-29)', () => {
  // Minimal functional store fake (same shape as the persistence suite's).
  function makeStore(seed: Record<string, { x: number; y: number }> = {}): LayoutStore {
    const map = new Map(Object.entries(seed));
    return {
      load: () => new Map(map),
      save: (_root, positions) => {
        map.clear();
        for (const [k, v] of positions) map.set(k, { ...v });
      },
      update: (_root, id, p) => {
        map.set(id, { ...p });
      },
      clear: () => map.clear(),
      getMode: () => 'regions',
      setMode: () => {}
    };
  }

  const posOf = (cy: FakeCy, id: string): { x: number; y: number } =>
    (
      cy as unknown as {
        getElementById(id: string): { position(): { x: number; y: number } };
      }
    )
      .getElementById(id)
      .position();

  // a/b stay UNREGIONED strays (src/*.ts misses the path table but carries
  // edges), so no post-pass touches them or the seeded newcomer — position
  // assertions read exactly what applyDelta wrote.
  function runSeedScenario(): { x: number; y: number } {
    const store = makeStore({ 'a.ts': { x: 100, y: 100 } });
    const { view, cy } = mountView({ store });
    view.applySnapshot(
      snapshotWith([node('a.ts'), node('b.ts')], [{ from: 'a.ts', to: 'b.ts' }])
    );
    view.applyDelta({
      addedNodes: [node('c.ts')],
      removedNodeIds: [],
      addedEdges: [{ from: 'a.ts', to: 'c.ts' }],
      removedEdges: []
    });
    return posOf(cy, 'c.ts');
  }

  it('a fresh ball seeds off its existing-neighbor centroid, 30–70px away', () => {
    const p = runSeedScenario();
    const d = Math.hypot(p.x - 100, p.y - 100);
    expect(d).toBeGreaterThanOrEqual(30);
    expect(d).toBeLessThanOrEqual(70);
  });

  it('the seed is a pure function of the inputs — two runs land bitwise equal', () => {
    expect(runSeedScenario()).toEqual(runSeedScenario());
  });

  it('brand-new balls with no EXISTING neighbor get no seed (fcose owns them)', () => {
    const { view, cy } = mountView({ store: makeStore() });
    view.applySnapshot(snapshotWith([node('a.ts')]));
    view.applyDelta({
      addedNodes: [node('c.ts'), node('d.ts')],
      removedNodeIds: [],
      addedEdges: [{ from: 'c.ts', to: 'd.ts' }],
      removedEdges: []
    });
    // Each is the other's only neighbor and neither exists at seed time →
    // no seed → they land coincident at (0,0). 2026-09-01 D3: the global
    // minimum-distance pass no longer leaves strays stacked — the pair is
    // split apart, ≥ diameter+ballGap center-to-center.
    const pc = posOf(cy, 'c.ts');
    const pd = posOf(cy, 'd.ts');
    expect(
      Math.hypot(pc.x - pd.x, pc.y - pd.y)
    ).toBeGreaterThanOrEqual(diameterOf(1) + THEME.layout.ballGap - 1e-6);
  });

  it('the archive beats the seed for a re-entering ball', () => {
    const store = makeStore({ 'a.ts': { x: 100, y: 100 } });
    const { view, cy } = mountView({ store });
    view.applySnapshot(snapshotWith([node('a.ts'), node('b.ts')], [{ from: 'a.ts', to: 'b.ts' }]));
    // The snapshot's wholesale save only keeps a/b — re-add the re-entering
    // ball's entry afterwards (it stands in for an archive spot that outlived
    // the removal, e.g. a watcher flicker that netted out before a save).
    store.update('/proj', 'c.ts', { x: 500, y: 500 });
    view.applyDelta({
      addedNodes: [node('c.ts')],
      removedNodeIds: [],
      addedEdges: [{ from: 'a.ts', to: 'c.ts' }],
      removedEdges: []
    });
    expect(posOf(cy, 'c.ts')).toEqual({ x: 500, y: 500 });
  });
});

describe('聚类排列模式接线 (ADR 0004)', () => {
  // Mode-aware store fake (the persistence suite's makeStore is scoped there).
  function makeStore(
    seed: Record<string, { x: number; y: number }> = {},
    mode?: LayoutMode
  ): LayoutStore & {
    load: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    getMode: ReturnType<typeof vi.fn>;
    setMode: ReturnType<typeof vi.fn>;
  } {
    const map = new Map(Object.entries(seed));
    const modes = new Map<string, LayoutMode>();
    if (mode !== undefined) modes.set('/proj', mode);
    const load = vi.fn((_root: string) => new Map(map));
    const save = vi.fn((_root: string, positions: ReadonlyMap<string, { x: number; y: number }>) => {
      map.clear();
      for (const [k, v] of positions) map.set(k, { ...v });
    });
    const getMode = vi.fn((_root: string): LayoutMode => modes.get('/proj') ?? 'regions');
    const setMode = vi.fn((_root: string, m: LayoutMode) => modes.set('/proj', m));
    return { load, save, getMode, setMode, update: vi.fn(), clear: vi.fn() } as unknown as LayoutStore & {
      load: ReturnType<typeof vi.fn>;
      save: ReturnType<typeof vi.fn>;
      getMode: ReturnType<typeof vi.fn>;
      setMode: ReturnType<typeof vi.fn>;
    };
  }

  function pathNode(path: string): ModuleNode {
    return { id: path, path, language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [] };
  }
  function clusterFixture(): GraphSnapshot {
    return snapshotWith(
      [
        pathNode('src/web/main.ts'),
        pathNode('src/web/util.ts'),
        pathNode('src/server/http.ts'),
        pathNode('tests/main.test.ts')
      ],
      [
        { from: 'src/web/main.ts', to: 'src/web/util.ts' },
        { from: 'src/server/http.ts', to: 'src/web/main.ts' },
        { from: 'tests/main.test.ts', to: 'src/web/main.ts' }
      ]
    );
  }

  type EleHandle = {
    nonempty(): boolean;
    position(): { x: number; y: number };
  };
  const ele = (cy: FakeCy, id: string): EleHandle =>
    (cy as unknown as { getElementById(id: string): EleHandle }).getElementById(id);

  it('聚类求解喂的是 D1/D2 覆盖（numIter 600 / gravity 1.2 / clusterIdealEdgeLength）', () => {
    const store = makeStore({}, 'cluster');
    const { view } = mountView({ store });
    view.applySnapshot(clusterFixture());
    const opts = h.layouts[h.layouts.length - 1] as Record<string, unknown>;
    expect(opts).toEqual(
      expect.objectContaining({
        name: 'fcose',
        numIter: THEME.layout.cluster.fcose.numIter,
        gravity: THEME.layout.cluster.fcose.gravity,
        randomize: false,
        nodeSeparation: 150
      })
    );
    expect(typeof opts.idealEdgeLength).toBe('function');
  });

  it('snapshot resolves the per-root mode and announces it (store.getMode, not localStorage)', () => {
    const onMode = vi.fn();
    const store = makeStore({}, 'cluster');
    const { view } = mountView({ store, onLayoutModeChange: onMode });
    expect(view.getLayoutMode()).toBe('cluster'); // 快照前默认（2026-09-01 R2 翻转）
    view.applySnapshot(clusterFixture());
    expect(view.getLayoutMode()).toBe('cluster');
    expect(onMode).toHaveBeenLastCalledWith('cluster');
    expect(store.getMode).toHaveBeenCalledWith('/proj');
  });

  it('cluster render: no region plates, birth-point positions, archive untouched for solving', () => {
    const store = makeStore({ 'src/web/main.ts': { x: 111, y: 222 } }, 'cluster');
    const { view, cy } = mountView({ store });
    view.applySnapshot(clusterFixture());
    // 区域模式会挂 plate:*——聚类通道整体跳过罗盘与题注。
    expect(ele(cy, 'plate:web').nonempty()).toBe(false);
    expect(ele(cy, 'plate:server').nonempty()).toBe(false);
    // 求解零种子：archive 从不参与（load 未调，位置不是存档位也不是默认零点）。
    expect(store.load).not.toHaveBeenCalled();
    const p = ele(cy, 'src/web/main.ts').position();
    expect(p).not.toEqual({ x: 111, y: 222 });
    expect(Math.hypot(p.x, p.y)).toBeGreaterThan(0);
    // D5 write-through：求解完照常回写最后稳定布局。
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('setLayoutMode persists per-root, announces, and re-renders; same mode is a no-op', () => {
    const onMode = vi.fn();
    const store = makeStore({}, 'cluster');
    const { view } = mountView({ store, onLayoutModeChange: onMode });
    view.applySnapshot(clusterFixture());
    onMode.mockClear();
    view.setLayoutMode('cluster'); // 同值 → 不播报、不重渲
    expect(onMode).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledTimes(1);

    view.setLayoutMode('regions');
    expect(view.getLayoutMode()).toBe('regions');
    expect(store.setMode).toHaveBeenCalledWith('/proj', 'regions');
    expect(onMode).toHaveBeenLastCalledWith('regions');
    expect(store.save).toHaveBeenCalledTimes(2); // 区域管线重解后又 write-through
  });

  it('back in regions mode the archive written by cluster solves replays (D5 互为种子)', () => {
    const store = makeStore({}, 'cluster');
    const { view, cy } = mountView({ store });
    view.applySnapshot(clusterFixture());
    const clusterPos = { ...ele(cy, 'src/web/main.ts').position() };
    view.setLayoutMode('regions');
    // 存档里是聚类落点（无 physics 基线 = cy 位置原样入档），区域回放拿回的
    // 正是它——罗盘平移对无区域 strayed 成员只做刚体搬移，逐位对比不稳，
    // 但 load 必须真的被调用（不再零种子）。
    expect(store.load).toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledTimes(2);
    const savedPoints = store.save.mock.calls[0]![1] as Map<string, { x: number; y: number }>;
    expect(savedPoints.get('src/web/main.ts')).toEqual(clusterPos);
  });
});

describe('标签节流 (2026-09-01 D5)', () => {
  type CyWithView = {
    __fire(key: string, evt: unknown): void;
    __view: { zoom: number; panX: number; panY: number; width: number; height: number };
    getElementById(id: string): { hasClass(name: string): boolean };
  };

  function labelSet(cy: FakeCy, ids: string[]): string[] {
    const c = cy as unknown as CyWithView;
    return ids.filter((id) => c.getElementById(id).hasClass('labeled'));
  }

  function starFixture(size: number): GraphSnapshot {
    const leaves = Array.from({ length: size }, (_, i) => node(`l${String(i).padStart(2, '0')}.ts`));
    const hub = node('hub.ts');
    return snapshotWith(
      [hub, ...leaves],
      leaves.map((l) => ({ from: 'hub.ts', to: l.id }))
    );
  }

  it('小图（≤ viewportMax 球）全开：每颗带 .labeled', () => {
    const { view, cy } = mountView();
    view.applySnapshot(starFixture(4));
    const ids = ['hub.ts', ...Array.from({ length: 4 }, (_, i) => `l0${i}.ts`)];
    expect(labelSet(cy, ids).length).toBe(5);
  });

  it('默认档 = 度数前 hubCount，平票按 id 升序（确定性可复算）', () => {
    const { view, cy } = mountView();
    view.applySnapshot(starFixture(40)); // 41 球 > viewportMax 40
    const leaves = Array.from({ length: 40 }, (_, i) => `l${String(i).padStart(2, '0')}.ts`);
    const labeled = labelSet(cy as unknown as FakeCy, ['hub.ts', ...leaves]);
    expect(labeled.length).toBe(THEME.labels.hubCount);
    expect(labeled).toContain('hub.ts');
    // 40 颗度 1 叶子取前 23（id 升序决胜）：l00..l22 在、l23 不在。
    expect(labeled).toContain('l22.ts');
    expect(labeled).not.toContain('l23.ts');
  });

  it('放大只重判视口：罩住一颗球时全开=只有它', () => {
    const { view, cy } = mountView();
    view.applySnapshot(starFixture(40)); // >40 球默认档只有 24 个标签
    const c = cy as unknown as CyWithView;
    const p = (
      cy as unknown as { getElementById(id: string): { position(): { x: number; y: number } } }
    ).getElementById('l37.ts').position();
    Object.assign(c.__view, { zoom: 2, panX: -(p.x - 2.5) * 2, panY: -(p.y - 2.5) * 2, width: 5, height: 5 });
    c.__fire('zoom', {});
    const leaves = Array.from({ length: 40 }, (_, i) => `l${String(i).padStart(2, '0')}.ts`);
    const labeled = labelSet(cy, ['hub.ts', ...leaves]);
    expect(labeled).toHaveLength(1);
    expect(labeled[0]).toBe('l37.ts');
  });

  it('hub 集在结构变化时重算：applyDelta 新球以最小 id 挤掉末位 hub', () => {
    const { view, cy } = mountView();
    view.applySnapshot(starFixture(40));
    view.applyDelta({
      addedNodes: [node('AAA.ts')],
      removedNodeIds: [],
      addedEdges: [{ from: 'hub.ts', to: 'AAA.ts' }],
      removedEdges: []
    });
    const c = cy as unknown as CyWithView;
    expect(c.getElementById('AAA.ts').hasClass('labeled')).toBe(true);
    expect(c.getElementById('l22.ts').hasClass('labeled')).toBe(false); // 被平票挤下
    expect(c.getElementById('hub.ts').hasClass('labeled')).toBe(true);
    const leaves = Array.from({ length: 40 }, (_, i) => `l${String(i).padStart(2, '0')}.ts`);
    expect(labelSet(cy, [c ? 'AAA.ts' : '', 'hub.ts', ...leaves].filter(Boolean)).length).toBe(
      THEME.labels.hubCount
    );
  });

  it('label 走 class 通道：base 规则无字，.labeled/.focused 各自接回，题注板不受影响', () => {
    const styles = (h.styles[0] ?? []) as Array<{
      selector: string;
      style?: Record<string, unknown>;
    }>;
    const base = styles.find((r) => r.selector === 'node');
    expect(base?.style?.label).toBe('');
    const labeled = styles.find((r) => r.selector === 'node.labeled');
    expect(labeled?.style?.label).toBe('data(label)');
    const focused = styles.find((r) => r.selector === 'node.focused');
    expect(focused?.style?.label).toBe('data(label)');
    const plate = styles.find((r) => r.selector === '.region-plate');
    expect(plate?.style?.label).toBe('data(label)');
  });
});

describe('ADR 0002 §7.2 改动标记: 三通道 + 新范围=新基线', () => {
  // Module-table paths plus an out-of-table file: scope marks read the module
  // table via deriveScopeMarks, so fixtures keep a mixed membership.
  function markerFixture(): GraphSnapshot {
    return snapshotWith(
      [
        node('src/server/mcp.ts'),
        node('src/server/index.ts'),
        node('src/server/incremental-graph.ts'),
        node('src/web/main.ts'),
        node('src/shared/types.ts'),
        node('package.json')
      ],
      [
        { from: 'src/server/mcp.ts', to: 'src/server/index.ts' },
        { from: 'src/server/mcp.ts', to: 'src/shared/types.ts' },
        { from: 'src/shared/types.ts', to: 'src/server/mcp.ts' },
        { from: 'src/web/main.ts', to: 'src/shared/types.ts' },
        { from: 'src/web/main.ts', to: 'package.json' }
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

  it('改动标记: 范围紫环 / 已改紫 / 越界红角标（三条独立 class 通道）', () => {
    view.applySnapshot(markerFixture());
    view.setEditScope({ modules: ['mcp-service'], files: ['package.json'] });
    expect(ele('src/server/mcp.ts').hasClass('in-scope')).toBe(true);
    expect(ele('src/server/index.ts').hasClass('in-scope')).toBe(true);
    expect(ele('package.json').hasClass('in-scope')).toBe(true); // 显式点名
    expect(ele('src/web/main.ts').hasClass('in-scope')).toBe(false);

    view.setEditVerification({
      edited: ['src/server/mcp.ts', 'src/web/main.ts', 'package.json'],
      outOfScope: ['src/web/main.ts'],
      unreported: []
    });
    expect(ele('src/server/mcp.ts').hasClass('edited')).toBe(true);
    expect(ele('src/server/mcp.ts').hasClass('out-of-scope')).toBe(false);
    expect(ele('src/web/main.ts').hasClass('edited')).toBe(true);
    expect(ele('src/web/main.ts').hasClass('out-of-scope')).toBe(true);
    expect(String(ele('src/web/main.ts').data('label'))).toContain('⛔'); // 红角标文案
    expect(ele('package.json').hasClass('edited')).toBe(true);
  });

  it('新范围 = 新基线: setEditScope 清掉已改/越界标记', () => {
    view.applySnapshot(markerFixture());
    view.setEditScope({ modules: ['mcp-service'], files: [] });
    view.setEditVerification({ edited: ['src/server/mcp.ts'], outOfScope: ['src/web/main.ts'], unreported: [] });
    expect(ele('src/server/mcp.ts').hasClass('edited')).toBe(true);
    expect(ele('src/web/main.ts').hasClass('out-of-scope')).toBe(true);
    view.setEditScope({ modules: ['graph-engine'], files: [] });
    expect(ele('src/server/mcp.ts').hasClass('edited')).toBe(false);
    expect(ele('src/web/main.ts').hasClass('out-of-scope')).toBe(false);
    expect(ele('src/server/incremental-graph.ts').hasClass('in-scope')).toBe(true);
  });
});
