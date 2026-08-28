import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CoverageMapper,
  buildTestTargetIndex,
  deriveTestState,
  isTestFile,
  parseCoverageSummaryJson,
  reportKeyToRelative,
  testTargetStems,
  toPosix
} from '../src/server/coverage.js';

// ---------------------------------------------------------------------------
// Four-color derivation (pure rule table)
// ---------------------------------------------------------------------------

describe('deriveTestState (Ticket 06 four-color rule)', () => {
  it('green: covered by the report and the run is healthy', () => {
    expect(
      deriveTestState({ reportFound: true, inReport: true, runFailed: false, hasConventionalTests: true })
    ).toBe('passing');
  });

  it('red: covered by the report and the run failed', () => {
    expect(
      deriveTestState({ reportFound: true, inReport: true, runFailed: true, hasConventionalTests: true })
    ).toBe('failing');
  });

  it('red stays red even without a naming-convention match (report evidence wins)', () => {
    expect(
      deriveTestState({ reportFound: true, inReport: true, runFailed: true, hasConventionalTests: false })
    ).toBe('failing');
  });

  it('yellow: test exists by convention but no coverage data', () => {
    expect(
      deriveTestState({ reportFound: false, inReport: false, runFailed: false, hasConventionalTests: true })
    ).toBe('has-tests-unrun');
    // A report that simply does not mention the file is still "no coverage data".
    expect(
      deriveTestState({ reportFound: true, inReport: false, runFailed: false, hasConventionalTests: true })
    ).toBe('has-tests-unrun');
  });

  it('yellow survives a failed run when the file has no report evidence', () => {
    expect(
      deriveTestState({ reportFound: true, inReport: false, runFailed: true, hasConventionalTests: true })
    ).toBe('has-tests-unrun');
  });

  it('grey: no coverage data and no conventional test', () => {
    expect(
      deriveTestState({ reportFound: false, inReport: false, runFailed: false, hasConventionalTests: false })
    ).toBe('untested');
    expect(
      deriveTestState({ reportFound: true, inReport: false, runFailed: false, hasConventionalTests: false })
    ).toBe('untested');
  });

  it('grey and red are distinguishable states (ticket acceptance: 灰≠红)', () => {
    const grey = deriveTestState({ reportFound: false, inReport: false, runFailed: true, hasConventionalTests: false });
    const red = deriveTestState({ reportFound: true, inReport: true, runFailed: true, hasConventionalTests: false });
    expect(grey).toBe('untested');
    expect(red).toBe('failing');
    expect(grey).not.toBe(red);
  });
});

// ---------------------------------------------------------------------------
// Naming-convention detection
// ---------------------------------------------------------------------------

describe('naming-convention index', () => {
  it('isTestFile recognises .test/.spec and __tests__ members only', () => {
    expect(isTestFile('core/app.test.ts')).toBe(true);
    expect(isTestFile('core/app.spec.tsx')).toBe(true);
    expect(isTestFile('core/__tests__/app.ts')).toBe(true);
    expect(isTestFile('app.test.js')).toBe(true);
    expect(isTestFile('core/app.ts')).toBe(false);
    expect(isTestFile('core/app.test.txt')).toBe(false);
    expect(isTestFile('readme.md')).toBe(false);
  });

  it('testTargetStems maps test shapes back onto their source stems', () => {
    expect(testTargetStems('core/app.test.ts')).toEqual(['core/app']);
    expect(testTargetStems('core/app.spec.ts')).toEqual(['core/app']);
    expect(testTargetStems('core/__tests__/app.test.ts')).toEqual(['core/app']);
    expect(testTargetStems('core/__tests__/app.ts')).toEqual(['core/app']);
    expect(testTargetStems('app.test.ts')).toEqual(['app']);
    expect(testTargetStems('core/app.ts')).toEqual([]); // not a test file
  });

  it('buildTestTargetIndex groups several tests per source, sorted', () => {
    const files = ['core/app.ts', 'core/app.spec.ts', 'core/app.test.ts', 'core/__tests__/app.ts', 'core/other.ts'];
    const index = buildTestTargetIndex(files);
    expect(index.get('core/app')).toEqual(['core/__tests__/app.ts', 'core/app.spec.ts', 'core/app.test.ts']);
    expect(index.get('core/other')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// json-summary parsing
// ---------------------------------------------------------------------------

describe('parseCoverageSummaryJson', () => {
  it('extracts file keys and skips the total bucket', () => {
    const raw = JSON.stringify({
      total: { lines: { total: 10, covered: 8, skipped: 0, pct: 80 } },
      '/repo/core/app.ts': { lines: { total: 5, covered: 5, skipped: 0, pct: 100 } },
      '/repo/core/emitter.ts': { statements: { total: 3, covered: 1 } }
    });
    expect(parseCoverageSummaryJson(raw)).toEqual({
      fileKeys: ['/repo/core/app.ts', '/repo/core/emitter.ts']
    });
  });

  it('skips malformed entries instead of throwing', () => {
    const raw = JSON.stringify({
      total: {},
      '/repo/good.ts': { lines: { total: 1, covered: 1 } },
      '/repo/broken.ts': { lines: 'nonsense' },
      '/repo/empty.ts': {}
    });
    expect(parseCoverageSummaryJson(raw)).toEqual({ fileKeys: ['/repo/good.ts'] });
  });

  it('returns undefined for unusable documents (bad JSON, arrays, scalars)', () => {
    expect(parseCoverageSummaryJson('{ not json')).toBeUndefined();
    expect(parseCoverageSummaryJson('[1,2]')).toBeUndefined();
    expect(parseCoverageSummaryJson('"x"')).toBeUndefined();
  });
});

describe('reportKeyToRelative', () => {
  it('strips the root prefix and normalises backslashes', () => {
    expect(reportKeyToRelative('/repo/core/app.ts', '/repo')).toBe('core/app.ts');
    expect(reportKeyToRelative('C:\\repo\\core\\app.ts', 'C:\\repo')).toBe('core/app.ts');
  });

  it('matches case-insensitively on both sides (Windows drive/path casing, P1-6)', () => {
    expect(reportKeyToRelative('C:\\Repo\\core\\app.ts', 'C:\\repo')).toBe('core/app.ts');
    expect(reportKeyToRelative('C:\\repo\\Core\\App.ts', 'c:\\REPO')).toBe('Core/App.ts');
    expect(reportKeyToRelative('/REPO/core/app.ts', '/repo')).toBe('core/app.ts');
  });

  it('drops entries outside the watched root', () => {
    expect(reportKeyToRelative('/elsewhere/app.ts', '/repo')).toBeUndefined();
    expect(reportKeyToRelative('', '/repo')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CoverageMapper end-to-end against a temp project
// ---------------------------------------------------------------------------

describe('CoverageMapper.refresh on a temp project', () => {
  let root: string;

  const FILES = ['core/app.ts', 'core/app.test.ts', 'core/emitter.ts', 'utils/format.ts'];

  const metric = { total: 5, covered: 5, skipped: 0, pct: 100 };
  const writeReport = async (relPath: string, coveredFiles: string[]): Promise<void> => {
    const doc: Record<string, unknown> = {
      total: { lines: { total: 10, covered: 10, skipped: 0, pct: 100 } }
    };
    for (const rel of coveredFiles) {
      doc[toPosix(join(root, rel))] = { lines: metric, statements: metric, functions: metric, branches: metric };
    }
    await mkdir(join(root, relPath, '..'), { recursive: true }).catch(() => undefined);
    await writeFile(join(root, relPath), JSON.stringify(doc), 'utf8');
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'coverage-mapper-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('no report: convention-only colors (grey + yellow, ticket fallback case)', async () => {
    const result = await new CoverageMapper(root).refresh(FILES);
    expect(result.reportFound).toBe(false);
    expect(result.reportPath).toBeUndefined();
    expect(result.states.get('core/app.ts')).toEqual({ testState: 'has-tests-unrun', coveredBy: ['core/app.test.ts'] });
    expect(result.states.get('core/emitter.ts')).toEqual({ testState: 'untested', coveredBy: [] });
    expect(result.states.get('utils/format.ts')).toEqual({ testState: 'untested', coveredBy: [] });
  });

  it('report present: covered files turn green, uncovered stay grey/yellow', async () => {
    await writeReport('coverage/coverage-summary.json', ['core/app.ts', 'core/emitter.ts']);
    const result = await new CoverageMapper(root).refresh(FILES);
    expect(result.reportFound).toBe(true);
    expect(result.reportPath).toBe('coverage/coverage-summary.json');
    expect(result.states.get('core/app.ts')?.testState).toBe('passing');
    expect(result.states.get('core/emitter.ts')?.testState).toBe('passing');
    expect(result.states.get('utils/format.ts')?.testState).toBe('untested');
    // The test file itself gets no self-attribution.
    expect(result.states.get('core/app.test.ts')?.testState).toBe('untested');
  });

  it('failed run: covered files turn red, uncovered files keep their colors', async () => {
    await writeReport('coverage/coverage-summary.json', ['core/app.ts']);
    const mapper = new CoverageMapper(root);
    mapper.setLastRunFailed(true);
    const result = await mapper.refresh(FILES);
    expect(result.runFailed).toBe(true);
    expect(result.states.get('core/app.ts')?.testState).toBe('failing');
    expect(result.states.get('core/emitter.ts')?.testState).toBe('untested');
    expect(result.states.get('utils/format.ts')?.testState).toBe('untested');
  });

  it('report disappearance remaps back to convention-only colors', async () => {
    const reportPath = join(root, 'coverage', 'coverage-summary.json');
    await writeReport('coverage/coverage-summary.json', ['core/app.ts']);
    const mapper = new CoverageMapper(root);
    expect((await mapper.refresh(FILES)).states.get('core/app.ts')?.testState).toBe('passing');

    await rm(reportPath, { force: true });
    const after = await mapper.refresh(FILES);
    expect(after.reportFound).toBe(false);
    expect(after.states.get('core/app.ts')?.testState).toBe('has-tests-unrun');
    expect(after.states.get('core/emitter.ts')?.testState).toBe('untested');
  });

  it('a half-written/corrupt report degrades like an absent one', async () => {
    await mkdir(join(root, 'coverage'), { recursive: true });
    await writeFile(join(root, 'coverage', 'coverage-summary.json'), '{ "total": ', 'utf8');
    const result = await new CoverageMapper(root).refresh(FILES);
    expect(result.reportFound).toBe(false);
    expect(result.states.get('core/app.ts')?.testState).toBe('has-tests-unrun');
  });

  it('adding/removing test files changes the mapped colors', async () => {
    const mapper = new CoverageMapper(root);

    const before = await mapper.refresh(FILES);
    expect(before.states.get('utils/format.ts')?.testState).toBe('untested');

    const withNewTest = [...FILES, 'utils/format.test.ts'];
    const afterAdd = await mapper.refresh(withNewTest);
    expect(afterAdd.states.get('utils/format.ts')).toEqual({
      testState: 'has-tests-unrun',
      coveredBy: ['utils/format.test.ts']
    });

    const afterRemove = await mapper.refresh(FILES);
    expect(afterRemove.states.get('utils/format.ts')?.testState).toBe('untested');
  });

  it('finds the report at the fallback root-level location', async () => {
    await writeReport('coverage-summary.json', ['core/app.ts']);
    const result = await new CoverageMapper(root).refresh(FILES);
    expect(result.reportFound).toBe(true);
    expect(result.reportPath).toBe('coverage-summary.json');
    expect(result.states.get('core/app.ts')?.testState).toBe('passing');
  });
});
