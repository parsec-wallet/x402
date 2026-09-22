# x402 — what is left

## The goal

> **A participant — human or agent — can pay for an HTTP resource from any wallet, and
> keep proof they did.**

## The plan, and where it stands

| # | step | state |
|---|---|---|
| 1 | Speak the published protocol — v2 headers, v1 read, exact amounts | **done** |
| 2 | Pay on Algorand — `exact`, sponsored group, USDC ASA or ALGO | **done** |
| 3 | Keep the proof — read `PAYMENT-RESPONSE`, write a receipt | **done** |
| 4 | Make chains pluggable — a rail registry, not a branch | **done** |
| 5 | Pay on a second chain, proving 4 — EVM via EIP-3009 | **done** |
| 6 | Work in any wallet — ports, adapters, no host imports in the core | **done** |
| 7 | Make it easy — one client object, free reads, no key to quote | **done** |
| 8 | Spend the proof on something — paid BANKON name claim | **done** |
| 9 | Reach the whole market — Solana, and a memo/receipt extension | **open** |
| 10 | Prove it on mainnet — a real settlement, end to end | **open** |

Steps 1–8 are in `matrix-entry`. What follows is 9 and 10, and the smaller debts.

---

## Open

### A Solana rail — step 9

The last namespace with real volume behind it. A Solana requirement is currently reported
unpayable by name, which is honest and not much use.

The scheme is client-driven and differs from both existing rails: build a **versioned
transaction** containing an SPL transfer to `payTo`, sign it **partially** (the facilitator
adds the `feePayer` signature at settle), base64 the serialised result into
`payload.transaction`. `extra.memo`, when present, must be used verbatim as the Memo
instruction rather than a random nonce.

What it needs that we do not have:

- SPL `transferChecked` instruction encoding
- Associated Token Account derivation — a PDA, so ed25519 curve checks and sha256
- a Memo instruction
- v0 message serialisation with the fee payer as first signer, and partial signing

`src/lib/solana/transfer.ts` hand-rolls System Program SOL transfers only. `@solana/kit`
is already a dependency and makes this tractable. Estimate: a focused session, not an
afternoon — a mis-derived ATA sends money to an address nobody controls, so it wants its
own tests against known vectors before it goes near a payment button.

### A mainnet settlement — step 10

Everything is verified against stubs, testnet shapes and a live facilitator's `/supported`
and `/discovery`. Nothing in this module has yet moved real USDC.

Needs: the payer account opted in to ASA `31566704`, funded, and one real payment through
a mainnet resource. Until that happens the module is *believed* to work end to end.

This is also what the [x402 Global Challenge](../../../docs/x402-integration.md#the-x402-global-challenge)
scores — real mainnet settlements, not code.

---

## Debts

### Rust

- **`bankon_vault/commands_v2.rs` is not registered** — 18 commands, the `bankon-vault/2`
  session format. This is the genuine v2 work: a second format, not a missing accessor.
  It is why `generate_handler!` holds 102 commands and not the 122 once cited.
- **`src-tauri/examples/connect_harness.rs` does not compile.** It imports
  `parsec_wallet_lib::parsec_connect`, which `lib.rs` declares private, so `cargo test`
  fails on the example before reaching the library. Use `cargo test --lib`. Pre-existing.

### TypeScript

- **58 `tsc` errors, none in this module.** All in untracked views reaching for unlanded
  library work — `brandLogo` from `lib/dom`, `vaultMigrate` from `lib/vault`, `changeFor`
  from `lib/prices`, `Store.back`. The tree does not build; `npx vite build` fails on the
  first of them.
- **One unexplained full-suite flake.** A single run reported 5 failures across 3 files;
  thirteen subsequent runs were stable at the 3 pre-existing `prices-derived` failures,
  and the x402 suite passed five times running (137/137 today). Cause unknown. Not reproduced.

### Module

- **`bridge.ts` is legacy.** A vault-held algosdk signer, still used by the AORC minters,
  not on the payment path. It retrieves a mnemonic into the renderer, which the rest of
  the module no longer does. Migrating AORC to `parsecAvmSigner` would let it go.
- **`X402Signers` declares `svm`/`arweave` as `never`.** Deliberate — they type-error at
  the call site rather than accepting a signer nothing will read — but it will need to
  change the moment step 9 lands.
- **The EVM rail has no mainnet exercise either**, and its RPC defaults are public
  endpoints that rate-limit. A host in production should configure its own.

---

## Not planned

Recording these so they are not rediscovered as gaps.

- **`permit2` and `erc-7710` on EVM.** `eip3009` covers USDC, which is what the rail is
  for. Permit2 needs a prior on-chain approval, breaking the gasless property that makes
  this worth having.
- **Settling our own payments.** The client builds and signs; the resource server settles.
  See [`technical.md`](./technical.md#4-verification-and-settlement-are-the-resource-servers-calls-not-ours).
- **A receipt ledger of record.** Receipts are a per-device record for the participant.
  The chain is the ledger.
