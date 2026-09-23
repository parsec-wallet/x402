import { describe, it, expect } from 'vitest';
import { normalizeChallenge, normalizeRequirement } from '../protocol';
import { canPay } from '../rails';
import '../rails/avm';
describe('hostile input', () => {
  const nasty: unknown[] = [
    null, undefined, 42, 'string', [], {},
    { accepts: 'not an array' },
    { accepts: [null, 42, 'x'] },
    { accepts: [{ amount: {} }] },
    { accepts: [{ amount: '-1' }] },
    { accepts: [{ amount: '1e400' }] },
    { accepts: [{ amount: '0x10' }] },
    { accepts: [{ maxTimeoutSeconds: 'soon' }] },
    { accepts: [{ extra: 'not an object' }] },
    { x402Version: 'two', accepts: [] },
    { resource: 12345, accepts: [] },
  ];
  it('never throws on a malformed challenge', () => {
    for (const n of nasty) expect(() => normalizeChallenge(n, 'https://x/y')).not.toThrow();
  });
  it('never yields an amount that is not a decimal integer string', () => {
    for (const n of nasty) {
      for (const r of normalizeChallenge(n, 'https://x/y').accepts) {
        expect(r.amount).toMatch(/^\d+$/);
      }
    }
  });
  it('refuses an amount that is not plainly a decimal integer', () => {
    // Unchecked, each of these reaches BigInt(): '0x10' is silently 16 rather than 10,
    // '-1' is a negative transfer, and '1e400' throws in the middle of a payment.
    for (const bad of ['-1', '1e400', '0x10', '1_000', '1.5', '', 'NaN', 'Infinity', '+5']) {
      expect(normalizeRequirement({ amount: bad }).amount).toBe('0');
    }
  });

  it('tolerates surrounding whitespace, which servers do pad with', () => {
    expect(normalizeRequirement({ amount: ' 12 ' }).amount).toBe('12');
  });

  it('canonicalises a legitimate amount without losing precision', () => {
    expect(normalizeRequirement({ amount: '0250000' }).amount).toBe('250000');
    expect(normalizeRequirement({ amount: '9007199254740993' }).amount).toBe('9007199254740993');
    expect(normalizeRequirement({ amount: 1000 }).amount).toBe('1000');
  });

  it('treats an unreadable quote as unpayable rather than signing a zero transfer', () => {
    const zero = normalizeRequirement({ scheme: 'exact', network: 'algorand-mainnet', amount: '0x10', asset: '0', payTo: 'P' });
    expect(zero.amount).toBe('0');
    expect(canPay(zero)).toBe(false);
  });
});
