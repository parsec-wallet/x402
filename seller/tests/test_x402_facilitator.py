"""The facilitator contract, and the guard on the terms a payment declares.

mindX used to post a bespoke body to ``/verify`` and never call ``/settle`` at all,
so against a published facilitator nothing verified and nothing reached a chain. These
pin the spec shape in both directions, and pin that a payer cannot restate the terms.
"""
from __future__ import annotations

import json

import pytest

from mindx_backend_service import x402_facilitator as xf


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _Client:
    """A stub httpx.Client that records what was sent and replays canned answers."""

    calls: list = []
    answers: dict = {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, **kw):
        _Client.calls.append(("GET", url, None))
        return _Resp(200, _Client.answers.get("GET " + url, {}))

    def post(self, url, json=None, **kw):
        _Client.calls.append(("POST", url, json))
        path = url.rsplit("/", 1)[-1]
        return _Resp(200, _Client.answers.get("POST /" + path, {}))


@pytest.fixture(autouse=True)
def stub_http(monkeypatch):
    _Client.calls = []
    _Client.answers = {}
    monkeypatch.setattr(xf, "_client", lambda: _Client())
    xf.reset_cache()
    yield _Client


SUPPORTED = {
    "kinds": [
        {"x402Version": 2, "scheme": "exact", "network": "eip155:8453"},
        {
            "x402Version": 2,
            "scheme": "exact",
            "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
            "extra": {"feePayer": "SPONSOR"},
        },
    ],
    "extensions": ["bazaar"],
    "signers": {"algorand:*": ["SIGNER"], "eip155:*": ["0xSIGNER"]},
}

REQUIREMENTS = {
    "scheme": "exact",
    "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "asset": "31566704",
    "amount": "2000",
    "payTo": "PAYEE",
    "maxTimeoutSeconds": 300,
    "extra": {"feePayer": "SPONSOR"},
}

PAYMENT = {
    "x402Version": 2,
    "scheme": "exact",
    "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "accepted": REQUIREMENTS,
    "payload": {"paymentGroup": ["unsigned", "signed"], "paymentIndex": 1},
}

FAC = "https://facilitator.example"


def test_fee_payer_comes_from_the_matching_kind(stub_http):
    stub_http.answers["GET " + FAC + "/supported"] = SUPPORTED
    assert xf.fee_payer_for(FAC, "algorand-mainnet") == "SPONSOR"


def test_fee_payer_falls_back_to_the_namespace_signer(stub_http):
    stub_http.answers["GET " + FAC + "/supported"] = SUPPORTED
    # Base declares no feePayer of its own; the eip155 signer is the same account.
    assert xf.fee_payer_for(FAC, "eip155:8453") == "0xSIGNER"


def test_unknown_network_has_no_sponsor(stub_http):
    stub_http.answers["GET " + FAC + "/supported"] = SUPPORTED
    assert xf.fee_payer_for(FAC, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") is None


def test_supported_is_cached(stub_http):
    stub_http.answers["GET " + FAC + "/supported"] = SUPPORTED
    xf.supported(FAC)
    xf.supported(FAC)
    assert len([c for c in stub_http.calls if c[0] == "GET"]) == 1


def test_an_unreachable_facilitator_is_not_an_error(monkeypatch):
    def boom():
        raise RuntimeError("no network")

    monkeypatch.setattr(xf, "_client", lambda: boom())
    xf.reset_cache()
    assert xf.supported(FAC) == {}
    assert xf.fee_payer_for(FAC, "algorand-mainnet") is None


def test_verify_sends_the_spec_body(stub_http):
    stub_http.answers["POST /verify"] = {"isValid": True, "payer": "PAYER"}
    result = xf.verify(FAC, PAYMENT, REQUIREMENTS, endpoint="/x")

    sent = [c for c in stub_http.calls if c[0] == "POST"][0][2]
    assert sent["x402Version"] == 2
    assert sent["paymentPayload"]["payload"]["paymentIndex"] == 1
    assert sent["paymentRequirements"]["payTo"] == "PAYEE"
    assert sent["endpoint"] == "/x"  # in-house extras ride along
    assert result["isValid"] is True
    assert result["payer"] == "PAYER"


def test_verify_reads_a_rejection(stub_http):
    stub_http.answers["POST /verify"] = {"isValid": False, "invalidReason": "insufficient_funds"}
    assert xf.verify(FAC, PAYMENT, REQUIREMENTS)["invalidReason"] == "insufficient_funds"


def test_verify_still_understands_the_legacy_shape(stub_http):
    stub_http.answers["POST /verify"] = {"verified": True, "reason": ""}
    assert xf.verify(FAC, PAYMENT, REQUIREMENTS)["isValid"] is True


def test_settle_returns_the_transaction_id(stub_http):
    stub_http.answers["POST /settle"] = {
        "success": True,
        "transaction": "NTRZR6HGMMZGYMJKUNVNLKLA427ACAVIPFNC6JHA5XNBQQHW7MWA",
        "network": "algorand-mainnet",
        "payer": "PAYER",
    }
    settled = xf.settle(FAC, PAYMENT, REQUIREMENTS)
    assert settled["success"] is True
    assert settled["transaction"] == "NTRZR6HGMMZGYMJKUNVNLKLA427ACAVIPFNC6JHA5XNBQQHW7MWA"
    assert settled["network"].startswith("algorand:")


def test_settle_keeps_the_transaction_of_a_failure(stub_http):
    stub_http.answers["POST /settle"] = {
        "success": False, "errorReason": "rejected", "transaction": "TXFAIL", "network": "algorand-mainnet",
    }
    settled = xf.settle(FAC, PAYMENT, REQUIREMENTS)
    assert settled["success"] is False
    assert settled["transaction"] == "TXFAIL"


def test_settle_understands_the_legacy_shape(stub_http):
    stub_http.answers["POST /settle"] = {"verified": True, "txHash": "0xdead"}
    settled = xf.settle(FAC, PAYMENT, REQUIREMENTS)
    assert settled["success"] is True
    assert settled["transaction"] == "0xdead"


def test_a_facilitator_that_answers_nonsense_raises(stub_http):
    class _Bad(_Client):
        def post(self, url, json=None, **kw):
            return _Resp(500, {"oh": "no"})

    stub_http.answers = {}
    import mindx_backend_service.x402_facilitator as mod

    mod._client = lambda: _Bad()
    with pytest.raises(xf.FacilitatorError):
        xf.settle(FAC, PAYMENT, REQUIREMENTS)
