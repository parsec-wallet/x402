# x402

Pay for an HTTP resource that answers `402 Payment Required`.

A resource server describes what it will accept, the client builds and signs a payment,
resends the request carrying it, and a *facilitator* verifies and settles it on chain.
Nothing is registered, nothing is subscribed to, no account exists anywhere — **the
payment is the authentication**. That is what makes it the natural rail for agents: one
with a key can buy something it has never seen from a seller it will never meet again.

This module is the **buyer**. Parsec is one host; any wallet can be another.

## Quickstart

```ts
import { createX402Client, algorandSigner } from './lib/x402';

const x402 = createX402Client({
  signers: { avm: algorandSigner(address, transactionSigner) },
  approve: async (p) => confirm(`Pay ${p.quote.amountDisplay} ${p.quote.assetSymbol}?`),
});

const res = await x402.fetch('https://api.example.com/weather');
```

A free resource passes straight through. A 402 is quoted, approved, signed, settled, and
the transaction id recorded.

Reading costs nothing and needs no key:

```ts
const x402 = createX402Client();              // no signers at all
await x402.quote('https://api.example.com/weather');   // what it costs, null if free
await x402.discover({ maxAmount: 10_000n });           // the Bazaar catalogue
```

## Supported today

| | |
|---|---|
| protocol | x402 **v2** (`PAYMENT-*` headers), reads **v1** (`X-PAYMENT` + body `accepts`) |
| Algorand | scheme `exact` — facilitator-sponsored atomic group, USDC ASA or native ALGO |
| EVM | scheme `exact` — EIP-3009 `transferWithAuthorization` |
| Solana | scheme `exact` — a partially-signed transaction the facilitator completes |
| discovery | Bazaar (`/discovery/*`) and the `bazaar` extension on a live challenge |
| receipts | every settlement, with the transaction id that proves it |

Arweave is the last registrable rail slot with nothing behind it — a fulfilment leg with no settlement chain.

## Files

```
pay.ts            createX402Client() — the whole module behind one object
host.ts           the three ports: signing, storage, nodes
client.ts         the flow: probe → choose → quote → approve → sign → submit → record
protocol.ts       the wire, v1 and v2: challenge, payment, settlement envelopes
networks.ts       CAIP-2 identity, aliases, assets (USDC ASAs), explorers
rails.ts          the rail registry — one per CAIP-2 namespace
rails/avm.ts      Algorand: group build, preflight, ASA opt-in
rails/evm.ts      EVM: EIP-3009 authorization
quote.ts          exact atomic→display arithmetic; USD where it is knowable
receipts.ts       the settlement ledger
facilitator.ts    /supported, /verify, /settle — read-only from a client
bazaar.ts         the catalogue of paid resources
settings.ts       preferred network, facilitator, auto-approve cap
adapters/
  parsec.ts       Parsec's ports, Rust-backed — the only file that knows Parsec exists
  wallets.ts      algosdk.TransactionSigner, ARC-0001, EIP-1193
module.ts         registerModule() — Parsec's routes and dashboard tile
choices.ts        privilege: sign · reach: external · persistence: device
```

`bridge.ts`, `oracle.ts`, `discount.ts`, `constants.ts`, `types.ts` and
`agenticplace-client.ts` predate the rewrite and serve the identity and AgenticPlace
surfaces; `bridge.ts` is a legacy vault signer used by the AORC minters, **not** the
payment path.

## The three ports

Everything that is not the protocol lives behind [`host.ts`](host.ts), which is why the same code
runs in another wallet:

| port | default | override when |
|---|---|---|
| **signers** | none — read and quote only | always, to pay |
| **storage** | `localStorage`, else memory | an agent, SSR, a Tauri store, a test |
| **nodes** | public algod / EVM RPC | you run your own, or pay for one |

`AvmSigner.sign` **is** `algosdk.TransactionSigner`, so use-wallet, AlgoKit Utils, Pera,
Defly and Lute need no adapter at all.

## Rules this module keeps

- **No float in a value path.** An amount is a decimal string on the wire and a `bigint`
  to the transaction; it is formatted once, for a label. `9007199254740993` survives.
- **A catalogued price is a memory, a live 402 is a quote.** Nothing is ever paid against
  the first.
- **Discovery is free.** An agent that must pay to learn a price cannot reason about value.
- **The client does not settle its own payment.** A settlement asserted by the party
  trying to be convinced is not evidence.
- **Silence is not consent.** Without an `approve` callback every payment is refused
  unless it falls under an explicitly configured cap.

## Further reading

Beside this file:

| | |
|---|---|
| [`technical.md`](./technical.md) | how it works inside — the five decisions and what each refused, the invariants, the known limits |
| [`usage.md`](./usage.md) | task-oriented recipes — pay an endpoint, integrate a wallet, run an agent, build a confirmation screen |
| [`todo.md`](./todo.md) | the goal, the plan, and what is still open |

Elsewhere:

- [`docs/x402-integration.md`](../../../docs/x402-integration.md) — the protocol, both
  schemes in detail, integrating another wallet, the Global Challenge
- [`docs/x402-api.md`](../../../docs/x402-api.md) — every export, every error
- Spec: [algorandfoundation/x402](https://github.com/algorandfoundation/x402)
