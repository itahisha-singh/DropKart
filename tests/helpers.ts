import type { Pool } from 'pg';
import { createPool } from '../src/db';
import { CheckoutService } from '../src/services/checkoutService';
import { TEST_DB_URL } from './testDb';

export function makeCtx(opts: { holdSeconds?: number } = {}) {
  const pool = createPool(TEST_DB_URL, 20);
  const service = new CheckoutService(pool, { holdSeconds: opts.holdSeconds ?? 300 });
  return { pool, service };
}

export async function resetDb(pool: Pool) {
  await pool.query('TRUNCATE reconciliation_discrepancies, reconciliation_runs, ledger_entries, provider_webhook_events, payment_attempts, order_events, idempotency_keys, orders, products RESTART IDENTITY CASCADE');
}

export function seedProduct(
  service: CheckoutService,
  o: { stock: number; priceMinor?: number; maxPerOrder?: number },
) {
  return service.createProduct({
    name: 'Limited Edition Sneaker',
    priceMinor: o.priceMinor ?? 49_900,
    currency: 'INR',
    stock: o.stock,
    maxPerOrder: o.maxPerOrder ?? 2,
  });
}

export async function stockOf(pool: Pool, productId: string): Promise<number> {
  const { rows } = await pool.query('SELECT stock FROM products WHERE id = $1', [productId]);
  return rows[0].stock;
}

export const key = (label: string) => `test-key-${label}`;
