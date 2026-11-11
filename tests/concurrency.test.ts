import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { key, makeCtx, resetDb, seedProduct, stockOf } from './helpers';

const { pool, service } = makeCtx();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

const orderCount = async (productId: string) =>
  Number((await pool.query('SELECT count(*) FROM orders WHERE product_id = $1', [productId])).rows[0].count);

describe('inventory under concurrency', () => {
  it('never oversells: 500 buyers fight for 50 units', async () => {
    const p = await seedProduct(service, { stock: 50, maxPerOrder: 1 });

    const results = await Promise.allSettled(
      Array.from({ length: 500 }, (_, i) =>
        service.createOrder({ productId: p.id, userId: `user-${i}`, quantity: 1 }, key(`buy-${i}`)),
      ),
    );

    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(winners).toHaveLength(50);
    expect(losers).toHaveLength(450);
    expect(losers.every((l) => l.reason instanceof AppError && l.reason.code === 'SOLD_OUT')).toBe(true);
    expect(await stockOf(pool, p.id)).toBe(0);
    expect(await orderCount(p.id)).toBe(50);
  });

  it('handles mixed quantities exactly: 20 buyers want 2 each, 7 in stock', async () => {
    const p = await seedProduct(service, { stock: 7, maxPerOrder: 2 });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        service.createOrder({ productId: p.id, userId: `pair-${i}`, quantity: 2 }, key(`pair-${i}`)),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await stockOf(pool, p.id)).toBe(1);
  });

  it('enforces the per-order quantity limit', async () => {
    const p = await seedProduct(service, { stock: 10, maxPerOrder: 2 });
    await expect(
      service.createOrder({ productId: p.id, userId: 'greedy', quantity: 3 }, key('greedy')),
    ).rejects.toMatchObject({ code: 'QUANTITY_LIMIT' });
    expect(await stockOf(pool, p.id)).toBe(10);
  });

  it('lets one user hold only one live order per product, and returns the stock it briefly took', async () => {
    const p = await seedProduct(service, { stock: 10 });
    await service.createOrder({ productId: p.id, userId: 'u1', quantity: 1 }, key('first-order'));

    await expect(
      service.createOrder({ productId: p.id, userId: 'u1', quantity: 1 }, key('second-order')),
    ).rejects.toMatchObject({ code: 'ALREADY_HAS_ORDER' });

    expect(await stockOf(pool, p.id)).toBe(9);
  });
});
