// The Algorand `exact` scheme, pinned to the shape the facilitators verify against:
// fee payer first and unsigned, payment second and signed, `paymentIndex` pointing at
// the payment, and the whole group's fee charged to the sponsor.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import algosdk from 'algosdk';

const PAYER = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const FEE_PAYER = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA';
const PAY_TO = 'AIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBMXPWWNQ';

const suggestedParams = {
  fee: 0n,
  minFee: 1000n,
  firstValid: 1000n,
  lastValid: 2000n,
  genesisID: 'testnet-v1.0',
  genesisHash: new Uint8Array(Buffer.from('SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=', 'base64')),
  flatFee: false,
};

const signCalls: string[] = [];

vi.mock('../host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../host')>()),
  hostAlgod: async () => ({
    getTransactionParams: () => ({ do: async () => ({ ...suggestedParams }) }),
    accountInformation: () => ({ do: async () => ({ amount: 5_000_000n, assets: [{ assetId: 10458941n, amount: 2_000_000n }] }) }),
  }),
}));

const { buildPaymentGroup, signPaymentGroup, preflightAvm, avmRail } = await import('../rails/avm');
const { normalizeChallenge, normalizeRequirement, base64ToBytes } = await import('../protocol');

/**
 * A signer in the ecosystem's own shape — this is what any wallet passes in, and what
 * the test uses in place of Parsec's Rust one. Nothing about the rail knows the difference.
 */
const signer = {
  address: PAYER,
  async sign(txnGroup: algosdk.Transaction[], indexesToSign: number[]) {
    return indexesToSign.map((i) => {
      signCalls.push(txnGroup[i].sender.toString());
      return txnGroup[i].attachSignature(PAYER, new Uint8Array(64).fill(7));
    });
  },
};

const challenge = normalizeChallenge({ x402Version: 2, resource: { url: 'https://x/y' }, accepts: [] }, 'https://x/y');

function context(extra: Record<string, unknown>, asset = '10458941', amount = '250000') {
  return {
    requirement: normalizeRequirement({
      scheme: 'exact',
      network: 'algorand-testnet',
      amount,
      asset,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra,
    }),
    challenge,
    payer: PAYER,
    walletNetwork: 'testnet' as const,
    signers: { avm: signer },
  };
}

beforeEach(() => {
  signCalls.length = 0;
});

describe('building the group', () => {
  it('puts the sponsor first and the payment second', async () => {
    const { group, paymentIndex } = await buildPaymentGroup(context({ feePayer: FEE_PAYER }));
    expect(group).toHaveLength(2);
    expect(paymentIndex).toBe(1);
    expect(group[0].sender.toString()).toBe(FEE_PAYER);
    expect(group[0].payment?.receiver.toString()).toBe(FEE_PAYER);
    expect(group[0].payment?.amount).toBe(0n);
    expect(group[1].sender.toString()).toBe(PAYER);
  });

  it('charges the whole group’s fee to the sponsor and none to the payer', async () => {
    const { group } = await buildPaymentGroup(context({ feePayer: FEE_PAYER }));
    expect(group[0].fee).toBe(2000n); // two transactions × the 1,000 µALGO minimum
    expect(group[1].fee).toBe(0n);
  });

  it('transfers the quoted atomic amount of the quoted ASA to the quoted address', async () => {
    const { group, paymentIndex } = await buildPaymentGroup(context({ feePayer: FEE_PAYER }));
    const payment = group[paymentIndex];
    expect(payment.assetTransfer?.assetIndex).toBe(10458941n);
    expect(payment.assetTransfer?.amount).toBe(250000n);
    expect(payment.assetTransfer?.receiver.toString()).toBe(PAY_TO);
  });

  it('groups the transactions atomically', async () => {
    const { group } = await buildPaymentGroup(context({ feePayer: FEE_PAYER }));
    expect(group[0].group).toBeDefined();
    expect(Buffer.from(group[0].group!).toString('base64')).toBe(Buffer.from(group[1].group!).toString('base64'));
  });

  it('sends a native ALGO payment when the asset is 0', async () => {
    const { group, paymentIndex } = await buildPaymentGroup(context({ feePayer: FEE_PAYER }, '0', '5000'));
    expect(group[paymentIndex].payment?.amount).toBe(5000n);
    expect(group[paymentIndex].assetTransfer).toBeUndefined();
  });

  it('falls back to a lone self-funded payment when no sponsor is offered', async () => {
    const { group, paymentIndex } = await buildPaymentGroup(context({}));
    expect(group).toHaveLength(1);
    expect(paymentIndex).toBe(0);
    expect(group[0].sender.toString()).toBe(PAYER);
    expect(group[0].group).toBeUndefined();
  });
});

describe('signing the group', () => {
  it('signs only what the payer owns, and leaves the sponsor’s transaction unsigned', async () => {
    const { group } = await buildPaymentGroup(context({ feePayer: FEE_PAYER }));
    const encoded = await signPaymentGroup(group, signer);

    expect(signCalls).toEqual([PAYER]); // the sponsor's transaction was never offered

    // Index 0 decodes as a bare transaction: no signature was attached to it.
    const unsigned = algosdk.decodeUnsignedTransaction(base64ToBytes(encoded[0]));
    expect(unsigned.sender.toString()).toBe(FEE_PAYER);

    // Index 1 decodes as a signed transaction carrying the signature Rust returned.
    const signed = algosdk.decodeSignedTransaction(base64ToBytes(encoded[1]));
    expect(signed.sig).toBeDefined();
    expect(signed.txn.sender.toString()).toBe(PAYER);
  });

  it('produces the payload the scheme names', async () => {
    const payload = await avmRail.buildPayload(context({ feePayer: FEE_PAYER }));
    expect(payload.paymentIndex).toBe(1);
    expect(Array.isArray(payload.paymentGroup)).toBe(true);
    expect((payload.paymentGroup as string[])).toHaveLength(2);
  });
});

describe('preflight', () => {
  it('passes when the payer holds enough of the asset', async () => {
    const result = await preflightAvm(context({ feePayer: FEE_PAYER }));
    expect(result.ok).toBe(true);
    expect(result.balance).toBe(2_000_000n);
  });

  it('blocks when the balance is below the quote', async () => {
    const result = await preflightAvm(context({ feePayer: FEE_PAYER }, '10458941', '9000000'));
    expect(result.ok).toBe(false);
    expect(result.blockers[0].code).toBe('insufficient-funds');
  });

  it('blocks, with a remedy, when the payer has never opted in', async () => {
    const result = await preflightAvm(context({ feePayer: FEE_PAYER }, '31566704'));
    expect(result.ok).toBe(false);
    expect(result.blockers[0].code).toBe('not-opted-in');
    expect(result.blockers[0].remedy).toBeTruthy();
  });

  it('refuses to guess an account', async () => {
    const result = await preflightAvm({ ...context({}), payer: '' });
    expect(result.blockers[0].code).toBe('no-account');
  });
});
