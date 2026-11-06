import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    // CI disks are slower than local (fixture git clones in beforeEach).
    hookTimeout: 60000,
  },
});
