"""Self-check cache/anti-burst di /session/me. Esegui: python scripts/test_session_me_cache.py"""
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main
from fastapi import HTTPException, Response


class FakeUser:
    uid = "TEST123"
    is_logged_in = True


def setup(monkey_card):
    """Crea una sessione e sostituisce la chiamata upstream raw con un contatore."""
    main._fetch_student_card_raw = monkey_card
    main.build_session_profile = lambda u, card_res=None: {"username": u.uid}
    sid = main.create_session(FakeUser())
    return sid


def test_burst_collapses_to_one_upstream_call():
    calls = {"n": 0}

    def fake_card(u):
        calls["n"] += 1
        return {}

    sid = setup(fake_card)

    def hit():
        main.session_me(Response(), session_id=sid)

    threads = [threading.Thread(target=hit) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert calls["n"] == 1, f"burst di 20 → attese 1 chiamata upstream, fatte {calls['n']}"


def test_within_ttl_no_new_call():
    calls = {"n": 0}
    sid = setup(lambda u: (calls.__setitem__("n", calls["n"] + 1), {})[1])

    main.session_me(Response(), session_id=sid)
    main.session_me(Response(), session_id=sid)
    assert calls["n"] == 1, f"entro TTL → 1 chiamata, fatte {calls['n']}"


def test_expired_cache_refetches():
    calls = {"n": 0}
    sid = setup(lambda u: (calls.__setitem__("n", calls["n"] + 1), {})[1])

    main.session_me(Response(), session_id=sid)
    # forza la scadenza di entrambe le cache (me_cache + card_cache condivisa)
    main.sessions[sid]["me_cache"] = (0, main.sessions[sid]["me_cache"][1])
    main.sessions[sid]["card_cache"] = (0, main.sessions[sid]["card_cache"][1])
    main.session_me(Response(), session_id=sid)
    assert calls["n"] == 2, f"dopo scadenza → 2 chiamate, fatte {calls['n']}"


def test_upstream_401_destroys_session():
    def boom(u):
        raise HTTPException(status_code=401, detail="scaduta")

    sid = setup(boom)
    try:
        main.session_me(Response(), session_id=sid)
        assert False, "atteso HTTPException 401"
    except HTTPException as e:
        assert e.status_code == 401
    assert sid not in main.sessions, "sessione doveva essere distrutta dopo 401 upstream"


def test_rate_limit_does_not_logout():
    """429 → UpstreamUnavailable: sessione resta viva, niente loop."""
    def rate_limited(u):
        raise main.UpstreamUnavailable("Spaggiari status 429")

    sid = setup(rate_limited)
    try:
        main.session_me(Response(), session_id=sid)
        assert False, "atteso UpstreamUnavailable"
    except main.UpstreamUnavailable as e:
        assert e.status_code == 503
    assert sid in main.sessions, "rate limit NON deve distruggere la sessione"


def test_rate_limit_serves_stale_card():
    """Prima card ok in cache, poi 429: si serve la copia vecchia, niente errore."""
    state = {"mode": "ok"}

    def flaky(u):
        if state["mode"] == "ok":
            return {"firstName": "Mario"}
        raise main.UpstreamUnavailable("Spaggiari status 429")

    sid = setup(flaky)
    main.session_me(Response(), session_id=sid)        # popola card_cache
    main.sessions[sid]["me_cache"] = (0, main.sessions[sid]["me_cache"][1])  # forza miss me
    state["mode"] = "429"
    res = main.session_me(Response(), session_id=sid)   # deve servire card stale
    assert res["authenticated"] is True
    assert sid in main.sessions


def test_card_endpoint_shares_cache():
    """/session/me e /card non devono fare due fetch upstream distinte."""
    calls = {"n": 0}
    sid = setup(lambda u: (calls.__setitem__("n", calls["n"] + 1), {})[1])

    main.session_me(Response(), session_id=sid)
    main.card(request=None, session_id=sid)
    assert calls["n"] == 1, f"/session/me + /card → 1 fetch, fatte {calls['n']}"


if __name__ == "__main__":
    test_burst_collapses_to_one_upstream_call()
    test_within_ttl_no_new_call()
    test_expired_cache_refetches()
    test_upstream_401_destroys_session()
    test_rate_limit_does_not_logout()
    test_rate_limit_serves_stale_card()
    test_card_endpoint_shares_cache()
    print("OK: cache condivisa, anti-burst, no-logout su rate-limit, stale-serve e 401 reale")
