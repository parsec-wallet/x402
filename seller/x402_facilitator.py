# Copyright 2026 BANKON. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

"""x402 facilitator client — the shape the published facilitators actually speak.

A facilitator does three things for a resource server:

* ``GET /supported`` — what it can settle, and which address sponsors fees on each
  network. On Algorand that address is the whole point: without it a client cannot
  build a fee-abstracted group, and the payer must hold ALGO as well as USDC.
* ``POST /verify`` — is this payment well-formed and would it succeed? For AVM this
  simulates the atomic group against a node. **Verification is not settlement.**
* ``POST /settle`` — sign the fee payer, submit the group, return the transaction id.

Both POSTs take ``{x402Version, paymentPayload, paymentRequirements}`` and return
``{isValid, …}`` / ``{success, transaction, network, payer, …}`` respectively
(``typescript/packages/core/src/types/facilitator.ts`` in algorandfoundation/x402).

mindX previously posted a bespoke body to ``/verify`` (``{scheme, network, payload,
endpoint, max_amount_microusd}``) and read ``{verified, txHash}``, and never called
``/settle`` at all — so against a published facilitator nothing verified and nothing
ever reached a chain. Both shapes are handled here: the spec one is sent first, and a
facilitator that answers in the legacy shape is still understood, so a self-hosted
one keeps working while the hosted ones start to.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Mapping, Optional, Tuple

from mindx_backend_service import x402_protocol as xp

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 20.0
SUPPORTED_TTL_SECONDS = 900.0

# url → (fetched_at, payload)
_supported_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}


def _client():
    import httpx

    return httpx.Client(timeout=TIMEOUT_SECONDS)


# ── /supported ───────────────────────────────────────────────────────────────


def supported(url: str, *, force: bool = False) -> Dict[str, Any]:
    """Cached ``GET /supported``. Returns ``{}`` when the facilitator is unreachable.

    Unreachable is not an error here: a 402 challenge is still worth serving without
    a sponsor, it just costs the payer their own fee.
    """
    base = url.rstrip("/")
    now = time.time()
    cached = _supported_cache.get(base)
    if cached and not force and (now - cached[0]) < SUPPORTED_TTL_SECONDS:
        return cached[1]
    try:
        with _client() as client:
            resp = client.get(base + "/supported", headers={"Accept": "application/json"})
        payload = resp.json() if resp.status_code == 200 else {}
    except Exception as exc:  # network, DNS, TLS, bad JSON — all the same to a caller
        logger.debug("x402 facilitator /supported failed for %s: %s", base, exc)
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    _supported_cache[base] = (now, payload)
    return payload


def kinds(url: str) -> List[Dict[str, Any]]:
    payload = supported(url)
    raw = payload.get("kinds")
    return [k for k in raw if isinstance(k, Mapping)] if isinstance(raw, list) else []


def fee_payer_for(url: str, network: str) -> Optional[str]:
    """The address this facilitator sponsors fees with on ``network``.

    Checks the matching ``kinds[].extra.feePayer`` first, then falls back to the
    namespace signer in ``signers`` (``"algorand:*"``), which is the same account.
    """
    caip2 = xp.to_caip2(network)
    for kind in kinds(url):
        if xp.to_caip2(str(kind.get("network", ""))) != caip2:
            continue
        extra = kind.get("extra")
        if isinstance(extra, Mapping) and extra.get("feePayer"):
            return str(extra["feePayer"])
    signers = supported(url).get("signers")
    if isinstance(signers, Mapping):
        namespace = caip2.split(":", 1)[0]
        entry = signers.get(f"{namespace}:*")
        if isinstance(entry, list) and entry:
            return str(entry[0])
    return None


def settles(url: str, network: str, scheme: str = "exact") -> bool:
    """Whether the facilitator declares it can settle this scheme on this network."""
    caip2 = xp.to_caip2(network)
    return any(
        xp.to_caip2(str(k.get("network", ""))) == caip2 and str(k.get("scheme", "")) == scheme
        for k in kinds(url)
    )


def extensions(url: str) -> List[str]:
    raw = supported(url).get("extensions")
    return [str(e) for e in raw] if isinstance(raw, list) else []


# ── /verify and /settle ──────────────────────────────────────────────────────


class FacilitatorError(RuntimeError):
    """The facilitator could not be reached, or answered in a shape we cannot read."""


def _post(url: str, path: str, body: Mapping[str, Any]) -> Dict[str, Any]:
    try:
        with _client() as client:
            resp = client.post(url.rstrip("/") + path, json=dict(body))
    except Exception as exc:
        raise FacilitatorError(f"{path} unreachable: {exc}") from exc
    if resp.status_code not in (200, 400, 402):
        raise FacilitatorError(f"{path} returned {resp.status_code}: {resp.text[:512]}")
    try:
        parsed = resp.json()
    except Exception as exc:
        raise FacilitatorError(f"{path} returned non-JSON: {resp.text[:256]}") from exc
    if not isinstance(parsed, dict):
        raise FacilitatorError(f"{path} returned {type(parsed).__name__}, expected an object")
    return parsed


def _request_body(payment: Mapping[str, Any], requirements: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "x402Version": int(payment.get("x402Version") or xp.X402_VERSION),
        "paymentPayload": dict(payment),
        "paymentRequirements": dict(requirements),
    }


def verify(
    url: str, payment: Mapping[str, Any], requirements: Mapping[str, Any], **legacy: Any
) -> Dict[str, Any]:
    """``POST /verify``. Returns ``{"isValid": bool, "invalidReason": str, "payer": str}``.

    ``legacy`` carries the fields an in-house facilitator wants (``endpoint``,
    ``max_amount_microusd``); they are sent alongside and ignored by a spec one.
    """
    body = _request_body(payment, requirements)
    body.update({k: v for k, v in legacy.items() if v is not None})
    parsed = _post(url, "/verify", body)

    if "isValid" in parsed:
        return {
            "isValid": bool(parsed.get("isValid")),
            "invalidReason": str(parsed.get("invalidReason") or ""),
            "invalidMessage": str(parsed.get("invalidMessage") or ""),
            "payer": str(parsed.get("payer") or ""),
        }
    # Legacy in-house shape: {"verified": bool, "reason": str, "txHash": str}
    return {
        "isValid": bool(parsed.get("verified")),
        "invalidReason": str(parsed.get("reason") or ""),
        "invalidMessage": "",
        "payer": str(parsed.get("payer") or ""),
        "_legacy": parsed,
    }


def settle(
    url: str, payment: Mapping[str, Any], requirements: Mapping[str, Any], **legacy: Any
) -> Dict[str, Any]:
    """``POST /settle``. Returns ``{"success", "transaction", "network", "payer", …}``.

    ``transaction`` is the settled transaction id — on Algorand, of the
    ``paymentGroup[paymentIndex]`` transfer. It is the only thing a payer can later
    use to prove they paid, so it is carried verbatim, never reformatted.
    """
    body = _request_body(payment, requirements)
    body.update({k: v for k, v in legacy.items() if v is not None})
    parsed = _post(url, "/settle", body)

    if "success" in parsed or "transaction" in parsed:
        return {
            "success": bool(parsed.get("success", bool(parsed.get("transaction")))),
            "transaction": str(parsed.get("transaction") or ""),
            "network": xp.to_caip2(str(parsed.get("network") or requirements.get("network", ""))),
            "payer": str(parsed.get("payer") or ""),
            "errorReason": str(parsed.get("errorReason") or ""),
            "errorMessage": str(parsed.get("errorMessage") or ""),
            "amount": str(parsed.get("amount") or ""),
        }
    # Legacy in-house shape.
    return {
        "success": bool(parsed.get("verified") or parsed.get("settled")),
        "transaction": str(parsed.get("txHash") or parsed.get("txId") or ""),
        "network": xp.to_caip2(str(requirements.get("network", ""))),
        "payer": str(parsed.get("payer") or ""),
        "errorReason": str(parsed.get("reason") or ""),
        "errorMessage": "",
        "amount": str(parsed.get("amount") or ""),
        "_legacy": parsed,
    }


def reset_cache() -> None:
    """Drop the ``/supported`` cache. For tests and for an operator changing rails."""
    _supported_cache.clear()


__all__ = [
    "FacilitatorError",
    "SUPPORTED_TTL_SECONDS",
    "supported",
    "kinds",
    "fee_payer_for",
    "settles",
    "extensions",
    "verify",
    "settle",
    "reset_cache",
]
