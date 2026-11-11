import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { key, makeCtx, resetDb, seedProduct, stockOf } from './helpers';

const { pool, service } = makeCtx();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

const reserve = async (productId: string, userId: string, quantity = 1) =>
  (await service.createOrder({ productId, userId, quantity }, key(`reserve-${userId}`))).body as { id: string };

const backdate = (ids: string[]) =>
  pool.query("UPDATE orders SET hold_expires_at = now() - interval '1 second' WHERE id = ANY($1::uuid[])", [ids]);

describe('order lifecycle', () => {
  it('pays a live reservation', async () => {
    const p = await seedProduct(service, { stock: 3 });
    const o = await reserve(p.id, 'happy');
    const res = await service.payOrder(o.id, key('pay-happy'));
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('PAID');
    expect(await stockOf(pool, p.id)).toBe(2);
  });

  it('refuses payment after the hold expires and releases the stock', async () => {
    const p = await seedProduct(service, { stock: 3 });
    const o = await reserve(p.id, 'late');
    await backdate([o.id]);

    const res = await service.payOrder(o.id, key('pay-late'));

    expect(res.status).toBe(410);
    expect((await service.getOrder(o.id)).status).toBe('EXPIRED');
    expect(await stockOf(pool, p.id)).toBe(3);
  });

  it('cancelling returns stock; a cancelled order cannot be paid', async () => {
    const p = await seedProduct(service, { stock: 3 });
    const o = await reserve(p.id, 'changed-mind');

    expect((await service.cancelOrder(o.id, key('cancel-1'))).status).toBe(200);
    expect(await stockOf(pool, p.id)).toBe(3);

    const pay = await service.payOrder(o.id, key('pay-after-cancel'));
    expect(pay.status).toBe(409);
  });

  it('the sweeper releases every expired hold and leaves live ones alone', async () => {
    const p = await seedProduct(service, { stock: 10 });
    const stale = await Promise.all(['a', 'b', 'c'].map((u) => reserve(p.id, u)));
    await reserve(p.id, 'still-live');
    await backdate(stale.map((o) => o.id));

    expect(await service.releaseExpiredHolds()).toBe(3);
    expect(await service.releaseExpiredHolds()).toBe(0);
    expect(await stockOf(pool, p.id)).toBe(9);
  });

  it('a released seat can be bought by someone else', async () => {
    const p = await seedProduct(service, { stock: 1 });
    const first = await reserve(p.id, 'slow-buyer');
    await expect(
      service.createOrder({ productId: p.id, userId: 'fast-buyer', quantity: 1 }, key('fast-1')),
    ).rejects.toMatchObject({ code: 'SOLD_OUT' });

    await backdate([first.id]);
    await service.releaseExpiredHolds();

    const second = await service.createOrder({ productId: p.id, userId: 'fast-buyer', quantity: 1 }, key('fast-2'));
    expect(second.status).toBe(201);
  });
});

describe('stock accounting invariant', () => {
  it('stock + live order quantities always equals the starting stock, even with everything racing', async () => {
    const initial = 40;
    const p = await seedProduct(service, { stock: initial, maxPerOrder: 2 });

    const created = await Promise.allSettled(
      Array.from({ length: 150 }, (_, i) =>
        service.createOrder({ productId: p.id, userId: `racer-${i}`, quantity: (i % 2) + 1 }, key(`race-${i}`)),
      ),
    );
    const orders = created
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof service.createOrder>>> => r.status === 'fulfilled')
      .map((r) => r.value.body as { id: string });

    // Split the winners: pay a third, cancel a third, let a third expire. Run it all at once, with sweepers too.
    const toPay = orders.filter((_, i) => i % 3 === 0);
    const toCancel = orders.filter((_, i) => i % 3 === 1);
    const toExpire = orders.filter((_, i) => i % 3 === 2);
    await backdate(toExpire.map((o) => o.id));

    await Promise.all([
      ...toPay.map((o) => service.payOrder(o.id, key(`p-${o.id}`))),
      ...toCancel.map((o) => service.cancelOrder(o.id, key(`c-${o.id}`))),
      service.releaseExpiredHolds(),
      service.releaseExpiredHolds(),
    ]);
    await service.releaseExpiredHolds(); // final sweep for anything a concurrent sweeper skipped

    const stock = await stockOf(pool, p.id);
    const { rows } = await pool.query(
      "SELECT COALESCE(sum(quantity), 0)::int AS live FROM orders WHERE product_id = $1 AND status IN ('RESERVED', 'PAID')",
      [p.id],
    );
    expect(stock).toBeGreaterThanOrEqual(0);
    expect(stock + rows[0].live).toBe(initial);
    expect(rows[0].live).toBeGreaterThan(0);
  });
});
