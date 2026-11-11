import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type ProviderOutcome = 'APPROVED' | 'DECLINED' | 'TIMEOUT';
export type ProviderEvent = {
  id: string;
  type: 'payment.succeeded' | 'payment.failed';
  orderId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
};

export class MockPaymentProvider {
  constructor(private readonly signingSecret: string) {}

  /** Deterministic local simulator. TIMEOUT models an ambiguous network outcome; it does not charge. */
  createPayment(input: { orderId: string; amountMinor: number; currency: string; outcome?: ProviderOutcome }) {
    const outcome = input.outcome ?? 'APPROVED';
    if (outcome === 'TIMEOUT') return { outcome, event: null, signature: null } as const;
    const event: ProviderEvent = {
      id: randomUUID(),
      type: outcome === 'APPROVED' ? 'payment.succeeded' : 'payment.failed',
      orderId: input.orderId,
      paymentId: `mock_${randomUUID()}`,
      amountMinor: input.amountMinor,
      currency: input.currency,
      occurredAt: new Date().toISOString(),
    };
    return { outcome, event, signature: this.sign(event) } as const;
  }

  sign(event: ProviderEvent): string {
    return createHmac('sha256', this.signingSecret).update(JSON.stringify(event)).digest('hex');
  }

  verify(event: ProviderEvent, signature: string): boolean {
    const expected = Buffer.from(this.sign(event), 'hex');
    let supplied: Buffer;
    try { supplied = Buffer.from(signature, 'hex'); } catch { return false; }
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}
