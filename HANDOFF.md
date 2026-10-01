# x402 — operator status

Updated 2026-09-30. What is live, what is not yet, and who has to do the rest.

## Where things stand

| | |
|---|---|
| Payer module, three rails (Algorand, EVM, Solana) | **done** — `payer/src/x402/` |
| Seller middleware (402 challenge, verify, settle, Bazaar) | **done** — `seller/mindx_backend_service/` |
| `https://mindx.pythai.net/names/*` answers a correct 402 | **live** since 2026-09-30 |
| PARSEC registers a `.algo` name by paying the service fee over x402 | **done** in PARSEC (`.algo Names`) |
| The receiving `payTo` opted in to USDC (ASA `31566704`) | **in progress** — moving to a new account |
| One real mainnet settlement | follows the opt-in |

### Live, 2026-09-30

```
POST https://mindx.pythai.net/names/algo    → 402, PAYMENT-REQUIRED header
  resource   https://mindx.pythai.net/names/algo   (absolute)
  rails      Algorand mainnet  USDC 31566704  0.50   feePayer from GoPlausible
             Algorand testnet  USDC 10458941  0.50
             Base              USDC            0.50
  extensions bazaar
GET  https://mindx.pythai.net/names/reservations/{tx}   → free lookup
```

The three things that had to change on the live app, now deployed:

1. **The error handler passes a 402 through intact.** It used to rebuild every error as
   `{"detail": …}` and drop the response headers, so a challenge reached the payer with
   no `PAYMENT-REQUIRED` header and its body nested one level down — nothing to pay.
   Browsers were given an HTML error page instead of the challenge.
2. **The access gate lets priced routes through to the paywall.** A route behind the
   login gate answers 401, which an autonomous caller cannot act on; the paywall's 402
   says *the price, the asset, the address, the network*, which it can.
3. **The name routes exist on the app that is actually deployed.**

## Changing the `payTo`

The pricing file reloads when its modification time moves — no restart. To move the
receiving address:

1. Opt the new address in to USDC `31566704` (an `axfer` to an account that has not
   opted in is rejected by the protocol, so nothing can settle until this is done):

   ```bash
   X402_PAYTO=<address> python3 seller/usdc_optin.py
   ```

   The script derives the address from the phrase you type and refuses to sign unless it
   matches. The phrase is never an argument and never leaves the machine.

2. Set it on both Algorand rails in `data/config/x402_pricing.json`, replace the file on
   the host, and `touch` it — a copy that preserves an older timestamp is not reloaded.

3. Check the live challenge names the new address:

   ```bash
   curl -si -X POST https://mindx.pythai.net/names/algo \
     -H 'content-type: application/json' -d '{"name":"x.algo"}' | grep -i payment-required
   ```

Keep one `payTo` per domain, and keep it once payments have settled to it: the
facilitator's catalogue keys a merchant by that address.

## Then: one real payment

Pay one endpoint on **mainnet** from PARSEC (`.algo Names` → Review & register → Pay &
register, or the x402 desk) or any wallet. The paid response carries the settlement
transaction id; the USDC lands in the `payTo`; the facilitator lists the endpoint in its
catalogue after the first settlement.

## Where everything is

| | |
|---|---|
| Payer module | `payer/src/x402/` (mirrored from PARSEC) |
| Seller middleware | `seller/mindx_backend_service/` |
| Prices and rails | mindX `data/config/x402_pricing.json` |
| Opt-in tool | [`seller/usdc_optin.py`](seller/usdc_optin.py) |
| Protocol, all three schemes, embedding | [`docs/x402-integration.md`](docs/x402-integration.md) |
| Every export, every error | [`docs/x402-api.md`](docs/x402-api.md) |
| Goal, plan, what is open | [`payer/src/x402/todo.md`](payer/src/x402/todo.md) |

## Known debts, stated rather than buried

- **Nothing here has moved real value on any mainnet yet.** Everything is verified
  against stubs, testnet shapes and live *read* endpoints. That is not the same as having
  settled; the first mainnet settlement is the next step.
- The `arweave` rail slot is empty and may stay so: it is a fulfilment leg with no
  settlement chain.
- Credential hygiene findings in the private trees are recorded in mindX's own copy of
  this document, not here.
