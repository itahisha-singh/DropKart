import { AppError } from '../errors';

export type OrderStatus = 'RESERVED' | 'PAYMENT_PENDING' | 'PAID' | 'PAYMENT_FAILED' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  RESERVED: ['PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'],
  PAYMENT_PENDING: ['PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'],
  PAYMENT_FAILED: ['PAYMENT_PENDING', 'EXPIRED', 'CANCELLED'],
  PAID: ['REFUNDED'],
  EXPIRED: [], CANCELLED: [], REFUNDED: [],
};
export function canTransition(from: OrderStatus, to: OrderStatus): boolean { return TRANSITIONS[from].includes(to); }
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new AppError(409, 'INVALID_TRANSITION', `Cannot move an order from ${from} to ${to}`);
}
