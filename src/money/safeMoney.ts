/** Integer-minor-unit money helpers. Never use binary floating point for monetary arithmetic. */
export type Currency = 'INR' | 'USD' | 'EUR' | 'GBP' | 'JPY';
const DECIMALS: Record<Currency, number> = { INR: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0 };

function assertAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Amount must be a non-negative safe integer');
}
export function currencyDecimals(currency: string): number {
  if (!Object.prototype.hasOwnProperty.call(DECIMALS, currency)) throw new RangeError(`Unsupported currency: ${currency}`);
  return DECIMALS[currency as Currency];
}
export function multiplyMinor(unitPriceMinor: number, quantity: number): number {
  assertAmount(unitPriceMinor);
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError('Quantity must be a non-negative safe integer');
  const total = unitPriceMinor * quantity;
  if (!Number.isSafeInteger(total)) throw new RangeError('Monetary result exceeds safe integer range');
  return total;
}
/** Splits an amount evenly; remainder minor units are assigned to earlier recipients. */
export function splitMinor(amountMinor: number, recipients: number): number[] {
  assertAmount(amountMinor);
  if (!Number.isSafeInteger(recipients) || recipients < 1) throw new RangeError('Recipients must be a positive integer');
  const base = Math.floor(amountMinor / recipients);
  const remainder = amountMinor % recipients;
  return Array.from({ length: recipients }, (_, i) => base + (i < remainder ? 1 : 0));
}
export function applyBasisPointRate(amountMinor: number, basisPoints: number): number {
  assertAmount(amountMinor);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 100_000) throw new RangeError('Invalid basis-point rate');
  // Round half up using integer arithmetic.
  const numerator = BigInt(amountMinor) * BigInt(basisPoints) + 5_000n;
  const result = numerator / 10_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Monetary result exceeds safe integer range');
  return Number(result);
}
