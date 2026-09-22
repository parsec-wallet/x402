# What x402 is, and why it is shaped like this

For a reader who has not met the protocol. [`technical.md`](technical.md) is the design;
[`usage.md`](usage.md) is the recipes; this is the idea.

## The problem it solves

Paying for an API today means becoming a customer first. You sign up, you get a key, you
put a card on file, and from then on the provider knows who you are and bills you later.
That arrangement is fine for a company with a procurement department. It is unworkable for
a program.

An agent that wants one weather reading cannot open an account. It cannot pass KYC, hold a
card, or remember a password. And the provider cannot price a single reading at a
thousandth of a cent, because the payment rail charges thirty cents to move any money at
all. So the whole long tail of tiny, one-off, machine-to-machine purchases simply does not
happen — not because nobody wants it, but because the plumbing costs more than the goods.

## The idea

`402 Payment Required` has been in the HTTP specification since 1997, reserved and unused.
x402 finally gives it a meaning.

```
GET /weather                    →  402 Payment Required
                                   here is the price, the asset, the address, the network
GET /weather + a signed payment →  200 OK
```

Three things follow from that, and they are the whole point:

**No account.** The server never learns who you are. It learns that it was paid. A payment
is a bearer proof — it authenticates by existing, the way a coin in a vending machine
does. There is nothing to sign up for, nothing to revoke, and nothing to leak.

**No minimum.** Settlement is a stablecoin transfer on a chain with sub-cent fees, so a
tenth of a cent is a sensible price. Prices can finally match what a single API call is
actually worth.

**No relationship.** Buyer and seller need never meet again. That is what makes it a rail
for agents: one with a key can buy something it has never seen from a seller it will never
deal with twice.

## How a payment happens

```
   client                    resource server           facilitator          chain
     │  GET /weather              │                          │                │
     │ ─────────────────────────► │                          │                │
     │  402 + what it will accept │                          │                │
     │ ◄───────────────────────── │                          │                │
     │  sign a payment            │                          │                │
     │  GET + the signature       │                          │                │
     │ ─────────────────────────► │  verify ───────────────► │  simulate ───► │
     │                            │  settle ───────────────► │  submit ─────► │
     │  200 + the transaction id  │ ◄─────────────────────── │ ◄──────────────│
     │ ◄───────────────────────── │                          │                │
```

The **facilitator** is the piece that makes this practical. It verifies the payment is
well-formed, submits it, and — the part that matters most — **pays the network fee**. The
buyer needs only the asset they are spending. No gas token, no separate balance to
top up, no reason to hold a second coin just to move the first.

What the facilitator cannot do is redirect the money. The recipient and the amount are
inside what the buyer signed. It can refuse to broadcast; it cannot change where the
payment goes. That asymmetry is why the arrangement is safe to use with a stranger.

## Why each chain works differently

The protocol is one idea with a different implementation per chain, because "a signed
payment you cannot alter" means different things in different places.

**Algorand** has atomic transaction groups: a set of transactions that all succeed or all
fail. The payment is a group of two — the facilitator's fee-paying transaction, and the
buyer's transfer. The buyer signs only their own. The facilitator signs its own at
settlement. Neither can do anything with half a group.

**EVM** has EIP-3009, a standard where a token accepts a signed authorization to move a
specific amount to a specific address within a time window. The buyer signs the
authorization; anyone can submit it and pay the gas. The token itself enforces that the
authorization is used once.

**Solana** does something subtler. The payer builds a whole transaction, names the
facilitator as the one who pays its fee, and signs only their own part. The result is a
transaction that *cannot run* — a signature is missing. The facilitator adds it and
submits, or nothing happens at all. It cannot alter the transaction, because changing any
byte would invalidate the signature already on it.

Three mechanisms, same guarantee: **the payer names the recipient and the amount, and
nobody downstream can change either.**

## Why a wallet module rather than a library call

The buying side needs a key, and keys live in wallets. Everything here is built so that
the wallet keeps its key and this code never sees it: a signer is passed in, and the module
asks it to sign a transaction it has built and can show you.

On Algorand that signer is `algosdk.TransactionSigner` — the type the whole ecosystem
already uses — so a wallet that can sign anything can sign this, with no adapter. On
Parsec, the signer is backed by Rust holding the seed; a browser wallet passes its own.
The module cannot tell them apart, which is the property that lets it live in any wallet
at all.

## Discovery, and why it is free

A market needs a way to find what is for sale. Facilitators keep a catalogue — the
**Bazaar** — of endpoints that have settled payments through them, including what each one
takes and returns.

Browsing it costs nothing, and so does asking an endpoint its price. That is deliberate. An
agent that had to pay to discover a price could not reason about value: it would be
spending to find out whether spending was worthwhile. Reading is free; only the goods cost
money.

One consequence worth stating plainly: a catalogued price is a *memory* of what something
cost when it was last bought. The price you pay is read live from the endpoint at the
moment you pay. Those are different numbers and this module never confuses them.

## What can still go wrong

Being honest about the failure modes is more useful than a feature list.

**The payment settles and the resource fails.** These are two facts, not one. The money
moved; the goods did not arrive. This module records the transaction id either way, because
losing it would leave you having paid with nothing to show.

**The price changes between quote and payment.** You re-quote. A proof of payment that no
longer covers the asking price is not payment for that thing any more.

**A facilitator refuses to broadcast.** It cannot steal — it can only decline. You pay
through a different one, or the endpoint names another.

**You have no asset to pay with.** On Algorand there is a wrinkle worth knowing: an
account must *opt in* to a token before it can hold it. A payment from an account that has
never opted in to USDC fails at the protocol level, and it does not look like a funds
problem. This module checks before signing and offers to fix it.
