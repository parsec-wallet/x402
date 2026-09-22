// The whole loop, with the network stubbed: probe → 402 → choose → sign → resend →
// settlement → receipt. What it is really pinning is that the transaction id survives
// the round trip, which is the defect this module was rewritten to fix.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};

const { encodeEnvelope, decodeEnvelope, HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_RESPONSE, HEADER_PAYMENT_SIGNATURE } =
  await import('../protocol');
const { registerRail } = await import('../rails');
const { X402Declined, X402Unpayable, x402Request, HEADER_PAYER_HINT } = await import('../client');
const { clearReceipts, listReceipts } = await import('../receipts');
const { setX402Settings } = await import('../settings');
const { ALGORAND_TESTNET } = await import('../networks');

const PAYER = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const TX = 'NTRZR6HGMMZGYMJKUNVNLKLA427ACAVIPFNC6JHA5XNBQQHW7MWA';

registerRail({
  family: 'avm',
  label: 'Stub Algorand',
  schemes: ['exact'],
  async buildPayload() {
    return { paymentGroup: ['unsigned', 'signed'], paymentIndex: 1 };
  },
  async preflight() {
    return { ok: true, blockers: [], balance: 1_000_000n };
  },
});

const challenge = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://api.example.com/weather', description: 'Weather' },
  accepts: [
    {
      scheme: 'exact',
      network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
      amount: '1000',
      asset: '10458941',
      payTo: 'TREASURY',
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', decimals: 6, feePayer: 'FACILITATOR' },
    },
  ],
};

let requests: Array<{ url: string; headers: Record<string, string> }> = [];

/** A resource server that answers 402 once, then delivers on a payment header. */
function server(options: { settle?: boolean; deliver?: boolean; free?: boolean } = {}) {
  const { settle = true, deliver = true, free = false } = options;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url, headers });
    if (free) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (!headers[HEADER_PAYMENT_SIGNATURE]) {
      return new Response('{}', { status: 402, headers: { [HEADER_PAYMENT_REQUIRED]: encodeEnvelope(challenge) } });
    }
    const settlement: Record<string, string> = settle
      ? { [HEADER_PAYMENT_RESPONSE]: encodeEnvelope({ success: true, transaction: TX, network: ALGORAND_TESTNET, payer: PAYER }) }
      : {};
    return new Response(JSON.stringify({ weather: 'foggy' }), {
      status: deliver ? 200 : 500,
      headers: settlement,
    });
  });
}

beforeEach(() => {
  requests = [];
  clearReceipts();
  setX402Settings({ preferNetwork: ALGORAND_TESTNET, autoApproveMicroUsd: 0, preflight: true });
});

describe('a free resource', () => {
  it('passes through untouched', async () => {
    globalThis.fetch = server({ free: true }) as unknown as typeof fetch;
    const result = await x402Request('https://api.example.com/free', undefined, { payer: PAYER });
    expect(result.success).toBe(true);
    expect(requests).toHaveLength(1);
  });
});

describe('a paid resource', () => {
  it('pays, delivers, and keeps the transaction id', async () => {
    globalThis.fetch = server() as unknown as typeof fetch;
    const approve = vi.fn(async () => true);

    const result = await x402Request('https://api.example.com/weather', undefined, { payer: PAYER, approve });

    expect(approve).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.txId).toBe(TX);
    expect(result.receipt?.payTo).toBe('TREASURY');
    expect(result.receipt?.amount).toBe('1000');
    expect(listReceipts()).toHaveLength(1);
  });

  it('shows the participant the quote before it signs anything', async () => {
    globalThis.fetch = server() as unknown as typeof fetch;
    let seen: { amountDisplay: string; assetSymbol: string; usdDisplay: string } | null = null;
    await x402Request('https://api.example.com/weather', undefined, {
      payer: PAYER,
      approve: async (pending) => {
        seen = { amountDisplay: pending.quote.amountDisplay, assetSymbol: pending.quote.assetSymbol, usdDisplay: pending.quote.usdDisplay };
        expect(pending.preflight?.ok).toBe(true);
        expect(pending.mainnet).toBe(false);
        return true;
      },
    });
    expect(seen).toEqual({ amountDisplay: '0.001', assetSymbol: 'USDC', usdDisplay: '$0.001' });
  });

  it('sends the payment as the v2 header, with the chosen offer verbatim', async () => {
    globalThis.fetch = server() as unknown as typeof fetch;
    await x402Request('https://api.example.com/weather', undefined, { payer: PAYER, approve: async () => true });

    const paid = requests.find((r) => r.headers[HEADER_PAYMENT_SIGNATURE])!;
    const payment = decodeEnvelope<{ x402Version: number; accepted: { amount: string; payTo: string }; payload: { paymentIndex: number } }>(
      paid.headers[HEADER_PAYMENT_SIGNATURE],
    );
    expect(payment.x402Version).toBe(2);
    expect(payment.accepted.amount).toBe('1000');
    expect(payment.accepted.payTo).toBe('TREASURY');
    expect(payment.payload.paymentIndex).toBe(1);
  });

  it('hints who is paying on the probe so a server can quote per payer', async () => {
    globalThis.fetch = server() as unknown as typeof fetch;
    await x402Request('https://api.example.com/weather', undefined, { payer: PAYER, approve: async () => true });
    expect(requests[0].headers[HEADER_PAYER_HINT]).toBe(PAYER);
  });

  it('can be told not to hint', async () => {
    globalThis.fetch = server() as unknown as typeof fetch;
    await x402Request('https://api.example.com/weather', undefined, { payer: PAYER, approve: async () => true, sendPayerHint: false });
    expect(requests[0].headers[HEADER_PAYER_HINT]).toBeUndefined();
  });

  it('declines without paying', async () => {
    globalThis.fetch = server() as unknown as typeof fetch;
    await expect(
      x402Request('https://api.example.com/weather', undefined, { payer: PAYER, approve: async () => false }),
    ).rejects.toBeInstanceOf(X402Declined);
    expect(requests).toHaveLength(1);
    expect(listReceipts()).toHaveLength(0);
  });

  it('pays without asking only under an explicit cap', async () => {
    globalThis.fetch = server() as unknown as typeof fetch;
    setX402Settings({ autoApproveMicroUsd: 1000 });
    const approve = vi.fn(async () => true);
    const result = await x402Request('https://api.example.com/weather', undefined, { payer: PAYER, approve });
    expect(approve).not.toHaveBeenCalled();
    expect(result.txId).toBe(TX);
  });

  it('still asks when the price is over the cap', async () => {
    globalThis.fetch = server() as unknown as typeof fetch;
    setX402Settings({ autoApproveMicroUsd: 999 });
    const approve = vi.fn(async () => true);
    await x402Request('https://api.example.com/weather', undefined, { payer: PAYER, approve });
    expect(approve).toHaveBeenCalledOnce();
  });
});

describe('when things go wrong', () => {
  it('records the receipt even though the resource failed to deliver', async () => {
    globalThis.fetch = server({ deliver: false }) as unknown as typeof fetch;
    const result = await x402Request('https://api.example.com/weather', undefined, { payer: PAYER, approve: async () => true });
    expect(result.success).toBe(false);
    expect(result.txId).toBe(TX);
    expect(listReceipts()[0].delivered).toBe(false);
    expect(listReceipts()[0].error).toContain('500');
  });

  it('reports a settlement the server never read back, rather than inventing one', async () => {
    globalThis.fetch = server({ settle: false }) as unknown as typeof fetch;
    const result = await x402Request('https://api.example.com/weather', undefined, { payer: PAYER, approve: async () => true });
    expect(result.success).toBe(true);
    expect(result.txId).toBeUndefined();
    expect(listReceipts()).toHaveLength(0);
  });

  it('names the networks it cannot pay', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{}', {
        status: 402,
        headers: {
          [HEADER_PAYMENT_REQUIRED]: encodeEnvelope({
            x402Version: 2,
            accepts: [{ scheme: 'exact', network: 'cosmos:cosmoshub-4', amount: '1', asset: 'uatom', payTo: 'x' }],
          }),
        },
      }),
    ) as unknown as typeof fetch;

    await expect(
      x402Request('https://api.example.com/weather', undefined, { payer: PAYER, approve: async () => true }),
    ).rejects.toBeInstanceOf(X402Unpayable);
  });
});


// ── Which address pays ───────────────────────────────────────────────────────
// A multi-chain wallet has a different address on every chain. Which one pays is
// decided by the offer the server made, not by whichever address the caller had first.

const { resolvePayer } = await import('../client');
const { BASE_MAINNET, ALGORAND_MAINNET } = await import('../networks');
describe('resolving the payer', () => {
  const payers = { avm: PAYER, evm: '0x857b06519E91e3A54538791bDbb0E22373e36b66' };

  it('picks the address for the requirement’s own rail', () => {
    expect(resolvePayer(ALGORAND_MAINNET, { payers })).toBe(PAYER);
    expect(resolvePayer(BASE_MAINNET, { payers })).toBe(payers.evm);
  });

  it('falls back to a single address when that is all the caller gave', () => {
    expect(resolvePayer(ALGORAND_MAINNET, { payer: PAYER })).toBe(PAYER);
  });

  it('refuses rather than paying an EVM requirement from an Algorand address', () => {
    // Signing an EIP-3009 authorization whose `from` is a base32 address produces a
    // signature that recovers to nobody, and the failure would surface at the
    // facilitator as something unrelated to the real cause.
    expect(() => resolvePayer(BASE_MAINNET, { payers: { avm: PAYER } })).toThrow(/No EVM address/);
  });

});
