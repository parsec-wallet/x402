# Technical design

Both halves of the rail, and why each is shaped the way it is. The idea is in
[`explanation.md`](explanation.md); the payer module's own internals are in
[`payer/src/x402/technical.md`](payer/src/x402/technical.md).

## The goal

> **A participant — human or agent — can pay for an HTTP resource from any wallet, and
> keep proof they did. A seller can price a route and be paid by strangers.**

Everything below is downstream of that sentence.

## Layout

```
payer/                         TypeScript — the wallet side
  src/x402/
    pay.ts                     createX402Client() — the whole module as one object
    host.ts                    the four ports: signing, storage, nodes, price
    client.ts                  probe → choose → quote → approve → sign → submit → record
    protocol.ts                the wire, v1 and v2
    networks.ts                CAIP-2 identity, assets, explorers
    rails.ts, rails/{avm,evm,svm}  one rail per CAIP-2 namespace
    quote.ts, receipts.ts      exact pricing, the settlement ledger
    facilitator.ts, bazaar.ts  capability queries and discovery
    adapters/wallets.ts        TransactionSigner, ARC-0001, EIP-1193
  rust/eip712.rs               the EIP-3009 signer

seller/                        Python — the endpoint side
  mindx_backend_service/
    x402_protocol.py           the wire, shared by middleware and clients
    x402_middleware.py         the paywall
    x402_facilitator.py        /supported, /verify, /settle
  tools/
    x402_bazaar.py             discovery
    x402_avm_client.py         a Python payer, for server-to-server buying
```

Dependencies point one way. Nothing in `payer/src/x402` imports anything outside itself
except [`money.ts`](payer/src/money.ts), and a test enforces that by reading the source.

## The payer: five decisions, and what each refused

### 1. The signer is `algosdk.TransactionSigner`, not an interface of our own

`AvmSigner` is `{ address, sign }` where `sign` is exactly algosdk's type. use-wallet,
AlgoKit Utils, Pera, Defly and Lute already produce one, so integration is a line.

*Refused:* a bespoke `signGroup(txns)`. It would read more cleanly in isolation and make
every real integration a translation layer. An interface nobody else speaks is a cost paid
by everyone downstream.

### 2. Rails register; nothing branches on a chain name

`railFor(network)` resolves by CAIP-2 namespace. `selectRequirement()` asks the registry
which offers are payable; `unpayableNetworks()` names the rest.

*Refused:* `if (network.startsWith('algorand:'))`. The module this replaced did exactly
that, and the result was a signer hardcoded to one chain with every other payee unreachable
behind it.

### 3. Amounts are `bigint` end to end

A decimal string on the wire, a `bigint` in memory, formatted once for a label.
`9007199254740993` survives; through `Number` it would not.

*Refused:* parsing to a number at the edge because prices are small. They are small until a
server quotes in wei, and the failure is silent.

### 4. Everything host-specific is a port

Signing, storage, node endpoints, and the USD price of a non-pegged asset. Four small
interfaces in [`host.ts`](payer/src/x402/host.ts); the defaults work without configuration.

*Refused:* reaching for a price feed. Choosing a vendor on the host's behalf is not the
module's business, and a quote shown in the asset it is denominated in is the honest
presentation anyway.

### 5. A receipt is written on settlement, not on success

The moment `PAYMENT-RESPONSE` decodes, whether or not the resource then delivered.

*Refused:* writing on HTTP 200. *The payment settled* and *the resource failed* are
different facts, and collapsing them loses the transaction id in exactly the case where you
most need it.

## The seller: three decisions

### Verification is not settlement

`/verify` simulates; `/settle` signs the fee payer and submits. Both are called, in that
order. A middleware that called only the first would let through payments that never
reached a chain.

### The terms are the server's, not the payer's

A payment envelope carries `accepted`, a copy of the requirement — and it arrives **from
the payer**. It is checked against what the server published: payee, asset, and an amount
at least the quote. A client that rewrote `payTo` to their own address would otherwise have
the facilitator verify a payment to themselves and then be handed the goods.

### 402, not 401

A priced route answers 402 when called without payment. 401 says *authenticate and come
back*, which an autonomous caller cannot act on — there is nobody to log in. 402 says *here
is the price, the asset, the address and the network*, which it can act on immediately.

## The two schemes

| | Algorand | EVM | Solana |
|---|---|---|---|
| artefact | an atomic group | an EIP-712 signature | a partially-signed transaction |
| sponsor | a `pay` at index 0, unsigned, carrying the whole group's fee | the facilitator, by broadcasting | the facilitator, as fee payer |
| the payer's part | an `axfer` at index 1, signed | the authorization | the `transferChecked` and our signature slot |
| replay guard | the group's validity window | a single-use 32-byte nonce the token marks spent | the blockhash lifetime |

Solana's is the least obvious: the payer sends a transaction that **cannot execute**,
because a required signature is missing. The facilitator completes it or it never happens,
and cannot alter a byte without invalidating the signature already on it.

The Algorand sponsor transaction travels **unsigned** deliberately: signing it is the
facilitator's job, and a client able to sign it would hold an authority it has no business
holding.

On EVM, preflight never checks for gas. The facilitator pays it; an account with zero ETH
can still pay, and a gas check would refuse a payment that would have worked.

## Signing

```
TypeScript builds the transaction
   ├─ Algorand: txn.bytesToSign()  → the wallet's TransactionSigner → signature
   └─ EVM:      named fields       → EIP-712 digest built in rust/eip712.rs → signature
```

There is no `sign_hash` door. One that signs any 32 bytes is a blank cheque: the caller
would decide what the key attests to, and the signer would have no way to tell a payment
from a delegation. Each door signs one named thing.

## Invariants

1. No float touches a value path.
2. A catalogued price is a memory; a live 402 is a quote. Only the second is paid against.
3. Discovery is free.
4. Silence is not consent — without an approval callback, payment is refused unless under
   an explicit cap.
5. A rail signs only what its payer owns.
6. The terms paid are the terms quoted.

## Limits

- `arweave` is the last empty rail slot — a fulfilment leg with no settlement chain.
- The Solana rail needs `@solana/kit` (an optional peer dependency); the other two need
  nothing beyond `algosdk`.
- EVM implements `eip3009` only. `permit2` needs a prior on-chain approval and `erc-7710` a
  smart account; both are refused rather than half-signed.
- Receipts are per-device — a record for the participant, not a ledger of record. The chain
  is that.
- **Nothing here has settled real value on mainnet yet.**
