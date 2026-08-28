import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TypeErrorEntry } from '../shared/types.js';

/**
 * Ticket 07: type-error badge source.
 *
 * Runs the watched repository's type check (`tsc --noEmit --pretty false`)
 * as a child process, parses the diagnostics and groups them per file into
 * `TypeErrorEntry` lists (line + TS error code + message). Every failure
 * mode degrades to a status instead of throwing:
 *
 *   'ok'           — clean run, zero diagnostics
 *   'errors'       — diagnostics parsed and grouped
 *   'timeout'      — killed after timeoutMs
 *   'unavailable'  — no tsc found under the watched root
 *   'parse-failed' — tsc exited non-zero but produced no parsable output
 */

export type TypecheckStatus = 'ok' | 'errors' | 'timeout' | 'unavailable' | 'parse-failed';

export interface TypecheckOptions {
  /** kill the child after this many ms; default 60_000 */
  timeoutMs?: number;
  /** override the tsc entry script; default probes the watched root's node_modules */
  tscBin?: string;
  /** node executable used to run tscBin; default process.execPath */
  nodeBin?: string;
}

export interface TypecheckResult {
  status: TypecheckStatus;
  /** root-relative POSIX path -> diagnostics, sorted by line */
  errorsByFile: Map<string, TypeErrorEntry[]>;
  totalErrors: number;
  /** diagnostics with no file location (config errors etc.) */
  globalMessages: string[];
  /** human-readable note for degraded statuses */
  note?: string;
  durationMs: number;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
/** After the timeout SIGTERM, how long a stubborn child gets before SIGKILL. */
export const SIGKILL_GRACE_MS = 2_000;

// `src/foo.ts(12,5): error TS2322: ...` — file paths may contain spaces, so
// anchor on the trailing (line,col) group instead of greedily splitting.
const FILE_DIAGNOSTIC_RE = /^(.+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
const GLOBAL_DIAGNOSTIC_RE = /^error\s+(TS\d+):\s+(.+)$/;

// ---------------------------------------------------------------------------
// Diagnostic parsing (pure: unit-testable without spawning anything)
// ---------------------------------------------------------------------------

/**
 * Normalise one diagnostic file reference to a root-relative POSIX path.
 * tsc prints cwd-relative paths most of the time but absolute ones are
 * handled too; paths outside the root are returned as-is (posix-ified).
 */
export function diagnosticPathToRelative(rawFile: string, rootPath: string): string {
  const rootPosix = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const posix = rawFile.replace(/\\/g, '/').trim();
  if (posix.startsWith(`${rootPosix}/`)) return posix.slice(rootPosix.length + 1);
  // Drive letters differ only by case on Windows.
  if (posix.toLowerCase().startsWith(`${rootPosix.toLowerCase()}/`)) {
    return posix.slice(rootPosix.length + 1);
  }
  return posix;
}

export interface ParsedDiagnostics {
  errorsByFile: Map<string, TypeErrorEntry[]>;
  globalMessages: string[];
  totalErrors: number;
}

/** Parse combined stdout+stderr of `tsc --noEmit --pretty false`. */
export function parseTscOutput(output: string, rootPath: string): ParsedDiagnostics {
  const errorsByFile = new Map<string, TypeErrorEntry[]>();
  const globalMessages: string[] = [];
  let totalErrors = 0;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0) continue;

    const fileMatch = FILE_DIAGNOSTIC_RE.exec(line);
    if (fileMatch !== null) {
      const [, filePart, linePart, , codePart, messagePart] = fileMatch;
      if (filePart === undefined || linePart === undefined || codePart === undefined || messagePart === undefined) continue;
      const rel = diagnosticPathToRelative(filePart, rootPath);
      const bucket = errorsByFile.get(rel) ?? [];
      bucket.push({ line: Number(linePart), code: codePart, message: messagePart.trim() });
      errorsByFile.set(rel, bucket);
      totalErrors++;
      continue;
    }

    const globalMatch = GLOBAL_DIAGNOSTIC_RE.exec(line);
    if (globalMatch !== null) {
      const [, codePart, messagePart] = globalMatch;
      globalMessages.push(`${codePart}: ${messagePart?.trim() ?? ''}`);
      totalErrors++;
    }
    // Anything else (banners, "Found N errors" summaries) is noise.
  }

  for (const bucket of errorsByFile.values()) {
    bucket.sort((a, b) => a.line - b.line);
  }
  return { errorsByFile, globalMessages, totalErrors };
}

// ---------------------------------------------------------------------------
// tsc discovery
// ---------------------------------------------------------------------------

/** Probes the watched root's own node_modules; undefined = no local tsc. */
export function resolveTscBin(rootPath: string): string | undefined {
  const candidates = [
    join(rootPath, 'node_modules', 'typescript', 'bin', 'tsc'),
    join(rootPath, 'node_modules', '.bin', 'tsc')
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The runner proper
// ---------------------------------------------------------------------------

/**
 * Never throws: every failure mode lands in `status` + `note` so the
 * dashboard can show a degraded badge instead of crashing.
 */
export function runTypecheck(rootPath: string, options: TypecheckOptions = {}): Promise<TypecheckResult> {
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const tscBin = options.tscBin ?? resolveTscBin(rootPath);
  if (tscBin === undefined) {
    return Promise.resolve({
      status: 'unavailable',
      errorsByFile: new Map(),
      totalErrors: 0,
      globalMessages: [],
      note: 'no tsc under <root>/node_modules — install typescript to enable type badges',
      durationMs: elapsed()
    });
  }

  return new Promise<TypecheckResult>((resolvePromise) => {
    let settled = false;
    const finish = (result: TypecheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolvePromise(result);
    };

    let child;
    try {
      child = spawn(options.nodeBin ?? process.execPath, [tscBin, '--noEmit', '--pretty', 'false'], {
        cwd: rootPath,
        windowsHide: true
      });
    } catch (err) {
      finish({
        status: 'unavailable',
        errorsByFile: new Map(),
        totalErrors: 0,
        globalMessages: [],
        note: `failed to spawn tsc: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: elapsed()
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A child that ignores SIGTERM never emits 'close', leaving this
      // promise unsettled and the typecheck pipeline locked forever;
      // SIGKILL cannot be ignored and guarantees the exit event.
      killTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish({
        status: 'unavailable',
        errorsByFile: new Map(),
        totalErrors: 0,
        globalMessages: [],
        note: code === 'ENOENT' ? `node binary not found: ${options.nodeBin ?? process.execPath}` : `tsc spawn failed: ${err.message}`,
        durationMs: elapsed()
      });
    });

    child.on('close', (exitCode: number | null) => {
      if (timedOut) {
        finish({
          status: 'timeout',
          errorsByFile: new Map(),
          totalErrors: 0,
          globalMessages: [],
          note: `tsc killed after ${timeoutMs}ms`,
          durationMs: elapsed()
        });
        return;
      }

      const parsed = parseTscOutput(`${stdout}\n${stderr}`, rootPath);
      if (parsed.totalErrors > 0) {
        finish({
          status: 'errors',
          errorsByFile: parsed.errorsByFile,
          totalErrors: parsed.totalErrors,
          globalMessages: parsed.globalMessages,
          durationMs: elapsed()
        });
        return;
      }
      if (exitCode === 0) {
        finish({
          status: 'ok',
          errorsByFile: new Map(),
          totalErrors: 0,
          globalMessages: [],
          durationMs: elapsed()
        });
        return;
      }
      const head = `${stdout}\n${stderr}`.trim().split('\n').slice(0, 3).join(' | ');
      finish({
        status: 'parse-failed',
        errorsByFile: new Map(),
        totalErrors: 0,
        globalMessages: [],
        note: `tsc exited ${exitCode} without parsable diagnostics: ${head || '(no output)'}`,
        durationMs: elapsed()
      });
    });
  });
}
