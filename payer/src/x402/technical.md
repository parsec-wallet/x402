# x402 — technical design

Why the module is shaped the way it is. The protocol narrative is
[`docs/x402-integration.md`](../../../docs/x402-integration.md); the symbol surface is
[`docs/x402-api.md`](../../../docs/x402-api.md); this is the reasoning underneath both.

## The goal it serves

> **A participant — human or agent — can pay for an HTTP resource from any wallet, and
> keep proof they did.**

Every decision below is downstream of that sentence. *Any wallet* forced the port layer.
*Keep proof* forced the receipt ledger. *Agent* forced discovery to be free and quoting to
need no key.

## Shape

```
        createX402Client()                    ← the facade most callers use
                 │
    ┌────────────┼────────────┐
    │            │            │
 client.ts    quote.ts    receipts.ts         ← the flow, priced, recorded
    │
 rails.ts ──── rails/avm.ts ── rails/evm.ts   ← one rail per CAIP-2 namespace
    │
 protocol.ts   networks.ts                    ← the wire, and what a network is
    │
 host.ts                                      ← the three ports
    │
 adapters/parsec.ts   adapters/wallets.ts     ← implementations, per host
```

Dependencies point downward only. [`protocol.ts`](protocol.ts) knows nothing of rails; [`rails.ts`](rails.ts) knows
nothing of the client; nothing below [`host.ts`](host.ts) knows which application it is inside.

## Five decisions, and what each one refused

### 1. The signer is `algosdk.TransactionSigner`, not an interface of our own

An `AvmSigner` is `{ address, sign }` where `sign` is exactly algosdk's own type. This is
the single most load-bearing choice in the module: use-wallet, AlgoKit Utils, Pera, Defly
and Lute all already produce one, so integrating them is a line, not an adapter.

*Refused:* a bespoke `signGroup(txns): Promise<Blob[]>`. It would have read more cleanly
in isolation and made every real integration a translation layer. An interface nobody else
speaks is a cost paid by everyone downstream.

### 2. Rails register; nothing branches on a chain name

`railFor(network)` resolves a rail by CAIP-2 namespace. `selectRequirement()` asks the
registry which of a server's offers are payable; `unpayableNetworks()` names the rest.

*Refused:* `if (network.startsWith('algorand:'))`. The previous module did exactly that,
and the result was a signer hardcoded to Algorand with every EVM and Solana payee
unreachable behind it. The registry makes adding a chain one call and makes *failing to
support one* a reported fact rather than silence.

### 3. Amounts are `bigint` end to end

`amount` is a decimal string on the wire, a `bigint` in memory, and is formatted exactly
once — for a label. `9007199254740993` survives the round trip; through `Number` it would
not.

*Refused:* parsing to a number at the edge "because prices are small". They are small
until a server quotes in wei, and the failure is silent: a payment for the wrong amount
that the facilitator rejects for reasons that look unrelated.

### 3½. Everything host-specific is a port — including the price feed

Signing, storage, node endpoints, and the USD price of a non-pegged asset. The last one
was a late addition, forced by extracting the module into its own repository: [`quote.ts`](quote.ts)
read ALGO/USD from a Vestige client, which is a vendor choice, and a portable module has
no business making one on its host's behalf. `hostUsdRate(symbol)` returns `null` by
default and on any failure, and a quote with no reading is shown in the asset it is
denominated in — never wrong, only less convenient. Parsec supplies the Vestige feed
through the port, like any other host would supply its own.

*Refused:* keeping the feed inside. It would have made the public copy and this one
diverge on their first day.

### 4. Verification and settlement are the resource server's calls, not ours

The client builds and signs. The *server* asks a facilitator to verify and settle. This
module exposes `verifyPayment` and `settlePayment` for operating a server or running a dry
run, and the payment flow calls neither.

*Refused:* settling our own payment and telling the server it succeeded. A settlement
asserted by the party trying to be convinced is not evidence, and a protocol that accepted
it would not need signatures.

### 5. A receipt is written on settlement, not on success

`submitPayment` records the moment `PAYMENT-RESPONSE` decodes, whether or not the resource
then delivered. A delivered-false receipt carries the transaction id and the error.

*Refused:* writing on HTTP 200. *The payment settled* and *the resource failed* are
different facts, and collapsing them is precisely the defect this module was rewritten to
fix — the previous flow declared `txId` and never assigned it, so a successful payment left
no evidence of itself.

## The three schemes

All are `exact`. They differ in what "a signed payment" is.

| | Algorand | EVM | Solana |
|---|---|---|---|
| artefact | an atomic group | an EIP-712 signature | a partially-signed transaction |
| sponsor | `pay` at index 0, unsigned, carrying the group's whole fee | the facilitator, implicitly, by broadcasting | the facilitator, as the transaction's fee payer |
| ours | `axfer` at index 1, signed | the authorization | the `transferChecked`, and our signature slot |
| replay guard | the group's validity window | a single-use 32-byte nonce the token marks spent | the blockhash lifetime |
| what the facilitator cannot do | redirect or alter the transfer | redirect or alter the transfer | alter any byte — doing so invalidates our signature |

Solana's is the most elegant of the three and the least obvious: the payer compiles a
transaction whose **fee payer is the facilitator**, signs only their own slot, and sends
something that cannot execute. A transaction missing a required signature is inert. The
facilitator completes it or it never happens, and it cannot change a byte without
invalidating the signature already on it.

The Algorand sponsor transaction travels **unsigned** and this is not an oversight: signing
it is the facilitator's job, and a client able to sign it would hold an authority it has no
business holding.

On EVM, preflight deliberately never checks for gas. The point of EIP-3009 is that the
facilitator pays it; an account holding zero ETH can still make the payment, and a gas
check would refuse a payment that would have worked.

## Where signing actually happens

```
TypeScript builds the transaction
        │
        ├─ Algorand: txn.bytesToSign()  ─→ chain_algo_sign_transaction   ─→ signature
        │                                   (Rust holds the seed)
        └─ EVM:      named fields       ─→ chain_evm_sign_transfer_authorization
                                            (Rust builds the EIP-712 digest itself)
```

There is deliberately **no `sign_hash` command**. A door that signs any 32 bytes handed to
it is a blank cheque: the renderer would decide what the participant's key attests to, and
Rust would have no way to tell a payment from a transaction from a delegation. Each door
signs one named thing.

In another wallet the same seam is whatever `sign` that wallet provides. The rail cannot
tell the difference, which is the test [`portability.test.ts`](__tests__/portability.test.ts) exists to keep true.

## Invariants

These hold across the module; breaking one is a bug even if tests pass.

1. **No float touches a value path.** Display only, once, at the end.
2. **A catalogued price is a memory; a live 402 is a quote.** Only the second is ever paid
   against.
3. **Discovery is free.** An agent that must pay to learn a price cannot reason about value.
4. **Silence is not consent.** Without `approve`, a payment is refused unless it falls under
   an explicitly configured cap.
5. **A rail signs only what its payer owns.** Anything else in the group travels unsigned.
6. **The terms paid are the terms quoted.** A proof that no longer covers its quote is
   dropped, not submitted (`proofStillCovers`).

## Kept in step with the public copy

This module is published standalone at
[github.com/parsec-wallet/x402](https://github.com/parsec-wallet/x402) — the same files,
minus the four that reach into Parsec (`adapters/parsec.ts`, `module.ts`, `choices.ts`,
`bridge.ts`). [`protocol.ts`](protocol.ts), [`networks.ts`](networks.ts), `rails*`, [`client.ts`](client.ts), [`quote.ts`](quote.ts), [`host.ts`](host.ts),
[`receipts.ts`](receipts.ts), [`settings.ts`](settings.ts), [`bazaar.ts`](bazaar.ts), [`facilitator.ts`](facilitator.ts) and [`adapters/wallets.ts`](adapters/wallets.ts)
should stay byte-identical in both — 14 files, verified with `diff`, not asserted.

[`index.ts`](index.ts) is the one legitimate difference: each barrel lists what its own copy
contains, and this one also re-exports `bridge`, `constants`, `types`, `oracle`,
`discount` and `agenticplace-client`, which serve Parsec's identity surface and are not
part of the portable core. Do not "fix" that.

When the other fourteen drift, the published copy is not what anyone is running, and the
claim that this is extractable stops being true.

## Known limits

- **`arweave` is the last empty rail slot** — a fulfilment leg with no settlement chain.
- **The Solana rail depends on `@solana/kit`**, unlike the other two, which are
  dependency-free beyond `algosdk`. Kit supplies the transaction machinery; the ATA
  derivation and the SPL encoding are ours, because kit does not carry them.
- **EVM implements `eip3009` only.** `permit2` needs a prior on-chain approval and
  `erc-7710` a smart account; both are refused rather than half-signed.
- **`extra.decimals` is trusted.** A server misreporting it misprices its own resource;
  the atomic amount signed is still exactly what was quoted.
- **Receipts are per-device.** They are a record for the participant, not a ledger of
  record. The chain is that.
