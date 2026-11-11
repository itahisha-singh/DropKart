export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/dropkart',
  poolMax: Number(process.env.PG_POOL_MAX ?? 20),
  holdSeconds: Number(process.env.HOLD_SECONDS ?? 300),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 5000),
  adminToken: process.env.ADMIN_TOKEN ?? 'dev-admin-token',
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'local-only-webhook-secret-change-me',
};
