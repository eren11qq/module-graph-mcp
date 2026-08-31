import type { EvalTask } from '../types.js';

import { task as dashboardInfoReportsRoot } from './dashboard-info-reports-root.js';
import { task as moduleGraphShape } from './module-graph-shape.js';
import { task as moduleDetailsSource } from './module-details-source.js';
import { task as notFoundSuggests } from './not-found-suggests.js';
import { task as listUntestedCounts } from './list-untested-counts.js';
import { task as noteSetClear } from './note-set-clear.js';
import { task as reviewBeginEndPairs } from './review-begin-end-pairs.js';
import { task as testRunRemap } from './test-run-remap.js';
import { task as healthReportRanking } from './health-report-ranking.js';
import { task as reportPageHttp } from './report-page-http.js';
import { task as playbookPresent } from './playbook-present.js';

/**
 * The task registry — the single list the runner executes. The structure
 * test (tests/evals-structure.test.ts) audits this registry against the
 * disk BOTH ways: a task file not imported here, or a ghost entry with no
 * file behind it, turns the suite red.
 *
 * Budget provenance (ADR 0001): maxMs/maxBytes = local cold-start p95 × 1.5,
 * rounded up; measured 2026-08-31 on the dev machine (ms worst ~229ms, bytes
 * deterministic). CI (ubuntu) is slower — if the evals step goes red there,
 * re-measure on CI and write those numbers back.
 */
export const ALL_TASKS: readonly EvalTask[] = [
  dashboardInfoReportsRoot,
  moduleGraphShape,
  moduleDetailsSource,
  notFoundSuggests,
  listUntestedCounts,
  noteSetClear,
  reviewBeginEndPairs,
  testRunRemap,
  healthReportRanking,
  reportPageHttp,
  playbookPresent
];
