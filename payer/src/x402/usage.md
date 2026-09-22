# x402 — usage

Task-oriented. For the symbol list see [`docs/x402-api.md`](../../../docs/x402-api.md);
for why it is built this way, [`technical.md`](./technical.md).

---

## Pay for one endpoint

```ts
import { createX402Client, algorandSigner } from './lib/x402';

const x402 = createX402Client({
  signers: { avm: algorandSigner(address, transactionSigner) },
  approve: async (p) => confirm(`Pay ${p.quote.amountDisplay} ${p.quote.assetSymbol}?`),
});

const res  = await x402.fetch('https://api.example.com/weather');
const data = await res.json();
```

A free resource passes straight through — `fetch` semantics are unchanged until a 402
arrives.

## Pay, and keep the proof

```ts
const result = await x402.request('https://api.example.com/weather');

result.txId          // the settled transaction id
result.receipt       // the ledger entry
result.success       // whether the resource then delivered
```

`request` returns where `fetch` throws. Use it when you need the transaction id — a
refund claim, an audit trail, a name registration.

## Find out what something costs, without a key

```ts
const x402 = createX402Client();            // no signers at all

await x402.quote('https://api.example.com/weather');
// { amountDisplay: '0.25', assetSymbol: 'USDC', usdDisplay: '$0.25', testnet: false }
// → null when the resource is free
```

Quoting signs nothing and reads no balance. An agent deciding whether a resource is worth
paying for should not need to hold a key to find out.

## Browse what is for sale

```ts
const cheap = await x402.discover({ maxAmount: 10_000n });   // ≤ 0.01 USDC
const found = await x402.search('weather');

for (const r of cheap) {
  console.log(r.method, r.resourceUrl, describePrice(r), r.settleCount);
}
```

Free. The catalogue is the facilitator's memory of what settled; **the price you pay is
read live from the resource's own 402 at payment time**, never from here.

## Integrate a wallet

| your wallet exposes | use |
|---|---|
| `algosdk.TransactionSigner` (use-wallet, AlgoKit, Pera, Defly) | `algorandSigner(address, signer)` |
| ARC-0001 `signTxns` (Lute, WalletConnect) | `arc0001Signer(address, provider)` |
| EIP-1193 `request` (MetaMask, Rabby, WalletConnect) | `eip1193Signer(address, provider)` |
| Parsec's vault | `signersForAccount(account)` |

```ts
// use-wallet
const { activeAddress, transactionSigner } = useWallet();
createX402Client({ signers: { avm: algorandSigner(activeAddress, transactionSigner) } });

// AlgoKit
createX402Client({ signers: { avm: algorandSigner(addr, algorand.account.getSigner(addr)) } });

// a local account, for a script or an agent
import algosdk from 'algosdk';
const acct = algosdk.mnemonicToSecretKey(process.env.MNEMONIC!);
createX402Client({
  signers: { avm: algorandSigner(acct.addr.toString(), algosdk.makeBasicAccountTransactionSigner(acct)) },
});
```

## Run it outside a browser

```ts
import { createX402Client, memoryStorage, algorandSigner } from './lib/x402';

const x402 = createX402Client({
  signers: { avm: algorandSigner(addr, signer) },
  approve: async (p) => p.quote.usdMicro !== null && p.quote.usdMicro <= 50_000n,  // ≤ $0.05
  host: {
    storage: memoryStorage(),               // no localStorage in Node
    algod: () => myAlgodClient,             // your own node
  },
});
```

For an unattended agent, `approve` **is** the policy. Returning `true` unconditionally
means paying whatever any server asks — including a server reached through a redirect.
Bound it by price, by network, by payee, or by all three:

```ts
approve: async (p) =>
  !p.mainnet ||
  (p.quote.usdMicro !== null &&
   p.quote.usdMicro <= 50_000n &&
   TRUSTED_PAYEES.has(p.requirement.payTo)),
```

Alternatively set a standing cap and omit `approve` entirely:

```ts
createX402Client({ signers, settings: { autoApproveMicroUsd: 50_000 } });   // ≤ $0.05
```

Without either, every payment is refused. That is deliberate.

## Build your own confirmation screen

```ts
const challenge = await x402.probe(url);
if (!challenge) return;                     // free

const pending = await x402.prepare(url, challenge);
// pending.quote.amountDisplay   '0.25'
// pending.quote.assetSymbol     'USDC'
// pending.alternatives          every offer, priced — what you are passing over
// pending.preflight?.blockers   what would stop this, each with an optional remedy
// pending.mainnet               whether this moves real value
// pending.bazaar?.input         what the endpoint takes, if it published it

const result = await x402.pay(pending);     // signs and sends
```

Nothing is signed until `pay`. This is how `views/x402-confirm.ts` works.

## Clear a blocker

```ts
for (const b of pending.preflight?.blockers ?? []) {
  console.warn(b.message);
  if (b.remedy) await b.remedy.run();       // e.g. the USDC opt-in
}
```

The common one on Algorand is `not-opted-in`: the protocol rejects a transfer of an asset
the account has never opted in to, which is not a funds problem and does not look like
one. The remedy runs the opt-in — it locks 0.1 ALGO into the account's minimum balance for
as long as the holding exists, so say so before running it.

## Pay for a BANKON name

```ts
import { quoteNameClaim, proveNameClaimPayment } from './lib/bankon-names/pay';

const quote = await quoteNameClaim('Buy-Name', name, { paymentMethod: 'algorand' }, network);
// quote.treasury   read live from the registry
// quote.amount     microALGO
// quote.existing   a settlement already on file that covers it, or null

const proof = await proveNameClaimPayment(signer, quote, name, network);
await adapter.claim({ …, paymentMethod: 'algorand', paymentProof: proof.txId, paymentAmount: proof.amount });
```

`proveNameClaimPayment` reuses an existing settlement rather than paying twice. If the
term changes after paying, re-quote and check `proofStillCovers(proof, quote)` — a payment
for a one-year lease is not payment for a five-year one.

## Switch accounts

```ts
x402.useSigners(signersForAccount(newAccount));
```

No need to rebuild the client.

---

## Settings

| | default | |
|---|---|---|
| `preferNetwork` | Algorand Testnet | which offer to take when several are payable |
| `facilitatorUrl` | GoPlausible | asked what it can settle, and for the catalogue |
| `autoApproveMicroUsd` | `0` | pay without asking at or below this. Zero means always ask |
| `preflight` | on | read balance and opt-in state before confirming |

A payment settles through whichever facilitator the **resource's own** requirement names
as fee payer. The setting above governs capability queries and discovery only.

## When something goes wrong

The error table and troubleshooting notes are in
[`docs/x402-api.md`](../../../docs/x402-api.md#errors). The three that surprise people:

- **A settled payment whose resource then failed** is two facts, not one. The receipt is
  written with `delivered: false`; the money moved.
- **An EVM payment from an account with no ETH** is correct. The facilitator pays gas.
- **A catalogue price differing from the live quote** is working as intended.
