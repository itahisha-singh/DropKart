import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { key, makeCtx, resetDb, seedProduct, stockOf } from './helpers';

const { pool, service } = makeCtx();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

describe('idempotent requests', () => {
  it('25 simultaneous retries with the same key create exactly one order', async () => {
    const p = await seedProduct(service, { stock: 10 });
    const input = { productId: p.id, userId: 'retry-user', quantity: 1 };

    const results = await Promise.all(Array.from({ length: 25 }, () => service.createOrder(input, key('double-click'))));

    const orderIds = new Set(results.map((r) => (r.body as { id: string }).id));
    expect(orderIds.size).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(24);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await stockOf(pool, p.id)).toBe(9);
  });

  it('replays the original response when the same key is sent later', async () => {
    const p = await seedProduct(service, { stock: 10 });
    const input = { productId: p.id, userId: 'later-user', quantity: 1 };

    const first = await service.createOrder(input, key('later'));
    const again = await service.createOrder(input, key('later'));

    expect(again.replayed).toBe(true);
    expect(again.body).toEqual(first.body);
    expect(await stockOf(pool, p.id)).toBe(9);
  });

  it('rejects a reused key that comes with a different request', async () => {
    const p = await seedProduct(service, { stock: 10 });
    await service.createOrder({ productId: p.id, userId: 'mix-user', quantity: 1 }, key('mixup'));

    await expect(
      service.createOrder({ productId: p.id, userId: 'mix-user', quantity: 2 }, key('mixup')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 422 });
  });

  it('paying twice (double-submit) pays once and returns the same result', async () => {
    const p = await seedProduct(service, { stock: 5 });
    const order = (await service.createOrder({ productId: p.id, userId: 'payer', quantity: 1 }, key('pay-order')))
      .body as { id: string };

    const results = await Promise.all(Array.from({ length: 10 }, () => service.payOrder(order.id, key('pay-click'))));

    expect(results.every((r) => r.status === 200)).toBe(true);
    const { rows } = await pool.query("SELECT count(*) FROM order_events WHERE order_id = $1 AND to_status = 'PAID'", [
      order.id,
    ]);
    expect(Number(rows[0].count)).toBe(1);
  });
});
