"""Self-check di login da sessione web (SPID/CIE), abbinamento PC e dispositivi collegati.

Spaggiari è simulato: nessuna chiamata di rete. Esegui:
    .venv/bin/python scripts/test_web_session_pairing.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("DATABASE_PATH", os.path.join(tempfile.mkdtemp(), "test.db"))
os.environ.setdefault("COOKIE_SECURE", "false")

import classeviva_client as cv

VALID_COOKIES = {"spidcookie1234567890", "spidcookieNEW1234567"}
calls = []


class FakeResponse:
    def __init__(self, status_code, payload=None, content_type="application/json"):
        self.status_code = status_code
        self._payload = payload
        self.headers = {"Content-Type": content_type}
        self.text = json.dumps(payload) if payload is not None else ""

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def fake_upstream(method, url, headers=None, **kwargs):
    calls.append((method, url))
    cookie = (headers or {}).get("Cookie", "")
    valid = any(cookie == f"PHPSESSID={c}" for c in VALID_COOKIES)
    assert "/rest/v1/" not in url, f"un utente web non deve chiamare le API dell'app: {url}"
    if not valid:
        # Spaggiari con sessione non valida: redirect alla pagina di login
        return FakeResponse(302, None, content_type="text/html")
    if url.endswith("/misc/whoami"):
        return FakeResponse(200, {"id": "S7654321", "nome": "Mario", "cognome": "Rossi", "account_type": "S"})
    if url.endswith("/students/7654321/card"):
        return FakeResponse(200, {"card": {"ident": "S7654321X", "firstName": "Mario", "lastName": "Rossi", "schCode": "VRIT0007"}})
    if url.endswith("/students/7654321/grades"):
        return FakeResponse(200, {"grades": [{"subjectDesc": "MATEMATICA", "decimalValue": 8.0, "displayValue": "8", "evtDate": "2026-10-10", "periodPos": 1, "noAverage": False, "canceled": False}]})
    if url.endswith("/students/7654321/noticeboard"):
        if method.upper() != "GET":
            return FakeResponse(405, {"error": "method"})
        return FakeResponse(200, {"items": []})
    return FakeResponse(200, {})


cv.requests.get = lambda url, headers=None, **kw: fake_upstream("GET", url, headers, **kw)
cv.requests.request = lambda method, url, headers=None, **kw: fake_upstream(method, url, headers, **kw)

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

PC_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"}
PHONE_UA = {"User-Agent": "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"}


def web_login(client, cookie="spidcookie1234567890"):
    return client.post("/login/web-session", json={"phpsessid": cookie}, headers=PHONE_UA)


def test_web_session_user_rewrites_urls():
    u = cv.WebSessionUtente("spidcookie1234567890")
    u.login_from_session()
    assert u.ident == "7654321" and u.uid == "S7654321X", (u.ident, u.uid)
    url, method = u.resolve(cv.RequestURLs.noticeboard)
    assert url.startswith(cv.WEB_BASE_URL) and method == "get"
    assert u.request(cv.RequestURLs.noticeboard).status_code == 200
    assert u.get_headers()["Cookie"] == "PHPSESSID=spidcookie1234567890"
    assert "Z-Auth-Token" not in u.get_headers()


def test_invalid_cookie_rejected():
    with TestClient(main.app) as client:
        r = web_login(client, "invalidcookie1234567")
        assert r.status_code == 401, r.text
        assert "SPID" in r.json()["detail"]
        assert "session_id" not in r.cookies
        r = client.post("/login/web-session", json={"phpsessid": "bad cookie with spaces!"})
        assert r.status_code in (400, 422), r.text


def test_full_flow_login_data_pairing_devices():
    with TestClient(main.app) as phone, TestClient(main.app) as pc:
        # Telefono: login da sessione SPID
        r = web_login(phone)
        assert r.status_code == 200, r.text
        assert r.json()["user"] == "S7654321X"

        me = phone.get("/session/me")
        assert me.status_code == 200, me.text
        assert me.json()["auth_mode"] == "web"

        voti = phone.post("/voti")
        assert voti.status_code == 200, voti.text
        assert voti.json()["voti"]["grades"][0]["subjectDesc"] == "MATEMATICA"

        # PC: avvia abbinamento
        start = pc.post("/pair/start", headers=PC_UA).json()
        code, pair_id = start["code"], start["pair_id"]
        assert len(code) == 9 and code[4] == "-"
        assert pc.post("/pair/status", json={"pair_id": pair_id}).json()["status"] == "pending"
        assert pc.get("/session/me").status_code == 401

        # Senza sessione non si può confermare
        assert pc.post("/pair/confirm", json={"code": code}).status_code == 401

        # Telefono: verifica e conferma (codice scritto in minuscolo e senza trattino)
        typed = code.replace("-", "").lower()
        look = phone.post("/pair/lookup", json={"code": typed})
        assert look.status_code == 200, look.text
        assert look.json()["device_label"] == "Chrome su Windows"
        assert phone.post("/pair/confirm", json={"code": typed}).status_code == 200

        # PC: riceve la sessione
        st = pc.post("/pair/status", json={"pair_id": pair_id})
        assert st.json()["status"] == "approved", st.text
        me_pc = pc.get("/session/me")
        assert me_pc.status_code == 200, me_pc.text
        assert me_pc.json()["username"] == "S7654321X"

        # Monouso
        assert pc.post("/pair/status", json={"pair_id": pair_id}).json()["status"] == "expired"
        assert phone.post("/pair/confirm", json={"code": code}).status_code == 404

        # Dispositivi: il telefono vede il PC e lo può scollegare
        devices = phone.get("/devices").json()["devices"]
        assert devices[0]["current"] is True
        pc_dev = next(d for d in devices if d["linked_via"] == "pairing")
        assert pc_dev["label"] == "Chrome su Windows"
        assert phone.post("/devices/revoke", json={"device_id": devices[0]["device_id"]}).status_code == 400
        assert phone.post("/devices/revoke", json={"device_id": pc_dev["device_id"]}).status_code == 200
        assert pc.get("/session/me").status_code == 401


def test_relogin_renews_linked_devices():
    with TestClient(main.app) as phone, TestClient(main.app) as pc:
        web_login(phone)
        start = pc.post("/pair/start", headers=PC_UA).json()
        phone.post("/pair/confirm", json={"code": start["code"]})
        pc.post("/pair/status", json={"pair_id": start["pair_id"]})
        # Il telefono rifà SPID: nuovo cookie; il PC deve usarlo senza nuovo abbinamento.
        assert web_login(phone, "spidcookieNEW1234567").status_code == 200
        pc_sid = pc.cookies.get("session_id")
        assert main.sessions[pc_sid]["user"].phpsessid == "spidcookieNEW1234567"


def test_spaggiari_session_expired_logs_out():
    with TestClient(main.app) as phone:
        web_login(phone)
        sid = phone.cookies.get("session_id")
        main.sessions[sid]["user"].update_session("expiredcookie1234567")
        main.sessions[sid]["card_cache"] = None
        main.sessions[sid]["me_cache"] = None
        main.upstream_cache.clear()
        r = phone.get("/session/me")
        assert r.status_code == 401, r.text
        assert sid not in main.sessions


def test_expired_code():
    with TestClient(main.app) as phone, TestClient(main.app) as pc:
        web_login(phone)
        start = pc.post("/pair/start").json()
        main.pairings[start["pair_id"]]["expires"] = 0
        assert phone.post("/pair/lookup", json={"code": start["code"]}).status_code == 404
        assert pc.post("/pair/status", json={"pair_id": start["pair_id"]}).json()["status"] == "expired"


if __name__ == "__main__":
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for t in tests:
        main.login_attempts.clear()
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} test passati")
