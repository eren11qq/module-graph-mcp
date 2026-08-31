// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutStore } from '../src/web/layout-store.js';
import { CHROME } from '../src/web/theme.js';

/**
 * Code-review 2026-08-29: the layout archive under mg-layout — one JSON
 * document, versioned, keyed by rootPath, degrading to memory-only when
 * localStorage refuses (private mode / quota).
 */

const seed = (value: unknown): void => localStorage.setItem(CHROME.layoutStorageKey, JSON.stringify(value));

describe('layout-store (mg-layout)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips positions per root and per mode', () => {
    const store = createLayoutStore();
    store.save('/proj', new Map([['a.ts', { x: 12, y: 34 }]]), 'file');
    expect(store.load('/proj', 'file')).toEqual(new Map([['a.ts', { x: 12, y: 34 }]]));
    // And it survives a fresh store instance (real persistence).
    expect(createLayoutStore().load('/proj', 'file')).toEqual(new Map([['a.ts', { x: 12, y: 34 }]]));
  });

  it('ADR 0002: file and module archives are isolated per root+mode', () => {
    const store = createLayoutStore();
    store.save('/proj', new Map([['a.ts', { x: 1, y: 1 }]]), 'file');
    store.save('/proj', new Map([['pile:mcp-service', { x: 9, y: 9 }]]), 'module');
    expect(store.load('/proj', 'file').has('pile:mcp-service')).toBe(false);
    expect(store.load('/proj', 'module').has('a.ts')).toBe(false);
    expect(store.load('/proj', 'module')).toEqual(new Map([['pile:mcp-service', { x: 9, y: 9 }]]));
    expect(createLayoutStore().load('/proj', 'file').has('a.ts')).toBe(true);
  });

  it('keeps roots isolated', () => {
    const store = createLayoutStore();
    store.save('/a', new Map([['x.ts', { x: 1, y: 1 }]]), 'file');
    store.save('/b', new Map([['y.ts', { x: 2, y: 2 }]]), 'file');
    expect(store.load('/a', 'file').has('y.ts')).toBe(false);
    expect(store.load('/b', 'file').has('x.ts')).toBe(false);
  });

  it('save replaces a root+mode wholesale — gone nodes drop out', () => {
    const store = createLayoutStore();
    store.save('/proj', new Map([['old.ts', { x: 1, y: 1 }]]), 'file');
    store.save('/proj', new Map([['new.ts', { x: 2, y: 2 }]]), 'file');
    expect(store.load('/proj', 'file')).toEqual(new Map([['new.ts', { x: 2, y: 2 }]]));
  });

  it('update upserts a single point without touching siblings (mode-scoped)', () => {
    const store = createLayoutStore();
    store.save('/proj', new Map([['a.ts', { x: 1, y: 2 }]]), 'file');
    store.update('/proj', 'a.ts', { x: 9, y: 9 }, 'file');
    store.update('/proj', 'b.ts', { x: 3, y: 4 }, 'file');
    expect(store.load('/proj', 'file')).toEqual(
      new Map([
        ['a.ts', { x: 9, y: 9 }],
        ['b.ts', { x: 3, y: 4 }]
      ])
    );
  });

  it('clear forgets exactly one root', () => {
    const store = createLayoutStore();
    store.save('/a', new Map([['x.ts', { x: 1, y: 1 }]]), 'file');
    store.save('/b', new Map([['y.ts', { x: 2, y: 2 }]]), 'file');
    store.clear('/a');
    expect(store.load('/a', 'file').size).toBe(0);
    expect(store.load('/b', 'file').size).toBe(1);
  });

  it('ADR 0002 重置布局两档全清: clear without mode wipes both modes of the root', () => {
    const store = createLayoutStore();
    store.save('/proj', new Map([['a.ts', { x: 1, y: 1 }]]), 'file');
    store.save('/proj', new Map([['pile:mcp-service', { x: 9, y: 9 }]]), 'module');
    store.clear('/proj');
    expect(store.load('/proj', 'file').size).toBe(0);
    expect(store.load('/proj', 'module').size).toBe(0);
    // And a mode-scoped clear leaves the other mode alone.
    store.save('/proj', new Map([['a.ts', { x: 1, y: 1 }]]), 'file');
    store.save('/proj', new Map([['pile:mcp-service', { x: 9, y: 9 }]]), 'module');
    store.clear('/proj', 'file');
    expect(store.load('/proj', 'file').size).toBe(0);
    expect(store.load('/proj', 'module').size).toBe(1);
  });

  it('a version mismatch resets the archive', () => {
    seed({ v: 0, roots: { '/old': { 'x.ts': { x: 1, y: 2 } } } });
    const store = createLayoutStore();
    expect(store.load('/old', 'file').size).toBe(0);
    // And a save rewrites the archive at the current version.
    store.save('/new', new Map([['y.ts', { x: 5, y: 6 }]]), 'file');
    expect(createLayoutStore().load('/new', 'file')).toEqual(new Map([['y.ts', { x: 5, y: 6 }]]));
  });

  it('corrupt JSON resets the archive instead of throwing', () => {
    localStorage.setItem(CHROME.layoutStorageKey, '{not json');
    const store = createLayoutStore();
    expect(store.load('/proj', 'file').size).toBe(0);
    expect(() => store.save('/proj', new Map(), 'file')).not.toThrow();
  });

  it('loads only finite numeric points', () => {
    seed({ v: 4, roots: { '/proj': { file: { good: { x: 1, y: 2 }, bad: { x: '1', y: 2 }, worse: null } } } });
    const store = createLayoutStore();
    expect(store.load('/proj', 'file')).toEqual(new Map([['good', { x: 1, y: 2 }]]));
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
