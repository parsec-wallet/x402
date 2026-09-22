// The codec is the compatibility surface: a v1 server and a v2 server must both be
// understood, and neither must be shown the other's vocabulary.

import { describe, it, expect } from 'vitest';
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HEADER_X_PAYMENT,
  HEADER_X_PAYMENT_RESPONSE,
  buildPayment,
  decodeEnvelope,
  encodeEnvelope,
  normalizeChallenge,
  normalizeRequirement,
  paymentHeaders,
  readChallenge,
  readSettlement,
} from '../protocol';
import { ALGORAND_MAINNET, ALGORAND_TESTNET } from '../networks';

const V2_CHALLENGE = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://api.example.com/weather', description: 'Weather', mimeType: 'application/json' },
  accepts: [
    {
      scheme: 'exact',
      network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
      amount: '1000',
      asset: '10458941',
      payTo: 'RESOURCESERVERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALTSRPAE',
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', decimals: 6, feePayer: 'FACILITATORADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALQCXBZE' },
    },
  ],
  extensions: { bazaar: { info: { input: { type: 'http', method: 'GET' } } } },
};

const V1_CHALLENGE = {
  x402Version: 1,
  error: 'X-PAYMENT header is required',
  accepts: [
    {
      scheme: 'exact',
      network: 'algorand-mainnet',
      maxAmountRequired: '250000',
      asset: '31566704',
      payTo: 'RESOURCESERVERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALTSRPAE',
      resource: 'https://api.example.com/v1/data',
      description: 'Legacy quote',
      mimeType: 'application/json',
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
};

function response(status: number, headers: Record<string, string>, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('x402 envelope', () => {
  it('round-trips through base64 without mangling non-ASCII', () => {
    const value = { note: 'résumé · 402 · 日本語' };
    expect(decodeEnvelope(encodeEnvelope(value))).toEqual(value);
  });
});

describe('normalizing a challenge', () => {
  it('reads a v2 challenge as given', () => {
    const c = normalizeChallenge(V2_CHALLENGE, 'https://api.example.com/weather');
    expect(c.x402Version).toBe(2);
    expect(c.resource.url).toBe('https://api.example.com/weather');
    expect(c.accepts[0].amount).toBe('1000');
    expect(c.accepts[0].network).toBe(ALGORAND_TESTNET);
    expect(c.extensions?.bazaar).toBeTruthy();
  });

  it('reads v1 maxAmountRequired as amount and lifts the per-entry resource', () => {
    const c = normalizeChallenge(V1_CHALLENGE, 'https://api.example.com/v1/data');
    expect(c.x402Version).toBe(1);
    expect(c.accepts[0].amount).toBe('250000');
    expect(c.accepts[0].network).toBe(ALGORAND_MAINNET);
    expect(c.resource.url).toBe('https://api.example.com/v1/data');
    expect(c.resource.description).toBe('Legacy quote');
  });

  it('accepts paymentRequirements as an alias for accepts', () => {
    const c = normalizeChallenge({ x402Version: 1, paymentRequirements: V1_CHALLENGE.accepts }, 'https://x/y');
    expect(c.accepts).toHaveLength(1);
  });

  it('never lets an amount pass through a float', () => {
    // 9007199254740993 is the first integer a double cannot represent.
    const r = normalizeRequirement({ scheme: 'exact', network: 'algorand-mainnet', amount: '9007199254740993' });
    expect(r.amount).toBe('9007199254740993');
    expect(BigInt(r.amount)).toBe(9007199254740993n);
  });

  it('defaults a missing amount to zero rather than NaN', () => {
    expect(normalizeRequirement({}).amount).toBe('0');
  });
});

describe('reading a 402', () => {
  it('prefers the v2 header over the body', async () => {
    const res = response(402, { [HEADER_PAYMENT_REQUIRED]: encodeEnvelope(V2_CHALLENGE) }, V1_CHALLENGE);
    const c = await readChallenge(res, 'https://api.example.com/weather');
    expect(c.x402Version).toBe(2);
    expect(c.accepts[0].amount).toBe('1000');
  });

  it('falls back to the body when the header is absent', async () => {
    const c = await readChallenge(response(402, {}, V1_CHALLENGE), 'https://api.example.com/v1/data');
    expect(c.x402Version).toBe(1);
  });

  it('falls back to the body when the header is malformed', async () => {
    const res = response(402, { [HEADER_PAYMENT_REQUIRED]: 'not base64 json' }, V1_CHALLENGE);
    const c = await readChallenge(res, 'https://api.example.com/v1/data');
    expect(c.accepts[0].amount).toBe('250000');
  });

  it('survives an empty body', async () => {
    const res = new Response('', { status: 402 });
    const c = await readChallenge(res, 'https://x/y');
    expect(c.accepts).toEqual([]);
    expect(c.resource.url).toBe('https://x/y');
  });
});

describe('writing a payment', () => {
  const challenge = normalizeChallenge(V2_CHALLENGE, 'https://api.example.com/weather');
  const v1 = normalizeChallenge(V1_CHALLENGE, 'https://api.example.com/v1/data');

  it('carries the chosen requirement verbatim as `accepted`', () => {
    const p = buildPayment(challenge, challenge.accepts[0], { paymentGroup: ['a'], paymentIndex: 0 });
    expect(p.accepted).toBe(challenge.accepts[0]);
    expect(p.scheme).toBe('exact');
    expect(p.network).toBe(ALGORAND_TESTNET);
    expect(p.x402Version).toBe(2);
  });

  it('sends only the v2 header to a v2 server', () => {
    const p = buildPayment(challenge, challenge.accepts[0], {});
    const headers = paymentHeaders(p);
    expect(headers[HEADER_PAYMENT_SIGNATURE]).toBeTruthy();
    expect(headers[HEADER_X_PAYMENT]).toBeUndefined();
  });

  it('adds the v1 alias for a v1 server', () => {
    const p = buildPayment(v1, v1.accepts[0], {});
    const headers = paymentHeaders(p);
    expect(headers[HEADER_X_PAYMENT]).toBe(headers[HEADER_PAYMENT_SIGNATURE]);
  });

  it('upgrades an unversioned server to v2 rather than guessing v0', () => {
    const c = normalizeChallenge({ accepts: V2_CHALLENGE.accepts }, 'https://x/y');
    expect(buildPayment(c, c.accepts[0], {}).x402Version).toBe(2);
  });
});

describe('reading a settlement', () => {
  it('extracts the transaction id from the v2 header', () => {
    const res = response(200, {
      [HEADER_PAYMENT_RESPONSE]: encodeEnvelope({
        success: true,
        transaction: 'NTRZR6HGMMZGYMJKUNVNLKLA427ACAVIPFNC6JHA5XNBQQHW7MWA',
        network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
        payer: 'PAYER',
      }),
    });
    const s = readSettlement(res)!;
    expect(s.success).toBe(true);
    expect(s.transaction).toBe('NTRZR6HGMMZGYMJKUNVNLKLA427ACAVIPFNC6JHA5XNBQQHW7MWA');
    expect(s.network).toBe(ALGORAND_MAINNET);
  });

  it('reads the v1 header too', () => {
    const res = response(200, {
      [HEADER_X_PAYMENT_RESPONSE]: encodeEnvelope({ success: true, transaction: 'TX1', network: 'algorand-mainnet' }),
    });
    expect(readSettlement(res)?.transaction).toBe('TX1');
  });

  it('keeps the transaction id of a failed settlement', () => {
    const res = response(402, {
      [HEADER_PAYMENT_RESPONSE]: encodeEnvelope({ success: false, errorReason: 'insufficient_funds', transaction: 'TXFAIL', network: 'algorand-mainnet' }),
    });
    const s = readSettlement(res)!;
    expect(s.success).toBe(false);
    expect(s.errorReason).toBe('insufficient_funds');
    expect(s.transaction).toBe('TXFAIL');
  });

  it('returns null when the server sent no readback', () => {
    expect(readSettlement(response(200, {}))).toBeNull();
  });
});
