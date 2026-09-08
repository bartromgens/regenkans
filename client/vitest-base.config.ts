import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Avoid forked workers: teardown was adding ~15s of kill timeouts here.
    pool: 'threads',
  },
});
