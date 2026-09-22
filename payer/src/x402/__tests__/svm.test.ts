// The Solana rail. The derivation in it is the one place where being wrong is silent and
// expensive — a mis-derived associated token account is a valid-looking address nobody
// controls — so it is pinned against addresses read back from mainnet, not against this
// module's own arithmetic.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const PAYER = '8a8fFNfk2AGS7rgVv1BoqPUWnzQuoCrShJV8tSE6RAYi';
const PAY_TO = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FEE_PAYER = 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd';

// Read from mainnet with getAccountInfo: each exists and reports the owner and mint it
// was derived from.
const PAYER_USDC_ATA = '6VHyLFsFsY7b9wHFQhNXux1TDhZCZbrePafJGwwHnVmn';
const PAY_TO_USDC_ATA = '3XZXfFJHF5ox3yPop16oqYfSWxLpkjsEuvTe2S67G2rj';

const signed: Uint8Array[] = [];
const signer = {
  address: PAYER,
  async signTransaction(message: Uint8Array) {
    signed.push(message);
    return new Uint8Array(64).fill(9);
  },
};

const {
  associatedTokenAddress, encodeTransferChecked, compactU16,
  serializeWithSignature, buildSvmPayment, preflightSvm, svmRail,
} = await import('../rails/svm');
const { normalizeChallenge, normalizeRequirement, base64ToBytes } = await import('../protocol');
const { SOLANA_MAINNET } = await import('../networks');

const challenge = normalizeChallenge({ x402Version: 2, resource: { url: 'https://x/y' }, accepts: [] }, 'https://x/y');

function context(extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    requirement: normalizeRequirement({
      scheme: 'exact', network: SOLANA_MAINNET, amount: '1000',
      asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60,
      extra: { feePayer: FEE_PAYER, decimals: 6, ...extra },
      ...over,
    }),
    challenge,
    payer: PAYER,
    walletNetwork: 'mainnet' as const,
    signers: { svm: signer },
  };
}

/** A Solana node that answers the two calls the rail makes. */
function node(opts: { payerBalance?: string | null; payeeExists?: boolean } = {}) {
  const { payerBalance = '9000000', payeeExists = true } = opts;
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'getLatestBlockhash') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
        value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 },
      }}));
    }
    if (body.method === 'getAccountInfo') {
      const who = body.params[0];
      const exists = who === PAYER_USDC_ATA ? payerBalance !== null : payeeExists;
      const amount = who === PAYER_USDC_ATA ? payerBalance : '1';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
        value: exists ? { data: { parsed: { info: { tokenAmount: { amount }, owner: who } } } } : null,
      }}));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
  });
}

beforeEach(() => {
  signed.length = 0;
  globalThis.fetch = node() as unknown as typeof fetch;
});

describe('associated token accounts', () => {
  it('derives the address the chain actually holds', async () => {
    // Both were read back from mainnet and report exactly these owners and this mint.
    expect(await associatedTokenAddress(PAYER, USDC)).toBe(PAYER_USDC_ATA);
    expect(await associatedTokenAddress(PAY_TO, USDC)).toBe(PAY_TO_USDC_ATA);
  });

  it('gives a different account for a different owner', async () => {
    expect(await associatedTokenAddress(PAYER, USDC)).not.toBe(await associatedTokenAddress(PAY_TO, USDC));
  });

  it('gives a different account under the Token-2022 program', async () => {
    const { TOKEN_2022_PROGRAM } = await import('../rails/svm');
    expect(await associatedTokenAddress(PAYER, USDC, TOKEN_2022_PROGRAM)).not.toBe(PAYER_USDC_ATA);
  });
});

describe('instruction encoding', () => {
  it('encodes transferChecked as the SPL program reads it', () => {
    const data = encodeTransferChecked(1000n, 6);
    expect(data).toHaveLength(10);
    expect(data[0]).toBe(12);                        // the transferChecked discriminator
    expect(new DataView(data.buffer).getBigUint64(1, true)).toBe(1000n);  // little-endian
    expect(data[9]).toBe(6);                         // decimals
  });

  it('carries an amount larger than a double can represent', () => {
    const big = 9_007_199_254_740_993n;
    expect(new DataView(encodeTransferChecked(big, 6).buffer).getBigUint64(1, true)).toBe(big);
  });

  it('encodes compact-u16 the way Solana does', () => {
    expect([...compactU16(0)]).toEqual([0]);
    expect([...compactU16(1)]).toEqual([1]);
    expect([...compactU16(127)]).toEqual([127]);
    expect([...compactU16(128)]).toEqual([0x80, 1]);
    expect([...compactU16(300)]).toEqual([0xac, 2]);
  });
});

describe('the wire transaction', () => {
  it('leaves an empty slot for the signature we cannot make', () => {
    const message = new Uint8Array([1, 2, 3]);
    const wire = serializeWithSignature(
      { messageBytes: message, signatures: { [FEE_PAYER]: null, [PAYER]: null } },
      PAYER,
      new Uint8Array(64).fill(7),
    );
    expect(wire[0]).toBe(2);                                  // two signers
    expect([...wire.slice(1, 65)]).toEqual(Array(64).fill(0)); // the facilitator's, unfilled
    expect([...wire.slice(65, 129)]).toEqual(Array(64).fill(7)); // ours
    expect([...wire.slice(129)]).toEqual([1, 2, 3]);
  });
});

describe('building the payment', () => {
  it('signs a compiled message and returns it base64', async () => {
    const payload = await buildSvmPayment(context());
    expect(Object.keys(payload)).toEqual(['transaction']);
    expect(signed).toHaveLength(1);
    const wire = base64ToBytes(payload.transaction);
    expect(wire.length).toBeGreaterThan(64);
  });

  it('refuses a requirement with no sponsor rather than building something inert', async () => {
    // Without a feePayer the payer would have to hold SOL, and the scheme has no shape
    // for a self-paid transaction.
    await expect(buildSvmPayment(context({ feePayer: undefined }))).rejects.toThrow(/feePayer/);
    expect(signed).toHaveLength(0);
  });

  it('refuses a signature that is not ed25519-shaped', async () => {
    const short = { ...context(), signers: { svm: { address: PAYER, signTransaction: async () => new Uint8Array(32) } } };
    await expect(buildSvmPayment(short)).rejects.toThrow(/64/);
  });

  it('refuses when no Solana signer was supplied', async () => {
    await expect(buildSvmPayment({ ...context(), signers: {} })).rejects.toThrow(/no Solana signer/);
  });
});

describe('preflight', () => {
  it('passes when the payer holds enough and the payee can receive', async () => {
    const result = await preflightSvm(context());
    expect(result.ok).toBe(true);
    expect(result.balance).toBe(9_000_000n);
  });

  it('blocks when the balance is below the quote', async () => {
    globalThis.fetch = node({ payerBalance: '1' }) as unknown as typeof fetch;
    const result = await preflightSvm(context());
    expect(result.ok).toBe(false);
    expect(result.blockers[0].code).toBe('insufficient-funds');
  });

  it('says plainly when the recipient cannot receive the token', async () => {
    // Solana's analogue of the Algorand opt-in, and the payer cannot fix it.
    globalThis.fetch = node({ payeeExists: false }) as unknown as typeof fetch;
    const result = await preflightSvm(context());
    expect(result.ok).toBe(false);
    expect(result.blockers.some((b) => b.message.includes('must create one'))).toBe(true);
  });

  it('does not block a payment because a public RPC would not answer', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const result = await preflightSvm(context());
    expect(result.ok).toBe(true);
    expect(result.blockers[0].code).toBe('other');
  });

  it('never asks for SOL — the facilitator is the fee payer', async () => {
    const methods: string[] = [];
    globalThis.fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      methods.push(JSON.parse(String(init?.body)).method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: null } }));
    }) as unknown as typeof fetch;
    await preflightSvm(context());
    expect(methods.every((m) => m === 'getAccountInfo')).toBe(true);
    expect(methods).not.toContain('getBalance');
  });

  it('refuses to guess an account', async () => {
    expect((await preflightSvm({ ...context(), signers: {} })).blockers[0].code).toBe('no-account');
  });
});

describe('the rail', () => {
  it('serves the Solana namespace only', () => {
    expect(svmRail.family).toBe('svm');
    expect(svmRail.schemes).toEqual(['exact']);
    expect(svmRail.networks).toContain(SOLANA_MAINNET);
  });
});
