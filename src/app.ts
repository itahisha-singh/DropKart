import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, ZodError } from 'zod';
import { config } from './config';
import { AppError } from './errors';
import { CheckoutService } from './services/checkoutService';
import type { IdempotentResult } from './services/idempotency';

const idempotencyKeySchema = z.string().min(8).max(128);
const uuid = z.string().uuid();

const createOrderSchema = z.object({
  productId: uuid,
  userId: z.string().min(1).max(100),
  quantity: z.number().int().min(1).max(10),
});

const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).transform((s) => s.toUpperCase()),
  stock: z.number().int().nonnegative(),
  maxPerOrder: z.number().int().positive().max(10).default(2),
});

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const requireIdempotencyKey = (req: Request) => idempotencyKeySchema.parse(req.header('idempotency-key'));

function send(res: Response, result: IdempotentResult) {
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
}

export function createApp(service: CheckoutService) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Seeding a drop is an admin action. (Real auth arrives in a later phase.)
  app.post(
    '/products',
    wrap(async (req, res) => {
      if (req.header('x-admin-token') !== config.adminToken) {
        throw new AppError(401, 'UNAUTHORIZED', 'Missing or wrong admin token');
      }
      const product = await service.createProduct(createProductSchema.parse(req.body));
      res.status(201).json(product);
    }),
  );

  app.get(
    '/products/:id',
    wrap(async (req, res) => {
      res.json(await service.getProduct(uuid.parse(req.params.id)));
    }),
  );

  app.post(
    '/orders',
    wrap(async (req, res) => {
      const key = requireIdempotencyKey(req);
      const input = createOrderSchema.parse(req.body);
      send(res, await service.createOrder(input, key));
    }),
  );

  app.get(
    '/orders/:id',
    wrap(async (req, res) => {
      res.json(await service.getOrder(uuid.parse(req.params.id)));
    }),
  );

  app.post(
    '/orders/:id/pay',
    wrap(async (req, res) => {
      const key = requireIdempotencyKey(req);
      const body = z.object({ outcome: z.enum(['APPROVED', 'DECLINED', 'TIMEOUT']).optional() }).parse(req.body ?? {});
      send(res, await service.payOrder(uuid.parse(req.params.id), key, body.outcome));
    }),
  );

  app.post(
    '/orders/:id/refund',
    wrap(async (req, res) => {
      const key = requireIdempotencyKey(req);
      send(res, await service.refundOrder(uuid.parse(req.params.id), key));
    }),
  );

  app.post(
    '/webhooks/mock-provider',
    wrap(async (req, res) => {
      const eventSchema = z.object({
        id: z.string().uuid(), type: z.enum(['payment.succeeded', 'payment.failed']),
        orderId: uuid, paymentId: z.string().min(1), amountMinor: z.number().int().nonnegative(),
        currency: z.string().length(3), occurredAt: z.string().datetime(),
      });
      const event = eventSchema.parse(req.body);
      const result = await service.processPaymentWebhook(event, req.header('x-provider-signature') ?? '');
      res.json(result);
    }),
  );

  app.post('/admin/reconciliation/run', wrap(async (req, res) => {
    if (req.header('x-admin-token') !== config.adminToken) throw new AppError(401, 'UNAUTHORIZED', 'Missing or wrong admin token');
    res.json(await service.reconcilePayments());
  }));

  app.post(
    '/orders/:id/cancel',
    wrap(async (req, res) => {
      const key = requireIdempotencyKey(req);
      send(res, await service.cancelOrder(uuid.parse(req.params.id), key));
    }),
  );

  // Error handler: expected errors become clean JSON, anything else is logged and hidden from the client.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
    } else if (err instanceof ZodError) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid request', details: err.issues } });
    } else if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    } else {
      console.error(err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
    }
  });

  return app;
}
