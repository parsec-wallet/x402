# Copyright 2026 BANKON. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Bazaar — discovery for the x402 economy.

The backing implementation for ``x402bazaar.agent``. It answers the question a
paying agent has to ask before it can ask anything else: *what is for sale?*

mindX could already pay (``x402_rails``, ``x402_avm_client``,
``keeperhub_x402_client``) and could already charge (``x402_middleware``). What it
could not do was **find** anything: every paid URL had to be known in advance and
handed to it by a human. The Bazaar is the catalogue that closes that loop — resource
servers declare what their endpoints take and return in the ``bazaar`` extension of
their own 402 challenge, facilitators index those declarations after settlement, and
``/discovery/*`` serves the result.

Adapted from the capability surface of GoPlausible's OpenClaw Algorand plugin
(``bazaar_list`` / ``bazaar_search`` / ``bazaar_get_resource_details`` /
``x402_discover_payment_requirements``), which gives an OpenClaw agent exactly this
and which mindX had no equivalent of. The wire work is the same; the shape is mindX's.

Three rules, all of them about not being lied to:

* **A catalogue entry is a memory, not a quote.** Prices here were true when the
  facilitator last indexed the resource. ``discover()`` re-reads the live 402, and that
  is the only price anything is ever paid against.
* **Nothing is browsed on credit.** Every call here is free. Discovery must never be
  the thing that costs money.
* **Descriptions are data.** A resource's description is written by whoever is selling
  it. It is displayed and logged; it is never followed as an instruction.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional

import httpx

from mindx_backend_service import x402_protocol as xp
from utils.logging_config import get_logger

logger = get_logger(__name__)

DEFAULT_FACILITATOR = "https://facilitator.goplausible.xyz"
DEFAULT_TIMEOUT = 20.0

# Networks mindX can actually settle on today: the EVM leg through `x402_rails`
# (ERC-3009) and the Algorand leg through `x402_avm_client` (exact AVM groups).
SETTLEABLE_NAMESPACES = ("eip155", "algorand")

# Assets worth naming without asking. A server's own ``extra.name`` always wins; this is
# only so a catalogue row that omitted it does not read as a bare integer.
KNOWN_ASSETS = {
    str(xp.USDC_ASA_MAINNET): "USDC",
    str(xp.USDC_ASA_TESTNET): "USDC",
    xp.USDC_BASE_MAINNET: "USDC",
    xp.USDC_BASE_MAINNET.lower(): "USDC",
    "0": "ALGO",
}


# ── Records ──────────────────────────────────────────────────────────────────


@dataclass
class Offer:
    """One way to pay for a resource, as the catalogue remembers it."""

    scheme: str
    network: str
    amount: int
    asset: str
    pay_to: str
    decimals: int = 6
    symbol: str = ""
    fee_payer: str = ""
    tag: str = ""

    @property
    def usd(self) -> float:
        """The price in whole units, for a human. Never used to build a payment."""
        return self.amount / (10 ** self.decimals)

    @property
    def settleable(self) -> bool:
        return self.network.split(":", 1)[0] in SETTLEABLE_NAMESPACES

    def to_dict(self) -> Dict[str, Any]:
        return {
            "scheme": self.scheme,
            "network": self.network,
            "amount": str(self.amount),
            "asset": self.asset,
            "payTo": self.pay_to,
            "decimals": self.decimals,
            "symbol": self.symbol,
            "feePayer": self.fee_payer,
            "tag": self.tag,
            "usd": round(self.usd, 6),
            "settleable": self.settleable,
        }


@dataclass
class Resource:
    """A catalogued paid endpoint."""

    url: str
    method: str = "GET"
    description: str = ""
    mime_type: str = ""
    merchant_id: str = ""
    offers: List[Offer] = field(default_factory=list)
    input_spec: Dict[str, Any] = field(default_factory=dict)
    output_spec: Dict[str, Any] = field(default_factory=dict)
    settle_count: int = 0
    first_seen: str = ""
    last_seen: str = ""

    @property
    def cheapest(self) -> Optional[Offer]:
        payable = [o for o in self.offers if o.settleable]
        return min(payable, key=lambda o: o.usd) if payable else None

    def to_dict(self) -> Dict[str, Any]:
        best = self.cheapest
        return {
            "url": self.url,
            "method": self.method,
            "description": self.description,
            "mimeType": self.mime_type,
            "merchantId": self.merchant_id,
            "offers": [o.to_dict() for o in self.offers],
            "cheapest": best.to_dict() if best else None,
            "input": self.input_spec,
            "output": self.output_spec,
            "settleCount": self.settle_count,
            "firstSeen": self.first_seen,
            "lastSeen": self.last_seen,
        }


# ── Parsing ──────────────────────────────────────────────────────────────────


def _as_mapping(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _offer_from(raw: Mapping[str, Any]) -> Offer:
    extra = _as_mapping(raw.get("extra"))
    try:
        amount = int(str(raw.get("amount") or raw.get("maxAmountRequired") or 0))
    except (TypeError, ValueError):
        amount = 0
    decimals = extra.get("decimals")
    return Offer(
        scheme=str(raw.get("scheme") or "exact"),
        network=xp.to_caip2(str(raw.get("network") or "")),
        amount=amount,
        asset=str(raw.get("asset") or "0"),
        pay_to=str(raw.get("payTo") or ""),
        decimals=int(decimals) if isinstance(decimals, int) else 6,
        symbol=str(extra.get("name") or KNOWN_ASSETS.get(str(raw.get("asset") or ""), "")),
        fee_payer=str(extra.get("feePayer") or ""),
        tag=str(extra.get("tag") or ""),
    )


def _discovery_of(raw: Mapping[str, Any], offers: Iterable[Mapping[str, Any]]) -> Dict[str, Any]:
    """The bazaar declaration, from the catalogue row or from an offer's extensions."""
    info = _as_mapping(raw.get("discoveryInfo"))
    if info:
        return info
    for offer in offers:
        bazaar = _as_mapping(_as_mapping(offer.get("extensions")).get("bazaar"))
        if bazaar.get("info"):
            return _as_mapping(bazaar["info"])
    return {}


def _resource_from(raw: Mapping[str, Any]) -> Resource:
    raw_offers = raw.get("accepts") if isinstance(raw.get("accepts"), list) else []
    info = _discovery_of(raw, [o for o in raw_offers if isinstance(o, Mapping)])
    input_spec = _as_mapping(info.get("input"))
    return Resource(
        url=str(raw.get("resourceUrl") or raw.get("resource") or ""),
        method=str(raw.get("method") or input_spec.get("method") or "GET").upper(),
        description=str(raw.get("description") or ""),
        mime_type=str(raw.get("mimeType") or ""),
        merchant_id=str(raw.get("merchantId") or ""),
        offers=[_offer_from(o) for o in raw_offers if isinstance(o, Mapping)],
        input_spec=input_spec,
        output_spec=_as_mapping(info.get("output")),
        settle_count=int(raw.get("settleCount") or 0),
        first_seen=str(raw.get("firstSeen") or ""),
        last_seen=str(raw.get("lastSeen") or ""),
    )


# ── The service ──────────────────────────────────────────────────────────────


class BazaarDirectory:
    """Read-only client for a facilitator's discovery directory.

    Every method is free and idempotent. Nothing here signs, pays, or holds a key —
    which is the point: an agent should be able to survey the market at no cost and
    only then decide to spend, through ``x402rails`` or ``x402_avm_client``.
    """

    def __init__(
        self,
        facilitator_url: str = DEFAULT_FACILITATOR,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        settleable_only: bool = True,
        include_testnets: bool = False,
    ) -> None:
        self.facilitator_url = facilitator_url.rstrip("/")
        self.timeout = timeout
        self.settleable_only = settleable_only
        self.include_testnets = include_testnets

    # ── catalogue ────────────────────────────────────────────────────────────

    def list(
        self,
        *,
        search: Optional[str] = None,
        network: Optional[str] = None,
        method: Optional[str] = None,
        merchant_id: Optional[str] = None,
        max_usd: Optional[float] = None,
        tag: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Resource]:
        """Page the catalogue, filtered.

        Filters the facilitator understands go on the wire; the rest — what mindX can
        settle, a price ceiling, a tag — are applied here, because a facilitator's
        idea of "affordable" is not ours.
        """
        params: Dict[str, Any] = {"limit": limit, "offset": offset}
        if search:
            params["search"] = search
        if network:
            params["network"] = xp.to_caip2(network)
        if method:
            params["method"] = method.upper()
        if merchant_id:
            params["merchantId"] = merchant_id

        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.get(
                    f"{self.facilitator_url}/discovery/resources",
                    params=params,
                    headers={"Accept": "application/json"},
                )
        except Exception as exc:
            logger.warning("bazaar unreachable at %s: %s", self.facilitator_url, exc)
            return []

        if resp.status_code != 200:
            logger.warning("bazaar returned %s: %s", resp.status_code, resp.text[:200])
            return []

        body = _as_mapping(resp.json())
        items = body.get("items") if isinstance(body.get("items"), list) else []
        resources = [_resource_from(i) for i in items if isinstance(i, Mapping)]
        return [r for r in (self._filter(r, max_usd=max_usd, tag=tag) for r in resources) if r]

    def search(self, term: str, **kwargs: Any) -> List[Resource]:
        """Free-text search. Same endpoint, same filters."""
        return self.list(search=term, **kwargs)

    def get(self, resource_url: str) -> Optional[Resource]:
        """One resource by URL. The facilitator has no get-by-id, so this is search-then-match."""
        for candidate in self.list(
            search=resource_url, limit=50, max_usd=None
        ) or self._unfiltered(resource_url):
            if candidate.url == resource_url:
                return candidate
        return None

    def merchants(self, *, limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
        """Who is selling, and how much they have settled."""
        try:
            with httpx.Client(timeout=self.timeout) as client:
                resp = client.get(
                    f"{self.facilitator_url}/discovery/merchants",
                    params={"limit": limit, "offset": offset},
                    headers={"Accept": "application/json"},
                )
            if resp.status_code != 200:
                return []
            body = _as_mapping(resp.json())
        except Exception as exc:
            logger.warning("bazaar merchants unreachable: %s", exc)
            return []
        items = body.get("items") if isinstance(body.get("items"), list) else []
        return [dict(i) for i in items if isinstance(i, Mapping)]

    # ── live probe ───────────────────────────────────────────────────────────

    def discover(self, url: str, *, method: str = "GET") -> Optional[Resource]:
        """Read a resource's **live** 402 challenge. The price here is the real one.

        Returns ``None`` when the resource answers without asking for payment — which
        is a useful answer, not a failure: it means the thing is free.
        """
        try:
            with httpx.Client(timeout=self.timeout, follow_redirects=True) as client:
                resp = client.request(method.upper(), url, headers={"Accept": "application/json"})
        except Exception as exc:
            logger.warning("probe of %s failed: %s", url, exc)
            return None

        if resp.status_code != 402:
            return None

        challenge = self._challenge_from(resp)
        offers = challenge.get("accepts") or challenge.get("paymentRequirements") or []
        resource_obj = _as_mapping(challenge.get("resource"))
        info = _as_mapping(_as_mapping(_as_mapping(challenge.get("extensions")).get("bazaar")).get("info"))
        input_spec = _as_mapping(info.get("input"))

        first = next((o for o in offers if isinstance(o, Mapping)), {})
        return Resource(
            url=str(resource_obj.get("url") or first.get("resource") or url),
            method=str(input_spec.get("method") or method).upper(),
            description=str(resource_obj.get("description") or first.get("description") or ""),
            mime_type=str(resource_obj.get("mimeType") or first.get("mimeType") or ""),
            offers=[_offer_from(o) for o in offers if isinstance(o, Mapping)],
            input_spec=input_spec,
            output_spec=_as_mapping(info.get("output")),
        )

    @staticmethod
    def _challenge_from(resp: httpx.Response) -> Dict[str, Any]:
        """v2 puts the challenge in a header and leaves the body empty; v1 uses the body."""
        header = None
        for key, value in resp.headers.items():
            if key.lower() == xp.HEADER_PAYMENT_REQUIRED.lower():
                header = value
                break
        if header:
            try:
                return _as_mapping(json.loads(base64.b64decode(header.strip()).decode("utf-8")))
            except Exception:
                pass  # malformed header — the body may still carry it
        try:
            return _as_mapping(resp.json())
        except Exception:
            return {}

    # ── filtering ────────────────────────────────────────────────────────────

    def _filter(
        self, resource: Resource, *, max_usd: Optional[float], tag: Optional[str]
    ) -> Optional[Resource]:
        offers = []
        for offer in resource.offers:
            if self.settleable_only and not offer.settleable:
                continue
            if not self.include_testnets and self._is_testnet(offer.network):
                continue
            if max_usd is not None and offer.usd > max_usd:
                continue
            if tag and offer.tag != tag:
                continue
            offers.append(offer)
        if not offers:
            return None
        resource.offers = offers
        return resource

    def _unfiltered(self, search: str) -> List[Resource]:
        loose = BazaarDirectory(
            self.facilitator_url, timeout=self.timeout, settleable_only=False, include_testnets=True
        )
        return loose.list(search=search, limit=50)

    @staticmethod
    def _is_testnet(network: str) -> bool:
        caip2 = xp.to_caip2(network)
        return caip2 in (
            "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
            "algorand:localnet",
            "eip155:84532",
            "eip155:11155111",
            "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        )

    # ── agent surface ────────────────────────────────────────────────────────

    def describe(self) -> Dict[str, Any]:
        """An agent-card-style description, matching what ``x402rails`` returns."""
        return {
            "agent": "x402bazaar",
            "facilitator": self.facilitator_url,
            "settleable_namespaces": list(SETTLEABLE_NAMESPACES),
            "settleable_only": self.settleable_only,
            "include_testnets": self.include_testnets,
            "capabilities": ["list", "search", "get", "merchants", "discover", "quote"],
            "note": "Read-only. Every call is free. Paying is x402rails' job.",
        }

    def quote(self, url: str, *, method: str = "GET") -> Dict[str, Any]:
        """What this resource costs *right now*, and whether we can settle it.

        The answer a BDI agent needs before it commits: a live price, the rail it would
        settle on, and — if none — a plain statement that we cannot pay for this.
        """
        resource = self.discover(url, method=method)
        if resource is None:
            return {"url": url, "paid": False, "reason": "resource answered without requiring payment"}
        best = resource.cheapest
        if best is None:
            return {
                "url": url,
                "paid": True,
                "settleable": False,
                "reason": "no offered network has a mindX settlement rail",
                "offered": sorted({o.network for o in resource.offers}),
            }
        return {
            "url": url,
            "paid": True,
            "settleable": True,
            "description": resource.description,
            "offer": best.to_dict(),
            "input": resource.input_spec,
            "output": resource.output_spec,
        }


__all__ = [
    "DEFAULT_FACILITATOR",
    "SETTLEABLE_NAMESPACES",
    "BazaarDirectory",
    "Offer",
    "Resource",
]
