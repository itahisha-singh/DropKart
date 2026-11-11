import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, type OrderStatus } from '../src/domain/orderStateMachine';

describe('order state machine', () => {
  it('allows reservation, payment, failure, expiry, cancellation and refund moves', () => {
    expect(canTransition('RESERVED', 'PAYMENT_PENDING')).toBe(true);
    expect(canTransition('RESERVED', 'PAID')).toBe(true);
    expect(canTransition('PAYMENT_PENDING', 'PAYMENT_FAILED')).toBe(true);
    expect(canTransition('PAYMENT_FAILED', 'PAYMENT_PENDING')).toBe(true);
    expect(canTransition('PAID', 'REFUNDED')).toBe(true);
    expect(canTransition('RESERVED', 'EXPIRED')).toBe(true);
    expect(canTransition('RESERVED', 'CANCELLED')).toBe(true);
  });

  it('treats terminal states as final', () => {
    const finals: OrderStatus[] = ['EXPIRED', 'CANCELLED', 'REFUNDED'];
    const all: OrderStatus[] = ['RESERVED', 'PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'];
    for (const from of finals) for (const to of all) expect(canTransition(from, to)).toBe(false);
  });

  it('rejects an illegal move with a 409 error', () => {
    expect(() => assertTransition('EXPIRED', 'PAID')).toThrowError(/Cannot move an order from EXPIRED to PAID/);
  });
});
