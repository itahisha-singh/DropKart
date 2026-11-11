import { defineConfig } from 'vitest/config';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/dropkart_test';

export default defineConfig({
  test: {
    globalSetup: ['tests/globalSetup.ts'],
    // Tests share one real Postgres database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    env: { DATABASE_URL: TEST_DB_URL },
  },
});
