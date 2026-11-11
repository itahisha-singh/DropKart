import { describe, expect, it } from 'vitest';
import { applyBasisPointRate, currencyDecimals, multiplyMinor, splitMinor } from './safeMoney';

describe('safe-money integer arithmetic', () => {
  it('multiplies minor units without floating point', () => expect(multiplyMinor(49900, 3)).toBe(149700));
  it('rejects unsafe integer overflow', () => expect(() => multiplyMinor(Number.MAX_SAFE_INTEGER, 2)).toThrow());
  it('splits every paisa without loss', () => {
    for (let amount = 0; amount < 1000; amount++) {
      const parts = splitMinor(amount, 7);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    }
  });
  it('uses currency-specific decimal places', () => {
    expect(currencyDecimals('INR')).toBe(2);
    expect(currencyDecimals('JPY')).toBe(0);
    expect(() => currencyDecimals('ABC')).toThrow();
  });
  it('calculates percentage rates in basis points', () => expect(applyBasisPointRate(10000, 1850)).toBe(1850));
});
