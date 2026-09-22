import { describe, it, expect } from 'vitest';
import { applyDiscountExact } from '../discount';
import { USD_DECIMALS, parseDecimal } from '../../money';

const usd = (s: string): bigint => parseDecimal(s, USD_DECIMALS);

describe('applyDiscountExact — the BANKON holder discount', () => {
  it('halves the price for a holder', () => {
    expect(applyDiscountExact(usd('1.00'), true, 50)).toBe(usd('0.50'));
  });

  it('leaves a non-holder at list price', () => {
    expect(applyDiscountExact(usd('1.00'), false, 50)).toBe(usd('1.00'));
  });

  it('is exact where the old float form was not', () => {
    // The previous implementation was `+(price * (1 - pct/100)).toFixed(6)`.
    // 0.07 * 0.5 in IEEE-754 is 0.034999999999999996 — this is 0.035 exactly.
    expect(applyDiscountExact(usd('0.07'), true, 50)).toBe(usd('0.035'));
  });

  it('never rounds a discount upward into a higher charge', () => {
    // One micro-USD at 50% off floors to zero, never back up to one.
    expect(applyDiscountExact(1n, true, 50)).toBe(0n);
    expect(applyDiscountExact(3n, true, 50)).toBe(1n);
  });

  it('treats a zero or negative discount as no discount', () => {
    expect(applyDiscountExact(usd('2.00'), true, 0)).toBe(usd('2.00'));
    expect(applyDiscountExact(usd('2.00'), true, -10)).toBe(usd('2.00'));
  });

  it('never charges more than the list price', () => {
    for (const price of ['0.000001', '0.07', '1.00', '999.999999']) {
      const list = usd(price);
      expect(applyDiscountExact(list, true, 50) <= list).toBe(true);
    }
  });
});
