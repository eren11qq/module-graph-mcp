/**
 * Shared wall-clock budget for waits that ride the LIVE pipeline:
 * chokidar event → debounce → graph/state update → WS frame (or child
 * process stderr). Every budgeted step is real OS timing, so on a loaded
 * machine (parallel test files, antivirus on Windows) the chain can
 * legitimately take far longer than its idle-time latency — an 8 s budget
 * was observed to flake red at ~8.1 s while the suite itself was healthy.
 *
 * The budget must stay generous enough to survive load, yet finite so a
 * genuinely broken pipeline still fails loudly. Raise per-file only with a
 * measured reason; do not sprinkle ad-hoc numbers.
 */
export const PIPELINE_WAIT_MS = 30_000;
