import { describe, expect, it } from 'vitest';
import {
  createEditScopeStore,
  normalizeFilePath,
  verifyEdits,
  type DeclaredEditScope
} from '../src/server/edit-scope.js';

/**
 * ADR 0002 / MODULE-DESIGN §7.2: the edit-scope verifier. The system judges
 * by module table + watcher disk facts, not by AI self-report — a change is
 * out of scope whether the agent admitted it or not, and watcher-recorded
 * files the agent never reported are 漏报.
 */

const scope = (over: Partial<DeclaredEditScope> = {}): DeclaredEditScope => ({
  modules: [],
  files: [],
  ...over
});

describe('verifyEdits — scope membership', () => {
  it('no scope declared: every change is out of scope', () => {
    const v = verifyEdits(null, ['a.ts'], ['b.ts']);
    expect(v.scopeDeclared).toBe(false);
    expect(v.outOfScope).toEqual([
      { id: 'a.ts', source: 'reported' },
      { id: 'b.ts', source: 'watcher' }
    ]);
    expect(v.unreported).toEqual(['b.ts']);
    expect(v.ok).toBe(false);
  });

  it('a declared module covers all files of that functional module', () => {
    const v = verifyEdits(scope({ modules: ['graph-engine'] }), ['src/server/incremental-graph.ts'], []);
    expect(v.outOfScope).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('files of an undeclared module are out of scope even when reported', () => {
    const v = verifyEdits(scope({ modules: ['graph-engine'] }), ['src/server/mcp.ts'], []);
    expect(v.outOfScope).toEqual([{ id: 'src/server/mcp.ts', source: 'reported' }]);
    expect(v.ok).toBe(false);
  });

  it('explicit files admit files of undeclared modules (and out-of-table files)', () => {
    const inScope = verifyEdits(scope({ files: ['src/server/mcp.ts', 'package.json'] }), ['src/server/mcp.ts', 'package.json'], []);
    expect(inScope.outOfScope).toEqual([]);
    expect(inScope.ok).toBe(true);

    // Same files WITHOUT the explicit entries: package.json is out of table
    // (moduleIdOf null) and mcp.ts belongs to an undeclared module.
    const out = verifyEdits(scope({ modules: ['graph-engine'] }), ['src/server/mcp.ts', 'package.json'], []);
    expect(out.outOfScope.map((e) => e.id)).toEqual(['src/server/mcp.ts', 'package.json']);
  });

  it('module + explicit files compose: either channel admits the file', () => {
    const v = verifyEdits(
      scope({ modules: ['dashboard'], files: ['src/server/mcp.ts'] }),
      ['src/web/main.ts', 'src/server/mcp.ts', 'src/server/http.ts'],
      []
    );
    expect(v.outOfScope).toEqual([{ id: 'src/server/http.ts', source: 'reported' }]);
  });
});

describe('verifyEdits — watcher cross-check (漏报也逃不掉)', () => {
  it('watcher-recorded files not reported show up as unreported', () => {
    const v = verifyEdits(scope({ files: ['src/server/http.ts'] }), ['src/server/http.ts'], ['src/server/mcp.ts']);
    expect(v.unreported).toEqual(['src/server/mcp.ts']);
    expect(v.outOfScope).toEqual([{ id: 'src/server/mcp.ts', source: 'watcher' }]);
    expect(v.ok).toBe(false);
  });

  it('a watcher-recorded in-scope file the agent forgot to report is still unreported (but not out of scope)', () => {
    const v = verifyEdits(scope({ files: ['src/server/http.ts'] }), [], ['src/server/http.ts']);
    expect(v.unreported).toEqual(['src/server/http.ts']);
    expect(v.outOfScope).toEqual([]);
    expect(v.ok).toBe(false);
  });

  it('the out-of-scope set is the UNION of reported and watcher facts, deduped', () => {
    const v = verifyEdits(scope({ modules: ['graph-engine'] }), ['src/server/mcp.ts'], ['src/server/mcp.ts', 'src/server/version.ts']);
    expect(v.outOfScope).toEqual([
      { id: 'src/server/mcp.ts', source: 'reported' }, // reported wins the tag
      { id: 'src/server/version.ts', source: 'watcher' }
    ]);
    expect(v.unreported).toEqual(['src/server/version.ts']); // mcp.ts 已上报,不算漏报
  });

  it('ok = no out-of-scope and no unreported', () => {
    expect(verifyEdits(scope({ files: ['a.ts'] }), ['a.ts'], ['a.ts']).ok).toBe(true);
    expect(verifyEdits(scope({ files: ['a.ts'] }), ['a.ts'], []).ok).toBe(true);
    expect(verifyEdits(scope({ files: ['a.ts'] }), [], ['a.ts']).ok).toBe(false);
    expect(verifyEdits(null, [], []).ok).toBe(true); // nothing changed, nothing to judge
  });
});

describe('normalizeFilePath — agent input hygiene', () => {
  it('strips whitespace, converts backslashes, drops a leading ./', () => {
    expect(normalizeFilePath('  src/web/main.ts  ')).toBe('src/web/main.ts');
    expect(normalizeFilePath('src\\web\\main.ts')).toBe('src/web/main.ts');
    expect(normalizeFilePath('./src/web/main.ts')).toBe('src/web/main.ts');
    expect(normalizeFilePath('src/web/main.ts')).toBe('src/web/main.ts');
  });

  it('returns "" for empty/garbage input (caller filters)', () => {
    expect(normalizeFilePath('')).toBe('');
    expect(normalizeFilePath('   ')).toBe('');
    expect(normalizeFilePath('./')).toBe('');
    expect(normalizeFilePath('\\')).toBe('');
  });
});

describe('createEditScopeStore — session-level state', () => {
  it('declare replaces the previous scope and stamps a declaredAt baseline', () => {
    const store = createEditScopeStore();
    expect(store.current()).toBeNull();
    store.declare(scope({ modules: ['dashboard'] }));
    const first = store.current()!;
    expect(first.modules).toEqual(['dashboard']);
    expect(first.files).toEqual([]);
    expect(typeof first.declaredAt).toBe('number');
    store.declare(scope({ files: ['a.ts'] }));
    const second = store.current()!;
    expect(second.files).toEqual(['a.ts']);
    expect(second.modules).toEqual([]);
    expect(second.declaredAt).toBeGreaterThanOrEqual(first.declaredAt!);
  });

  it('declaring an empty scope clears the previous one', () => {
    const store = createEditScopeStore();
    store.declare(scope({ modules: ['dashboard'] }));
    store.declare(scope());
    expect(store.current()).toBeNull();
  });
});

/**
 * Ticket 13 修法 A (scope epoch): watcher evidence older than the current
 * declaration's baseline is preexisting — shown, never judged. In-generation
 * evidence (changedAt >= declaredAt, same-ms races included) goes through the
 * normal verdicts. No declaration → no lower bound (legacy behaviour).
 */
const epochScope = (declaredAt: number, over: Partial<DeclaredEditScope> = {}): DeclaredEditScope => ({
  ...scope(over),
  modules: over.modules ?? [],
  files: over.files ?? [],
  declaredAt
});

describe('verifyEdits — scope epoch (baseline filtering)', () => {
  it('pre-baseline out-of-scope watcher evidence lands in preexisting, ok stays true', () => {
    const v = verifyEdits(epochScope(1000, { files: ['http.ts'] }), [], [
      { id: 'stale.ts', changedAt: 999 },
      { id: 'stale-in-scope.ts', changedAt: 500 }
    ]);
    expect(v.preexisting).toEqual(['stale.ts', 'stale-in-scope.ts']); // 在/不在范围都列（给人看）
    expect(v.outOfScope).toEqual([]);
    expect(v.unreported).toEqual([]); // 基线前的记录不参与漏报判定，范围内外一视同仁
    expect(v.ok).toBe(true);
  });

  it('in-generation watcher evidence is still judged (same-ms race counts as in-generation)', () => {
    const v = verifyEdits(epochScope(1000, { files: ['http.ts'] }), [], [
      { id: 'race.ts', changedAt: 1000 },
      { id: 'stray.ts', changedAt: 1001 }
    ]);
    expect(v.preexisting).toEqual([]);
    expect(v.outOfScope).toEqual([
      { id: 'race.ts', source: 'watcher' },
      { id: 'stray.ts', source: 'watcher' }
    ]);
    expect(v.unreported).toEqual(['race.ts', 'stray.ts']);
    expect(v.ok).toBe(false);
  });

  it('reported out-of-scope edits are never exempted by the baseline', () => {
    const v = verifyEdits(epochScope(1000, { files: ['http.ts'] }), ['guilty.ts'], []);
    expect(v.outOfScope).toEqual([{ id: 'guilty.ts', source: 'reported' }]);
    expect(v.ok).toBe(false);
  });

  it('bare-id watcher facts (no timestamp) are never exempted', () => {
    const v = verifyEdits(epochScope(1000, { files: ['http.ts'] }), [], ['anytime.ts']);
    expect(v.outOfScope).toEqual([{ id: 'anytime.ts', source: 'watcher' }]);
  });

  it('no declaration → no lower bound: every watcher fact is judged (no regression)', () => {
    const v = verifyEdits(null, [], [{ id: 'ancient.ts', changedAt: 1 }]);
    expect(v.preexisting).toEqual([]);
    expect(v.outOfScope).toEqual([{ id: 'ancient.ts', source: 'watcher' }]);
    expect(v.ok).toBe(false);
  });
});
