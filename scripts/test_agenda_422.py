"""Self-check: /agenda non deve esplodere su upstream 422 (fuori anno scolastico)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main
from fastapi import HTTPException


class FakeUser:
    uid = "S10371278X"
    ident = "10371278"
    is_logged_in = True
    token = "fake-token"

    def get_headers(self):
        return {"Z-Auth-Token": self.token}


class FakeResp:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def json(self):
        return self._payload


def test_normalize_rejects_inverted_range():
    try:
        main.normalize_agenda_range("20251010", "20251001")
        assert False, "atteso 400 per end < start"
    except HTTPException as e:
        assert e.status_code == 400


def test_normalize_rejects_too_long_range():
    try:
        main.normalize_agenda_range("20251001", "20251020")
        assert False, "atteso 400 per range > 14 giorni"
    except HTTPException as e:
        assert e.status_code == 400


def test_normalize_accepts_week():
    start, end = main.normalize_agenda_range("20260727", "20260802")
    assert start == "20260727"
    assert end == "20260802"


def test_upstream_422_returns_empty_agenda(monkeypatch_get):
    main.upstream_cache.clear()
    calls = {"n": 0}

    def fake_get(url, headers=None, timeout=None):
        calls["n"] += 1
        assert "/agenda/all/20260727/20260802" in url
        assert "/students/10371278/" in url
        return FakeResp(422, {"error": "out of range"})

    main.requests.get = fake_get
    data = main.cached_agenda_json(FakeUser(), "20260727", "20260802")
    assert data == {"agenda": []}
    assert calls["n"] == 1

    # Seconda chiamata: risultato vuoto è in cache, niente nuovo hit upstream.
    data2 = main.cached_agenda_json(FakeUser(), "20260727", "20260802")
    assert data2 == {"agenda": []}
    assert calls["n"] == 1


def test_agenda_endpoint_maps_422_to_ok():
    main.upstream_cache.clear()
    main.requests.get = lambda *a, **k: FakeResp(422)

    # Bypass auth dependency invocando la logica come fa il router.
    body = main.AgendaBody(start="20260727", end="20260802")
    res = main.agenda(u=FakeUser(), body=body)
    assert res["ok"] is True
    assert res["agenda"] == {"agenda": []}


def test_agenda_endpoint_still_surfaces_real_upstream_errors():
    main.upstream_cache.clear()
    main.requests.get = lambda *a, **k: FakeResp(500, {"error": "boom"})
    body = main.AgendaBody(start="20251001", end="20251007")
    try:
        main.agenda(u=FakeUser(), body=body)
        assert False, "atteso 502 su upstream 500"
    except HTTPException as e:
        assert e.status_code == 502
        assert "500" in str(e.detail)


if __name__ == "__main__":
    test_normalize_rejects_inverted_range()
    test_normalize_rejects_too_long_range()
    test_normalize_accepts_week()
    test_upstream_422_returns_empty_agenda(None)
    test_agenda_endpoint_maps_422_to_ok()
    test_agenda_endpoint_still_surfaces_real_upstream_errors()
    print("OK: agenda valida range, 422→vuota, 500→502")
