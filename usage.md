# Usage

Both halves. The payer module's fuller recipe collection is in
[`payer/src/x402/usage.md`](payer/src/x402/usage.md).

## Install

```bash
# payer
cd payer && npm install

# seller
cd seller && pip install -e ".[test]"
```

## Pay for something

```ts
import { createX402Client, algorandSigner } from './payer/src/x402';

const x402 = createX402Client({
  signers: { avm: algorandSigner(address, transactionSigner) },
  approve: async (p) => confirm(`Pay ${p.quote.amountDisplay} ${p.quote.assetSymbol}?`),
});

const res = await x402.fetch('https://api.example.com/weather');
```

A free resource passes straight through — `fetch` semantics are unchanged until a 402
arrives. Use `x402.request(url)` instead when you want the transaction id and receipt
rather than just the body.

## Look before you buy — no key required

```ts
const x402 = createX402Client();                      // no signers at all

await x402.quote('https://api.example.com/weather');  // what it costs, null if free
await x402.discover({ maxAmount: 10_000n });          // the Bazaar, ≤ 0.01 USDC
await x402.facilitator();                             // what can settle, who sponsors fees
```

## Connect a wallet

| your wallet exposes | use |
|---|---|
| `algosdk.TransactionSigner` (use-wallet, AlgoKit, Pera, Defly) | `algorandSigner(address, signer)` |
| ARC-0001 `signTxns` (Lute, WalletConnect) | `arc0001Signer(address, provider)` |
| EIP-1193 `request` (MetaMask, Rabby) | `eip1193Signer(address, provider)` |

```ts
const { activeAddress, transactionSigner } = useWallet();
createX402Client({ signers: { avm: algorandSigner(activeAddress, transactionSigner) } });
```

## Run unattended

```ts
import { createX402Client, memoryStorage, algorandSigner } from './payer/src/x402';

const x402 = createX402Client({
  signers: { avm: algorandSigner(addr, signer) },
  approve: async (p) =>
    !p.mainnet ||
    (p.quote.usdMicro !== null && p.quote.usdMicro <= 50_000n && TRUSTED.has(p.requirement.payTo)),
  host: { storage: memoryStorage(), algod: () => myAlgodClient },
});
```

For an agent, **`approve` is the policy**. Returning `true` unconditionally means paying
whatever any server asks, including one reached through a redirect. Bound it by price, by
network, by payee. Or set a standing cap and omit it:

```ts
createX402Client({ signers, settings: { autoApproveMicroUsd: 50_000 } });   // ≤ $0.05
```

Without either, every payment is refused. That is deliberate.

## Sell something

```python
from fastapi import Depends, FastAPI
from mindx_backend_service.x402_middleware import x402_required

app = FastAPI()

@app.post("/weather", dependencies=[Depends(x402_required("/weather"))])
async def weather():
    return {"weather": "foggy"}
```

Price it in `data/config/x402_pricing.json`:

```json
{
  "endpoints": {
    "/weather": {
      "max_amount_microusd": 1000,
      "description": "Current conditions",
      "discovery": { "method": "POST", "body": {"city": "SF"}, "output": {"weather": "foggy"} }
    }
  },
  "discovery": { "base_url": "https://api.example.com", "tag": "x402-global-challenge" },
  "rails": {
    "algorand-mainnet": {
      "scheme": "exact",
      "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
      "asset": "31566704",
      "payTo": "<your 58-char address, opted in to USDC>",
      "extra": { "decimals": 6, "facilitator": "https://facilitator.goplausible.xyz" }
    }
  }
}
```

`extra.feePayer` is resolved from the facilitator's `/supported` when you leave it unset —
that is what makes the payment gasless for your buyers.

**Your `payTo` must be opted in to the asset.** On Algorand a transfer to an account that
has never opted in is rejected by the protocol, so without it nothing can ever settle.

## Discover what is for sale

```python
from tools.x402_bazaar import BazaarDirectory

bazaar = BazaarDirectory()
for r in bazaar.list(max_usd=0.05, limit=20):
    print(r.method, r.url, r.cheapest.usd, r.settle_count)

bazaar.quote("https://www.agent-mesh.app/api/x402/relay")   # the live price, not the catalogue's
```

Free, and it holds no key.

## Tests

```bash
cd payer  && npx tsc --noEmit && npx vitest run    # 131 tests, 0 type errors
cd seller && python -m pytest                      # 52 passed, 1 skipped
```

`payer/src/x402/__tests__/portability.test.ts` pays end to end with a bare `algosdk`
account and an in-memory store, then reads the module's own source and fails if anything
in it reaches outside the module.

## When something looks wrong

- **A settled payment whose resource then failed** is two facts. The receipt is written
  with `delivered: false`; the money moved.
- **An EVM payment from an account with no ETH** is correct — the facilitator pays gas.
- **A catalogue price differing from the live quote** is working as intended.
- **`not-opted-in` on Algorand** is not a funds problem; the blocker carries a remedy.
