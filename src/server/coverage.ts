import { readFile, stat } from 'node:fs/promises';
import { SOURCE_EXTENSIONS } from './path-conventions.js';
import type { TestState } from '../shared/types.js';

/**
 * Ticket 06: four-color test-state mapping.
 *
 * Reads the coverage report produced by vitest/jest in istanbul's
 * `json-summary` format and maps every source file to one of four states:
 *
 *   grey   'untested'          — no coverage data and no test by naming convention
 *   yellow 'has-tests-unrun'   — a test exists by naming convention but no coverage data
 *   green  'passing'           — present in the coverage report and the run is healthy
 *   red    'failing'           — present in the coverage report and the run failed
 *
 * Report appearance, updates and disappearance all remap correctly because
 * refresh() rebuilds the mapping from scratch on every call.
 *
 * Documented deviation from the ticket text: istanbul's json-summary carries
 * no per-test attribution (it cannot say WHICH test covered a file), so
 * `coveredBy` is filled from the naming-convention index instead. The
 * coverage report only decides green/red and confirms the run happened.
 */

/** Probed in order; the first readable, parseable file wins. */
export const COVERAGE_REPORT_CANDIDATES = [
  'coverage/coverage-summary.json',
  'coverage-summary.json'
] as const;

// ---------------------------------------------------------------------------
// json-summary parsing (tolerant: malformed parts are skipped, never thrown)
// ---------------------------------------------------------------------------

export interface CoverageMetric {
  total: number;
  covered: number;
  skipped?: number;
  pct?: number;
}

export interface CoverageSummaryFileEntry {
  lines?: CoverageMetric;
  statements?: CoverageMetric;
  functions?: CoverageMetric;
  branches?: CoverageMetric;
}

export interface ParsedCoverageReport {
  /** file keys exactly as they appear in the report (absolute paths usually) */
  fileKeys: string[];
}

function isMetric(value: unknown): value is CoverageMetric {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.total === 'number' && typeof candidate.covered === 'number';
}

function isFileEntry(value: unknown): value is CoverageSummaryFileEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isMetric(candidate.lines) ||
    isMetric(candidate.statements) ||
    isMetric(candidate.functions) ||
    isMetric(candidate.branches)
  );
}

/**
 * Parse a json-summary document. Returns undefined when the file is not a
 * usable report (bad JSON, wrong shape) — callers degrade as if the report
 * were absent instead of crashing on a half-written file.
 */
export function parseCoverageSummaryJson(raw: string): ParsedCoverageReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const fileKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === 'total') continue;
    if (isFileEntry(value)) fileKeys.push(key);
  }
  return { fileKeys };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

export function stripExtension(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  const dot = relPath.lastIndexOf('.');
  if (dot <= slash) return relPath;
  const ext = relPath.slice(dot);
  return (SOURCE_EXTENSIONS as readonly string[]).includes(ext) ? relPath.slice(0, -ext.length) : relPath;
}

function hasSourceExtension(relPath: string): boolean {
  const slash = relPath.lastIndexOf('/');
  const dot = relPath.lastIndexOf('.');
  if (dot <= slash) return false;
  return (SOURCE_EXTENSIONS as readonly string[]).includes(relPath.slice(dot));
}

/**
 * Turn a report file key into a root-relative POSIX path. Returns undefined
 * for entries that do not live under the watched root — such files cannot
 * become graph nodes, so they are dropped rather than kept as phantom keys.
 */
export function reportKeyToRelative(key: string, rootPath: string): string | undefined {
  const posixKey = toPosix(key).trim();
  const rootPosix = toPosix(rootPath).replace(/\/+$/, '');
  if (posixKey.length === 0) return undefined;

  // Case-insensitive prefix match on BOTH sides: Windows roots arrive with
  // arbitrary drive/path casing (C:\Repo vs c:\repo) and folding only the
  // root side left upper-cased report keys unmatched (P1-6).
  const lowerKey = posixKey.toLowerCase();
  const lowerRoot = `${rootPosix.toLowerCase()}/`;
  if (!lowerKey.startsWith(lowerRoot)) return undefined;
  return posixKey.slice(rootPosix.length + 1);
}

// ---------------------------------------------------------------------------
// Naming-convention index
// ---------------------------------------------------------------------------

/**
 * Jest/vitest-style test file detection: a source-extension file whose stem
 * ends in `.test` / `.spec`, or anything living under a `__tests__/` segment.
 */
export function isTestFile(relPath: string): boolean {
  if (!hasSourceExtension(relPath)) return false;
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const stem = base.slice(0, base.lastIndexOf('.'));
  if (stem.endsWith('.test') || stem.endsWith('.spec')) return true;
  return relPath.split('/').includes('__tests__');
}

/**
 * The source stems a test file plausibly covers:
 *   a/b/x.test.ts      -> a/b/x
 *   a/b/x.spec.ts      -> a/b/x
 *   a/__tests__/x.*    -> a/x      (with or without the .test/.spec suffix)
 */
export function testTargetStems(testRelPath: string): string[] {
  const slash = testRelPath.lastIndexOf('/');
  const dir = slash >= 0 ? testRelPath.slice(0, slash) : '';
  const base = testRelPath.slice(slash + 1);
  const stem = base.slice(0, base.lastIndexOf('.'));

  let core = stem;
  let stripped = false;
  for (const suffix of ['.test', '.spec']) {
    if (core.endsWith(suffix)) {
      core = core.slice(0, -suffix.length);
      stripped = true;
      break;
    }
  }

  const joinDir = (d: string, name: string): string => (d.length === 0 ? name : `${d}/${name}`);
  const segments = dir.length === 0 ? [] : dir.split('/');

  if (segments[segments.length - 1] === '__tests__') {
    return [joinDir(segments.slice(0, -1).join('/'), core)];
  }
  return stripped ? [joinDir(dir, core)] : [];
}

/** source stem -> test files that conventionally cover it */
export function buildTestTargetIndex(allFiles: readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of allFiles) {
    if (!isTestFile(file)) continue;
    for (const stem of testTargetStems(file)) {
      const bucket = index.get(stem);
      if (bucket === undefined) index.set(stem, [file]);
      else bucket.push(file);
    }
  }
  for (const bucket of index.values()) bucket.sort();
  return index;
}

// ---------------------------------------------------------------------------
// Four-color derivation
// ---------------------------------------------------------------------------

export interface DeriveInput {
  reportFound: boolean;
  inReport: boolean;
  runFailed: boolean;
  hasConventionalTests: boolean;
}

/**
 * The four-color rule. Red requires presence in the report — without
 * per-test attribution there is no evidence that a non-instrumented file
 * participated in the failing run, so it keeps its convention-based color.
 */
export function deriveTestState(input: DeriveInput): TestState {
  if (input.inReport) {
    return input.runFailed ? 'failing' : 'passing';
  }
  return input.hasConventionalTests ? 'has-tests-unrun' : 'untested';
}

// ---------------------------------------------------------------------------
// The mapper proper
// ---------------------------------------------------------------------------

export interface SourceTestInfo {
  testState: TestState;
  coveredBy: string[];
}

export interface CoverageRefreshResult {
  reportFound: boolean;
  /** root-relative path of the report that was used, when one was found */
  reportPath: string | undefined;
  /** mtime of the used report — the best available "last test run at" proxy */
  reportMtimeMs: number | undefined;
  runFailed: boolean;
  states: Map<string, SourceTestInfo>;
}

export class CoverageMapper {
  private runFailed = false;

  constructor(
    private readonly rootPath: string,
    private readonly reportCandidates: readonly string[] = COVERAGE_REPORT_CANDIDATES
  ) {}

  /**
   * Outcome signal from the test runner (wired by the watcher in a later
   * ticket). Coverage alone cannot say whether the run passed — a report is
   * written in both cases — so the red/green split is fed in explicitly.
   */
  setLastRunFailed(failed: boolean): void {
    this.runFailed = failed;
  }

  lastRunFailed(): boolean {
    return this.runFailed;
  }

  /**
   * Full rebuild: call with the current file list of the watched tree
   * (root-relative POSIX paths) whenever the report or the file set may
   * have changed. Deleted reports/files can never leave stale colors.
   */
  async refresh(allFiles: readonly string[]): Promise<CoverageRefreshResult> {
    const posixFiles = allFiles.map(toPosix);
    const rootPosix = toPosix(this.rootPath).replace(/\/+$/, '');

    let reportPath: string | undefined;
    let reportKeys: string[] | undefined;
    let reportMtimeMs: number | undefined;
    for (const candidate of this.reportCandidates) {
      const absolute = `${rootPosix}/${candidate}`;
      let raw: string;
      try {
        raw = await readFile(absolute, 'utf8');
      } catch {
        continue; // absent candidate: try the next one
      }
      const parsed = parseCoverageSummaryJson(raw);
      if (parsed === undefined) continue; // unreadable/half-written: treat as absent
      reportPath = candidate;
      reportKeys = parsed.fileKeys;
      try {
        reportMtimeMs = (await stat(absolute)).mtimeMs;
      } catch {
        reportMtimeMs = undefined;
      }
      break;
    }

    const reportFound = reportKeys !== undefined;
    const covered = new Set<string>();
    if (reportKeys !== undefined) {
      for (const key of reportKeys) {
        const rel = reportKeyToRelative(key, rootPosix);
        if (rel !== undefined) covered.add(rel);
      }
    }

    const testIndex = buildTestTargetIndex(posixFiles);
    const states = new Map<string, SourceTestInfo>();
    for (const file of posixFiles) {
      // A test file is not covered by itself; it gets no convention match.
      const coveredBy = isTestFile(file) ? [] : (testIndex.get(stripExtension(file)) ?? []);
      const testState = deriveTestState({
        reportFound,
        inReport: covered.has(file),
        runFailed: this.runFailed,
        hasConventionalTests: coveredBy.length > 0
      });
      states.set(file, { testState, coveredBy });
    }

    return { reportFound, reportPath, reportMtimeMs, runFailed: this.runFailed, states };
  }
}
