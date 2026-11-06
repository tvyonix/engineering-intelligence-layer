import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    // CI disks are slower (fixture git clones in beforeEach); local default stayed 30s.
    hookTimeout: 60000,
    // GitHub-hosted runners crash the vitest worker pool with
    // ERR_IPC_CHANNEL_CLOSED (localized via ci-diag: a single-worker run
    // passes 195/195 there; local runs in any container config pass).
    // Run test files sequentially on CI, keep local parallelism.
    fileParallelism: process.env.CI !== 'true',
  },
});
