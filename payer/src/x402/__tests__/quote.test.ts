// A quote is display arithmetic over an exact amount. The exact amount must survive it.

import { describe, it, expect } from 'vitest';
import { quote, decimalsFor, symbolFor } from '../quote';
import { normalizeRequirement } from '../protocol';
import { ALGORAND_MAINNET, ALGORAND_TESTNET } from '../networks';

function req(over: Record<string, unknown>) {
  return normalizeRequirement({ scheme: 'exact', network: ALGORAND_MAINNET, amount: '250000', asset: '31566704', payTo: 'P', ...over });
}

describe('reading the asset', () => {
  it('trusts the server’s declared decimals over our table', () => {
    expect(decimalsFor(req({ extra: { decimals: 2 } }))).toBe(2);
  });

  it('falls back to the table when the server declares nothing', () => {
    expect(decimalsFor(req({}))).toBe(6);
    expect(symbolFor(req({}))).toBe('USDC');
  });

  it('trusts the server’s declared name', () => {
    expect(symbolFor(req({ extra: { name: 'gUSD' } }))).toBe('gUSD');
  });
});

describe('quoting', () => {
  it('formats atomic units into whole units without touching the atomic value', async () => {
    const q = await quote(req({ amount: '250000' }));
    expect(q.amountAtomic).toBe(250000n);
    expect(q.amountDisplay).toBe('0.25');
    expect(q.assetSymbol).toBe('USDC');
  });

  it('treats a USD-pegged asset as exact, with no oracle', async () => {
    const q = await quote(req({ amount: '1000' }));
    expect(q.usdSource).toBe('pegged');
    expect(q.usdMicro).toBe(1000n);
    expect(q.usdDisplay).toBe('$0.001');
  });

  it('carries an amount larger than a double can represent', async () => {
    const q = await quote(req({ amount: '9007199254740993' }));
    expect(q.amountAtomic).toBe(9007199254740993n);
  });

  it('marks a testnet quote as a testnet quote', async () => {
    const q = await quote(req({ network: ALGORAND_TESTNET, asset: '10458941' }));
    expect(q.testnet).toBe(true);
    expect(q.networkLabel).toBe('Algorand Testnet');
  });

  it('leaves USD empty for an asset with no peg and no rate', async () => {
    const q = await quote(req({ asset: '999999', extra: { name: 'MYSTERY' } }));
    expect(q.usdMicro).toBeNull();
    expect(q.usdDisplay).toBe('');
    expect(q.amountDisplay).toBe('0.25');
  });
});
