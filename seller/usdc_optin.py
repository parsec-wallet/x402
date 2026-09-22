#!/usr/bin/env python3
# Opt an Algorand account in to an asset — for the x402 treasury and USDC.
#
# Why this exists: a transfer of an ASA to an account that has never opted in is
# rejected by the protocol. Until the x402 payTo address is opted in to USDC, no
# payment can settle to it, and the failure does not read as a configuration problem.
#
# The key never leaves your machine and is never passed as an argument — arguments land
# in shell history and process listings. Set it in the environment for one command, or
# let the script prompt for it.
#
#     ALGO_MNEMONIC="word1 word2 … word25" python3 scripts/usdc_optin.py
#
# The script refuses to sign unless the mnemonic derives to the address it expects, so a
# wrong phrase costs nothing.
#
# SPDX-FileCopyrightText: 2026 BANKON
# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import getpass
import json
import os
import sys
import urllib.request

ALGOD = os.environ.get("ALGOD_URL", "https://mainnet-api.algonode.cloud")
INDEXER = os.environ.get("INDEXER_URL", "https://mainnet-idx.algonode.cloud")
USDC_MAINNET = 31566704
MIN_BALANCE_PER_ASSET = 100_000  # microALGO the protocol locks per holding


def expected_address() -> str:
    """The payTo this repository advertises — the account that must be opted in."""
    try:
        cfg = json.load(open(os.path.join(os.path.dirname(__file__), "..", "data", "config", "x402_pricing.json")))
        return cfg["rails"]["algorand-mainnet"]["payTo"]
    except Exception:
        return os.environ.get("X402_PAYTO", "")


def get(url: str):
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.loads(r.read())


def main() -> int:
    want = os.environ.get("X402_PAYTO") or expected_address()
    asset = int(os.environ.get("ASSET_ID", USDC_MAINNET))
    if not want:
        print("No expected address. Set X402_PAYTO, or run from a checkout with data/config/x402_pricing.json.")
        return 2

    try:
        from algosdk import account, mnemonic, transaction
        from algosdk.v2client import algod
    except ImportError:
        print("py-algorand-sdk is not installed:  pip install py-algorand-sdk")
        return 2

    phrase = os.environ.get("ALGO_MNEMONIC") or getpass.getpass("25-word Algorand mnemonic (hidden): ")
    phrase = " ".join(phrase.split())
    if len(phrase.split()) != 25:
        print(f"Expected 25 words, got {len(phrase.split())}.")
        return 2

    try:
        sk = mnemonic.to_private_key(phrase)
    except Exception as exc:
        print(f"Not a valid Algorand mnemonic: {exc}")
        return 2
    addr = account.address_from_private_key(sk)

    # Refuse before signing, not after. A wrong phrase should cost nothing.
    if addr != want:
        print(f"That phrase derives {addr}")
        print(f"but the payTo this repository advertises is {want}.")
        print("Refusing to sign. Nothing was sent.")
        return 1

    info = get(f"{INDEXER}/v2/accounts/{addr}")["account"]
    already = any(a.get("asset-id") == asset for a in info.get("assets", []))
    if already:
        print(f"{addr} is already opted in to asset {asset}. Nothing to do.")
        return 0

    balance = info["amount"]
    need = info.get("min-balance", 100_000) + MIN_BALANCE_PER_ASSET + 1_000
    print()
    print(f"  account      {addr}")
    print(f"  asset        {asset}  (USDC on mainnet)" if asset == USDC_MAINNET else f"  asset        {asset}")
    print(f"  balance      {balance / 1e6:.6f} ALGO")
    print(f"  this locks   0.1 ALGO into the minimum balance, for as long as the holding exists")
    print(f"  fee          0.001 ALGO")
    print()
    if balance < need:
        print(f"Balance is below the {need / 1e6:.6f} ALGO this needs. Fund the account first.")
        return 1

    if input("Type the word 'optin' to sign and send on MAINNET: ").strip() != "optin":
        print("Nothing was sent.")
        return 1

    client = algod.AlgodClient("", ALGOD)
    params = client.suggested_params()
    # A zero-amount transfer to oneself is the opt-in.
    txn = transaction.AssetTransferTxn(sender=addr, sp=params, receiver=addr, amt=0, index=asset)
    txid = client.send_transaction(txn.sign(sk))
    print(f"\n  submitted    {txid}")
    result = transaction.wait_for_confirmation(client, txid, 6)
    print(f"  confirmed    round {result.get('confirmed-round')}")
    print(f"  explorer     https://allo.info/tx/{txid}")
    print("\nThe payTo can now receive USDC. x402 payments to it will settle.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
