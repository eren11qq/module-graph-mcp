import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDotModuleStore, DOT_MODULE_DIR, errText, type DotModuleStore } from '../src/server/dot-module-store.js';

/**
 * 落盘卫生层 (dot-module store, 2026-09-05 架构评审候选 #1): the shared fs
 * ceremony behind every `<root>/.module-graph/*.json` state file — atomic
 * tmp+rename write, gitignore bootstrap, corrupt-read-as-empty, version
 * envelope, warn-once latch, degrade-never-throw.
 *
 * Protocol pins were recycled here from review-store.test.ts /
 * recent-changes.test.ts so the fs contract is proven ONCE; consumer suites
 * keep only their domain pins (merge rules, decoding).
 *
 * Interface under test: loadRaw() / saveRaw(body) / warn(msg).
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dot-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeStore(overrides: Partial<Parameters<typeof createDotModuleStore>[0]> = {}): DotModuleStore {
  return createDotModuleStore({
    rootPath: dir,
    fileName: 'thing.json',
    version: 1,
    ...overrides
  });
}

const storeFile = (): string => join(dir, DOT_MODULE_DIR, 'thing.json');

describe('createDotModuleStore — round trip', () => {
  it('saveRaw then loadRaw returns the body back', () => {
    const s = makeStore();
    expect(s.saveRaw({ version: 1, hello: 'world' })).toEqual({ ok: true });
    const r = s.loadRaw();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.body.hello).toBe('world');
  });

  it('writes pretty JSON with a trailing newline under .module-graph/ (legacy byte format)', () => {
    const s = makeStore();
    const body = { version: 1, payload: { 'a.ts': 1 } };
    s.saveRaw(body);
    expect(readFileSync(storeFile(), 'utf8')).toBe(`${JSON.stringify(body, null, 2)}\n`);
  });

  it('leaves no .tmp residue after a successful write', () => {
    const s = makeStore();
    s.saveRaw({ version: 1 });
    expect(existsSync(`${storeFile()}.tmp`)).toBe(false);
  });

  it('a trailing separator in rootPath lands on the same file (root normalisation)', () => {
    const s = makeStore({ rootPath: `${dir}${sep}` });
    expect(s.saveRaw({ version: 1, x: 2 })).toEqual({ ok: true });
    const r = s.loadRaw();
    expect(r.status).toBe('ok');
  });
});

describe('createDotModuleStore — loadRaw outcomes', () => {
  it('no file yet → empty/missing, silently', () => {
    const logs: string[] = [];
    const s = makeStore({ log: (m) => logs.push(m) });
    expect(s.loadRaw()).toEqual({ status: 'empty', reason: 'missing' });
    expect(logs).toEqual([]);
  });

  it('unparseable file → empty/corrupt (the consumer decides whether to warn)', () => {
    const s = makeStore();
    s.saveRaw({ version: 1 });
    writeFileSync(storeFile(), '{{{ not json', 'utf8');
    expect(s.loadRaw()).toEqual({ status: 'empty', reason: 'corrupt' });
  });

  it('version mismatch → empty/version', () => {
    const s = makeStore();
    s.saveRaw({ version: 1 });
    writeFileSync(storeFile(), JSON.stringify({ version: 99, hello: 'world' }), 'utf8');
    expect(s.loadRaw()).toEqual({ status: 'empty', reason: 'version' });
  });

  it('array or scalar JSON that fails the version read → empty/version, never throws', () => {
    const s = makeStore();
    s.saveRaw({ version: 1 });
    writeFileSync(storeFile(), '[1,2,3]', 'utf8');
    expect(s.loadRaw()).toEqual({ status: 'empty', reason: 'version' });
    writeFileSync(storeFile(), '"hi"', 'utf8');
    expect(s.loadRaw()).toEqual({ status: 'empty', reason: 'version' });
  });

  it('an unreadable file path (regular file blocking the dir) reads as missing', () => {
    writeFileSync(join(dir, DOT_MODULE_DIR), 'blocking file', 'utf8');
    const s = makeStore();
    expect(s.loadRaw()).toEqual({ status: 'empty', reason: 'missing' });
  });
});

describe('createDotModuleStore — saveRaw ceremony', () => {
  it('creates the dir and bootstraps the self-ignoring .gitignore', () => {
    const s = makeStore();
    s.saveRaw({ version: 1 });
    expect(readFileSync(join(dir, DOT_MODULE_DIR, '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n');
  });

  it('never overwrites an existing custom .gitignore', () => {
    const s = makeStore();
    s.saveRaw({ version: 1 });
    const gitignore = join(dir, DOT_MODULE_DIR, '.gitignore');
    writeFileSync(gitignore, '!keep me\n', 'utf8');
    s.saveRaw({ version: 1, again: true });
    expect(readFileSync(gitignore, 'utf8')).toBe('!keep me\n');
  });

  it('a root that cannot be written → ok:false with the fs error, never throws', () => {
    writeFileSync(join(dir, DOT_MODULE_DIR), 'blocking file', 'utf8');
    const s = makeStore();
    const r = s.saveRaw({ version: 1 });
    expect(r.ok).toBe(false);
    // errno 不锁（mkdir 撞普通文件在 Windows/Linux 报 EEXIST/ENOTDIR 皆有）——
    // 契约是 ok:false + 携带错误 + 不 throw,消费者据此降级仅内存。
    if (!r.ok) expect(errText(r.err).length).toBeGreaterThan(0);
  });
});

describe('createDotModuleStore — warn latch', () => {
  it('warn logs the first message only; later warns are silent', () => {
    const logs: string[] = [];
    const s = makeStore({ log: (m) => logs.push(m) });
    s.warn('first');
    s.warn('second');
    expect(logs).toEqual(['first']);
  });

  it('no log injected → warn is a silent no-op, never throws', () => {
    const s = makeStore({ log: undefined });
    expect(() => s.warn('hello')).not.toThrow();
  });
});
