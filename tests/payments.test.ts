import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MockPaymentProvider } from '../src/services/mockPaymentProvider';
import { config } from '../src/config';
import { makeCtx, resetDb, seedProduct } from './helpers';

const { pool, service } = makeCtx();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());
const reserve = async (user: string) => {
  const p = await seedProduct(service, { stock: 5, priceMinor: 12_345 });
  const r = await service.createOrder({ productId: p.id, userId: user, quantity: 2 }, `reserve-${user}-key`);
  return { id: (r.body as { id: string }).id, productId: p.id };
};

describe('Phase 2 payment, ledger and reconciliation', () => {
  it('approves a payment and writes balanced double-entry ledger rows', async () => {
    const o = await reserve('buyer-approved');
    const paid = await service.payOrder(o.id, 'payment-approved-key', 'APPROVED');
    expect(paid.status).toBe(200);
    expect((await service.getOrder(o.id)).status).toBe('PAID');
    const { rows } = await pool.query(`SELECT sum(debit_minor)::bigint AS debits,sum(credit_minor)::bigint AS credits,count(*)::int AS n FROM ledger_entries WHERE order_id=$1`, [o.id]);
    expect(Number(rows[0].debits)).toBe(24_690);
    expect(Number(rows[0].credits)).toBe(24_690);
    expect(rows[0].n).toBe(2);
  });

  it('records declines without marking an order paid; a later retry can succeed', async () => {
    const o = await reserve('buyer-declined');
    const declined = await service.payOrder(o.id, 'payment-declined-key', 'DECLINED');
    expect(declined.status).toBe(402);
    expect((await service.getOrder(o.id)).status).toBe('PAYMENT_FAILED');
    const approved = await service.payOrder(o.id, 'payment-retry-key', 'APPROVED');
    expect(approved.status).toBe(200);
    expect((await service.getOrder(o.id)).status).toBe('PAID');
  });

  it('keeps an ambiguous timeout pending and supports later retry', async () => {
    const o = await reserve('buyer-timeout');
    const timeout = await service.payOrder(o.id, 'payment-timeout-key', 'TIMEOUT');
    expect(timeout.status).toBe(202);
    expect((await service.getOrder(o.id)).status).toBe('PAYMENT_PENDING');
    expect((await service.payOrder(o.id, 'payment-after-timeout-key', 'APPROVED')).status).toBe(200);
  });

  it('refunds a paid order with a balanced reversing journal', async () => {
    const o = await reserve('buyer-refund');
    await service.payOrder(o.id, 'payment-refund-key', 'APPROVED');
    const refund = await service.refundOrder(o.id, 'refund-idempotency-key');
    expect(refund.status).toBe(200);
    expect((await service.getOrder(o.id)).status).toBe('REFUNDED');
    const { rows } = await pool.query(`SELECT sum(debit_minor)::bigint AS debits,sum(credit_minor)::bigint AS credits FROM ledger_entries WHERE order_id=$1`, [o.id]);
    expect(Number(rows[0].debits)).toBe(Number(rows[0].credits));
    expect(Number(rows[0].debits)).toBe(49_380);
  });

  it('reconciliation reports a clean ledger and catches an injected discrepancy', async () => {
    const o = await reserve('buyer-reconcile');
    await service.payOrder(o.id, 'payment-reconcile-key', 'APPROVED');
    expect((await service.reconcilePayments()).mismatchCount).toBe(0);
    await pool.query(`DELETE FROM ledger_entries WHERE id=(SELECT min(id) FROM ledger_entries WHERE order_id=$1)`, [o.id]);
    expect((await service.reconcilePayments()).mismatchCount).toBe(1);
  });

  it('rejects invalid provider signatures', async () => {
    const o = await reserve('buyer-signature');
    await service.payOrder(o.id, 'payment-signature-key', 'APPROVED');
    const provider = new MockPaymentProvider(config.webhookSecret);
    const event = { id: 'f8f79d20-2fb1-4f8e-98d0-2c81c8e9b7bb', type: 'payment.succeeded' as const, orderId: o.id, paymentId: 'not-a-real-payment', amountMinor: 24_690, currency: 'INR', occurredAt: new Date().toISOString() };
    expect(provider.verify(event, '00')).toBe(false);
    await expect(service.processPaymentWebhook(event, '00')).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });
});
