"""Self-check del client ClasseViva e di POST /login, con risposte Spaggiari simulate.

Non fa chiamate di rete. Esegui:
    DATABASE_PATH=/tmp/aulera-test/test.db .venv/bin/python scripts/test_classeviva_client.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("DATABASE_PATH", os.path.join(tempfile.mkdtemp(), "test.db"))
os.environ.setdefault("COOKIE_SECURE", "false")

import requests

import classeviva_client as cv


class FakeResponse:
    def __init__(self, status_code, payload=None, text=None):
        self.status_code = status_code
        self._payload = payload
        self.text = text if text is not None else (json.dumps(payload) if payload is not None else "")

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


captured = {}


def fake_post_factory(resp):
    def fake_post(url, headers=None, data=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        captured["data"] = data
        if isinstance(resp, Exception):
            raise resp
        return resp

    return fake_post


def run_login(resp, password="pw"):
    cv.requests.post = fake_post_factory(resp)
    user = cv.Utente("S1234567X")
    user.login(password)
    return user


def expect_error(resp, exc_type, contains=None):
    try:
        run_login(resp)
    except exc_type as e:
        if contains:
            assert contains in e.user_message, e.user_message
        return e
    raise AssertionError(f"atteso {exc_type.__name__}")


def test_success_and_json_escaping():
    tricky = 'pa"ss\\word'
    user = run_login(
        FakeResponse(200, {"ident": "S1234567X", "token": "tok", "firstName": "Mario", "expire": "x"}),
        password=tricky,
    )
    body = json.loads(captured["data"])
    assert body == {"ident": None, "pass": tricky, "uid": "S1234567X"}, body
    assert captured["url"].endswith("/rest/v1/auth/login")
    assert user.is_logged_in and user.ident == "1234567" and user.token == "tok"
    assert not hasattr(user, "pwd"), "la password non deve restare in memoria"
    assert user.get_headers()["Z-Auth-Token"] == "tok"


def test_wrong_password():
    expect_error(FakeResponse(422, {"statusCode": 422, "error": "422 Unprocessable Entity", "message": "wrong credentials"}), cv.InvalidCredentials)


def test_spid_required():
    e = expect_error(
        FakeResponse(403, {"error": "403 Forbidden", "message": "Accesso consentito solo tramite SPID o CIE"}),
        cv.DigitalIdentityRequired,
        contains="SPID",
    )
    assert e.status_code == 403


def test_apikey_rate_limit_and_down():
    expect_error(FakeResponse(400, {"error": "apikey.3", "message": "invalid apikey"}), cv.ClasseVivaUnavailable, "chiave")
    expect_error(FakeResponse(429, text="Too many"), cv.ClasseVivaUnavailable, "Troppi tentativi")
    expect_error(FakeResponse(502, text="<html>bad gateway</html>"), cv.ClasseVivaUnavailable)
    expect_error(requests.ConnectionError("boom"), cv.ClasseVivaUnavailable)


def test_200_without_token():
    expect_error(FakeResponse(200, {"actionRequested": "changePasswordDialog"}), cv.ClasseVivaUnavailable)


def test_login_endpoint():
    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as client:
        cv.requests.post = fake_post_factory(
            FakeResponse(403, {"message": "Utente abilitato solo con identità digitale SPID/CIE"})
        )
        r = client.post("/login", json={"username": "S1111111X", "password": "x"})
        assert r.status_code == 403, r.text
        assert "SPID" in r.json()["detail"]
        assert "session_id" not in r.cookies

        cv.requests.post = fake_post_factory(FakeResponse(422, {"message": "wrong credentials"}))
        r = client.post("/login", json={"username": "S2222222X", "password": "x"})
        assert r.status_code == 401, r.text
        assert "Credenziali non valide" in r.json()["detail"]

        cv.requests.post = fake_post_factory(FakeResponse(200, {"ident": "S3333333X", "token": "t"}))
        r = client.post("/login", json={"username": "S3333333X", "password": "x"})
        assert r.status_code == 200 and r.json()["ok"] is True, r.text
        assert "session_id" in r.cookies


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} test passati")
