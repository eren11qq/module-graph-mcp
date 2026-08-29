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
    seed({ v: 1, roots: { '/proj': { good: { x: 1, y: 2 }, bad: { x: '1', y: 2 }, worse: null } } });
    const store = createLayoutStore();
    expect(store.load('/proj')).toEqual(new Map([['good', { x: 1, y: 2 }]]));
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
