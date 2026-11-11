import type { PoolClient } from 'pg';
import { AppError } from '../errors';

export type WorkResult = { status: number; body: unknown };
export type IdempotentResult = WorkResult & { replayed: boolean };

/**
 * Runs `work` at most once per (scope, key), and replays the stored response on repeats.
 *
 * How it stays correct under concurrency: the key row is inserted INSIDE the same transaction as the
 * business work. If two requests with the same key arrive together, Postgres makes the second INSERT
 * wait for the first transaction to finish. When the first commits, the second sees the conflict and
 * just reads the stored response. If the first rolls back, the second proceeds and does the work itself.
 * So there is no "in progress" state to manage and no window where both can do the work.
 */
export async function runIdempotent(
  client: PoolClient,
  scope: string,
  key: string,
  requestHash: string,
  work: () => Promise<WorkResult>,
): Promise<IdempotentResult> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (scope, key, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (scope, key) DO NOTHING`,
    [scope, key, requestHash],
  );

  if (inserted.rowCount === 0) {
    const existing = await client.query(
      `SELECT request_hash, response_status, response_body
         FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const row = existing.rows[0];
    if (row.request_hash !== requestHash) {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request body',
      );
    }
    return { status: row.response_status, body: row.response_body, replayed: true };
  }

  const result = await work();
  await client.query(
    `UPDATE idempotency_keys SET response_status = $3, response_body = $4
      WHERE scope = $1 AND key = $2`,
    [scope, key, result.status, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}
