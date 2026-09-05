import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Must stay ABOVE tests/helpers/wait-budget.ts PIPELINE_WAIT_MS: a test
    // that waits on the live pipeline needs its own budget to expire first,
    // so the failure reads "waitFor timeout: <what>" (the pipeline is
    // guilty) instead of a bare vitest kill (the harness is guilty).
    testTimeout: 45_000
  }
});
