"""Bazaar discovery — the half of x402 that must never cost anything.

The rule these exist to protect: a catalogued price is a memory and a live 402 is a
quote, and nothing is ever paid against the first.
"""
from __future__ import annotations

import base64
import json

import pytest

from tools import x402_bazaar as bz


ALGO_MAINNET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="
ALGO_TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="

CATALOGUE = {
    "x402Version": 2,
    "items": [
        {
            "resourceUrl": "https://api.example.com/weather",
            "method": "GET",
            "description": "Weather data",
            "mimeType": "application/json",
            "merchantId": "M1",
            "accepts": [{
                "scheme": "exact", "network": "algorand-mainnet", "amount": "250000",
                "asset": "31566704", "payTo": "PAYEE",
                "extra": {"decimals": 6, "feePayer": "SPONSOR", "tag": "x402-global-challenge"},
            }],
            "discoveryInfo": {"input": {"type": "http", "method": "GET"}},
            "settleCount": 1091,
        },
        {
            "resourceUrl": "https://api.example.com/testnet-only",
            "method": "GET",
            "accepts": [{
                "scheme": "exact", "network": "algorand-testnet", "amount": "1000",
                "asset": "10458941", "payTo": "PAYEE", "extra": {"decimals": 6},
            }],
        },
        {
            "resourceUrl": "https://api.example.com/cosmos-only",
            "method": "GET",
            "accepts": [{
                "scheme": "exact", "network": "cosmos:cosmoshub-4", "amount": "1",
                "asset": "uatom", "payTo": "cosmos1", "extra": {"decimals": 6},
            }],
        },
        {
            "resourceUrl": "https://api.example.com/expensive",
            "method": "GET",
            "accepts": [{
                "scheme": "exact", "network": "algorand-mainnet", "amount": "5000000",
                "asset": "31566704", "payTo": "PAYEE", "extra": {"decimals": 6},
            }],
        },
    ],
    "pagination": {"limit": 50, "offset": 0, "total": 4},
}

LIVE_CHALLENGE = {
    "x402Version": 2,
    "resource": {"url": "https://api.example.com/weather", "description": "Weather, now", "mimeType": "application/json"},
    "accepts": [{
        "scheme": "exact", "network": "algorand-mainnet", "amount": "300000",
        "asset": "31566704", "payTo": "PAYEE",
        "extra": {"name": "USDC", "decimals": 6, "feePayer": "SPONSOR"},
    }],
    "extensions": {"bazaar": {"info": {"input": {"type": "http", "method": "GET", "queryParams": {"city": "SF"}}, "output": {"type": "json", "example": {"t": 60}}}}},
}


class _Resp:
    def __init__(self, status_code, payload, headers=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _Client:
    routes: dict = {}

    def __init__(self, *a, **kw):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, params=None, headers=None):
        return _Client.routes.get(url, _Resp(404, {}))

    def request(self, method, url, headers=None):
        return _Client.routes.get(f"{method} {url}", _Resp(404, {}))


@pytest.fixture(autouse=True)
def stub_http(monkeypatch):
    _Client.routes = {
        "https://facilitator.example/discovery/resources": _Resp(200, CATALOGUE),
        "https://facilitator.example/discovery/merchants": _Resp(200, {"items": [{"id": "M1", "resourceCount": 11}]}),
    }
    monkeypatch.setattr(bz.httpx, "Client", _Client)
    yield _Client


@pytest.fixture
def bazaar():
    return bz.BazaarDirectory("https://facilitator.example")


# ── the catalogue ────────────────────────────────────────────────────────────


def test_lists_what_we_can_settle(bazaar):
    urls = [r.url for r in bazaar.list()]
    assert "https://api.example.com/weather" in urls
    # Cosmos has no mindX rail; testnets are off by default.
    assert "https://api.example.com/cosmos-only" not in urls
    assert "https://api.example.com/testnet-only" not in urls


def test_testnets_are_available_on_request():
    loose = bz.BazaarDirectory("https://facilitator.example", include_testnets=True)
    assert "https://api.example.com/testnet-only" in [r.url for r in loose.list()]


def test_unsettleable_rails_can_be_shown_deliberately():
    loose = bz.BazaarDirectory("https://facilitator.example", settleable_only=False)
    assert "https://api.example.com/cosmos-only" in [r.url for r in loose.list()]


def test_a_price_ceiling_is_applied_locally(bazaar):
    urls = [r.url for r in bazaar.list(max_usd=1.0)]
    assert "https://api.example.com/weather" in urls       # $0.25
    assert "https://api.example.com/expensive" not in urls  # $5.00


def test_a_tag_filter_narrows_to_one_programme(bazaar):
    urls = [r.url for r in bazaar.list(tag="x402-global-challenge")]
    assert urls == ["https://api.example.com/weather"]


def test_prices_are_read_from_atomic_units(bazaar):
    weather = next(r for r in bazaar.list() if r.url.endswith("/weather"))
    offer = weather.cheapest
    assert offer.amount == 250000
    assert offer.usd == 0.25
    assert offer.symbol == "USDC"        # named from the ASA id when the server omits it
    assert offer.fee_payer == "SPONSOR"
    assert weather.settle_count == 1091


def test_the_discovery_declaration_is_carried_through(bazaar):
    weather = next(r for r in bazaar.list() if r.url.endswith("/weather"))
    assert weather.input_spec["method"] == "GET"


def test_merchants_are_listed(bazaar):
    assert bazaar.merchants()[0]["id"] == "M1"


def test_an_unreachable_facilitator_returns_nothing_rather_than_raising(monkeypatch, bazaar):
    class _Boom(_Client):
        def get(self, *a, **kw):
            raise RuntimeError("no network")

    monkeypatch.setattr(bz.httpx, "Client", _Boom)
    assert bazaar.list() == []
    assert bazaar.merchants() == []


# ── the live quote ───────────────────────────────────────────────────────────


def _challenge_response(payload):
    header = base64.b64encode(json.dumps(payload).encode()).decode()
    return _Resp(402, {}, {"payment-required": header})


def test_a_live_quote_overrides_the_catalogued_price(bazaar, stub_http):
    stub_http.routes["GET https://api.example.com/weather"] = _challenge_response(LIVE_CHALLENGE)
    catalogued = next(r for r in bazaar.list() if r.url.endswith("/weather")).cheapest
    quoted = bazaar.quote("https://api.example.com/weather")

    assert catalogued.amount == 250000       # what the directory remembered
    assert quoted["offer"]["amount"] == "300000"  # what it costs now
    assert quoted["settleable"] is True
    assert quoted["input"]["queryParams"] == {"city": "SF"}


def test_a_v1_challenge_in_the_body_is_read_too(bazaar, stub_http):
    body = {
        "x402Version": 1,
        "accepts": [{
            "scheme": "exact", "network": "algorand-mainnet", "maxAmountRequired": "9000",
            "asset": "31566704", "payTo": "PAYEE", "resource": "https://api.example.com/v1",
            "description": "Legacy", "extra": {"decimals": 6},
        }],
    }
    stub_http.routes["GET https://api.example.com/v1"] = _Resp(402, body)
    quoted = bazaar.quote("https://api.example.com/v1")
    assert quoted["offer"]["amount"] == "9000"
    assert quoted["description"] == "Legacy"


def test_a_free_resource_says_so(bazaar, stub_http):
    stub_http.routes["GET https://api.example.com/free"] = _Resp(200, {"ok": True})
    quoted = bazaar.quote("https://api.example.com/free")
    assert quoted["paid"] is False


def test_an_unsettleable_resource_names_what_it_offered(bazaar, stub_http):
    body = {"x402Version": 2, "accepts": [{
        "scheme": "exact", "network": "cosmos:cosmoshub-4", "amount": "1", "asset": "uatom", "payTo": "c1",
    }]}
    stub_http.routes["GET https://api.example.com/cosmos"] = _Resp(402, body)
    quoted = bazaar.quote("https://api.example.com/cosmos")
    assert quoted["paid"] is True
    assert quoted["settleable"] is False
    assert quoted["offered"] == ["cosmos:cosmoshub-4"]


def test_a_malformed_header_falls_back_to_the_body(bazaar, stub_http):
    stub_http.routes["GET https://api.example.com/broken"] = _Resp(
        402, LIVE_CHALLENGE, {"payment-required": "not base64"}
    )
    assert bazaar.quote("https://api.example.com/broken")["offer"]["amount"] == "300000"


def test_describe_states_what_it_will_not_do(bazaar):
    card = bazaar.describe()
    assert card["agent"] == "x402bazaar"
    assert "quote" in card["capabilities"]
    assert "algorand" in card["settleable_namespaces"]
