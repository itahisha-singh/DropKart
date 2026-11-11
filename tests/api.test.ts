import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { makeCtx, resetDb } from './helpers';

const { pool, service } = makeCtx();
const app = createApp(service);
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function newProduct(stock = 5) {
  const res = await request(app)
    .post('/products')
    .set('x-admin-token', config.adminToken)
    .send({ name: 'Concert Pass', priceMinor: 250_000, currency: 'inr', stock, maxPerOrder: 2 });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

describe('HTTP API', () => {
  it('protects product creation with the admin token', async () => {
    const res = await request(app).post('/products').send({ name: 'x', priceMinor: 1, currency: 'INR', stock: 1 });
    expect(res.status).toBe(401);
  });

  it('requires an Idempotency-Key header', async () => {
    const p = await newProduct();
    const res = await request(app).post('/orders').send({ productId: p.id, userId: 'u1', quantity: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('reserves, replays a retry, pays, and reads the order back', async () => {
    const p = await newProduct();
    const body = { productId: p.id, userId: 'u1', quantity: 2 };

    const first = await request(app).post('/orders').set('Idempotency-Key', 'http-key-0001').send(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'RESERVED', amountMinor: 500_000, currency: 'INR' });

    const retry = await request(app).post('/orders').set('Idempotency-Key', 'http-key-0001').send(body);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);

    const paid = await request(app).post(`/orders/${first.body.id}/pay`).set('Idempotency-Key', 'http-pay-0001');
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');

    const read = await request(app).get(`/orders/${first.body.id}`);
    expect(read.body.status).toBe('PAID');

    const stock = await request(app).get(`/products/${p.id}`);
    expect(stock.body.stock).toBe(3);
  });

  it('answers 409 SOLD_OUT with a clean JSON error', async () => {
    const p = await newProduct(1);
    await request(app).post('/orders').set('Idempotency-Key', 'sold-key-0001').send({ productId: p.id, userId: 'a', quantity: 1 });
    const res = await request(app).post('/orders').set('Idempotency-Key', 'sold-key-0002').send({ productId: p.id, userId: 'b', quantity: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SOLD_OUT');
  });

  it('returns 404 for unknown orders and 400 for malformed ids', async () => {
    expect((await request(app).get('/orders/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await request(app).get('/orders/not-a-uuid')).status).toBe(400);
  });
});
