// The ledger exists because the previous flow lost the settled transaction id. These pin
// that a settlement, once read, is kept and findable by the things that need proof.

import { describe, it, expect, beforeEach } from 'vitest';

// Device storage, stubbed: the module degrades without it, but the ledger is the point.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { clearReceipts, latestReceiptTo, listReceipts, receiptExplorerUrl, receiptsFor, recordReceipt, totals } =
  await import('../receipts');
const { ALGORAND_MAINNET } = await import('../networks');

function receipt(over: Partial<Parameters<typeof recordReceipt>[0]> = {}) {
  return {
    txId: 'TX1',
    network: ALGORAND_MAINNET,
    url: 'https://api.example.com/weather',
    payer: 'PAYER',
    payTo: 'TREASURY',
    amount: '250000',
    asset: '31566704',
    assetSymbol: 'USDC',
    decimals: 6,
    scheme: 'exact',
    settledAt: new Date().toISOString(),
    delivered: true,
    ...over,
  };
}

beforeEach(() => clearReceipts());

describe('the receipt ledger', () => {
  it('keeps a receipt newest first', () => {
    recordReceipt(receipt({ txId: 'TX1' }));
    recordReceipt(receipt({ txId: 'TX2' }));
    expect(listReceipts().map((r) => r.txId)).toEqual(['TX2', 'TX1']);
  });

  it('never stores the same settlement twice', () => {
    recordReceipt(receipt({ txId: 'TX1' }));
    recordReceipt(receipt({ txId: 'TX1', delivered: false }));
    expect(listReceipts()).toHaveLength(1);
    expect(listReceipts()[0].delivered).toBe(false);
  });

  it('keeps a payment that settled but was not delivered', () => {
    recordReceipt(receipt({ txId: 'TXFAIL', delivered: false, error: 'resource returned 500' }));
    expect(listReceipts()[0].error).toBe('resource returned 500');
  });

  it('finds the newest payment to an address — the proof a name claim asks for', () => {
    recordReceipt(receipt({ txId: 'OLD', payTo: 'TREASURY' }));
    recordReceipt(receipt({ txId: 'NEW', payTo: 'TREASURY' }));
    recordReceipt(receipt({ txId: 'OTHER', payTo: 'SOMEONE-ELSE' }));
    expect(latestReceiptTo('TREASURY')?.txId).toBe('NEW');
    expect(latestReceiptTo('TREASURY', 'algorand:nope')).toBeNull();
    expect(latestReceiptTo('NOBODY')).toBeNull();
  });

  it('finds every payment for a resource', () => {
    recordReceipt(receipt({ txId: 'A', url: 'https://a/' }));
    recordReceipt(receipt({ txId: 'B', url: 'https://b/' }));
    expect(receiptsFor('https://a/').map((r) => r.txId)).toEqual(['A']);
  });

  it('totals by asset without a float in sight', () => {
    recordReceipt(receipt({ txId: 'A', amount: '250000' }));
    recordReceipt(receipt({ txId: 'B', amount: '9007199254740993' }));
    const [entry] = totals();
    expect(entry.amount).toBe(9007199254990993n);
    expect(entry.count).toBe(2);
  });

  it('links a receipt to its explorer', () => {
    expect(receiptExplorerUrl(receipt({ txId: 'TXID' }))).toContain('TXID');
  });
});
