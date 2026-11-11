/**
 * Simulates a product drop: many buyers hit "Buy" at once, and every buyer's request is sent TWICE with the
 * same Idempotency-Key (like a double-click or a network retry).
 *
 *   npm run load -- --buyers 2000 --stock 200 --concurrency 200 --url http://127.0.0.1:3000
 *
 * It then checks the things that must never be wrong: no overselling, no duplicate orders, no stock drift.
 */
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const BASE = arg('url', 'http://127.0.0.1:3000');
const BUYERS = Number(arg('buyers', '2000'));
const STOCK = Number(arg('stock', '200'));
const CONCURRENCY = Number(arg('concurrency', '200'));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';

type Outcome = { status: number; ms: number; orderId?: string; code?: string };

async function post(path: string, body: unknown, key: string): Promise<Outcome> {
  const started = performance.now();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { code?: string } };
  return { status: res.status, ms: performance.now() - started, orderId: json.id, code: json.error?.code };
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

async function main() {
  const created = await fetch(`${BASE}/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
    body: JSON.stringify({ name: 'Load Test Drop', priceMinor: 99_900, currency: 'INR', stock: STOCK, maxPerOrder: 1 }),
  });
  if (!created.ok) throw new Error(`Could not create product: ${created.status} ${await created.text()}`);
  const product = (await created.json()) as { id: string };

  const outcomes: Outcome[] = [];
  const confirmed = new Set<string>();
  let disagreements = 0;
  let nextBuyer = 0;

  async function buyer() {
    for (;;) {
      const i = nextBuyer++;
      if (i >= BUYERS) return;
      const body = { productId: product.id, userId: `buyer-${i}`, quantity: 1 };
      const key = `load-${product.id}-${i}`;
      // Same request twice at the same moment: the retry must not create a second order.
      const [a, b] = await Promise.all([post('/orders', body, key), post('/orders', body, key)]);
      outcomes.push(a, b);
      if (a.status !== b.status || a.orderId !== b.orderId) disagreements++;
      if (a.status === 201 && a.orderId) confirmed.add(a.orderId);
    }
  }

  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, buyer));
  const seconds = (performance.now() - started) / 1000;

  const latencies = outcomes.map((o) => o.ms).sort((x, y) => x - y);
  const soldOut = outcomes.filter((o) => o.status === 409 && o.code === 'SOLD_OUT').length;
  const unexpected = outcomes.filter((o) => ![201, 409].includes(o.status));
  const finalStock = ((await (await fetch(`${BASE}/products/${product.id}`)).json()) as { stock: number }).stock;

  console.log('\n=== DropKart load test ===');
  console.log(`buyers: ${BUYERS}  stock: ${STOCK}  concurrency: ${CONCURRENCY}  requests: ${outcomes.length}`);
  console.log(`time: ${seconds.toFixed(2)}s   throughput: ${(outcomes.length / seconds).toFixed(0)} req/s`);
  console.log(
    `latency ms  p50: ${percentile(latencies, 0.5).toFixed(0)}  p95: ${percentile(latencies, 0.95).toFixed(0)}  p99: ${percentile(latencies, 0.99).toFixed(0)}`,
  );
  console.log(`confirmed orders: ${confirmed.size}   sold-out responses: ${soldOut}   unexpected: ${unexpected.length}`);
  console.log(`final stock: ${finalStock}`);

  const checks: [string, boolean][] = [
    ['no overselling (confirmed <= stock)', confirmed.size <= STOCK],
    ['sold out completely when demand > stock', BUYERS < STOCK || confirmed.size === STOCK],
    ['no stock drift (stock + confirmed = starting stock)', finalStock + confirmed.size === STOCK],
    ['retries never disagreed (no duplicate orders)', disagreements === 0],
    ['no unexpected status codes', unexpected.length === 0],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
