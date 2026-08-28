import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  diagnosticPathToRelative,
  parseTscOutput,
  resolveTscBin,
  runTypecheck
} from '../src/server/typecheck.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_TSC = join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

// ---------------------------------------------------------------------------
// Diagnostic parsing (pure, platform-independent)
// ---------------------------------------------------------------------------

const SAMPLE_OUTPUT = [
  'src/a.ts(10,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
  'src/a.ts(3,1): error TS2304: Cannot find name \'missingFn\'.',
  'src/deep dir/b.ts(7,12): error TS2551: Property \'lenght\' does not exist on type \'string\'. Did you mean \'length\'?',
  'error TS5058: The specified path does not exist.',
  'Found 3 errors in 2 files.',
  'Errors  Files',
  ''
].join('\n');

describe('parseTscOutput (Ticket 07)', () => {
  it('groups diagnostics per file with line, code and message', () => {
    const parsed = parseTscOutput(SAMPLE_OUTPUT, '/repo');

    expect(parsed.errorsByFile.get('src/a.ts')).toEqual([
      { line: 3, code: 'TS2304', message: "Cannot find name 'missingFn'." }, // sorted by line
      { line: 10, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." }
    ]);
    expect(parsed.errorsByFile.get('src/deep dir/b.ts')).toEqual([
      { line: 7, code: 'TS2551', message: "Property 'lenght' does not exist on type 'string'. Did you mean 'length'?" }
    ]);
    expect(parsed.globalMessages).toEqual(['TS5058: The specified path does not exist.']);
    expect(parsed.totalErrors).toBe(4);
  });

  it('ignores banners and summary noise', () => {
    const parsed = parseTscOutput('Found 3 errors in 2 files.\nErrors  Files\n', '/repo');
    expect(parsed.totalErrors).toBe(0);
    expect(parsed.errorsByFile.size).toBe(0);
    expect(parsed.globalMessages).toEqual([]);
  });

  it('handles empty output', () => {
    const parsed = parseTscOutput('', '/repo');
    expect(parsed.totalErrors).toBe(0);
  });
});

describe('diagnosticPathToRelative', () => {
  it('strips the root for absolute paths, keeps relative ones', () => {
    expect(diagnosticPathToRelative('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(diagnosticPathToRelative('src/a.ts', '/repo')).toBe('src/a.ts');
    expect(diagnosticPathToRelative('C:\\repo\\src\\a.ts', 'C:\\repo')).toBe('src/a.ts');
  });

  it('keeps paths outside the root intact (posix-ified)', () => {
    expect(diagnosticPathToRelative('/elsewhere/x.ts', '/repo')).toBe('/elsewhere/x.ts');
    expect(diagnosticPathToRelative('..\\up.ts', '/repo')).toBe('../up.ts');
  });
});

describe('resolveTscBin', () => {
  it('finds the local typescript install for this repo', () => {
    expect(resolveTscBin(PROJECT_ROOT)?.replace(/\\/g, '/')).toContain('node_modules/typescript/bin/tsc');
  });

  it('returns undefined for a project without node_modules', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'typecheck-'));
    try {
      expect(resolveTscBin(tmp)).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runTypecheck degraded modes (no real tsc needed)
// ---------------------------------------------------------------------------

describe('runTypecheck degraded modes', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'typecheck-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('no tsc anywhere: unavailable status, no throw (ticket acceptance)', async () => {
    const result = await runTypecheck(tmp);
    expect(result.status).toBe('unavailable');
    expect(result.note).toContain('no tsc');
    expect(result.totalErrors).toBe(0);
  });

  it('hanging tsc: killed after timeoutMs with timeout status', async () => {
    const neverJs = join(tmp, 'never.js');
    await writeFile(neverJs, 'setInterval(() => {}, 60_000);\n', 'utf8');
    const result = await runTypecheck(tmp, { tscBin: neverJs, timeoutMs: 300 });
    expect(result.status).toBe('timeout');
    expect(result.note).toContain('300ms');
  });

  it('tsc that ignores SIGTERM is SIGKILLed after the grace period and the pipeline stays usable (P0-3)', async () => {
    const stubbornCjs = join(tmp, 'stubborn.cjs');
    const pidFile = join(tmp, 'stubborn.pid');
    await writeFile(
      stubbornCjs,
      [
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "process.on('SIGTERM', () => {}); // stubbornly ignore polite termination",
        'setInterval(() => {}, 60_000);'
      ].join('\n'),
      'utf8'
    );
    const result = await runTypecheck(tmp, { tscBin: stubbornCjs, timeoutMs: 300 });
    expect(result.status).toBe('timeout');

    // The SIGKILL fallback must have reaped the child after the grace period…
    const pid = Number(await readFile(pidFile, 'utf8'));
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow();
      },
      { timeout: 5_000, interval: 100 }
    );

    // …so the next typecheck call can be issued normally (no permanent lock).
    const okCjs = join(tmp, 'ok.cjs');
    await writeFile(okCjs, 'process.exit(0);\n', 'utf8');
    const second = await runTypecheck(tmp, { tscBin: okCjs });
    expect(second.status).toBe('ok');
  });

  it('tsc that exits non-zero without diagnostics: parse-failed, not a crash', async () => {
    const junkJs = join(tmp, 'junk.js');
    await writeFile(junkJs, "process.stdout.write('weird output\\n'); process.exit(3);\n", 'utf8');
    const result = await runTypecheck(tmp, { tscBin: junkJs });
    expect(result.status).toBe('parse-failed');
    expect(result.note).toContain('exited 3');
  });
});

// ---------------------------------------------------------------------------
// Real tsc integration (skipped when the platform binary is missing,
// e.g. typescript@7 installed for another OS)
// ---------------------------------------------------------------------------

function tscAvailable(): boolean {
  try {
    const probe = spawnSync(process.execPath, [LOCAL_TSC, '--version'], {
      encoding: 'utf8',
      timeout: 20_000
    });
    return probe.status === 0 && /Version/.test(probe.stdout);
  } catch {
    return false;
  }
}

describe.runIf(tscAvailable())('runTypecheck with the real tsc', () => {
  let tmp: string;

  const TSCONFIG = JSON.stringify({
    compilerOptions: { strict: true, noEmit: true },
    include: ['*.ts']
  });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'typecheck-real-'));
    await writeFile(join(tmp, 'tsconfig.json'), TSCONFIG, 'utf8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('type errors produce per-file badge entries with line + code + message', async () => {
    await writeFile(join(tmp, 'bad.ts'), 'const x: number = "nope";\nconst y = missingFn();\n', 'utf8');

    const result = await runTypecheck(tmp, { tscBin: LOCAL_TSC });
    expect(result.status).toBe('errors');

    const entries = result.errorsByFile.get('bad.ts');
    expect(entries).toBeDefined();
    expect(entries?.length).toBeGreaterThanOrEqual(2);
    expect(entries?.some((e) => e.line === 1 && e.code === 'TS2322')).toBe(true);
    expect(entries?.some((e) => e.line === 2 && e.code === 'TS2304')).toBe(true);
    for (const entry of entries ?? []) {
      expect(Number.isInteger(entry.line)).toBe(true);
      expect(entry.code).toMatch(/^TS\d+$/);
      expect(entry.message.length).toBeGreaterThan(0);
    }
  });

  it('fixing the errors clears the badges on the next run', async () => {
    const badPath = join(tmp, 'bad.ts');
    await writeFile(badPath, 'const x: number = "nope";\n', 'utf8');
    const broken = await runTypecheck(tmp, { tscBin: LOCAL_TSC });
    expect(broken.status).toBe('errors');
    expect(broken.errorsByFile.get('bad.ts')?.length).toBeGreaterThan(0);

    await writeFile(badPath, 'export const x: number = 1;\n', 'utf8');
    const fixed = await runTypecheck(tmp, { tscBin: LOCAL_TSC });
    expect(fixed.status).toBe('ok');
    expect(fixed.totalErrors).toBe(0);
    expect(fixed.errorsByFile.size).toBe(0);
  });

  it('multiple files are grouped independently', async () => {
    await writeFile(join(tmp, 'a.ts'), 'const a: number = "a";\n', 'utf8');
    await writeFile(join(tmp, 'b.ts'), 'const b: boolean = 2;\n', 'utf8');

    const result = await runTypecheck(tmp, { tscBin: LOCAL_TSC });
    expect(result.status).toBe('errors');
    expect(result.errorsByFile.get('a.ts')?.length).toBeGreaterThan(0);
    expect(result.errorsByFile.get('b.ts')?.length).toBeGreaterThan(0);
  });
});
