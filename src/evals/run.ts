#!/usr/bin/env node
/**
 * Evals runner (trust-loop roadmap PR-2): executes every registered probe
 * task against a COLD-STARTED server, one fresh process per task.
 *
 * Judgment order per the plan: invariants first (a thrown ProbeFailure is
 * red regardless of speed), then the maxMs / maxBytes gates. The runner
 * always records p50/p95 for both ms and bytes so the numbers behind the
 * hard contract stay visible (ADR 0001). Any red task → exit code 1.
 *
 * This is a standalone CLI, not the MCP server: stdout here is human
 * output, stderr is free for diagnostics.
 */

import { join } from 'node:path';
import { spawnClient, repoRoot } from './mcp-client.js';
import { ALL_TASKS } from './tasks/registry.js';
import type { EvalTask } from './types.js';

interface TaskOutcome {
  id: string;
  ok: boolean;
  ms: number;
  bytes: number;
  detail?: string;
}

/** A wedged probe must fail the task, never hang CI. */
const WATCHDOG_MS = 120_000;

async function runTask(task: EvalTask, fixtureRoot: string): Promise<TaskOutcome> {
  const started = performance.now();
  const client = await spawnClient(fixtureRoot);
  try {
    const watchdog = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`probe exceeded the ${WATCHDOG_MS}ms watchdog`)), WATCHDOG_MS);
      timer.unref?.();
    });
    const { bytes } = await Promise.race([task.probe(client, fixtureRoot), watchdog]);
    const ms = performance.now() - started;
    if (ms > task.maxMs) {
      return { id: task.id, ok: false, ms, bytes, detail: `took ${Math.round(ms)}ms > maxMs ${task.maxMs}` };
    }
    if (bytes > task.maxBytes) {
      return { id: task.id, ok: false, ms, bytes, detail: `responses totaled ${bytes} bytes > maxBytes ${task.maxBytes}` };
    }
    return { id: task.id, ok: true, ms, bytes };
  } catch (err) {
    const ms = performance.now() - started;
    return { id: task.id, ok: false, ms, bytes: 0, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.close();
  }
}

/** Nearest-rank percentile over a sample list. */
function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

async function main(): Promise<void> {
  const fixtureRoot = join(repoRoot(), 'test-fixtures', 'sample-app');
  const outcomes: TaskOutcome[] = [];

  process.stdout.write(`module-graph-mcp evals — ${ALL_TASKS.length} probe task(s) against ${fixtureRoot}\n\n`);
  for (const task of ALL_TASKS) {
    const outcome = await runTask(task, fixtureRoot);
    outcomes.push(outcome);
    const verdict = outcome.ok ? 'PASS' : 'FAIL';
    const budget = `${String(Math.round(outcome.ms)).padStart(5)}ms/${task.maxMs}ms  ${String(outcome.bytes).padStart(6)}B/${task.maxBytes}B`;
    process.stdout.write(`  ${verdict}  ${task.id.padEnd(28)} ${budget}${outcome.detail ? `  — ${outcome.detail}` : ''}\n`);
  }

  const msSamples = outcomes.filter((o) => o.ok).map((o) => o.ms);
  const byteSamples = outcomes.filter((o) => o.ok).map((o) => o.bytes);
  const failed = outcomes.filter((o) => !o.ok);
  process.stdout.write(
    `\n  ${outcomes.length - failed.length}/${outcomes.length} green` +
      `   p50 ${Math.round(percentile(msSamples, 0.5))}ms / p95 ${Math.round(percentile(msSamples, 0.95))}ms` +
      `   p50 ${percentile(byteSamples, 0.5)}B / p95 ${percentile(byteSamples, 0.95)}B\n`
  );
  if (failed.length > 0) {
    process.stdout.write(`\n  ${failed.length} probe task(s) red:\n${failed.map((f) => `    - ${f.id}: ${f.detail}`).join('\n')}\n`);
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  process.stderr.write(`evals runner crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
