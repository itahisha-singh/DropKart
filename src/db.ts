import fs from 'node:fs';
import path from 'node:path';
import { Pool, PoolClient, types } from 'pg';
import { config } from './config';

// BIGINT (OID 20) arrives as a string by default. Money in minor units stays far below 2^53.
types.setTypeParser(20, (value) => Number(value));

export function createPool(url: string = config.databaseUrl, max: number = config.poolMax): Pool {
  return new Pool({ connectionString: url, max });
}

export async function migrate(pool: Pool): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// 40P01 = deadlock detected, 40001 = serialization failure. Postgres aborts one side; retrying is the standard fix.
const RETRYABLE = new Set(['40P01', '40001']);

/**
 * Runs `fn` inside a transaction. Rolls back on any error and retries on deadlocks.
 * Because of the retry, `fn` must only touch the database (no emails, no HTTP calls).
 */
export async function withTx<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code ?? '';
      if (attempt < maxRetries && RETRYABLE.has(code)) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
