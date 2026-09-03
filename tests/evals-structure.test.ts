import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_TASKS } from '../src/evals/tasks/registry.js';
import type { EvalTask } from '../src/evals/types.js';

/**
 * Trust-loop roadmap PR-2, decision #5: the evals suite guards its own
 * structure, both ways.
 *
 * ① Directory guard: every file in src/evals/tasks/ except registry.ts must
 *    export a legal EvalTask — a stray file (or an exported non-task) is red.
 * ② Registry ⇄ disk reconciliation: a task file missing from the registry
 *    AND a registry entry with no file behind it are both red. Task ids must
 *    equal their file stem, so the two views can be diffed exactly.
 */

const TASKS_DIR = join('src', 'evals', 'tasks');
const REGISTRY_FILE = 'registry.ts';

function taskFilesOnDisk(): string[] {
  return readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.ts') && f !== REGISTRY_FILE)
    .sort();
}

function isLegalTask(value: unknown): value is EvalTask {
  if (value === null || typeof value !== 'object') return false;
  const t = value as Partial<EvalTask>;
  return (
    typeof t.id === 'string' &&
    t.id.length > 0 &&
    typeof t.description === 'string' &&
    t.description.length > 0 &&
    typeof t.maxMs === 'number' &&
    Number.isInteger(t.maxMs) &&
    t.maxMs > 0 &&
    typeof t.maxBytes === 'number' &&
    Number.isInteger(t.maxBytes) &&
    t.maxBytes > 0 &&
    typeof t.probe === 'function'
  );
}

describe('evals directory guard (decision #5①)', () => {
  it('keeps the pinned src/evals layout', () => {
    for (const required of ['src/evals/types.ts', 'src/evals/mcp-client.ts', 'src/evals/run.ts', 'src/evals/tasks/registry.ts']) {
      expect(statSync(required).isFile(), `missing pinned file ${required}`).toBe(true);
    }
  });

  it('every task file exports a legal EvalTask whose id equals its file stem', async () => {
    const files = taskFilesOnDisk();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const mod = (await import(`../${join(TASKS_DIR, file).replace(/\\/g, '/').replace(/\.ts$/, '.js')}`)) as Record<string, unknown>;
      const exported = mod.task;
      expect(isLegalTask(exported), `${file} must export a legal EvalTask as "task"`).toBe(true);
      expect((exported as { id: string }).id, `${file} id must equal its file stem`).toBe(file.replace(/\.ts$/, ''));
    }
  });

  it('rejects a stray non-task file in tasks/', async () => {
    // Free-floating files are caught by the export shape check above; this
    // test pins the negative: an object missing the EvalTask fields must be
    // recognizably illegal to the same predicate.
    expect(isLegalTask({ id: 'x' })).toBe(false);
    expect(isLegalTask({ id: 'x', description: 'y', maxMs: 1, maxBytes: 1, probe: 'not-a-function' })).toBe(false); // probe type
    expect(isLegalTask({ id: 'x', description: 'y', maxMs: 0, maxBytes: 1, probe: () => {} })).toBe(false); // budget discipline
    expect(isLegalTask(null)).toBe(false);
  });
});

describe('registry ⇄ disk reconciliation (decision #5②)', () => {
  it('registry ids match the task files on disk exactly, no ghosts, no strays', () => {
    const registryIds = ALL_TASKS.map((t) => t.id).sort();
    const diskIds = taskFilesOnDisk().map((f) => f.replace(/\.ts$/, ''));
    expect(registryIds).toEqual(diskIds);
  });

  it('registry holds no duplicate ids and no dead entries', () => {
    const ids = ALL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of ALL_TASKS) expect(isLegalTask(t)).toBe(true);
  });

  it('the evals CLI contract is wired: package.json script + CI step', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.evals).toBe('node dist/evals/run.js');
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('npm run evals');
  });
});
