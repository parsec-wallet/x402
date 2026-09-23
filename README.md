# x402 on Algorand — a payer module and a seller middleware

Two halves of the same rail, both Apache-2.0, extracted from
[Parsec Wallet](https://github.com/parsec-wallet) and mindX.

New to the protocol? Start with **[explanation.md](explanation.md)** — what x402 is and
why it exists. Then [technical.md](technical.md) for the design and
[usage.md](usage.md) for the recipes.

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

This repository carries the **portable core only** — no host integration layer, and the
allowlist in its own portability test is empty as a result. Parsec's implementations of
the ports (Rust-backed signers, its UI registration) live in Parsec, which is where a
host's implementations belong.

| | |
|---|---|
| protocol | x402 **v2** (`PAYMENT-*` headers), reads **v1** (`X-PAYMENT` + body `accepts`) |
| Algorand | scheme `exact` — facilitator-sponsored atomic group, USDC ASA or native ALGO |
| EVM | scheme `exact` — EIP-3009 `transferWithAuthorization` |
| Solana | scheme `exact` — a partially-signed transaction the facilitator completes |
| discovery | Bazaar `/discovery/*`, and the `bazaar` extension on a live challenge |
| receipts | every settlement, with the transaction id that proves it |

Read [`payer/src/x402/README.md`](payer/src/x402/README.md) for the module,
[`technical.md`](payer/src/x402/technical.md) for why it is shaped this way, and
[`usage.md`](payer/src/x402/usage.md) for recipes.

[`payer/rust/eip712.rs`](payer/rust/eip712.rs) is the EIP-3009 signer: the EIP-712 digest is built in Rust from
named fields of one struct. There is deliberately no `sign_hash` command — a door that
signs any 32 bytes is a blank cheque, and Rust would have no way to tell a payment from a
delegation. Pinned against an `eth_account` vector.

## `seller/` — the endpoint side

Python. Prices a route, answers 402, verifies and settles through a facilitator.

| | |
|---|---|
| [`x402_protocol.py`](seller/mindx_backend_service/x402_protocol.py) | the wire, v1 and v2; CAIP-2; the `bazaar` extension |
| [`x402_middleware.py`](seller/mindx_backend_service/x402_middleware.py) | the paywall — free quota, session bypass, replay guard, settlement ledger |
| [`x402_facilitator.py`](seller/mindx_backend_service/x402_facilitator.py) | `/supported`, `/verify`, `/settle`, in the published shape |
| [`x402_bazaar.py`](seller/tools/x402_bazaar.py) | discovery — what is for sale, and what it costs right now |

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

## Build and test

```bash
cd payer  && npm install && npx tsc --noEmit && npx vitest run
#   → 0 type errors, 131 tests passed

cd seller && pip install -e ".[test]" && python -m pytest
#   → 52 passed, 1 skipped
```

`rust/eip712.rs` is a single file meant to be dropped into a Rust crate; its 8 tests run
with `cargo test eip712` once it is in one. They pin the digest and signature against a
vector generated by `eth_account` — an independent implementation, not our own arithmetic
replayed.

[`payer/src/x402/__tests__/portability.test.ts`](payer/src/x402/__tests__/portability.test.ts) pays end to end with a bare `algosdk`
account and an in-memory store, and its last case resolves every relative import in the
module and fails if anything reaches outside it.

## Status

Verified against stubs, testnet shapes, and a live facilitator's read endpoints. **It has
not yet moved real USDC on mainnet.** [`payer/src/x402/todo.md`](payer/src/x402/todo.md)
carries the goal, the plan, and what is honestly still open — including that, and the
Solana rail, which is an empty slot rather than a quiet omission.

## Running this as a challenge entry

[HANDOFF.md](HANDOFF.md) is the operator's page: what is done, the two things that are
not, and the exact commands for each.

## Documentation

| | |
|---|---|
| [explanation.md](explanation.md) | what x402 is and why it exists — start here |
| [technical.md](technical.md) | the design of both halves, and what each decision refused |
| [usage.md](usage.md) | recipes for buying, selling and discovering |
| [payer/src/x402/README.md](payer/src/x402/README.md) | the payer module's own entry point |
| [docs/x402-api.md](docs/x402-api.md) | every export, every error, troubleshooting |
| [HANDOFF.md](HANDOFF.md) | what is left, and who has to do it |

## Source map

Every file, one click away.

**Payer** — [`payer/src/x402/`](payer/src/x402/)

| | |
|---|---|
| [`pay.ts`](payer/src/x402/pay.ts) | `createX402Client()` — the whole module as one object |
| [`host.ts`](payer/src/x402/host.ts) | the four ports: signing, storage, nodes, price |
| [`client.ts`](payer/src/x402/client.ts) | probe → choose → quote → approve → sign → submit → record |
| [`protocol.ts`](payer/src/x402/protocol.ts) | the wire, v1 and v2 |
| [`networks.ts`](payer/src/x402/networks.ts) | CAIP-2 identity, assets, explorers |
| [`rails.ts`](payer/src/x402/rails.ts) | the rail registry |
| [`rails/avm.ts`](payer/src/x402/rails/avm.ts) | Algorand — sponsored atomic group |
| [`rails/evm.ts`](payer/src/x402/rails/evm.ts) | EVM — EIP-3009 authorization |
| [`rails/svm.ts`](payer/src/x402/rails/svm.ts) | Solana — partially-signed transaction |
| [`quote.ts`](payer/src/x402/quote.ts) | exact atomic→display arithmetic |
| [`receipts.ts`](payer/src/x402/receipts.ts) | the settlement ledger |
| [`facilitator.ts`](payer/src/x402/facilitator.ts) | `/supported`, `/verify`, `/settle` |
| [`bazaar.ts`](payer/src/x402/bazaar.ts) | discovery |
| [`settings.ts`](payer/src/x402/settings.ts) | preferred network, facilitator, auto-approve cap |
| [`adapters/wallets.ts`](payer/src/x402/adapters/wallets.ts) | `TransactionSigner`, ARC-0001, EIP-1193, Solana |
| [`rust/eip712.rs`](payer/rust/eip712.rs) | the EIP-3009 signer |
| [`__tests__/`](payer/src/x402/__tests__/) | 139 tests, including [`portability.test.ts`](payer/src/x402/__tests__/portability.test.ts) and [`hostile.test.ts`](payer/src/x402/__tests__/hostile.test.ts) |

**Seller** — [`seller/`](seller/)

| | |
|---|---|
| [`x402_protocol.py`](seller/mindx_backend_service/x402_protocol.py) | the wire, shared by middleware and clients |
| [`x402_middleware.py`](seller/mindx_backend_service/x402_middleware.py) | the paywall |
| [`x402_facilitator.py`](seller/mindx_backend_service/x402_facilitator.py) | the facilitator contract |
| [`x402_bazaar.py`](seller/tools/x402_bazaar.py) | discovery |
| [`x402_avm_client.py`](seller/tools/x402_avm_client.py) | a Python payer, for server-to-server buying |
| [`usdc_optin.py`](seller/usdc_optin.py) | opt a payTo in to USDC — see [HANDOFF.md](HANDOFF.md) |
| [`tests/`](seller/tests/) | 52 tests |

## Licence

Apache-2.0. See [LICENSE](LICENSE).

## References

- Spec: [algorandfoundation/x402](https://github.com/algorandfoundation/x402)
- Facilitator: <https://facilitator.goplausible.xyz>
- Developer guide: <https://algorand.co/agentic-commerce/x402/developers>
