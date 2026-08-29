// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphView } from '../src/web/graph-view.js';
import type { Edge, GraphDelta, GraphSnapshot, ModuleNode } from '../src/shared/types.js';

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
function mountView(): { onFocusChange: ReturnType<typeof vi.fn>; view: ReturnType<typeof createGraphView>; cy: FakeCy } {
  h.instances.length = 0;
  h.styles.length = 0;
  const onFocusChange = vi.fn();
  const view = createGraphView(document.createElement('div'), {
    onFocusChange,
    tooltipEl: document.createElement('div')
  });
  return { onFocusChange, view, cy: h.instances[0]! };
}

vi.mock('cytoscape', () => {
  type Ele = {
    id(): string;
    data(key?: string, value?: unknown): unknown;
    remove(): void;
    nonempty(): boolean;
    empty(): boolean;
    addClass(...names: string[]): Ele;
    removeClass(...names: string[]): Ele;
    toggleClass(name: string, force?: boolean): Ele;
    hasClass(name: string): boolean;
    closedNeighborhood(): { edges(): { addClass(): void; removeClass(): void }; addClass(): void };
  };
  type Def = { data: Record<string, unknown>; classes?: string };

  function makeEle(def: Def): Ele {
    const d = { ...def.data };
    const classes = new Set<string>(
      typeof def.classes === 'string' ? def.classes.split(/\s+/).filter(Boolean) : []
    );
    const ele: Ele = {
      id: () => String(d.id),
      data(key?: string, value?: unknown) {
        if (key === undefined) return d;
        if (value !== undefined) d[key] = value;
        return d[key];
      },
      remove() {},
      nonempty: () => true,
      empty: () => false,
    addClass: (...names: string[]) => {
      for (const n of names) classes.add(n);
      return ele;
    },
    removeClass: (...names: string[]) => {
      for (const n of names) classes.delete(n);
      return ele;
    },
    toggleClass: (name: string, force?: boolean) => {
      const want = force ?? !classes.has(name);
      if (want) classes.add(name);
      else classes.delete(name);
      return ele;
    },
    hasClass: (name: string) => classes.has(name),
      closedNeighborhood: () => ({ edges: () => ({ addClass() {}, removeClass() {} }), addClass() {} })
    };
    return ele;
  }

  const EMPTY_ELE: Ele = {
    id: () => '',
    data: () => undefined,
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
        return {
          remove: () => {
            defs.clear();
            eles.clear();
          },
          removeClass() {},
          not: () => ({ addClass() {} })
        };
      },
      nodes() {
        return { empty: () => ![...defs.values()].some((e) => e.data.source === undefined) };
      },
      edges() {
        return {
          forEach(fn: (e: Ele) => void) {
            for (const d of defs.values()) if (d.data.source !== undefined) fn(eleOf(String(d.data.id)));
          }
        };
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
