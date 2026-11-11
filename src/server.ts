import { createApp } from './app';
import { config } from './config';
import { createPool, migrate } from './db';
import { CheckoutService } from './services/checkoutService';

async function main() {
  const pool = createPool();
  await migrate(pool);

  const service = new CheckoutService(pool, { holdSeconds: config.holdSeconds });
  const app = createApp(service);
  const server = app.listen(config.port, () => console.log(`DropKart listening on :${config.port}`));

  // Background job: return stock held by unpaid reservations.
  const sweeper = setInterval(() => {
    service
      .releaseExpiredHolds()
      .then((n) => n > 0 && console.log(`released ${n} expired holds`))
      .catch((err) => console.error('sweeper failed', err));
  }, config.sweepIntervalMs);
  sweeper.unref();

  const shutdown = () => {
    clearInterval(sweeper);
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
