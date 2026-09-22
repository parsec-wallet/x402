// The EVM rail signs an authorization rather than building a group. What these pin is
// that the authorization says what the server asked for — and that the rail refuses the
// transfer methods it has not implemented instead of signing something that will not work.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const PAYER = '0x857b06519E91e3A54538791bDbb0E22373e36b66';
const PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const signCalls: Array<{ address: string; domain: Record<string, unknown>; authorization: Record<string, unknown> }> = [];

const { buildAuthorization, chainIdOf, randomNonce, validityWindow, preflightEvm, evmRail } = await import('../rails/evm');
type EvmSigner = import('../host').EvmSigner;

/** Any wallet's EVM signer. The rail cannot tell this from Parsec's Rust-backed one. */
const signer: EvmSigner = {
  address: PAYER,
  async signTransferAuthorization(domain, authorization) {
    signCalls.push({ address: PAYER, domain: { ...domain }, authorization: { ...authorization } });
    return `0x${'ab'.repeat(65)}`;
  },
};
const { normalizeChallenge, normalizeRequirement } = await import('../protocol');
const { BASE_MAINNET } = await import('../networks');

const challenge = normalizeChallenge({ x402Version: 2, resource: { url: 'https://x/y' }, accepts: [] }, 'https://x/y');

function context(extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    requirement: normalizeRequirement({
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: USDC_BASE,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: 'USDC', version: '2', ...extra },
      ...over,
    }),
    challenge,
    payer: PAYER,
    walletNetwork: 'mainnet' as const,
    signers: { evm: signer },
  };
}

beforeEach(() => {
  signCalls.length = 0;
});

describe('chain ids and nonces', () => {
  it('reads the chain id out of the CAIP-2 reference', () => {
    expect(chainIdOf('eip155:8453')).toBe(8453);
    expect(chainIdOf('base')).toBe(8453);
  });

  it('refuses a network that is not eip155', () => {
    expect(() => chainIdOf('algorand:localnet')).toThrow();
  });

  it('makes a 32-byte nonce that does not repeat', () => {
    const a = randomNonce();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(randomNonce());
  });
});

describe('the validity window', () => {
  it('backdates the start so a fast clock cannot sign something no node will accept yet', () => {
    const { validAfter, validBefore } = validityWindow(60, 1_700_000_000_000);
    expect(Number(validAfter)).toBe(1_700_000_000 - 60);
    expect(Number(validBefore)).toBe(1_700_000_000 + 60);
  });

  it('uses the server’s own timeout as the end of the window', () => {
    expect(Number(validityWindow(300, 1_700_000_000_000).validBefore)).toBe(1_700_000_000 + 300);
  });

  it('falls back to a minute when the server named nothing usable', () => {
    expect(Number(validityWindow(0, 1_700_000_000_000).validBefore)).toBe(1_700_000_000 + 60);
  });
});

describe('building the authorization', () => {
  it('says exactly what the server asked for', async () => {
    const payload = await buildAuthorization(context());
    expect(payload.authorization.from).toBe(PAYER);
    expect(payload.authorization.to).toBe(PAY_TO);
    expect(payload.authorization.value).toBe('10000');
    expect(payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('signs against the token’s own domain, so the signature is valid nowhere else', async () => {
    await buildAuthorization(context());
    expect(signCalls[0].domain).toEqual({
      name: 'USDC',
      version: '2',
      chainId: 8453,
      verifyingContract: USDC_BASE,
    });
    expect(signCalls[0].address).toBe(PAYER);
  });

  it('defaults the domain to USDC when the server declared none', async () => {
    await buildAuthorization(context({ name: undefined, version: undefined }));
    expect(signCalls[0].domain).toMatchObject({ name: 'USDC', version: '2' });
  });

  it('honours a token that names its own domain', async () => {
    await buildAuthorization(context({ name: 'EURC', version: '1' }));
    expect(signCalls[0].domain).toMatchObject({ name: 'EURC', version: '1' });
  });

  it('gives every payment a fresh nonce', async () => {
    const a = await buildAuthorization(context());
    const b = await buildAuthorization(context());
    expect(a.authorization.nonce).not.toBe(b.authorization.nonce);
  });

  it('refuses Permit2 rather than signing something that will not settle', async () => {
    await expect(buildAuthorization(context({ assetTransferMethod: 'permit2' }))).rejects.toThrow(/permit2/i);
    expect(signCalls).toHaveLength(0);
  });

  it('refuses an asset that is not a contract address', async () => {
    await expect(buildAuthorization(context({}, { asset: '31566704' }))).rejects.toThrow(/token contract address/);
  });
});

describe('preflight', () => {
  it('passes when the balance covers the quote', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${(100000).toString(16)}` })),
    ) as unknown as typeof fetch;
    const result = await preflightEvm(context());
    expect(result.ok).toBe(true);
    expect(result.balance).toBe(100000n);
  });

  it('blocks when it does not', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })),
    ) as unknown as typeof fetch;
    const result = await preflightEvm(context());
    expect(result.ok).toBe(false);
    expect(result.blockers[0].code).toBe('insufficient-funds');
  });

  it('does not block a payment because a public RPC would not answer', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const result = await preflightEvm(context());
    expect(result.ok).toBe(true);
    expect(result.blockers[0].code).toBe('other');
  });

  it('never asks for gas — that is the facilitator’s to pay', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)).method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2710' }));
    }) as unknown as typeof fetch;
    await preflightEvm(context());
    expect(calls).toEqual(['eth_call']);
  });

  it('refuses to guess an account', async () => {
    expect((await preflightEvm({ ...context(), payer: '' })).blockers[0].code).toBe('no-account');
  });
});

describe('the rail itself', () => {
  it('registers for the whole eip155 namespace', () => {
    expect(evmRail.family).toBe('evm');
    expect(evmRail.schemes).toEqual(['exact']);
    expect(evmRail.networks).toBeUndefined(); // any eip155 chain, not a fixed list
  });

  it('produces the payload the scheme names', async () => {
    const payload = await evmRail.buildPayload(context());
    expect(Object.keys(payload).sort()).toEqual(['authorization', 'signature']);
    expect(BASE_MAINNET).toBe('eip155:8453');
  });
});
