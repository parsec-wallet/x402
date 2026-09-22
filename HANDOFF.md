# x402 — handoff

**For the wallet owner. Everything below is blocked on something only you hold.**

Written 2026-09-21. The x402 Global Challenge closes **30 September** — nine days.

---

## Where things stand

| | |
|---|---|
| Payer module, three rails (Algorand, EVM, Solana) | **done**, 155 tests |
| Public repository (challenge eligibility) | **done** — [parsec-wallet/x402](https://github.com/parsec-wallet/x402) |
| Seller middleware answers 402, not 401 | **done in the repo**, *not deployed* |
| Three name products priced with Bazaar declarations | **done in the repo**, *not deployed* |
| `payTo` opted in to USDC | **blocked — needs your key** |
| One real mainnet settlement | blocked by the two above |
| Submission form + Electric Capital | not done |

Two things stand between this and a ranked entry, and neither is code.

---

## 1. Opt the treasury in to USDC — 2 minutes

**Why it is not optional.** An `axfer` to an account that has never opted in is rejected
by the Algorand protocol. Until this is done, **no x402 payment can ever settle to that
address**, and the failure does not read as a configuration problem. The challenge also
requires it explicitly.

The account is funded — 11.53 ALGO — so this is a signature, not a purchase.

```
account   L24WEG3KK6QDSQGQGXCJIYR46HHDFK5IJ7HOZF3YDDTHTREGYPDWY74KG4
asset     31566704  (USDC, mainnet)
costs     0.001 ALGO fee, and locks 0.1 ALGO into the minimum balance
```

### Run it

```bash
pip install py-algorand-sdk                  # if needed
python3 seller/usdc_optin.py                 # prompts for the phrase, hidden
```

The script **derives the address first and refuses to sign unless it matches** that payTo,
so a wrong phrase costs nothing. It prints what it will do and waits for you to type
`optin`. The key is never an argument — arguments land in shell history and process
listings — and never leaves your machine.

Verify afterwards:

```bash
curl -s "https://mainnet-idx.algonode.cloud/v2/accounts/L24WEG3KK6QDSQGQGXCJIYR46HHDFK5IJ7HOZF3YDDTHTREGYPDWY74KG4/assets?asset-id=31566704"
# "assets":[{…}]  — not the "assets":[] it returns today
```

### If you do not hold that key

Then pick an address you do hold, opt *it* in, and change one line:

```jsonc
// data/config/x402_pricing.json → rails → algorand-mainnet
"payTo": "<your 58-char address, opted in to USDC>"
```

Nothing else changes. `X402_PAYTO=<address> python3 scripts/usdc_optin.py` will opt in
whichever address you name.

**What I found while looking:** `~/.bankon/vault` is empty, no local env file holds a
phrase deriving to that address, and mindX's own identity snapshot already records
`"not_verified": ["possession of the private key…"]` for it. So I could not do this, and
nobody should assume the key is on this machine.

---

## 2. Deploy the 402 change — the endpoint still answers 401

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  https://mindx.pythai.net/coordinator/query
# 401 today. Must be 402.
```

The deployed host runs `main_service_production.py`, which gated on
`require_valid_session` and never imported the paywall. That is fixed in the repository
(`priced()` — a session opens the route, or a payment does) but **the VPS has not taken
the change**. Pull and restart on the host.

The challenge requires 402 when called without payment, and it is right to: 401 says
*authenticate and come back*, which an autonomous caller cannot act on — there is nobody
to log in. 402 says *here is the price, the asset, the address and the network*.

Once deployed, these should all answer 402:

```
POST /coordinator/query        $0.002
POST /names/arns/undername     $5.00   a permanent undername under a BANKON base name
POST /names/algo               $0.50   a .algo NFD registered to your Algorand address
POST /names/algo/segment       $0.25   a subdomain under mindx.algo
```

Each carries mainnet USDC (ASA 31566704), the GoPlausible fee payer, the
`x402-global-challenge` tag and a `bazaar` declaration — verified by building the
envelope from the config, not by reading the code.

---

## 3. Then: one real payment, and submit

With 1 and 2 done, the loop closes:

1. Pay one of your own endpoints from Parsec (or any wallet) on **mainnet**
2. That settlement puts you in the facilitator's Bazaar catalogue automatically
3. Submit the form, and the repository to Electric Capital, before 30 September

Use `parsec-wallet/x402` as the submitted repository — it is public, Apache-2.0, and
contains both halves with no history from any private tree.

---

## What kind of entry this is

The leaderboard measures **USDC settled *to* your endpoint**. A wallet that pays scores
nothing on a Standard or Composite entry, however good it is.

**Orchestrator** is the category that counts a payer: *client-facing endpoint payments
plus downstream payments both attributed to the leaderboard total*. It requires you to
expose your own paid endpoint and settle the client's payment before paying downstream —
which is exactly the shape already built. mindX sells; the Parsec module buys.

For context on the field: 2,150 resources catalogued, top settlement counts 5073 / 2120 /
452, **median 14**, and no entry in the sample with zero. One settlement gets you ranked.
Winning on volume means outrunning teams live for weeks — but the ten Devcon finalists are
chosen from submissions, which is where a differentiated build competes.

---

## Where everything is

| | |
|---|---|
| Public repo (submit this) | https://github.com/parsec-wallet/x402 |
| Payer module | `payer/src/x402/` (mirrored from Parsec) |
| Seller middleware | `seller/mindx_backend_service/` |
| Prices and rails | mindX `data/config/x402_pricing.json` |
| Opt-in tool | `seller/usdc_optin.py` (also `mindX/scripts/usdc_optin.py`) |
| Protocol, all three schemes, embedding | `docs/x402-integration.md` |
| Every export, every error | `docs/x402-api.md` |
| Goal, plan, what is open | `payer/src/x402/todo.md` |

## Known debts, stated rather than buried

- **Nothing here has moved real value on any mainnet.** Everything is verified against
  stubs, testnet shapes, live *read* endpoints, and — for the Solana associated-token
  derivation — two addresses read back from mainnet. That is not the same as having
  settled.
- The `arweave` rail slot is empty and may stay so: it is a fulfilment leg with no
  settlement chain.
- Credential hygiene findings in the private trees are recorded in mindX's own copy of
  this document, not here.
