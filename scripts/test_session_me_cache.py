"""Self-check cache/anti-burst di /session/me. Esegui: python scripts/test_session_me_cache.py"""
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main
from fastapi import HTTPException, Response


class FakeUser:
    uid = "TEST123"


def setup(monkey_card):
    """Crea una sessione e sostituisce le chiamate upstream con un contatore."""
    main.fetch_student_card_or_401 = monkey_card
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
    # forza la scadenza della cache
    main.sessions[sid]["me_cache"] = (0, main.sessions[sid]["me_cache"][1])
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


if __name__ == "__main__":
    test_burst_collapses_to_one_upstream_call()
    test_within_ttl_no_new_call()
    test_expired_cache_refetches()
    test_upstream_401_destroys_session()
    print("OK: cache, anti-burst, scadenza e 401 di /session/me funzionano")
