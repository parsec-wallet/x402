# x402 — paying for resources from Parsec

> **Status 2026-09-18.** Rewritten against the published protocol. The module speaks
> x402 **v2** (and reads v1), implements the **`exact` scheme on Algorand** (sponsored
> atomic groups in USDC or ALGO) and **on EVM** (EIP-3009 authorizations), signs both
> through **Rust**, and writes a **receipt carrying the settled transaction id**. Solana
> and Arweave are registrable slots with nothing behind them yet.
>
> **Solana as of 2026-09-21.** Three rails: Algorand, EVM and Solana, all `exact`.
>
> **Portable as of 2026-09-19.** The module depends on the application through three
> small ports (`host.ts`) rather than by importing it. Parsec supplies signing backed by
> Rust; any wallet with an `algosdk.TransactionSigner` — use-wallet, AlgoKit, Pera, Defly,
> Lute — supplies its own in one line. A test reads the source and fails if the core
> reaches back into the application again.
>
> **Runnable as of 2026-09-19.** Both chain packs are registered in
> `src-tauri/src/lib.rs` and `cargo check` is clean — see
> [How signing reaches Rust](#how-signing-reaches-rust).

**Also:** [`src/lib/x402/README.md`](../src/lib/x402/README.md) is the module's own entry
point and quickstart; [x402-api.md](./x402-api.md) is every export, every error and the
troubleshooting table.

## What x402 is

An HTTP status code with a protocol attached. A resource server answers `402 Payment
Required` and describes, in machine-readable form, what it will accept. The client builds
a payment, resends the request carrying it, and the server — via a *facilitator* that
verifies and submits on chain — delivers the resource and hands back proof of settlement.

Nothing is registered, nothing is subscribed to, and no account exists anywhere. The
payment *is* the authentication. That is why it is the natural rail for agents: an agent
with a key can buy something it has never seen from a seller it will never meet again.

```
   Parsec                    Resource server              Facilitator            Algorand
     │  GET /weather              │                            │                     │
     │ ─────────────────────────► │                            │                     │
     │  402 + PAYMENT-REQUIRED    │                            │                     │
     │ ◄───────────────────────── │                            │                     │
     │  build group, sign ours    │                            │                     │
     │  GET + PAYMENT-SIGNATURE   │                            │                     │
     │ ─────────────────────────► │  verify ─────────────────► │  simulate ────────► │
     │                            │ ◄───────────────────────── │ ◄────────────────── │
     │                            │  settle ─────────────────► │  sign fee payer,    │
     │                            │                            │  submit ──────────► │
     │  200 + PAYMENT-RESPONSE    │ ◄───────────────────────── │ ◄─ instant finality │
     │ ◄───────────────────────── │                            │                     │
```

## The module

```
src/lib/x402/
  protocol.ts        the wire — v1/v2 codec, challenge/payment/settlement envelopes
  networks.ts        CAIP-2 identity, aliases, assets (USDC ASAs), explorers
  rails.ts           the rail registry — one per CAIP-2 namespace
  rails/avm.ts       Algorand `exact`: group build, Rust signing, preflight, ASA opt-in
  rails/evm.ts       EVM `exact`: EIP-3009 authorization, Rust-built EIP-712 digest
  client.ts          the flow — probe, choose, quote, approve, sign, submit, receipt
  quote.ts           exact atomic→display arithmetic, USD where it is knowable
  receipts.ts        the settlement ledger (device storage)
  facilitator.ts     /supported, /verify, /settle — read-only from a client
  bazaar.ts          discovery: the catalogue of paid resources
  settings.ts        preferred network, facilitator, auto-approve cap
  host.ts            the ports — signing, storage, nodes — and their defaults
  pay.ts             createX402Client(): the whole module behind one object
  adapters/parsec.ts Parsec's port implementations, Rust-backed
  adapters/wallets.ts  algosdk.TransactionSigner, ARC-0001 and EIP-1193 adapters
  module.ts          registerModule() — routes, rail, dashboard tile
  choices.ts         privilege: sign · reach: external · persistence: device
  constants.ts       BANKON ASA, ERC-8004 registries, AgenticPlace URLs
  types.ts           ERC-8004 identity, access tiers, AgenticPlace payloads
  oracle.ts          Vestige ALGO/USD, for display only
  discount.ts        BANKON holder lookup (see "the discount moved" below)
  agenticplace-client.ts   discovery API, SmartOracle, MindX, BANKON identity
  bridge.ts          vault-held algosdk signer — used by AORC minting, not by payment

src/lib/
  chain-algo.ts      typed wrapper for chain_algo (signs the Algorand group legs)
  chain-evm.ts       typed wrapper for chain_evm (EIP-1559 txs, EIP-3009 authorizations)

src/views/
  x402-desk.ts       rails, facilitator, USDC opt-in, settings, receipts, pay-a-URL
  x402-bazaar.ts     the catalogue
  x402-confirm.ts    the approval surface
```

One `registerModule()` call in `module.ts` performs the router, navigation and dashboard
registrations, and importing it registers the Algorand rail as a side effect.

## The wire, in both versions

| | v1 | v2 |
|---|---|---|
| challenge | response **body** | `PAYMENT-REQUIRED` header (base64 JSON), body `{}` |
| payment | `X-PAYMENT` header | `PAYMENT-SIGNATURE` header |
| settlement | `X-PAYMENT-RESPONSE` header | `PAYMENT-RESPONSE` header |
| amount field | `maxAmountRequired` | `amount` |
| network | `algorand-testnet` | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` |
| `accepted` in the payment | optional | **required** |

`protocol.ts` reads either and normalizes to the v2 shape. It writes v2, and adds the v1
alias header **only** when the server declared version 1 — a server that names no version
is assumed current, not assumed ancient.

Amounts never pass through `Number`. `amount` is a decimal string on the wire and a
`bigint` in memory the whole way to the transaction; `9007199254740993` survives, which
is the first integer a double cannot represent. Formatting happens once, for a label
(cypherpunk4096 commitment IV).

## The `exact` scheme on Algorand

The requirement:

```json
{
  "scheme": "exact",
  "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  "amount": "250000",
  "asset": "31566704",
  "payTo": "<58-char address>",
  "maxTimeoutSeconds": 300,
  "extra": { "name": "USDC", "decimals": 6, "feePayer": "<facilitator address>" }
}
```

`asset` is an **ASA id as a string** — `"0"` means native ALGO — not a contract address.
USDC is `31566704` on mainnet and `10458941` on testnet, both 6 decimals.

The payload is an atomic group:

| index | transaction | sender → receiver | amount | fee | signed by |
|---|---|---|---|---|---|
| 0 | `pay` | feePayer → feePayer | 0 | the **whole group's** fee | the facilitator, at settlement |
| 1 | `axfer` (or `pay` for ALGO) | payer → `payTo` | `amount` | 0 | **us** |

`paymentIndex` is `1`, pointing at the transaction that actually pays. Fees are
`Σ max(feePerByte × size, minFee)` charged to index 0 — normally `1000 × n`, so 2,000
µALGO for a two-transaction group — which is what makes the payment gasless for the
participant. Index 0 travels **unsigned**: signing it is the facilitator's job, and a
client able to sign it would hold an authority it has no business holding.

With no `extra.feePayer`, the group is the single payment at index 0 and the payer covers
their own fee.

### Signing

Parsec builds the transactions, hands Rust the exact `TX`-prefixed preimage from
`txn.bytesToSign()`, and attaches the returned signature. The mnemonic does not enter the
renderer:

```
buildPaymentGroup()  → algosdk Transaction[]
  ↳ txn.bytesToSign() → base64 → chain_algo_sign_transaction → signature
  ↳ txn.attachSignature(payer, sig) → SignedTxn bytes → base64
```

Only transactions whose sender is the payer are signed. This satisfies CLAUDE.md
non-negotiables 2 and 3; the previous flow, which pulled the mnemonic through
`keystoreRetrieve` into `algosdk.mnemonicToSecretKey`, did not.

### Opt-in

Algorand will not let an account hold an asset it has not opted in to, so a USDC payment
from an account with no USDC holding is rejected by the protocol rather than failing for
want of funds. `preflightAvm()` reports it as a blocker with a remedy, the desk offers it
directly, and both say out loud that the holding locks 0.1 ALGO into the account's
minimum balance.

## The `exact` scheme on EVM

Where Algorand builds a group, EVM signs an authorization. The requirement:

```json
{
  "scheme": "exact",
  "network": "eip155:8453",
  "amount": "10000",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  "maxTimeoutSeconds": 60,
  "extra": { "assetTransferMethod": "eip3009", "name": "USDC", "version": "2" }
}
```

`asset` is the **token contract address**, not an id. The payload is an EIP-712
signature over `TransferWithAuthorization` plus the fields needed to reconstruct it:

```json
{
  "signature": "0x…65 bytes",
  "authorization": {
    "from": "0x857b…", "to": "0x2096…", "value": "10000",
    "validAfter": "1740672089", "validBefore": "1740672154",
    "nonce": "0xf374…32 bytes"
  }
}
```

The facilitator calls `transferWithAuthorization` on the token and pays the gas. It can
decline to broadcast; it cannot change the recipient or the amount, because both are
inside what was signed. The `nonce` is 32 random bytes and single-use — the token
contract marks it spent, which is what stops a facilitator replaying an authorization it
already settled. `validAfter` is backdated a minute so a fast clock cannot produce
something no node will accept yet; `validBefore` is the server's own `maxTimeoutSeconds`.

**No gas check in preflight.** The point of EIP-3009 is that the facilitator pays it; an
account holding zero ETH can still make this payment. Preflight reads the token balance
and nothing else, and a public RPC that will not answer is reported rather than treated
as a refusal.

The rail implements `eip3009` only. `permit2` needs a one-time on-chain approval and
`erc-7710` needs a smart account; a requirement naming either is **refused**, not
half-signed into something that will not settle.

### Signing, and the door that does not exist

```
buildAuthorization()  → domain + authorization fields
  ↳ chain_evm_sign_transfer_authorization(address, domain, authorization)
      ↳ Rust builds keccak256(0x1901 || domainSeparator || structHash)
      ↳ secp256k1, low-s, v = 27 + recid → 65 bytes r||s||v
```

There is deliberately **no `sign_hash` command**. A door that signs any 32 bytes handed
to it is a blank cheque: the renderer would decide what the key attests to and Rust would
have no way to tell a payment from a delegation. So the digest is built in
`src-tauri/src/chain_evm/eip712.rs` from named fields of one struct, and that is the only
message this path can produce. The typehashes are pinned against their own definitions,
and the digest and signature are pinned against `eth_account` — an independent
implementation, not our own arithmetic replayed.

## The `exact` scheme on Solana

The most elegant of the three, and the least obvious. The requirement:

```json
{
  "scheme": "exact",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": "1000",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "payTo": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4",
  "maxTimeoutSeconds": 60,
  "extra": { "feePayer": "<facilitator>", "memo": "pi_3abc123def456" }
}
```

`asset` is the **token mint**. The payload is one field:

```json
{ "transaction": "<base64 of the partially-signed wire transaction>" }
```

The payer compiles a transaction whose **fee payer is the facilitator**, signs only their
own slot, and sends something that *cannot execute*. A transaction missing a required
signature is inert; the facilitator completes it or it never happens. And it cannot change
a byte, because doing so invalidates the signature already on it.

`extra.memo`, when set, **must** be used verbatim rather than a nonce of ours — it is how
a seller reconciles a payment against an invoice.

### The part worth checking twice

A transfer moves tokens between *associated token accounts*, each derived as
`PDA([owner, tokenProgram, mint], associatedTokenProgram)`. This is the one place in the
rail where being wrong is silent and expensive: a mis-derived address is a valid-looking
account nobody controls, and the payment succeeds into it.

So it is pinned against two addresses **read back from mainnet** — derived by this code,
then confirmed by `getAccountInfo` to exist and report exactly the owner and mint they
were derived from. That is ground truth from the chain, not our own arithmetic replayed.

### The recipient must be able to receive

Solana's analogue of the Algorand opt-in, and it fails the same silent way: a transfer to
an account that does not exist is rejected, and it does not read as a funds problem.
Unlike the opt-in, **the payer cannot fix this one** — the recipient must. Preflight says
so by name.

There is no SOL check, for the same reason there is no gas check on EVM: the facilitator
pays the fee.

### Dependency

This rail uses `@solana/kit` for the transaction machinery. Kit does not carry the
associated-token derivation or the SPL instruction encoding, so both are here. It is the
only rail with a dependency beyond `algosdk`.

## Which address pays

A multi-chain wallet has a different address on every chain, and which one pays is
decided by the offer the server made — so the flow is handed all of them:

```ts
import { createX402Client } from './lib/x402';
import { signersForAccount } from './lib/x402/adapters/parsec';

const x402 = createX402Client({ signers: signersForAccount(account), approve });
```

A signer carries its own address, so supplying the signers supplies the payer too.
`resolvePayer()` picks after the requirement is chosen, and **throws** rather than
falling back to whatever address was nearest. Signing an EVM authorization whose `from`
is an Algorand address yields a signature that recovers to nobody, and the failure would
surface at the facilitator as something unrelated to the real cause.

## Using it from another wallet

The module talks to its host through three ports and nothing else, so embedding it is a
matter of supplying them. The Algorand signer is deliberately `algosdk.TransactionSigner`
— the shape use-wallet, AlgoKit Utils, Pera, Defly and Lute already produce — so for most
integrations there is no adapter to write at all.

```ts
import { createX402Client, algorandSigner } from './lib/x402';
import { useWallet } from '@txnlab/use-wallet';

const { activeAddress, transactionSigner } = useWallet();

const x402 = createX402Client({
  signers: { avm: algorandSigner(activeAddress, transactionSigner) },
  approve: async (pending) => confirm(`Pay ${pending.quote.amountDisplay} ${pending.quote.assetSymbol}?`),
});

const res = await x402.fetch('https://api.example.com/weather');   // 402 paid, receipt written
```

That is the whole integration. A free resource passes straight through; a 402 is quoted,
approved, signed and settled, and the transaction id is recorded.

### The three ports

| port | default | when to override |
|---|---|---|
| **signers** | none — the client can read and quote but not pay | always, to pay |
| **storage** | `localStorage`, falling back to memory | an agent, SSR, a Tauri store, a test |
| **nodes** | public algod / EVM RPC | your own node, or a paid endpoint |

```ts
createX402Client({
  signers: { avm, evm },
  host: {
    storage: myStore,                       // getItem / setItem / removeItem
    algod: (network) => myAlgodClient,      // per CAIP-2 network
    evmRpc: (network) => 'https://…',
  },
});
```

### Wallets that are not `TransactionSigner`-shaped

| adapter | for |
|---|---|
| `algorandSigner(address, signer)` | anything with an `algosdk.TransactionSigner` |
| `arc0001Signer(address, provider)` | a raw ARC-0001 `signTxns` provider — Lute, a WalletConnect session |
| `eip1193Signer(address, provider)` | the EVM rail, over `eth_signTypedData_v4` |
| `parsecAvmSigner` / `parsecEvmSigner` | Parsec's own, backed by Rust (`adapters/parsec.ts`) |

`arc0001Signer` sends transactions the payer does not own with `signers: []` — ARC-0001's
way of saying *this one is here for context, do not sign it*, which is exactly what a
sponsored group's facilitator transaction needs.

`eip1193Signer` assembles the typed-data document itself, so what the wallet displays is
an EIP-3009 transfer authorization and cannot be anything else.

### Reading costs nothing and needs no key

```ts
const x402 = createX402Client();                  // no signers at all
await x402.quote('https://api.example.com/x');    // what it costs, or null if free
await x402.probe('https://api.example.com/x');    // the raw challenge
await x402.discover({ maxAmount: 10000n });       // the Bazaar catalogue
await x402.facilitator();                         // what can be settled, and who sponsors fees
```

An agent deciding whether a resource is worth paying for should not have to hold a key to
find out what it costs.

### What is still Parsec's

Three files are the integration layer and are coupled on purpose: `adapters/parsec.ts`
(the port implementations), `module.ts` (routes and the dashboard tile) and `choices.ts`
(the privilege declaration). `bridge.ts` is a legacy vault signer kept for the AORC
minters and is not on the payment path.

The core keeps one shared dependency, `../money` — exact fixed-point arithmetic, pure and
dependency-free, and what stops a float reaching a signed amount. An extraction would take
it along.

## Adding a chain

One `registerRail()` call:

```ts
import { registerRail } from '../rails';

registerRail({
  family: 'evm',                       // the CAIP-2 namespace family
  label: 'Base',
  schemes: ['exact'],
  networks: [BASE_MAINNET],            // omit for "any network in the family"
  async buildPayload(ctx) {            // ctx: requirement, challenge, payer, walletNetwork
    return { signature, authorization }; // whatever the scheme names
  },
  async preflight(ctx) { … },          // optional: balance, allowances, blockers
});
```

Nothing else changes. `selectRequirement()` asks the registry which of the server's offers
are payable; `unpayableNetworks()` names the rest so a failure says *what* was offered
rather than "payment failed". This replaced a signer hardcoded to Algorand which made
every EVM and Solana payee unreachable.

The last rail slot with nothing behind it is `arweave` — a fulfilment leg, with no
settlement chain, so it may stay that way.

## Bazaar

Facilitators catalogue the resources that settle through them, and a server can declare in
its own 402 what the endpoint takes and returns (the `bazaar` extension in `extensions`).
`bazaar.ts` reads `/discovery/resources`; the Bazaar view browses it. Everything there is
free, and nothing in it is trusted beyond display — **the price a payment is made against
is read live from the resource's own 402, every time.**

## Settlement receipts

`PAYMENT-RESPONSE` carries `{ success, transaction, network, payer }`. `receipts.ts`
writes a receipt the moment one is decoded — whether or not the resource then delivered,
because *the payment settled* and *the resource failed* are two different facts and losing
the first was the original defect.

`latestReceiptTo(payTo, network)` is the lookup a paid name claim makes: a BNR
`Payment-Proof` wants exactly the transaction id of a payment to the registry treasury.

## Where the discount went

The old module applied a 50 % BANKON-holder discount **client-side**, to the amount it
paid. Under `exact` that produces a payment the network accepts and the facilitator
rejects, because verification checks the transferred amount against the quote. A client
cannot discount itself.

The discount belongs to the server, which needs to know whom it is quoting for — and
cannot, since x402 has no session. So the client sends `X-Payer-Hint: <address>` on the
probe. It is a hint, not a credential: a server that prices on it without checking
holdings on chain has only itself to blame, and a server that ignores it loses nothing.
`checkBankonHolder()` remains, for the identity view and for a server-side caller.

## Settings

| setting | default | what it does |
|---|---|---|
| `preferNetwork` | Algorand Testnet | which offer to take when several are payable |
| `facilitatorUrl` | `https://facilitator.goplausible.xyz` | asked what it can settle, and for the catalogue |
| `autoApproveMicroUsd` | `0` | pay without asking at or below this. Zero means always ask |
| `preflight` | on | read balance and opt-in state before showing the confirmation |

A payment settles through whichever facilitator the resource's own `extra.feePayer` names
— that is per-resource and not ours to configure. The setting above governs capability
queries and discovery only.

## Using it from Parsec

```ts
import { createX402Client } from './lib/x402';
import { signersForAccount } from './lib/x402/adapters/parsec';
import { approveThroughView } from './views/x402-confirm';

const x402 = createX402Client({
  signers: signersForAccount(account),
  approve: async (pending) => {
    // pending.quote.amountDisplay  '0.25'
    // pending.quote.assetSymbol    'USDC'
    // pending.preflight?.blockers  what would stop it
    // pending.mainnet              whether this is real money
    return confirmed;
  },
});

const result = await x402.request('https://api.example.com/weather');
result.txId     // settled transaction id
result.receipt  // the ledger entry
```

`x402.fetch()` is the same flow returning only a `Response`, for a caller that wants
`fetch` semantics. `x402.probe()` and `x402.quote()` read without paying.

Building a custom confirmation screen? `x402.prepare(url, challenge)` returns the pending
payment with nothing signed, and `x402.pay(pending)` signs and sends it — which is how
`views/x402-confirm.ts` works. The lower-level `x402Request` / `preparePayment` /
`signPayment` / `submitPayment` remain exported for anything the facade does not cover.

## AgenticPlace and mindX

`agenticplace.pythai.net` and `mindx.pythai.net` are the in-house resource servers.
mindX's middleware (`mindx_backend_service/x402_middleware.py`, protocol layer
`x402_protocol.py`) emits both versions of the challenge and prices per endpoint in
micro-USD from `data/config/x402_pricing.json`. Parsec is a first-class client of it:
same CAIP-2 vocabulary, same USDC ASA, same facilitator.

`agenticplace-client.ts` covers the non-payment surfaces — agent discovery, SmartOracle
prices, BANKON identity.

## The x402 Global Challenge

Submissions ran to 30 September 2026; the leaderboard measures **real mainnet
settlements**. The parts that matter to this module: mainnet USDC is ASA `31566704`
(testnet `10458941`), settlement goes through the GoPlausible facilitator, endpoints must
answer a real `402` and carry the Bazaar extension, and entries are tagged
`x402-global-challenge` — a tag that shows up in live catalogue entries under
`extra.tag`.

Parsec's side is the **buyer**: the wallet an agent or a person pays from. The seller side
lives in mindX.

## Paying for a BANKON name

The rail's first in-house consumer, and the thing the missing transaction id was
blocking. `src/lib/bankon-names/pay.ts`:

```ts
const quote = await quoteNameClaim('Buy-Name', name, { paymentMethod: 'algorand' }, network);
// quote.treasury  — BNR.Treasury.algorand, read live from the registry's own Info
// quote.amount    — microALGO
// quote.existing  — a settlement already on file that covers it, or null

const proof = await proveNameClaimPayment(payer, quote, name, network);
await adapter.claim({ …, paymentMethod: 'algorand', paymentProof: proof.txId, paymentAmount: proof.amount });
```

A receipt already in the ledger is used when it covers the quote, so a participant who
paid the treasury over x402 owes nothing further. It is refused when it underpaid, was
paid in another asset (`Payment-Amount` is denominated in microALGO — a USDC receipt
reads as a shortfall), paid someone else, or settled on another network. Otherwise
`payTreasury()` sends the quote, Rust-signed, and waits for finality.

No registry change was needed: an Algorand transaction id paying the treasury is exactly
what the existing verifier wants.

## How signing reaches Rust

The payment path calls two IPC commands:

| command | signs |
|---|---|
| `chain_algo_sign_transaction` | each Algorand transaction the payer owns, over the exact `TX`-prefixed preimage from `bytesToSign()` |
| `chain_evm_sign_transfer_authorization` | the EIP-3009 authorization, over a digest Rust builds itself from named fields |

Both live in chain packs that were present as source but **not registered** — absent from
`mod` declarations in `src-tauri/src/lib.rs` and from `generate_handler!` — so every
`chain_*` call failed with an unknown command and nothing in this module could sign.

Wiring them in needed one missing seam. The packs are written against
`VaultSession::{store_by_address, retrieve_by_address}`, which did not exist; the
committed session exposes `key()` and `dir()`, and `store::VaultStore` takes both as
arguments. `bankon_vault/mod.rs` now carries the two accessors over the *existing* store —
additive, no IPC change, no change to the on-disk format, and the encryption and manifest
stay exactly where they were:

```rust
fn unlocked(&self) -> Result<(&Path, &[u8]), String>      // both, or "vault is locked"
pub fn store_by_address(&self, chain, address, label, secret) -> Result<(), String>
pub fn retrieve_by_address(&self, address) -> Result<SecretBytes, String>
```

`retrieve_by_address` returns `SecretBytes` rather than a `Vec<u8>` so the plaintext is
wiped when the caller drops it; a `Vec` would leave it in the allocator for whatever reads
that page next. `secure_mem` was already in the tree and simply undeclared.

`chain_ar` and `chain_sol` are still unregistered. They need the same two accessors, which
now exist, so wiring them is a `mod` line and a handler list each — separate work, and not
x402's to do.

## Verification

```bash
npx tsc --noEmit && npx vitest run     # 137 tests across src/lib/x402/ and src/lib/bankon-names/
cd src-tauri && cargo test --lib       # 85 Rust tests (not `cargo test` — see todo.md)
cd src-tauri && cargo test chain_evm   # 8 EIP-712 tests, once the pack is wired in
```

`avm.test.ts` pins the group shape a facilitator verifies against — sponsor first and
unsigned, payment second and signed, fee on index 0, `paymentIndex` correct.
`client.test.ts` runs the whole loop against a stubbed resource server, including the
case where the payment settles and the resource then fails. `evm.test.ts` pins that the
authorization says what the server asked for and that unimplemented transfer methods are
refused rather than signed. `bankon-names/__tests__/pay.test.ts` pins the four ways a
receipt can fail to be proof of *this* payment. `portability.test.ts` pays end to end with
nothing but a bare `algosdk` account and an in-memory store — no Parsec, no Tauri, no
vault, no `localStorage` — and its last case reads the module's own source and fails if
the core reaches back into the application.

## References

- Spec: [algorandfoundation/x402](https://github.com/algorandfoundation/x402) —
  `specs/x402-specification-v2.md`, `specs/transports-v2/http.md`,
  `specs/schemes/exact/scheme_exact_algo.md`, `specs/extensions/bazaar.md`
- Facilitator: <https://facilitator.goplausible.xyz> (`/supported`, `/discovery/*`)
- Reference client: `@x402/avm` on npm
- Developer guide: <https://algorand.co/agentic-commerce/x402/developers>
- In-house: [x402-api.md](./x402-api.md) (API reference),
  [`src/lib/x402/README.md`](../src/lib/x402/README.md) (module entry point),
  `docs/integration/toon-naming-x402.md`, `docs/bankon-names.md`, and mindX `docs/X402.md`
