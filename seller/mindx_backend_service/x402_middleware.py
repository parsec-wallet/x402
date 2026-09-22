"""
I am the x402 paywall.

When a caller hits a cost-bearing endpoint without a valid payment header,
I construct a triple-rail 402 envelope (Base USDC, Tempo USDC.e, Algorand
USDC ASA) and return it. When a caller presents a valid X-PAYMENT header,
I verify the settlement with the configured facilitator (or accept a
syntactically-valid stub in dev mode) and let the request through.

Logged-in callers get a free-quota allowance (10 calls per 24h rolling
window) before x402 kicks in. Anonymous callers get 0 free calls.

For the protocol contract see ``docs/services/x402_as_a_service.md``.

The middleware is a FastAPI ``Depends`` factory:

    @app.post("/coordinator/query", dependencies=[Depends(x402_required("/coordinator/query"))])
    async def coordinator_query(...): ...

The dependency:
  1. Reads the request's wallet address from the session (X-Session-Token).
  2. Looks up the per-endpoint price from data/config/x402_pricing.json.
  3. If the caller has free quota remaining → records the call + lets it through.
  4. Else if the caller presented a valid X-PAYMENT header → verifies + records.
  5. Else → raises HTTPException(402, detail=<triple-rail envelope>).

Records every settlement to ``data/governance/free_quota_ledger.json`` and
mirrors a ``payment.x402.settled`` catalogue event (best-effort).
"""
from __future__ import annotations

import base64
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from fastapi import HTTPException, Request, Response

from mindx_backend_service import x402_protocol as xp
from mindx_backend_service import x402_facilitator as xf

logger = logging.getLogger(__name__)


# ─── Config loader (hot-reloadable) ──────────────────────────────────────


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_PRICING_PATH = _PROJECT_ROOT / "data" / "config" / "x402_pricing.json"
_QUOTA_LEDGER_PATH = _PROJECT_ROOT / "data" / "governance" / "free_quota_ledger.json"
# Persistent settlement ledger — doubles as the permanent replay guard (seen
# nonces/txids never expire) AND the unified cross-rail audit journal.
_SETTLEMENT_LEDGER_PATH = _PROJECT_ROOT / "data" / "governance" / "x402_settlement_ledger.json"
# SIWx (CAIP-122) sessions — an account that settled within its window may skip
# re-payment on subsequent calls (reference §5).
_SIWX_SESSIONS_PATH = _PROJECT_ROOT / "data" / "governance" / "x402_siwx_sessions.json"

_pricing_cache: Dict[str, Any] = {}
_pricing_loaded_at: float = 0.0


def _load_pricing(force: bool = False) -> Dict[str, Any]:
    """Read pricing config; reload if the file is newer than what we have.

    Reads the JSON on first call and whenever the file's mtime is newer than
    the cached load timestamp. Hot-reload contract documented in
    ``docs/services/x402_as_a_service.md`` §6.
    """
    global _pricing_cache, _pricing_loaded_at
    try:
        mtime = _PRICING_PATH.stat().st_mtime
    except OSError:
        return _pricing_cache
    if not force and _pricing_cache and mtime <= _pricing_loaded_at:
        return _pricing_cache
    try:
        with _PRICING_PATH.open("r", encoding="utf-8") as fh:
            _pricing_cache = json.load(fh)
        _pricing_loaded_at = mtime
    except Exception as exc:
        logger.warning(f"x402: failed to load pricing config: {exc}")
    return _pricing_cache


# ─── Free-quota ledger (per-wallet 24h rolling window) ───────────────────


def _load_quota_ledger() -> Dict[str, List[float]]:
    """Load the per-wallet quota ledger.

    Shape: ``{ "<wallet_lower>": [<unix_ts>, ...] }`` — a list of timestamps,
    each representing one free-quota call within the last 24h. Entries older
    than 24h are pruned on every read.
    """
    if not _QUOTA_LEDGER_PATH.exists():
        return {}
    try:
        with _QUOTA_LEDGER_PATH.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    cutoff = time.time() - 24 * 3600
    pruned: Dict[str, List[float]] = {}
    for wallet, ts_list in raw.items():
        if not isinstance(ts_list, list):
            continue
        kept = [float(t) for t in ts_list if isinstance(t, (int, float)) and float(t) >= cutoff]
        if kept:
            pruned[wallet] = kept
    return pruned


def _save_quota_ledger(ledger: Dict[str, List[float]]) -> None:
    try:
        _QUOTA_LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = _QUOTA_LEDGER_PATH.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(ledger, fh, indent=2)
        tmp.replace(_QUOTA_LEDGER_PATH)
    except Exception as exc:
        logger.warning(f"x402: failed to persist quota ledger: {exc}")


def _quota_status(wallet: str) -> Tuple[int, int]:
    """Return ``(used_in_window, limit)`` for ``wallet`` (lowercased).

    ``limit`` is taken from pricing config. For anonymous callers
    (empty/None wallet), the anonymous limit applies (0 by default).
    """
    cfg = _load_pricing()
    fq = cfg.get("free_quota", {}) if isinstance(cfg, dict) else {}
    if not wallet or wallet == "anonymous":
        limit = int(fq.get("anonymous_calls_per_24h", 0))
    else:
        limit = int(fq.get("calls_per_24h", 10))
    ledger = _load_quota_ledger()
    used = len(ledger.get((wallet or "").lower(), []))
    return used, limit


def _record_quota_use(wallet: str) -> None:
    if not wallet:
        return
    ledger = _load_quota_ledger()
    key = wallet.lower()
    ledger.setdefault(key, []).append(time.time())
    _save_quota_ledger(ledger)


# ─── Settlement ledger (permanent replay guard + unified audit journal) ───


# Short in-memory idempotency window so a *network retry* of the exact same
# payment within seconds returns the same receipt instead of re-hitting the
# facilitator. The *permanent* guard is the on-disk seen-key ledger below.
_idem_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_seen_keys: Optional[set] = None  # lazily hydrated from the ledger file


def _settlement_cache_ttl() -> int:
    cfg = _load_pricing()
    ido = cfg.get("idempotency", {}) if isinstance(cfg, dict) else {}
    return int(ido.get("settlement_cache_ttl_seconds", 60))


def _load_settlement_ledger() -> List[Dict[str, Any]]:
    if not _SETTLEMENT_LEDGER_PATH.exists():
        return []
    try:
        with _SETTLEMENT_LEDGER_PATH.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        return raw if isinstance(raw, list) else []
    except Exception:
        return []


def _seen_replay_keys() -> set:
    """Hydrate (once) and return the set of permanent replay keys."""
    global _seen_keys
    if _seen_keys is None:
        _seen_keys = {
            e.get("replay_key") for e in _load_settlement_ledger() if e.get("replay_key")
        }
    return _seen_keys


def _append_settlement(record: Dict[str, Any]) -> None:
    """Append a settled payment to the unified ledger and mark its replay key."""
    try:
        _SETTLEMENT_LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
        ledger = _load_settlement_ledger()
        ledger.append(record)
        tmp = _SETTLEMENT_LEDGER_PATH.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(ledger, fh, indent=2)
        tmp.replace(_SETTLEMENT_LEDGER_PATH)
        if record.get("replay_key"):
            _seen_replay_keys().add(record["replay_key"])
    except Exception as exc:
        logger.warning(f"x402: failed to persist settlement ledger: {exc}")


# ─── Settlement verification ─────────────────────────────────────────────


def _rail_facilitator(network: str) -> Optional[str]:
    """Return the facilitator URL for ``network`` — the rail's own
    ``extra.facilitator`` (e.g. GoPlausible for AVM) wins over the global one."""
    cfg = _load_pricing()
    if not isinstance(cfg, dict):
        return None
    caip2 = xp.to_caip2(network)
    for rail in (cfg.get("rails", {}) or {}).values():
        if not isinstance(rail, dict):
            continue
        if xp.to_caip2(str(rail.get("network", ""))) == caip2:
            fac = (rail.get("extra", {}) or {}).get("facilitator")
            if fac:
                return str(fac)
    return (cfg.get("facilitator") or {}).get("url")


def _our_requirement(network: str, endpoint_id: str, max_amount: int) -> Optional[Dict[str, Any]]:
    """The requirement *we* published for this network, rebuilt from config.

    The facilitator is asked to settle against this, never against whatever the client
    sent. A payment envelope carries an ``accepted`` field copied from our challenge,
    but it arrives from the payer — a client that edited ``payTo`` to their own address
    would otherwise have us ask a facilitator to verify a payment to themselves and
    then hand over the resource.
    """
    caip2 = xp.to_caip2(str(network))
    for req in _requirements_for(endpoint_id, max_amount):
        if xp.to_caip2(str(req.get("network", ""))) == caip2:
            return req
    return None


def _check_accepted(env: Mapping[str, Any], ours: Mapping[str, Any]) -> None:
    """Refuse a payment whose declared terms are not the terms we offered.

    Only the fields that decide where the money goes and how much of it: the payee,
    the asset, and an amount at least what we asked. Everything else a client may
    echo back however it likes.
    """
    accepted = env.get("accepted")
    if not isinstance(accepted, Mapping):
        return  # v1 clients send no `accepted`; the facilitator still checks ours.

    if str(accepted.get("payTo", "")) != str(ours.get("payTo", "")):
        raise HTTPException(status_code=402, detail={
            "code": "x402_terms_mismatch",
            "reason": "payment declares a payee we did not quote",
        })
    if str(accepted.get("asset", "")) != str(ours.get("asset", "")):
        raise HTTPException(status_code=402, detail={
            "code": "x402_terms_mismatch",
            "reason": "payment declares an asset we did not quote",
        })
    try:
        declared = int(str(accepted.get("amount") or accepted.get("maxAmountRequired") or 0))
    except ValueError:
        declared = 0
    if declared < int(ours.get("amount", 0)):
        raise HTTPException(status_code=402, detail={
            "code": "x402_underpaid",
            "reason": f"payment declares {declared}, the quote was {ours.get('amount')}",
        })


def _verify_payment(env: Dict[str, Any], endpoint_id: str, max_amount: int) -> Dict[str, Any]:
    """Verify and settle a decoded x402 payment envelope (v1 or v2).

    Syntactic checks here; cryptographic verification and on-chain submission at the
    rail's facilitator. **Verification is not settlement** — ``/verify`` simulates,
    ``/settle`` signs the fee payer and submits — so both are called, in that order,
    and the transaction id that comes back from the second is what the payer receives
    as proof. Permanent replay protection via the on-disk seen-key ledger (EIP-3009
    nonce / AVM group hash). In test mode (``MINDX_X402_TEST_MODE=1``) a syntactically
    valid envelope returns a stub success (``tx_hash="0xtest"``).

    Raises ``HTTPException(402)`` on malformed, mismatched or unverified, ``409`` on
    replay, ``503`` when no facilitator is configured or reachable.
    """
    if not isinstance(env, dict):
        raise HTTPException(status_code=402, detail={"code": "x402_malformed_payment"})

    payload = env.get("payload") or {}
    accepted = env.get("accepted") if isinstance(env.get("accepted"), Mapping) else {}
    # v2 clients may carry scheme/network only inside `accepted`.
    scheme = env.get("scheme") or accepted.get("scheme")
    network = env.get("network") or accepted.get("network")

    if scheme != "exact" or not network or not isinstance(payload, dict):
        raise HTTPException(status_code=402, detail={
            "code": "x402_malformed_payment",
            "reason": "envelope must have scheme='exact', network, payload",
        })

    ours = _our_requirement(str(network), endpoint_id, max_amount)
    if ours is None:
        raise HTTPException(status_code=402, detail={
            "code": "x402_network_not_offered",
            "reason": f"we did not quote {xp.to_caip2(str(network))} for this endpoint",
        })
    _check_accepted(env, ours)

    now = time.time()
    rkey = xp.replay_key(str(network), payload)

    # Permanent replay guard: a nonce/txid settled before is never honored again.
    if rkey and rkey in _seen_replay_keys():
        raise HTTPException(status_code=409, detail={
            "code": "x402_replay",
            "reason": "this payment authorization has already been settled",
            "replay_key": rkey,
        })

    # Short idempotency window for benign network retries (same payment, seconds).
    idem_key = rkey or f"{xp.to_caip2(str(network))}:{json.dumps(payload, sort_keys=True)[:256]}"
    cached = _idem_cache.get(idem_key)
    if cached and (now - cached[0]) < _settlement_cache_ttl():
        return cached[1]

    test_mode = os.environ.get("MINDX_X402_TEST_MODE", "0").strip() == "1"
    if test_mode:
        record = _settlement_record(network, "0xtest", max_amount, now, "test-stub", rkey, endpoint_id, payload)
        _idem_cache[idem_key] = (now, record)
        _append_settlement(record)
        return record

    fac = _rail_facilitator(str(network))
    if not fac:
        raise HTTPException(status_code=503, detail={
            "code": "x402_facilitator_not_configured",
            "reason": "no facilitator URL for this rail in x402_pricing.json",
        })

    # The envelope forwarded to the facilitator is the client's, with our terms
    # substituted: the payment is theirs to have signed, the terms are ours to state.
    payment_payload = {**env, "accepted": dict(ours)}
    legacy = {"endpoint": endpoint_id, "max_amount_microusd": max_amount}

    try:
        verified = xf.verify(fac, payment_payload, ours, **legacy)
    except xf.FacilitatorError as exc:
        raise HTTPException(status_code=503, detail={
            "code": "x402_facilitator_unreachable", "reason": str(exc),
        })
    if not verified.get("isValid"):
        raise HTTPException(status_code=402, detail={
            "code": "x402_settlement_not_verified",
            "reason": verified.get("invalidReason", ""),
            "message": verified.get("invalidMessage", ""),
        })

    try:
        settled = xf.settle(fac, payment_payload, ours, **legacy)
    except xf.FacilitatorError as exc:
        raise HTTPException(status_code=503, detail={
            "code": "x402_settlement_unreachable", "reason": str(exc),
        })
    if not settled.get("success"):
        raise HTTPException(status_code=402, detail={
            "code": "x402_settlement_failed",
            "reason": settled.get("errorReason", ""),
            "message": settled.get("errorMessage", ""),
            # A failed settlement may still name a transaction; it just is not on chain.
            "transaction": settled.get("transaction", ""),
        })

    amount = settled.get("amount") or ours.get("amount") or max_amount
    record = _settlement_record(
        network, settled.get("transaction", ""), int(amount), now, fac, rkey, endpoint_id, payload
    )
    record["success"] = True
    record["transaction"] = settled.get("transaction", "")
    record["payer"] = settled.get("payer") or verified.get("payer") or record.get("payer", "")
    record["payTo"] = ours.get("payTo", "")
    _idem_cache[idem_key] = (now, record)
    _append_settlement(record)
    return record


def _settlement_record(network, tx_hash, amount, ts, fac, rkey, endpoint_id, payload) -> Dict[str, Any]:
    """Build a unified-ledger settlement record (one shape across all rails)."""
    auth = payload.get("authorization") if isinstance(payload, dict) else {}
    return {
        "rail": xp.rail_for(str(network)) if _rail_ok(network) else str(network),
        "network": xp.to_caip2(str(network)),
        "scheme": "exact",
        "tx_hash": tx_hash,
        "amount_microusd": int(amount),
        "payer": (auth or {}).get("from", "") if isinstance(auth, dict) else "",
        "payTo": (auth or {}).get("to", "") if isinstance(auth, dict) else "",
        "endpoint": endpoint_id,
        "replay_key": rkey,
        "verified_at": ts,
        "facilitator": fac,
    }


def _rail_ok(network) -> bool:
    try:
        xp.rail_for(str(network))
        return True
    except Exception:
        return False


# ─── 402 envelope builder ────────────────────────────────────────────────


def _public_base_url() -> str:
    """Absolute base for the ``resource.url`` a client displays and a catalogue indexes."""
    cfg = _load_pricing()
    configured = (cfg.get("discovery", {}) or {}).get("base_url") if isinstance(cfg, dict) else None
    return str(
        os.environ.get("MINDX_PUBLIC_BASE_URL") or configured or "https://mindx.pythai.net"
    ).rstrip("/")


def _fee_payer_for(rail: Dict[str, Any]) -> Optional[str]:
    """The sponsor address for a rail: the operator's own, else the facilitator's.

    On Algorand this is what makes a payment gasless. A client that receives no
    ``extra.feePayer`` builds a single self-funded transfer instead, which works but
    requires the payer to hold ALGO as well as the asset being spent — so it is worth
    one cached ``/supported`` call to avoid.
    """
    extra = rail.get("extra", {}) or {}
    configured = extra.get("feePayer")
    if configured:
        return str(configured)
    facilitator = extra.get("facilitator") or (_load_pricing().get("facilitator", {}) or {}).get("url")
    if not facilitator:
        return None
    try:
        return xf.fee_payer_for(str(facilitator), str(rail.get("network", "")))
    except Exception as exc:
        logger.debug("fee payer lookup failed for %s: %s", rail.get("network"), exc)
        return None


def _discovery_extensions(endpoint_id: str, rule: Dict[str, Any]) -> Dict[str, Any]:
    """The ``bazaar`` declaration for this endpoint, from its pricing entry.

    An endpoint may state its own ``discovery`` block; otherwise a POST-with-JSON-body
    declaration is assumed, which is what every priced mindX route is.
    """
    discovery = rule.get("discovery", {}) if isinstance(rule, dict) else {}
    if discovery is False:
        return {}
    discovery = discovery if isinstance(discovery, dict) else {}
    return xp.bazaar_extension(
        str(discovery.get("method", "POST")),
        body_fields=discovery.get("body"),
        query_params=discovery.get("queryParams"),
        output_example=discovery.get("output"),
    )


def _requirements_for(endpoint_id: str, max_amount: int) -> List[Dict[str, Any]]:
    """Every rail that can actually take payment right now, as v2 requirements.

    Rails with no ``payTo`` are skipped rather than advertised: a challenge naming an
    address nobody controls wastes a client's whole round trip.
    """
    cfg = _load_pricing()
    rails_cfg = cfg.get("rails", {}) if isinstance(cfg, dict) else {}
    tag = (cfg.get("discovery", {}) or {}).get("tag") if isinstance(cfg, dict) else None
    requirements: List[Dict[str, Any]] = []

    for name, rail in rails_cfg.items():
        if not isinstance(rail, dict):
            continue
        pay_to = str(rail.get("payTo", "")).strip()
        if not pay_to or pay_to == "0x0000000000000000000000000000000000000000":
            continue

        extra = {k: v for k, v in (rail.get("extra", {}) or {}).items() if v is not None}
        fee_payer = _fee_payer_for(rail)
        if fee_payer:
            extra["feePayer"] = fee_payer
        if tag:
            extra["tag"] = str(tag)

        requirements.append({
            "scheme": rail.get("scheme", "exact"),
            "network": rail.get("network", name),
            "asset": rail.get("asset", ""),
            "amount": str(max_amount),                # v2 field name
            "maxAmountRequired": str(max_amount),     # v1 field name
            "payTo": pay_to,
            "resource": _public_base_url() + endpoint_id,
            "description": rail.get("_comment", ""),
            "mimeType": "application/json",
            "maxTimeoutSeconds": 300,
            "extra": extra,
        })
    return requirements


def _build_402_envelope(endpoint_id: str, max_amount: int) -> Tuple[Dict[str, Any], str]:
    """Construct the multi-rail 402 challenge (x402 v2 + v1 body).

    Returns ``(json_body, payment_required_header)``. Networks are emitted in CAIP-2
    form; the body carries both ``accepts`` (v2) and ``paymentRequirements`` (v1) so
    either client finds what it expects, and the v2 ``PAYMENT-REQUIRED`` header carries
    ``resource`` and the ``bazaar`` extension so a facilitator can catalogue the
    endpoint without a human registering it anywhere.
    """
    cfg = _load_pricing()
    rule = (cfg.get("endpoints", {}) if isinstance(cfg, dict) else {}).get(endpoint_id, {}) or {}
    requirements = _requirements_for(endpoint_id, max_amount)

    body, header = xp.encode_requirements(
        endpoint_id,
        requirements,
        message="This endpoint requires payment. Settle on an offered rail and retry with PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1).",
        resource={
            "url": _public_base_url() + endpoint_id,
            "description": str(rule.get("description", "") or endpoint_id),
            "mimeType": "application/json",
        },
        extensions=_discovery_extensions(endpoint_id, rule),
    )
    body["_note"] = "See docs/services/x402_as_a_service.md for the protocol contract."
    return body, header


# ─── SIWx (CAIP-122) sessions ─────────────────────────────────────────────


def _siwx_session_ok(request: Request) -> bool:
    """True if the request carries a still-valid SIWx session that already
    settled within its window — lets autonomous repeat calls skip re-payment.

    The session token is an ``X-SIWX-SESSION`` header naming a CAIP-10 account.
    Sessions are minted out-of-band (POST /x402/siwx) after one settled payment
    and stored in ``data/governance/x402_siwx_sessions.json``.
    """
    token = request.headers.get("X-SIWX-SESSION")
    if not token:
        return False
    try:
        if not _SIWX_SESSIONS_PATH.exists():
            return False
        with _SIWX_SESSIONS_PATH.open("r", encoding="utf-8") as fh:
            sessions = json.load(fh)
        sess = sessions.get(token) if isinstance(sessions, dict) else None
        if not isinstance(sess, dict):
            return False
        return float(sess.get("expires", 0)) > time.time()
    except Exception:
        return False


# ─── Catalogue mirror ────────────────────────────────────────────────────


async def _emit_settlement_event(wallet: str, endpoint_id: str, record: Dict[str, Any]) -> None:
    try:
        from agents.catalogue.events import emit_catalogue_event
        await emit_catalogue_event(
            kind="payment.x402.settled",
            actor="mindx.gateway",
            payload={
                "endpoint": endpoint_id,
                "wallet": wallet,
                "rail": record.get("rail"),
                "amount_microusd": record.get("amount_microusd"),
                "tx_hash": record.get("tx_hash"),
                "facilitator": record.get("facilitator"),
            },
            source_log="mindx_backend_service.x402_middleware",
        )
    except Exception:
        # Catalogue write failure must NEVER break a paid request.
        pass


async def _emit_free_quota_event(wallet: str, endpoint_id: str, used: int, limit: int) -> None:
    try:
        from agents.catalogue.events import emit_catalogue_event
        await emit_catalogue_event(
            kind="payment.x402.free_quota",
            actor="mindx.gateway",
            payload={
                "endpoint": endpoint_id,
                "wallet": wallet,
                "used_in_window": used + 1,
                "limit": limit,
            },
            source_log="mindx_backend_service.x402_middleware",
        )
    except Exception:
        pass


# ─── Session inspection ──────────────────────────────────────────────────


def _wallet_from_request(request: Request) -> Optional[str]:
    """Return the lowercase wallet address from the session, or None."""
    token = request.headers.get("X-Session-Token")
    if not token:
        return None
    try:
        # Lazy import to avoid a hard dependency on the vault during tests.
        from mindx_backend_service.bankon_vault import get_vault_manager
        vault = get_vault_manager()
        session = vault.get_user_session(token)
        if session and session.get("wallet_address"):
            return str(session["wallet_address"]).lower()
    except Exception:
        return None
    return None


# ─── The decorator-style factory ─────────────────────────────────────────


def x402_required(endpoint_id: str, max_amount_microusd: Optional[int] = None) -> Callable:
    """Return a FastAPI dependency that enforces x402 on the decorated route.

    The dependency:
      1. Looks up the wallet from X-Session-Token.
      2. If wallet has free quota remaining → records and allows.
      3. Else if X-PAYMENT present and verifies → records and allows.
      4. Else → raises HTTPException(402) with the triple-rail envelope.

    The ``endpoint_id`` is the canonical path string used in pricing config
    and catalogue events (e.g. "/coordinator/query"). When the path contains
    a path parameter like ``{agent_id}``, pass the templated form
    (``/agents/{agent_id}/evolve``) — the middleware uses it as a key, not
    a route match.
    """
    async def _dep(request: Request, response: Response) -> Dict[str, Any]:
        cfg = _load_pricing()
        endpoints = cfg.get("endpoints", {}) if isinstance(cfg, dict) else {}
        rule = endpoints.get(endpoint_id, {})
        amount = int(rule.get("max_amount_microusd", max_amount_microusd or 2000))

        wallet = _wallet_from_request(request) or "anonymous"
        used, limit = _quota_status(wallet)

        if used < limit:
            _record_quota_use(wallet)
            await _emit_free_quota_event(wallet, endpoint_id, used, limit)
            return {"path": "free_quota", "wallet": wallet, "used": used + 1, "limit": limit}

        # SIWx (CAIP-122) session: a wallet that established a session by paying
        # once may skip re-payment within its window (autonomous repeat calls).
        if _siwx_session_ok(request):
            return {"path": "siwx_session", "wallet": wallet}

        # Accept the payment in either v2 (PAYMENT-SIGNATURE) or v1 (X-PAYMENT).
        raw_present = bool(
            request.headers.get(xp.HEADER_PAYMENT_SIGNATURE) or request.headers.get(xp.HEADER_X_PAYMENT)
        )
        env, version = xp.decode_payment(request.headers)
        if env is not None:
            record = _verify_payment(env, endpoint_id, amount)
            await _emit_settlement_event(wallet, endpoint_id, record)
            # Echo settlement in both v2 + v1 response headers.
            for hk, hv in xp.settlement_headers(record).items():
                response.headers[hk] = hv
            return {"path": "x402_settled", "wallet": wallet, "x402Version": version, **record}
        if raw_present:
            # A payment header was sent but could not be decoded — surface it
            # rather than silently re-issuing the challenge.
            raise HTTPException(status_code=402, detail={
                "code": "x402_malformed_payment",
                "reason": "payment header present but could not be base64/JSON-decoded",
            })

        body, payment_required_header = _build_402_envelope(endpoint_id, amount)
        if not body.get("accepts"):
            # No rails currently settling → 503 so the caller knows the operator
            # hasn't finished configuring x402 yet.
            raise HTTPException(status_code=503, detail={
                "code": "x402_no_rails_configured",
                "reason": "No x402 rails have a payTo address yet. Operator must update data/config/x402_pricing.json.",
            })
        # 402 carries the v2 PAYMENT-REQUIRED header AND the v1/v2 JSON body.
        raise HTTPException(status_code=402, detail=body, headers={xp.HEADER_PAYMENT_REQUIRED: payment_required_header})

    _dep.__name__ = f"x402_required_for_{endpoint_id.strip('/').replace('/', '_').replace('{', '').replace('}', '')}"
    return _dep
