# x402 — API reference

Every export of `src/lib/x402/`, what it is for, and what it throws.

The narrative lives in [x402-integration.md](./x402-integration.md); the module's own
entry point is [`src/lib/x402/README.md`](../src/lib/x402/README.md). This page is the
surface.

> Generated against the source on 2026-09-19 and checked symbol by symbol. If something
> here does not exist, the source wins — say so and it gets fixed.

---

## The short way in — `pay.ts`

### `createX402Client(options?) → X402Client`

One object holding the signers, configured once.

```ts
interface X402ClientOptions {
  signers?: X402Signers;          // how to sign, per rail. Without these: read and quote only
  approve?: ApproveFn;            // called before anything is signed; false declines
  preferNetwork?: string;         // which offer to take when several are payable
  host?: Partial<X402Host>;       // storage, node endpoints — applied on construction
  settings?: Partial<X402Settings>;
}
```

| method | |
|---|---|
| `fetch(url, init?)` | `fetch`, except a 402 is paid. Throws on decline |
| `request(url, init?)` | the same, returning `X402PaymentResult` — transaction id and receipt |
| `probe(url, init?)` | the raw challenge, or `null` when the resource is free |
| `quote(url, init?)` | what it costs right now, priced. **Needs no signer** |
| `prepare(url, challenge, init?)` | a pending payment with nothing signed — for a custom confirmation screen |
| `pay(pending)` | sign and send a prepared payment |
| `discover(query?)` | the facilitator's catalogue. Free |
| `search(term, query?)` | the same, filtered by text. Free |
| `facilitator()` | what it can settle, and who sponsors fees |
| `receipts(url?)` | settlements recorded on this device, newest first |
| `useSigners(signers)` | swap accounts without rebuilding the client |

---

## The ports — `host.ts`

Everything that is not the protocol crosses one of these.

### Signing

```ts
interface AvmSigner {
  address: string;                 // 58-character base32
  sign: algosdk.TransactionSigner; // (txnGroup, indexesToSign) => Promise<Uint8Array[]>
}

interface EvmSigner {
  address: string;                 // 0x-hex
  signTransferAuthorization(domain: EvmDomain, auth: EvmAuthorizationFields): Promise<string>;
}

interface X402Signers { avm?: AvmSigner; evm?: EvmSigner }
```

`AvmSigner.sign` is `algosdk.TransactionSigner` exactly, so anything the Algorand
ecosystem already produces fits without an adapter. Transactions not named in
`indexesToSign` **must not be signed** — in an x402 group that is the facilitator's own.

`EvmDomain` is `{ name, version, chainId, verifyingContract }`;
`EvmAuthorizationFields` is `{ from, to, value, validAfter, validBefore, nonce }`.

| | |
|---|---|
| `signerAddress(signers, family)` | the address for a family, or `''` |

### Storage

```ts
interface X402Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
```

| | |
|---|---|
| `memoryStorage()` | in-memory implementation — an agent, a test, SSR |
| `hostStorage()` | the configured store, or `localStorage`, or memory |

Every call site wraps these, so an implementation may throw and the module degrades to
holding nothing rather than failing.

### Nodes and configuration

| | |
|---|---|
| `configureX402Host(partial)` | point the module at this host's facilities. Call once, at startup |
| `resetX402Host()` | back to defaults — for tests, and for tearing down a session |
| `hostAlgod(network)` | an `Algodv2` for a network |
| `hostEvmRpc(network)` | a JSON-RPC endpoint for an EVM network |
| `DEFAULT_ALGOD`, `DEFAULT_EVM_RPC` | the public endpoints used when nothing is configured |

---

## Adapters

### `adapters/wallets.ts` — any wallet

| | |
|---|---|
| `algorandSigner(address, sign)` | anything with an `algosdk.TransactionSigner` |
| `arc0001Signer(address, provider)` | a raw ARC-0001 `signTxns` provider — Lute, WalletConnect |
| `eip1193Signer(address, provider)` | the EVM rail over `eth_signTypedData_v4` |
| `Arc0001Provider`, `Eip1193Provider` | the two provider shapes |

`arc0001Signer` marks transactions the payer does not own with `signers: []` — ARC-0001
for *here for context, do not sign* — which is what a sponsored group needs.
`eip1193Signer` assembles the typed-data document itself, so the wallet cannot be shown
anything but an EIP-3009 authorization.

### `adapters/parsec.ts` — Parsec

| | |
|---|---|
| `parsecAvmSigner(address)` | Algorand signing via `chain_algo_sign_transaction` |
| `parsecEvmSigner(address)` | EVM signing via `chain_evm_sign_transfer_authorization` |
| `signersForAccount(account)` | every signer an account can offer |
| `payersFromAccount(account)` | addresses only, for the read-only paths |

The only file in the module that knows Parsec exists.

---

## The flow — `client.ts`

| | |
|---|---|
| `x402Request(url, init, options)` | the full flow → `X402PaymentResult` |
| `x402Fetch(url, init, options)` | the same, returning only a `Response` |
| `discoverRequirements(url, init?)` | probe for a challenge without paying |
| `preparePayment(url, challenge, options, init?)` | quote + preflight, nothing signed |
| `signPayment(pending)` | sign; nothing is sent |
| `submitPayment(pending, payment)` | send, read the settlement, write the receipt |
| `resolvePayer(network, options)` | which address pays this requirement |
| `HEADER_PAYER_HINT` | `X-Payer-Hint` — a hint, never a credential |

```ts
interface X402FetchOptions {
  signers?: X402Signers;      // preferred — a signer carries its own address
  payer?: string;             // one address, when only one rail is in play
  payers?: Partial<Record<RailFamily, string>>;
  approve?: ApproveFn;
  preferNetwork?: string;
  sendPayerHint?: boolean;    // default true
}

interface X402PaymentResult {
  success: boolean;
  txId?: string;              // the settled transaction id
  settlement?: SettlementResponse;
  receipt?: X402Receipt;
  response?: Response;
  error?: string;
}
```

`PendingX402Payment` carries `url`, `challenge`, `requirement`, `quote`, `alternatives`,
`payer`, `signers`, `preflight`, `bazaar` and `mainnet` — everything a confirmation
surface needs and nothing it must not have.

---

## The wire — `protocol.ts`

| | |
|---|---|
| `readChallenge(response, requestUrl)` | parse a 402 — v2 header first, v1 body second |
| `normalizeChallenge(raw, requestUrl)` | either version → the v2 shape |
| `normalizeRequirement(raw)` | one `accepts[]` entry, normalized |
| `buildPayment(challenge, accepted, payload)` | the payment envelope |
| `paymentHeaders(payment)` | the headers for the version the server declared |
| `readSettlement(response)` | `PAYMENT-RESPONSE` → the settled transaction id |
| `encodeEnvelope` / `decodeEnvelope` | base64 JSON, UTF-8 safe |
| `bytesToBase64` / `base64ToBytes` | chunked, so a payment group does not blow the argument limit |
| `X402_VERSION` | `2` |
| `HEADER_PAYMENT_REQUIRED` / `_SIGNATURE` / `_RESPONSE` | the v2 headers |
| `HEADER_X_PAYMENT` / `HEADER_X_PAYMENT_RESPONSE` | the v1 aliases |

Types: `ResourceInfo`, `PaymentRequirements`, `PaymentRequired`, `PaymentPayload`,
`SettlementResponse`.

**`amount` is a string on the wire and a `bigint` in memory, never a `number`.**

---

## Networks — `networks.ts`

| | |
|---|---|
| `toCaip2(network, family?)` | any alias → the canonical CAIP-2 id |
| `familyFor(network)` | `'avm' \| 'evm' \| 'svm' \| 'arweave'` |
| `sameNetwork(a, b)` | compares by prefix, so the truncated CASA form matches |
| `describeNetwork(network)` | label, family, testnet flag, explorer |
| `describeAsset(network, asset)` | symbol and decimals |
| `usdcFor(network)` | the USDC asset id for a network |
| `explorerTxUrl(network, txId)` | a link, or `''` |

Constants: `ALGORAND_MAINNET`, `ALGORAND_TESTNET`, `ALGORAND_LOCALNET`, `BASE_MAINNET`,
`BASE_SEPOLIA`, `ETHEREUM_MAINNET`, `SOLANA_MAINNET`, `SOLANA_DEVNET`, `ARWEAVE_PERMAWEB`,
`USDC_ASA_MAINNET` (31566704), `USDC_ASA_TESTNET` (10458941), `NETWORKS`, `ASSETS`.

Types: `Caip2`, `RailFamily`, `WalletNetwork`, `NetworkDescriptor`, `AssetDescriptor`.

---

## Rails — `rails.ts`

| | |
|---|---|
| `registerRail(rail)` | add a chain. The whole extension contract |
| `railFor(network)` | the rail for a network, or `null` |
| `listRails()` | every registered rail |
| `canPay(requirement)` | whether a registered rail can satisfy it |
| `selectRequirement(challenge, preferNetwork?)` | which offer to pay |
| `unpayableNetworks(challenge)` | what was offered that nothing can take |

```ts
interface X402Rail {
  family: RailFamily;
  label: string;
  schemes: string[];              // 'exact'
  networks?: Caip2[];             // omit for "any network in the family"
  buildPayload(ctx): Promise<Record<string, unknown>>;
  preflight?(ctx): Promise<X402Preflight>;
}
```

`X402PaymentContext` is `{ requirement, challenge, payer, walletNetwork, signers }`.
`X402Preflight` is `{ ok, blockers, balance? }`; an `X402Blocker` is
`{ code, message, remedy? }` with code `not-opted-in | insufficient-funds | no-account |
unsupported | other`.

### `rails/avm.ts` — Algorand

| | |
|---|---|
| `avmRail` | the rail; registered on import |
| `buildPaymentGroup(ctx)` | the atomic group and its `paymentIndex` |
| `signPaymentGroup(group, signer)` | signs only what the payer owns |
| `preflightAvm(ctx)` | balance and opt-in state |
| `isOptedIn(address, assetId, network)` | ASA opt-in check |
| `optInToAsset(signer, assetId, network)` | opt in — locks 0.1 ALGO into minimum balance |
| `sendAlgoPayment(signer, to, microAlgos, note, network)` | a plain transfer (the name claim uses this) |
| `signAndSend(signer, txn, network, waitRounds?)` | the shared sign-submit-confirm primitive |
| `walletNetworkFor(network)` | CAIP-2 → the host's network selector |

### `rails/evm.ts` — EVM

| | |
|---|---|
| `evmRail` | the rail; registered on import |
| `buildAuthorization(ctx)` | the EIP-3009 payload |
| `preflightEvm(ctx)` | token balance; **never** a gas check |
| `validityWindow(maxTimeoutSeconds, now?)` | `validAfter` backdated a minute, `validBefore` from the server |
| `chainIdOf(network)` | `eip155:8453` → `8453` |
| `randomNonce()` | 32 random bytes, single-use |
| `setEvmRpc(network, url)` | override the endpoint for one chain |

---

## Quoting, receipts, settings

### `quote.ts`

| | |
|---|---|
| `quote(requirement)` | → `X402Quote` |
| `quoteAll(requirements)` | cheapest first by USD where known |
| `decimalsFor` / `symbolFor` | the server's `extra` first, our table second |

`X402Quote` carries `amountAtomic` (a `bigint` — the number that gets signed),
`decimals`, `assetSymbol`, `networkLabel`, `amountDisplay`, `usdMicro`, `usdDisplay`,
`usdSource` (`pegged | oracle | none`) and `testnet`.

### `receipts.ts`

| | |
|---|---|
| `listReceipts()` | newest first |
| `recordReceipt(receipt)` | written the moment a settlement is decoded |
| `receiptsFor(url)` | every payment for a resource |
| `latestReceiptTo(payTo, network?)` | **the proof lookup a paid name claim makes** |
| `receiptExplorerUrl(receipt)` | a link, or `''` |
| `totals()` | per asset, for a summary row |
| `onReceipts(fn)` | subscribe; returns an unsubscribe |
| `clearReceipts()` | |

### `settings.ts`

| | default |
|---|---|
| `preferNetwork` | Algorand Testnet |
| `facilitatorUrl` | `https://facilitator.goplausible.xyz` |
| `autoApproveMicroUsd` | `0` — always ask |
| `preflight` | on |

`getX402Settings()`, `setX402Settings(partial)`, `isMainnetPreferred()`,
`DEFAULT_FACILITATOR`, `DEFAULT_X402_SETTINGS`.

---

## Facilitator and Bazaar

### `facilitator.ts`

| | |
|---|---|
| `getSupported(url?)` | what it can settle |
| `feePayerFor(supported, network)` | the sponsor address on a network |
| `probeFacilitator(url?)` | one round trip for a status row. **Never throws** |
| `verifyPayment(payment, requirements, url?)` | a dry run |
| `settlePayment(payment, requirements, url?)` | for operating a resource server — a client never calls it |

### `bazaar.ts`

| | |
|---|---|
| `listResources(query?)` | the catalogue, filtered |
| `searchResources(term, query?)` | free-text search |
| `getResource(url)` | one resource, search-then-match |
| `describePrice(resource)` | `0.25 USDC · Algorand Mainnet` |
| `bazaarInfoFrom(extensions)` | the declaration on a live challenge |

`BazaarQuery` takes `search`, `network`, `method`, `merchantId`, `limit`, `offset`,
`payableOnly` (default true), `includeTestnets` (default false), `maxAmount`.

---

## Errors

Two typed errors; everything else is an `Error` whose message names the cause.

| thrown | when | what to do |
|---|---|---|
| `X402Declined` | the `approve` callback returned false | nothing — this is the participant's answer |
| `X402Unpayable` | no registered rail can pay any offer. Carries `.networks` | register a rail, or tell the user what was offered |
| `No AVM/EVM address in this wallet to pay a <network> requirement` | no signer or address for the chosen rail's family | pass `signers` for that family |
| `no Algorand signer supplied for an Algorand requirement` (and the EVM twin) | an address was given but no signer, and signing was reached | pass a signer, not just an address |
| `Payment requires approval and no approval handler was provided` | a payment over the auto-approve cap with no `approve` | supply `approve`, or set `autoApproveMicroUsd` |
| `Payment blocked: …` | preflight found blockers and there is no `approve` to show them | clear the blocker — usually an ASA opt-in or funds |
| `asset transfer method "permit2" is not implemented` | an EVM requirement asking for Permit2 or ERC-7710 | unimplemented by design; not half-signed |
| `asset must be a token contract address, got …` | an EVM requirement whose `asset` is not 0x+40 hex | the server is misconfigured |
| `payment group has N transactions; Algorand allows 16` | a server asking for an oversized group | refuse it |
| `signer returned N signatures for M transactions` | a wallet adapter returning the wrong count | a bug in that adapter |
| `wallet did not sign transaction N` | an ARC-0001 provider returned null for a requested index | the user rejected it in the wallet |
| `asked to sign transaction N, which is not from <address>` | a rail offered a transaction the signer does not own | a bug — report it |
| `no algod endpoint for <caip2>` | a network with no default and none configured | `configureX402Host({ algod })` |
| `no RPC configured for <network>` | same, for EVM | `configureX402Host({ evmRpc })` or `setEvmRpc` |
| `unsupported x402 network <n>` | a CAIP-2 namespace with no rail family | expected for an exotic chain |
| `vault is locked` | **Parsec only** — signing was reached with no unlocked vault | unlock first; the signer cannot prompt |

A facilitator or Bazaar HTTP failure throws with the status and URL.
`probeFacilitator()` is the exception: it returns `{ reachable: false, error }`, because a
status row must not take a view down.

---

## Troubleshooting

**The payment settled but the resource returned an error.** Two different facts. The
receipt is written anyway with `delivered: false` — the transaction id is real and the
money moved. Take it up with the resource server.

**`not-opted-in` on a USDC payment.** Algorand rejects a transfer of an asset the account
has never opted in to; it is not a funds problem. The blocker carries a `remedy` that
runs the opt-in, and the x402 Desk offers it. It locks 0.1 ALGO into the account's
minimum balance for as long as the holding exists.

**An EVM payment with no ETH in the account.** Correct and expected. EIP-3009 means the
facilitator pays the gas; preflight deliberately never checks for it.

**Preflight says it could not read the balance.** A public RPC declined. That is reported
as a blocker of code `other` but does **not** stop the payment — refusing on the strength
of a rate-limited endpoint would be worse.

**The catalogue price and the live price differ.** Working as intended. A catalogue entry
is what the facilitator indexed after somebody last paid; the live 402 is the quote, and
it is the only thing ever paid against.

**A server keeps answering 402 after payment.** Check the facilitator actually settled —
`x402.facilitator()` shows what it can settle and who sponsors fees on each network. A
`PAYMENT-RESPONSE` with `success: false` carries `errorReason`.

**Nothing is payable and the server offered plenty.** `X402Unpayable.networks` names
them. Usually a Solana-only or exotic-chain resource; those rail slots are empty.
