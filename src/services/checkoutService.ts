import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTx } from '../db';
import { AppError } from '../errors';
import { assertTransition, OrderStatus } from '../domain/orderStateMachine';
import { IdempotentResult, runIdempotent } from './idempotency';
import { multiplyMinor } from '../money/safeMoney';
import { PaymentService } from './paymentService';
import { MockPaymentProvider, type ProviderOutcome, type ProviderEvent } from './mockPaymentProvider';
import { config } from '../config';

type OrderRow = {
  id: string;
  product_id: string;
  user_id: string;
  quantity: number;
  amount_minor: number;
  currency: string;
  status: OrderStatus;
  hold_expires_at: Date;
};

type ProductRow = {
  id: string;
  name: string;
  price_minor: number;
  currency: string;
  stock: number;
  max_per_order: number;
};

export type OrderDto = {
  id: string;
  productId: string;
  userId: string;
  quantity: number;
  amountMinor: number;
  currency: string;
  status: OrderStatus;
  holdExpiresAt: string;
};

export type ProductDto = {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  stock: number;
  maxPerOrder: number;
};

export type CreateOrderInput = { productId: string; userId: string; quantity: number };
export type CreateProductInput = {
  name: string;
  priceMinor: number;
  currency: string;
  stock: number;
  maxPerOrder: number;
};

const toOrderDto = (r: OrderRow): OrderDto => ({
  id: r.id,
  productId: r.product_id,
  userId: r.user_id,
  quantity: r.quantity,
  amountMinor: r.amount_minor,
  currency: r.currency.trim(),
  status: r.status,
  holdExpiresAt: r.hold_expires_at.toISOString(),
});

const toProductDto = (r: ProductRow): ProductDto => ({
  id: r.id,
  name: r.name,
  priceMinor: r.price_minor,
  currency: r.currency.trim(),
  stock: r.stock,
  maxPerOrder: r.max_per_order,
});

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

export class CheckoutService {
  private readonly holdSeconds: number;
  private readonly payments: PaymentService;

  constructor(
    private readonly pool: Pool,
    opts: { holdSeconds?: number } = {},
  ) {
    this.holdSeconds = opts.holdSeconds ?? 300;
    this.payments = new PaymentService(this.pool, new MockPaymentProvider(config.webhookSecret));
  }

  // ---------------------------------------------------------------- products

  async createProduct(input: CreateProductInput): Promise<ProductDto> {
    const { rows } = await this.pool.query<ProductRow>(
      `INSERT INTO products (name, price_minor, currency, stock, max_per_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.name, input.priceMinor, input.currency, input.stock, input.maxPerOrder],
    );
    return toProductDto(rows[0]);
  }

  async getProduct(id: string): Promise<ProductDto> {
    const { rows } = await this.pool.query<ProductRow>('SELECT * FROM products WHERE id = $1', [id]);
    if (!rows[0]) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    return toProductDto(rows[0]);
  }

  // ----------------------------------------------------------------- orders

  async getOrder(id: string): Promise<OrderDto> {
    const { rows } = await this.pool.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [id]);
    if (!rows[0]) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    return toOrderDto(rows[0]);
  }

  /**
   * Reserve stock for a buyer and start the payment countdown.
   *
   * Overselling is prevented by ONE atomic statement: `UPDATE ... WHERE stock >= qty`.
   * Postgres locks the row, re-checks the condition after any concurrent winner commits, and only then
   * decrements. No read-then-write gap, so no race. The CHECK (stock >= 0) in the schema is a second guard.
   */
  async createOrder(input: CreateOrderInput, idempotencyKey: string): Promise<IdempotentResult> {
    const hash = sha256([input.productId, input.userId, input.quantity]);
    try {
      return await withTx(this.pool, (c) =>
        runIdempotent(c, `create_order:${input.userId}`, idempotencyKey, hash, async () => {
          const reserved = await c.query<{ price_minor: number; currency: string }>(
            `UPDATE products
                SET stock = stock - $2
              WHERE id = $1 AND stock >= $2 AND max_per_order >= $2
          RETURNING price_minor, currency`,
            [input.productId, input.quantity],
          );

          if (reserved.rowCount === 0) {
            // Nothing was reserved; work out why so the client gets a useful answer.
            const p = await c.query<ProductRow>('SELECT * FROM products WHERE id = $1', [input.productId]);
            if (!p.rows[0]) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
            if (input.quantity > p.rows[0].max_per_order) {
              throw new AppError(
                422,
                'QUANTITY_LIMIT',
                `At most ${p.rows[0].max_per_order} per order for this product`,
              );
            }
            throw new AppError(409, 'SOLD_OUT', 'Not enough stock left');
          }

          const { price_minor, currency } = reserved.rows[0];
          // Monetary totals use checked integer-minor-unit arithmetic.
          const amountMinor = multiplyMinor(price_minor, input.quantity);

          const inserted = await c.query<OrderRow>(
            `INSERT INTO orders
               (product_id, user_id, quantity, amount_minor, currency, status, hold_expires_at)
             VALUES ($1, $2, $3, $4, $5, 'RESERVED', now() + make_interval(secs => $6))
             RETURNING *`,
            [input.productId, input.userId, input.quantity, amountMinor, currency, this.holdSeconds],
          );
          const order = inserted.rows[0];
          await this.recordEvent(c, order.id, null, 'RESERVED');
          return { status: 201, body: toOrderDto(order) };
        }),
      );
    } catch (err) {
      // The partial unique index rejected a second live order for this user and product.
      // The transaction has already rolled back, so the stock we took is back.
      if (isUniqueViolation(err)) {
        throw new AppError(409, 'ALREADY_HAS_ORDER', 'You already have an active order for this product');
      }
      throw err;
    }
  }

  /** Runs the local mock provider and applies its signed webhook event. */
  async payOrder(orderId: string, idempotencyKey: string, outcome: ProviderOutcome = 'APPROVED'): Promise<IdempotentResult> {
    return this.payments.payOrder(orderId, idempotencyKey, outcome);
  }

  async refundOrder(orderId: string, idempotencyKey: string): Promise<IdempotentResult> {
    return this.payments.refundOrder(orderId, idempotencyKey);
  }

  async processPaymentWebhook(event: ProviderEvent, signature: string) {
    return this.payments.processWebhook(event, signature);
  }

  async reconcilePayments() {
    return this.payments.reconcile();
  }

  /** Buyer gives the item up: RESERVED -> CANCELLED and the stock returns to the pool. */
  async cancelOrder(orderId: string, idempotencyKey: string): Promise<IdempotentResult> {
    return withTx(this.pool, (c) =>
      runIdempotent(c, `cancel:${orderId}`, idempotencyKey, sha256(orderId), async () => {
        const order = await this.lockOrder(c, orderId);

        if (order.status === 'CANCELLED') return { status: 200, body: toOrderDto(order) };
        if (!['RESERVED', 'PAYMENT_PENDING', 'PAYMENT_FAILED'].includes(order.status)) {
          return { status: 409, body: { error: { code: 'INVALID_STATE', message: `Order is ${order.status}` } } };
        }

        const cancelled = await this.transition(c, order, 'CANCELLED');
        await this.releaseStock(c, order.product_id, order.quantity);
        return { status: 200, body: toOrderDto(cancelled) };
      }),
    );
  }

  /**
   * Gives back stock held by reservations nobody paid for. Safe to run from many workers at once:
   * FOR UPDATE SKIP LOCKED makes each worker take a different batch instead of waiting on each other.
   * Returns how many holds were released.
   */
  async releaseExpiredHolds(batchSize = 500): Promise<number> {
    return withTx(this.pool, async (c) => {
      const { rows } = await c.query<OrderRow>(
        `SELECT * FROM orders
          WHERE status IN ('RESERVED','PAYMENT_PENDING','PAYMENT_FAILED') AND hold_expires_at < now()
          ORDER BY hold_expires_at
          LIMIT $1
            FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      for (const order of rows) await this.expire(c, order);
      return rows.length;
    });
  }

  // ---------------------------------------------------------------- helpers

  private async lockOrder(c: PoolClient, orderId: string) {
    const { rows } = await c.query<OrderRow & { hold_expired: boolean }>(
      `SELECT *, hold_expires_at < now() AS hold_expired
         FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!rows[0]) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    return rows[0];
  }

  private async transition(c: PoolClient, order: OrderRow, to: OrderStatus): Promise<OrderRow> {
    assertTransition(order.status, to);
    const { rows } = await c.query<OrderRow>(
      `UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [order.id, to],
    );
    await this.recordEvent(c, order.id, order.status, to);
    return rows[0];
  }

  private async expire(c: PoolClient, order: OrderRow): Promise<void> {
    await this.transition(c, order, 'EXPIRED');
    await this.releaseStock(c, order.product_id, order.quantity);
  }

  private async releaseStock(c: PoolClient, productId: string, quantity: number): Promise<void> {
    await c.query('UPDATE products SET stock = stock + $2 WHERE id = $1', [productId, quantity]);
  }

  private async recordEvent(c: PoolClient, orderId: string, from: OrderStatus | null, to: OrderStatus) {
    await c.query('INSERT INTO order_events (order_id, from_status, to_status) VALUES ($1, $2, $3)', [
      orderId,
      from,
      to,
    ]);
  }
}
