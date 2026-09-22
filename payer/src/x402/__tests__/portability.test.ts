// The claim this module makes is that another wallet can use it. These are the tests that
// hold it to that: everything here runs with no Parsec, no Tauri, no `localStorage`, and
// no vault — a bare `algosdk` account and an in-memory store, which is also what an
// autonomous agent has.
//
// If any of these start needing a Parsec import, the claim has quietly stopped being true.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import algosdk from 'algosdk';

const account = algosdk.generateAccount();
const PAY_TO = algosdk.encodeAddress(new Uint8Array(32).fill(3));
const FEE_PAYER = algosdk.encodeAddress(new Uint8Array(32).fill(4));
const TX = 'NTRZR6HGMMZGYMJKUNVNLKLA427ACAVIPFNC6JHA5XNBQQHW7MWA';

const suggestedParams = {
  fee: 0n,
  minFee: 1000n,
  firstValid: 1000n,
  lastValid: 2000n,
  genesisID: 'testnet-v1.0',
  genesisHash: new Uint8Array(Buffer.from('SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=', 'base64')),
  flatFee: false,
};

vi.mock('../host', async (importOriginal) => {
  const real = await importOriginal<typeof import('../host')>();
  return {
    ...real,
    hostAlgod: async () => ({
      getTransactionParams: () => ({ do: async () => ({ ...suggestedParams }) }),
      accountInformation: () => ({
        do: async () => ({ amount: 5_000_000n, assets: [{ assetId: 10458941n, amount: 9_000_000n }] }),
      }),
    }),
  };
});

const { memoryStorage, configureX402Host, resetX402Host, hostStorage } = await import('../host');
const { algorandSigner, arc0001Signer, eip1193Signer } = await import('../adapters/wallets');
const { createX402Client } = await import('../pay');
const { encodeEnvelope, decodeEnvelope, HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_RESPONSE, HEADER_PAYMENT_SIGNATURE, base64ToBytes } =
  await import('../protocol');
const { ALGORAND_TESTNET } = await import('../networks');
await import('../rails/avm');

const challenge = {
  x402Version: 2,
  resource: { url: 'https://api.example.com/weather', description: 'Weather' },
  accepts: [{
    scheme: 'exact',
    network: ALGORAND_TESTNET,
    amount: '250000',
    asset: '10458941',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: 'USDC', decimals: 6, feePayer: FEE_PAYER },
  }],
};

let requests: Array<Record<string, string>> = [];

function server() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push(headers);
    if (!headers[HEADER_PAYMENT_SIGNATURE]) {
      return new Response('{}', { status: 402, headers: { [HEADER_PAYMENT_REQUIRED]: encodeEnvelope(challenge) } });
    }
    return new Response(JSON.stringify({ weather: 'foggy' }), {
      status: 200,
      headers: {
        [HEADER_PAYMENT_RESPONSE]: encodeEnvelope({
          success: true, transaction: TX, network: ALGORAND_TESTNET, payer: account.addr.toString(),
        }),
      },
    });
  });
}

beforeEach(() => {
  requests = [];
  resetX402Host();
  configureX402Host({ storage: memoryStorage() });
  globalThis.fetch = server() as unknown as typeof fetch;
});

describe('a wallet that is not Parsec', () => {
  it('pays with nothing but an algosdk account and four lines', async () => {
    // Exactly what a use-wallet / AlgoKit / Pera integration already has to hand.
    const signer = algorandSigner(
      account.addr.toString(),
      algosdk.makeBasicAccountTransactionSigner(account),
    );
    const x402 = createX402Client({ signers: { avm: signer }, approve: async () => true });

    const result = await x402.request('https://api.example.com/weather');

    expect(result.success).toBe(true);
    expect(result.txId).toBe(TX);
    expect(result.receipt?.payTo).toBe(PAY_TO);
  });

  it('signs only its own leg of the sponsored group', async () => {
    const x402 = createX402Client({
      signers: { avm: algorandSigner(account.addr.toString(), algosdk.makeBasicAccountTransactionSigner(account)) },
      approve: async () => true,
    });
    await x402.request('https://api.example.com/weather');

    const sent = requests.find((h) => h[HEADER_PAYMENT_SIGNATURE])!;
    const payment = decodeEnvelope<{ payload: { paymentGroup: string[]; paymentIndex: number } }>(sent[HEADER_PAYMENT_SIGNATURE]);
    const { paymentGroup, paymentIndex } = payment.payload;

    expect(paymentIndex).toBe(1);
    // The sponsor's transaction is a bare unsigned txn; ours carries a signature.
    expect(algosdk.decodeUnsignedTransaction(base64ToBytes(paymentGroup[0])).sender.toString()).toBe(FEE_PAYER);
    const mine = algosdk.decodeSignedTransaction(base64ToBytes(paymentGroup[1]));
    expect(mine.sig).toBeDefined();
    expect(mine.txn.sender.toString()).toBe(account.addr.toString());
  });

  it('works through a raw ARC-0001 provider', async () => {
    // Lute, a WalletConnect session, an injected provider — base64 in, base64 out.
    const seen: Array<{ txn: string; signers?: string[] }> = [];
    const provider = {
      async signTxns(txns: Array<{ txn: string; signers?: string[] }>) {
        seen.push(...txns);
        return txns.map((t) => {
          if (t.signers?.length === 0) return null; // asked not to sign this one
          const decoded = algosdk.decodeUnsignedTransaction(base64ToBytes(t.txn));
          return Buffer.from(decoded.signTxn(account.sk)).toString('base64');
        });
      },
    };
    const x402 = createX402Client({
      signers: { avm: arc0001Signer(account.addr.toString(), provider) },
      approve: async () => true,
    });

    const result = await x402.request('https://api.example.com/weather');
    expect(result.txId).toBe(TX);
    // The facilitator's transaction went out marked "do not sign", per ARC-0001.
    expect(seen[0].signers).toEqual([]);
    expect(seen[1].signers).toBeUndefined();
  });

  it('keeps its receipts wherever the host says, not in localStorage', async () => {
    const store = memoryStorage();
    const x402 = createX402Client({
      signers: { avm: algorandSigner(account.addr.toString(), algosdk.makeBasicAccountTransactionSigner(account)) },
      approve: async () => true,
      host: { storage: store },
    });
    await x402.request('https://api.example.com/weather');

    expect(x402.receipts()).toHaveLength(1);
    expect(store.getItem('parsec-x402-receipts')).toContain(TX);
    expect(hostStorage()).toBe(store);
  });

  it('declines without signing when the approver says no', async () => {
    const sign = vi.fn(algosdk.makeBasicAccountTransactionSigner(account));
    const x402 = createX402Client({
      signers: { avm: algorandSigner(account.addr.toString(), sign) },
      approve: async () => false,
    });
    await expect(x402.request('https://api.example.com/weather')).rejects.toThrow(/declined/i);
    expect(sign).not.toHaveBeenCalled();
  });

  it('refuses a payment it has no signer for, rather than half-building one', async () => {
    const x402 = createX402Client({ signers: {}, approve: async () => true });
    await expect(x402.request('https://api.example.com/weather')).rejects.toThrow(/No AVM address/);
  });

  it('can swap accounts without being rebuilt', async () => {
    const other = algosdk.generateAccount();
    const x402 = createX402Client({ signers: {}, approve: async () => true });
    x402.useSigners({ avm: algorandSigner(other.addr.toString(), algosdk.makeBasicAccountTransactionSigner(other)) });

    const result = await x402.request('https://api.example.com/weather');
    expect(result.success).toBe(true);
  });
});

describe('reading without paying', () => {
  it('quotes a resource with no signer at all', async () => {
    const x402 = createX402Client();
    const q = await x402.quote('https://api.example.com/weather');
    expect(q?.amountDisplay).toBe('0.25');
    expect(q?.assetSymbol).toBe('USDC');
    expect(requests.some((h) => h[HEADER_PAYMENT_SIGNATURE])).toBe(false);
  });

  it('says so when a resource is free', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const x402 = createX402Client();
    expect(await x402.probe('https://api.example.com/free')).toBeNull();
    expect(await x402.quote('https://api.example.com/free')).toBeNull();
  });
});

describe('the EVM adapter', () => {
  it('asks an EIP-1193 wallet for typed data it cannot mistake for anything else', async () => {
    const calls: Array<{ method: string; params?: unknown[] }> = [];
    const provider = {
      async request(args: { method: string; params?: unknown[] }) {
        calls.push(args);
        return `0x${'ab'.repeat(65)}`;
      },
    };
    const signer = eip1193Signer('0xabc', provider);
    const sig = await signer.signTransferAuthorization(
      { name: 'USDC', version: '2', chainId: 8453, verifyingContract: '0xdef' },
      { from: '0xabc', to: '0x123', value: '10000', validAfter: '1', validBefore: '2', nonce: '0x00' },
    );

    expect(sig).toMatch(/^0x/);
    expect(calls[0].method).toBe('eth_signTypedData_v4');
    const typed = JSON.parse(String(calls[0].params?.[1]));
    expect(typed.primaryType).toBe('TransferWithAuthorization');
    expect(typed.domain.verifyingContract).toBe('0xdef');
    expect(typed.message.value).toBe('10000');
  });
});


// ── The guard ────────────────────────────────────────────────────────────────
// Portability is a property of the imports, and properties stated only in prose decay.
// This reads the module's own source and fails the moment the core reaches back into
// the application again.

describe('the core imports nothing from the application', () => {
  // In this repository there is no integration layer: the host's implementations live
  // in the host. The allowlist is empty on purpose, and that is the strongest form of
  // the claim — nothing here is coupled to anything.
  const ALLOWED_FILES = new Set<string>([]);

  // The one shared dependency the core keeps: exact fixed-point arithmetic. It is pure,
  // has no dependencies of its own, and is what stops a float reaching a signed amount.
  // An extraction of this module would take it along; it is a primitive, not the host.
  const ALLOWED_IMPORTS = new Set(['../money']);

  it('has no Parsec import outside the adapter and the integration layer', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { dirname, join, relative, resolve } = await import('node:path');

    const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry: string) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : walk(full);
        return entry.endsWith('.ts') ? [full] : [];
      });

    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = relative(root, file);
      if (ALLOWED_FILES.has(rel)) continue;
      const source = readFileSync(file, 'utf8');
      for (const [, spec] of source.matchAll(/from '(\.[^']+)'/g)) {
        // Resolve the specifier the way the bundler does. Anything landing outside the
        // module's own directory is a reach into the application.
        if (ALLOWED_IMPORTS.has(spec)) continue;
        const target = resolve(dirname(file), spec);
        if (relative(root, target).startsWith('..')) offenders.push(`${rel} → ${spec}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
