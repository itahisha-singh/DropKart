import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTx } from '../db';
import { AppError } from '../errors';
import { assertTransition, type OrderStatus } from '../domain/orderStateMachine';
import { runIdempotent, type IdempotentResult } from './idempotency';
import { MockPaymentProvider, type ProviderEvent, type ProviderOutcome } from './mockPaymentProvider';

type Order = { id: string; user_id: string; product_id: string; quantity: number; amount_minor: number; currency: string; status: OrderStatus; hold_expired?: boolean };
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class PaymentService {
  constructor(private readonly pool: Pool, private readonly provider: MockPaymentProvider) {}

  async payOrder(orderId: string, idempotencyKey: string, outcome: ProviderOutcome = 'APPROVED'): Promise<IdempotentResult> {
    return withTx(this.pool, (c) => runIdempotent(c, `pay:${orderId}`, idempotencyKey, hash({ orderId, outcome }), async () => {
      const { rows } = await c.query<Order>(`SELECT *, hold_expires_at < now() AS hold_expired FROM orders WHERE id=$1 FOR UPDATE`, [orderId]);
      const order = rows[0];
      if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
      if (order.status === 'PAID') return { status: 200, body: { orderId, status: 'PAID' } };
      if (order.hold_expired && ['RESERVED', 'PAYMENT_PENDING', 'PAYMENT_FAILED'].includes(order.status)) {
        await this.transition(c, order, 'EXPIRED');
        await c.query('UPDATE products SET stock=stock+$2 WHERE id=$1', [order.product_id, order.quantity]);
        return { status: 410, body: { error: { code: 'HOLD_EXPIRED', message: 'Reservation expired; stock released' } } };
      }
      if (!['RESERVED', 'PAYMENT_PENDING', 'PAYMENT_FAILED'].includes(order.status)) {
        return { status: 409, body: { error: { code: 'INVALID_STATE', message: `Order is ${order.status}` } } };
      }
      const attemptId = randomUUID();
      await c.query(`INSERT INTO payment_attempts(id,order_id,status,amount_minor,currency) VALUES($1,$2,'PENDING',$3,$4)`, [attemptId, order.id, order.amount_minor, order.currency]);
      if (order.status !== 'PAYMENT_PENDING') await this.transition(c, order, 'PAYMENT_PENDING');
      const result = this.provider.createPayment({ orderId, amountMinor: order.amount_minor, currency: order.currency.trim(), outcome });
      if (result.outcome === 'TIMEOUT') {
        await c.query(`UPDATE payment_attempts SET status='TIMED_OUT',updated_at=now() WHERE id=$1`, [attemptId]);
        return { status: 202, body: { orderId, status: 'PAYMENT_PENDING', message: 'Provider timed out; payment outcome is unknown. Retry or await webhook.' } };
      }
      await c.query(`UPDATE payment_attempts SET provider_payment_id=$2 WHERE id=$1`, [attemptId, result.event.paymentId]);
      await this.processEvent(c, result.event, result.signature!);
      const latest = await c.query<{ status: string }>('SELECT status FROM orders WHERE id=$1', [orderId]);
      return { status: result.outcome === 'APPROVED' ? 200 : 402, body: { orderId, status: latest.rows[0].status, paymentId: result.event.paymentId } };
    }));
  }

  async processWebhook(event: ProviderEvent, signature: string): Promise<{ accepted: boolean; duplicate: boolean }> {
    if (!this.provider.verify(event, signature)) throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature is invalid');
    return withTx(this.pool, async (c) => this.processEvent(c, event, signature));
  }

  private async processEvent(c: PoolClient, event: ProviderEvent, _signature: string): Promise<{ accepted: boolean; duplicate: boolean }> {
    const inserted = await c.query(`INSERT INTO provider_webhook_events(provider_event_id,payment_id,event_type,payload)
      VALUES($1,$2,$3,$4) ON CONFLICT(provider_event_id) DO NOTHING`, [event.id, event.paymentId, event.type, JSON.stringify(event)]);
    if (inserted.rowCount === 0) return { accepted: true, duplicate: true };
    const { rows } = await c.query<Order>(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [event.orderId]);
    const order = rows[0];
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found for provider event');
    if (event.amountMinor !== order.amount_minor || event.currency !== order.currency.trim()) {
      throw new AppError(422, 'PAYMENT_MISMATCH', 'Provider amount or currency does not match the order');
    }
    const attempt = await c.query<{ id: string }>(`SELECT id FROM payment_attempts WHERE provider_payment_id=$1 AND order_id=$2`, [event.paymentId, order.id]);
    if (!attempt.rows[0]) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment attempt not found');
    if (event.type === 'payment.succeeded') {
      if (order.status !== 'PAID') {
        assertTransition(order.status, 'PAID');
        await c.query(`UPDATE orders SET status='PAID',updated_at=now() WHERE id=$1`, [order.id]);
        await c.query(`INSERT INTO order_events(order_id,from_status,to_status) VALUES($1,$2,'PAID')`, [order.id, order.status]);
        const amount = order.amount_minor;
        if (amount > 0) {
          const journalId = randomUUID();
          await c.query(`INSERT INTO ledger_entries(journal_id,order_id,payment_attempt_id,account,currency,debit_minor)
            VALUES($1,$2,$3,'PROVIDER_CLEARING',$4,$5)`, [journalId, order.id, attempt.rows[0].id, order.currency, amount]);
          await c.query(`INSERT INTO ledger_entries(journal_id,order_id,payment_attempt_id,account,currency,credit_minor)
            VALUES($1,$2,$3,'MERCHANDISE_REVENUE',$4,$5)`, [journalId, order.id, attempt.rows[0].id, order.currency, amount]);
        }
      }
      await c.query(`UPDATE payment_attempts SET status='SUCCEEDED',updated_at=now() WHERE id=$1`, [attempt.rows[0].id]);
    } else {
      if (order.status === 'PAYMENT_PENDING') {
        await c.query(`UPDATE orders SET status='PAYMENT_FAILED',updated_at=now() WHERE id=$1`, [order.id]);
        await c.query(`INSERT INTO order_events(order_id,from_status,to_status) VALUES($1,'PAYMENT_PENDING','PAYMENT_FAILED')`, [order.id]);
      }
      await c.query(`UPDATE payment_attempts SET status='FAILED',failure_code='MOCK_DECLINED',updated_at=now() WHERE id=$1`, [attempt.rows[0].id]);
    }
    return { accepted: true, duplicate: false };
  }

  async refundOrder(orderId: string, idempotencyKey: string): Promise<IdempotentResult> {
    return withTx(this.pool, (c) => runIdempotent(c, `refund:${orderId}`, idempotencyKey, hash(orderId), async () => {
      const { rows } = await c.query<Order>(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId]);
      const order = rows[0];
      if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
      if (order.status === 'REFUNDED') return { status: 200, body: { orderId, status: 'REFUNDED' } };
      if (order.status !== 'PAID') return { status: 409, body: { error: { code: 'NOT_REFUNDABLE', message: 'Only paid orders can be refunded' } } };
      const { rows: attempts } = await c.query<{ id: string }>(`SELECT id FROM payment_attempts WHERE order_id=$1 AND status='SUCCEEDED' ORDER BY created_at DESC LIMIT 1`, [orderId]);
      if (!attempts[0]) throw new AppError(409, 'PAYMENT_NOT_FOUND', 'No successful payment to refund');
      if (order.amount_minor > 0) {
        const journalId = randomUUID();
        await c.query(`INSERT INTO ledger_entries(journal_id,order_id,payment_attempt_id,account,currency,debit_minor)
          VALUES($1,$2,$3,'MERCHANDISE_REVENUE',$4,$5)`, [journalId, order.id, attempts[0].id, order.currency, order.amount_minor]);
        await c.query(`INSERT INTO ledger_entries(journal_id,order_id,payment_attempt_id,account,currency,credit_minor)
          VALUES($1,$2,$3,'PROVIDER_CLEARING',$4,$5)`, [journalId, order.id, attempts[0].id, order.currency, order.amount_minor]);
      }
      await c.query(`UPDATE payment_attempts SET status='REFUNDED',updated_at=now() WHERE id=$1`, [attempts[0].id]);
      await c.query(`UPDATE orders SET status='REFUNDED',updated_at=now() WHERE id=$1`, [orderId]);
      await c.query(`INSERT INTO order_events(order_id,from_status,to_status) VALUES($1,'PAID','REFUNDED')`, [orderId]);
      return { status: 200, body: { orderId, status: 'REFUNDED', amountMinor: order.amount_minor, currency: order.currency.trim() } };
    }));
  }

  async reconcile(): Promise<{ runId: string; mismatchCount: number }> {
    return withTx(this.pool, async (c) => {
      const run = await c.query<{ id: string }>(`INSERT INTO reconciliation_runs DEFAULT VALUES RETURNING id`);
      const runId = run.rows[0].id;
      // A PAID order must have balanced ledger entries equal to its order amount.
      const { rows } = await c.query<{ id: string; amount_minor: number; currency: string; status: string; debits: number; credits: number }>(`
        SELECT o.id,o.amount_minor,o.currency,o.status,
          COALESCE(sum(l.debit_minor),0)::bigint AS debits,
          COALESCE(sum(l.credit_minor),0)::bigint AS credits
        FROM orders o LEFT JOIN ledger_entries l ON l.order_id=o.id
        WHERE o.status IN ('PAID','REFUNDED') GROUP BY o.id
      `);
      let mismatchCount = 0;
      for (const row of rows) {
        const expected = Number(row.amount_minor) * (row.status === 'REFUNDED' ? 2 : 1);
        const valid = Number(row.debits) === Number(row.credits) && Number(row.debits) === expected;
        if (!valid) {
          mismatchCount++;
          await c.query(`INSERT INTO reconciliation_discrepancies(run_id,order_id,discrepancy_type,details)
            VALUES($1,$2,'UNBALANCED_LEDGER',$3)`, [runId, row.id, JSON.stringify({ expectedGrossMinor: expected, debitMinor: row.debits, creditMinor: row.credits })]);
        }
      }
      await c.query(`UPDATE reconciliation_runs SET finished_at=now(),mismatch_count=$2 WHERE id=$1`, [runId, mismatchCount]);
      return { runId, mismatchCount };
    });
  }
    private async transition(
    c: PoolClient,
    order: Order,
    to: OrderStatus
  ): Promise<void> {
    assertTransition(order.status, to);

    await c.query(
      `UPDATE orders SET status=$2, updated_at=now() WHERE id=$1`,
      [order.id, to]
    );

    await c.query(
      `INSERT INTO order_events(order_id, from_status, to_status)
       VALUES($1, $2, $3)`,
      [order.id, order.status, to]
    );

    order.status = to;
  }
}
