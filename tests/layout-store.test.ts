// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutStore } from '../src/web/layout-store.js';
import { CHROME } from '../src/web/theme.js';

/**
 * Code-review 2026-08-29: the layout archive under mg-layout — one JSON
 * document, versioned, keyed by rootPath, degrading to memory-only when
 * localStorage refuses (private mode / quota).
 *
 * ADR 0003: rootPath 单档 —— the module视图 mode 分档随视图一起退役，
 * 旧分档档案整体作废、不迁移。
 */

const seed = (value: unknown): void => localStorage.setItem(CHROME.layoutStorageKey, JSON.stringify(value));

describe('layout-store (mg-layout)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips positions per root', () => {
    const store = createLayoutStore();
    store.save('/proj', new Map([['a.ts', { x: 12, y: 34 }]]));
    expect(store.load('/proj')).toEqual(new Map([['a.ts', { x: 12, y: 34 }]]));
    // And it survives a fresh store instance (real persistence).
    expect(createLayoutStore().load('/proj')).toEqual(new Map([['a.ts', { x: 12, y: 34 }]]));
  });

  it('keeps roots isolated', () => {
    const store = createLayoutStore();
    store.save('/a', new Map([['x.ts', { x: 1, y: 1 }]]));
    store.save('/b', new Map([['y.ts', { x: 2, y: 2 }]]));
    expect(store.load('/a').has('y.ts')).toBe(false);
    expect(store.load('/b').has('x.ts')).toBe(false);
  });

  it('save replaces a root wholesale — gone nodes drop out', () => {
    const store = createLayoutStore();
    store.save('/proj', new Map([['old.ts', { x: 1, y: 1 }]]));
    store.save('/proj', new Map([['new.ts', { x: 2, y: 2 }]]));
    expect(store.load('/proj')).toEqual(new Map([['new.ts', { x: 2, y: 2 }]]));
  });

  it('update upserts a single point without touching siblings', () => {
    const store = createLayoutStore();
    store.save('/proj', new Map([['a.ts', { x: 1, y: 2 }]]));
    store.update('/proj', 'a.ts', { x: 9, y: 9 });
    store.update('/proj', 'b.ts', { x: 3, y: 4 });
    expect(store.load('/proj')).toEqual(
      new Map([
        ['a.ts', { x: 9, y: 9 }],
        ['b.ts', { x: 3, y: 4 }]
      ])
    );
  });

  it('clear forgets exactly one root', () => {
    const store = createLayoutStore();
    store.save('/a', new Map([['x.ts', { x: 1, y: 1 }]]));
    store.save('/b', new Map([['y.ts', { x: 2, y: 2 }]]));
    store.clear('/a');
    expect(store.load('/a').size).toBe(0);
    expect(store.load('/b').size).toBe(1);
  });

  it('ADR 0003 单档化: the v5 mode-bucketed archive is ignored wholesale', () => {
    seed({
      v: 5,
      roots: {
        '/proj': {
          file: { 'a.ts': { x: 1, y: 1 } },
          module: { 'pile:mcp-service': { x: 9, y: 9 } }
        }
      }
    });
    const store = createLayoutStore();
    expect(store.load('/proj').size).toBe(0);
    // A save rewrites the root in the new single-tier shape at the new version.
    store.save('/proj', new Map([['a.ts', { x: 2, y: 2 }]]));
    expect(createLayoutStore().load('/proj')).toEqual(new Map([['a.ts', { x: 2, y: 2 }]]));
    const raw = JSON.parse(localStorage.getItem(CHROME.layoutStorageKey)!) as {
      v: number;
      roots: Record<string, unknown>;
    };
    expect(raw.v).toBe(6);
    expect(raw.roots['/proj']).toEqual({ 'a.ts': { x: 2, y: 2 } });
  });

  it('a version mismatch resets the archive', () => {
    seed({ v: 0, roots: { '/old': { 'x.ts': { x: 1, y: 2 } } } });
    const store = createLayoutStore();
    expect(store.load('/old').size).toBe(0);
    // And a save rewrites the archive at the current version.
    store.save('/new', new Map([['y.ts', { x: 5, y: 6 }]]));
    expect(createLayoutStore().load('/new')).toEqual(new Map([['y.ts', { x: 5, y: 6 }]]));
  });

  it('corrupt JSON resets the archive instead of throwing', () => {
    localStorage.setItem(CHROME.layoutStorageKey, '{not json');
    const store = createLayoutStore();
    expect(store.load('/proj').size).toBe(0);
    expect(() => store.save('/proj', new Map())).not.toThrow();
  });

  it('loads only finite numeric points', () => {
    seed({ v: 6, roots: { '/proj': { good: { x: 1, y: 2 }, bad: { x: '1', y: 2 }, worse: null } } });
    const store = createLayoutStore();
    expect(store.load('/proj')).toEqual(new Map([['good', { x: 1, y: 2 }]]));
  });

  describe('排列模式 (ADR 0004/D1 + 2026-09-01 R2 翻转)', () => {
    it('defaults to cluster and round-trips an explicit regions per root (version stays 6)', () => {
      const store = createLayoutStore();
      expect(store.getMode('/proj')).toBe('cluster'); // R2 翻转：缺省 = 聚类
      store.setMode('/proj', 'regions');
      expect(createLayoutStore().getMode('/proj')).toBe('regions');
      // 模式跟 root 走：别的仓库不受影响。
      expect(store.getMode('/other')).toBe('cluster');
      const raw = JSON.parse(localStorage.getItem(CHROME.layoutStorageKey)!) as {
        v: number;
        roots: Record<string, unknown>;
        modes: Record<string, string>;
      };
      expect(raw.v).toBe(6); // modes 是可选并列字段——不升版本，旧档不作废
      store.save('/proj', new Map([['a.ts', { x: 1, y: 1 }]]));
      expect(store.getMode('/proj')).toBe('regions'); // save 不踩 modes
      store.clear('/proj');
      expect(store.getMode('/proj')).toBe('regions'); // 重置布局只清位置，不清模式
    });

    it('old archives without modes load as cluster; dirty values fall back to cluster, explicit regions wins', () => {
      seed({ v: 6, roots: { '/proj': { 'a.ts': { x: 1, y: 2 } } } });
      let store = createLayoutStore();
      expect(store.getMode('/proj')).toBe('cluster'); // 旧档缺 modes → 聚类海报开场
      expect(store.load('/proj').size).toBe(1); // 位置档照常有效

      seed({ v: 6, roots: {}, modes: { '/proj': 'spiral-vibes', '/r': 'regions' } });
      store = createLayoutStore();
      expect(store.getMode('/proj')).toBe('cluster'); // 脏值回落，不炸不存脏
      expect(store.getMode('/r')).toBe('regions'); // 显式 regions 是唯一被认下的非缺省值
    });

    it('mode survives position invalidation (version mismatch wipes roots, modes ride along)', () => {
      const store = createLayoutStore();
      store.setMode('/proj', 'regions');
      store.save('/proj', new Map([['a.ts', { x: 1, y: 1 }]]));
      seed({ v: 999, roots: {}, modes: { '/proj': 'regions' } }); // 模拟换代
      expect(createLayoutStore().getMode('/proj')).toBe('cluster'); // 整档作废：模式也回默认
      localStorage.setItem(CHROME.layoutStorageKey, JSON.stringify({ v: 6, roots: {} }));
      const fresh = createLayoutStore();
      fresh.setMode('/p2', 'regions');
      expect(fresh.getMode('/p2')).toBe('regions');
    });
  });

  it('a throwing localStorage degrades to memory-only', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      const store = createLayoutStore();
      expect(() => store.save('/proj', new Map([['a.ts', { x: 1, y: 1 }]]))).not.toThrow();
      expect(store.load('/proj')).toEqual(new Map([['a.ts', { x: 1, y: 1 }]]));
    } finally {
      spy.mockRestore();
    }
  });
});
