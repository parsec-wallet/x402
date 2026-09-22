# x402 on Algorand — a payer module and a seller middleware

Two halves of the same rail, both Apache-2.0, extracted from
[Parsec Wallet](https://github.com/parsec-wallet) and mindX.

**x402** is an HTTP status code with a protocol attached. A server answers `402 Payment
Required` describing what it will accept; the client builds and signs a payment, resends
the request carrying it, and a facilitator verifies and settles it on chain. Nothing is
registered, nothing is subscribed to, no account exists anywhere — **the payment is the
authentication**. That is what makes it a rail for agents: one with a key can buy
something it has never seen from a seller it will never meet again.

```
   client                    resource server           facilitator          Algorand
     │  GET /weather              │                          │                  │
     │ ─────────────────────────► │                          │                  │
     │  402 + PAYMENT-REQUIRED    │                          │                  │
     │ ◄───────────────────────── │                          │                  │
     │  build group, sign ours    │                          │                  │
     │  GET + PAYMENT-SIGNATURE   │                          │                  │
     │ ─────────────────────────► │  verify ───────────────► │  simulate ─────► │
     │                            │  settle ───────────────► │  sign fee payer, │
     │                            │                          │  submit ───────► │
     │  200 + PAYMENT-RESPONSE    │ ◄─────────────────────── │ ◄ instant finality
     │ ◄───────────────────────── │                          │                  │
```

## `payer/` — the wallet side

Pays a 402 from any wallet. TypeScript, no framework.

```ts
import { createX402Client, algorandSigner } from './x402';

const x402 = createX402Client({
  signers: { avm: algorandSigner(address, transactionSigner) },
  approve: async (p) => confirm(`Pay ${p.quote.amountDisplay} ${p.quote.assetSymbol}?`),
});

await x402.fetch('https://api.example.com/weather');   // 402 paid, receipt written
```

`AvmSigner.sign` **is** `algosdk.TransactionSigner`, so use-wallet, AlgoKit Utils, Pera,
Defly and Lute need no adapter at all. Adapters exist for the two shapes that are not
already that: raw ARC-0001 `signTxns`, and EIP-1193 `eth_signTypedData_v4`.

| | |
|---|---|
| protocol | x402 **v2** (`PAYMENT-*` headers), reads **v1** (`X-PAYMENT` + body `accepts`) |
| Algorand | scheme `exact` — facilitator-sponsored atomic group, USDC ASA or native ALGO |
| EVM | scheme `exact` — EIP-3009 `transferWithAuthorization` |
| discovery | Bazaar `/discovery/*`, and the `bazaar` extension on a live challenge |
| receipts | every settlement, with the transaction id that proves it |

Read [`payer/src/x402/README.md`](payer/src/x402/README.md) for the module,
[`technical.md`](payer/src/x402/technical.md) for why it is shaped this way, and
[`usage.md`](payer/src/x402/usage.md) for recipes.

`payer/rust/eip712.rs` is the EIP-3009 signer: the EIP-712 digest is built in Rust from
named fields of one struct. There is deliberately no `sign_hash` command — a door that
signs any 32 bytes is a blank cheque, and Rust would have no way to tell a payment from a
delegation. Pinned against an `eth_account` vector.

## `seller/` — the endpoint side

Python. Prices a route, answers 402, verifies and settles through a facilitator.

| | |
|---|---|
| `x402_protocol.py` | the wire, v1 and v2; CAIP-2; the `bazaar` extension |
| `x402_middleware.py` | the paywall — free quota, session bypass, replay guard, settlement ledger |
| `x402_facilitator.py` | `/supported`, `/verify`, `/settle`, in the published shape |
| `x402_bazaar.py` | discovery — what is for sale, and what it costs right now |

**Verification is not settlement.** `/verify` simulates; `/settle` signs the fee payer and
submits. Both are called, in that order, and the transaction id that comes back from the
second is what the payer receives as proof.

The terms a payment declares are checked against the terms the server published, because
`accepted` arrives **from the payer** — a client that rewrote `payTo` to their own address
would otherwise have the facilitator verify a payment to themselves.

## Rules both halves keep

- **No float in a value path.** An amount is a decimal string on the wire and a `bigint`
  or `int` to the transaction, formatted once for a label.
- **A catalogued price is a memory; a live 402 is a quote.** Only the second is paid against.
- **Discovery is free.** An agent that must pay to learn a price cannot reason about value.
- **The client does not settle its own payment.** A settlement asserted by the party trying
  to be convinced is not evidence.
- **Silence is not consent.** Without an approval callback, a payment is refused unless it
  falls under an explicitly configured cap.

## Tests

```bash
# payer — 132 tests, including a full payment with no Parsec, no Tauri, no vault
npx vitest run payer/src/x402

# seller — 61 tests
python -m pytest seller/

# the EIP-712 signer — 8 tests, against an independent implementation's vector
cargo test --lib eip712
```

`payer/src/x402/__tests__/portability.test.ts` pays end to end with a bare `algosdk`
account and an in-memory store, and its last case resolves every relative import in the
module and fails if the core reaches back into the application it was extracted from.

## Status

Verified against stubs, testnet shapes, and a live facilitator's read endpoints. **It has
not yet moved real USDC on mainnet** — see [`todo.md`](payer/src/x402/todo.md), which
carries the goal, the plan, and what is honestly still open.

## Licence

Apache-2.0. See [LICENSE](LICENSE).

## References

- Spec: [algorandfoundation/x402](https://github.com/algorandfoundation/x402)
- Facilitator: <https://facilitator.goplausible.xyz>
- Developer guide: <https://algorand.co/agentic-commerce/x402/developers>
