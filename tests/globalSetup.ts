import { createPool, migrate } from '../src/db';
import { TEST_DB_URL } from './testDb';

// Create the tables once, before any test file runs.
export default async function setup() {
  const pool = createPool(TEST_DB_URL, 2);
  await migrate(pool);
  await pool.end();
}
