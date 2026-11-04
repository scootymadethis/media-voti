"""Self-check di Amici e condivisione dei voti (friends.py).

ClasseViva è simulato: nessuna chiamata di rete. Esegui:
    .venv/bin/python scripts/test_friends.py
"""
import json
import os
import re
import sys
import tempfile
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ["DATABASE_PATH"] = os.path.join(tempfile.mkdtemp(), "friends-test.db")
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ["CLASSEVIVA_KEEPALIVE_SECONDS"] = "0"

import classeviva_client as cv  # noqa: E402

TODAY = date.today()


def day(n):
    return (TODAY - timedelta(days=n)).isoformat()


def grade(subject, value, days_ago, **extra):
    g = {"subjectDesc": subject, "decimalValue": value, "displayValue": str(value), "evtDate": day(days_ago),
         "periodPos": 1, "periodDesc": "Primo periodo", "componentPos": 1, "noAverage": False, "canceled": False,
         "color": "green", "notesForFamily": "NOTA PRIVATA", "teacherName": "PROF SEGRETO"}
    g.update(extra)
    return g


# Studenti finti: cookie -> (id, nome, cognome, voti)
GIULIA_GRADES = [
    grade("MATEMATICA", 8, 2),
    grade("MATEMATICA", 5, 40),
    grade("LINGUA E LETTERATURA ITALIANA", 7, 30),
    grade("RELIGIONE CATTOLICA", 10, 3),                 # esclusa
    grade("STORIA", 9, 4, color="blue"),                 # voto blu: escluso
    grade("STORIA", None, 5, displayValue="A"),          # assente: escluso
    grade("STORIA", 2, 6, canceled=True),                # annullato: escluso
    grade("STORIA", 3, 7, noAverage=True),               # non fa media: escluso
]
MARCO_GRADES = [grade("MATEMATICA", 6, 1), grade("LINGUA E LETTERATURA ITALIANA", 9, 25), grade("STORIA", 7.5, 33)]
STUDENTS = {
    "cookieGiulia00000001": ("7654321", "GIULIA", "CONTI", GIULIA_GRADES),
    "cookieMarco000000001": ("1000001", "MARCO", "BELLINI", MARCO_GRADES),
    "cookieLuca0000000001": ("2000002", "LUCA", "MORETTI", [grade("MATEMATICA", 4, 2)]),
    "cookieAltra000000001": ("3000003", "SARA", "ALTRACLASSE", [grade("MATEMATICA", 9, 2)]),
}


class FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = {"Content-Type": "application/json" if payload is not None else "text/html"}
        self.text = json.dumps(payload) if payload is not None else ""

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    def iter_content(self, chunk_size=1):
        yield b""

    def close(self):
        pass


def fake_upstream(method, url, headers=None, **kwargs):
    cookie = (headers or {}).get("Cookie", "")
    student = next((s for c, s in STUDENTS.items() if cookie == f"PHPSESSID={c}"), None)
    if student is None:
        return FakeResponse(302, None)
    sid, first, last, grades = student
    if url.endswith("/misc/whoami"):
        return FakeResponse(200, {"id": f"S{sid}", "nome": first, "cognome": last, "account_type": "S"})
    if url.endswith(f"/students/{sid}/card"):
        return FakeResponse(200, {"card": {"ident": f"S{sid}X", "firstName": first, "lastName": last, "schCode": "VRIT0007"}})
    if url.endswith(f"/students/{sid}/grades"):
        return FakeResponse(200, {"grades": grades})
    return FakeResponse(200, {})


cv.requests.get = lambda url, headers=None, **kw: fake_upstream("GET", url, headers, **kw)
cv.requests.post = lambda url, headers=None, **kw: fake_upstream("POST", url, headers, **kw)
cv.requests.request = lambda method, url, headers=None, **kw: fake_upstream(method, url, headers, **kw)

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

main.requests.get = cv.requests.get
main.requests.post = cv.requests.post
import friends  # noqa: E402

CODE_RE = re.compile(r"^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$")
LEVEL_KEYS = {
    "none": {"level"},
    "average": {"level", "has_data", "updated_at", "general_average", "trend"},
    "subjects": {"level", "has_data", "updated_at", "general_average", "trend", "count", "subjects"},
    "grades": {"level", "has_data", "updated_at", "general_average", "trend", "count", "subjects", "grades"},
}


def seed_leaderboards():
    year = main.current_school_year()
    rows = [
        ("S7654321X", "Giulia Conti", "5EI", True),
        ("S1000001X", "Marco Bellini", "5EI", True),
        ("S2000002X", "Luca Moretti", "5EI", True),
        ("S3000003X", "Sara Altraclasse", "4EI", True),   # altra classe
        ("S4000004X", "Lucia Nascosta", "5EI", False),    # non visibile
    ]
    for user, name, cls, visible in rows:
        main.upsert_leaderboard_entry(username=user, full_name=name, class_code=cls, school_code="VRIT0007",
                                      hours=3.0, visible_in_leaderboard=visible, school_year=year)


def login(cookie):
    c = TestClient(main.app)
    c.__enter__()
    r = c.post("/login/web-session", json={"phpsessid": cookie})
    assert r.status_code == 200, r.text
    assert c.post("/voti").status_code == 200  # salva lo snapshot dell'anno in corso
    return c


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def main_test():
    main.init_db()
    seed_leaderboards()
    giulia = login("cookieGiulia00000001")
    marco = login("cookieMarco000000001")
    luca = login("cookieLuca0000000001")

    # --- non loggato
    with TestClient(main.app) as anon:
        check(anon.get("/friends").status_code == 401, "anonimo deve ricevere 401")
        check(anon.post("/friends/requests", json={"code": "AAAA-BBBB"}).status_code == 401, "anon request")

    # --- codice amico stabile e leggibile
    g = giulia.get("/friends").json()
    gcode = g["me"]["code"]
    check(CODE_RE.match(gcode), f"codice non valido: {gcode}")
    check(giulia.get("/friends").json()["me"]["code"] == gcode, "il codice deve essere stabile")
    check(g["me"]["privacy"] == "none", "privacy di default chiusa")
    check(g["me"]["name"] == "Giulia Conti" and g["me"]["class_code"] == "5EI", g["me"])
    check(g["me"]["has_snapshot"] is True and g["me"]["updated_at"], "snapshot proprio + timestamp")
    check("username" not in json.dumps(g) and "7654321" not in json.dumps(g), "gli username non devono uscire")
    mcode = marco.get("/friends").json()["me"]["code"]
    lcode = luca.get("/friends").json()["me"]["code"]
    check(len({gcode, mcode, lcode}) == 3, "codici distinti")

    # alias: S7654321X, 7654321 e G7654321 sono la stessa persona
    with main.db_lock, main.get_db_connection() as conn:
        for alias in ("7654321", "G7654321", " s7654321x "):
            row = friends._ensure_user_row(conn, username=alias)
            check(friends.format_code(row["code"]) == gcode, f"alias {alias} duplicato")
        conn.commit()

    # --- codici invalidi
    check(marco.post("/friends/lookup", json={"code": "abc"}).status_code == 400, "formato invalido")
    check(marco.post("/friends/lookup", json={"code": "OOOO-1111"}).status_code == 400, "0/O/1/I esclusi")
    check(marco.post("/friends/lookup", json={"code": "ZZZZ-ZZZZ"}).status_code == 404, "codice inesistente")
    check(marco.post("/friends/requests", json={"code": mcode}).status_code == 400, "non puoi aggiungere te stesso")
    look = marco.post("/friends/lookup", json={"code": gcode.replace("-", "").lower()})
    check(look.status_code == 200 and look.json()["person"]["name"] == "Giulia Conti" and look.json()["status"] == "none", look.text)
    check(set(look.json()["person"]) == {"code", "name", "class_code", "badges"}, look.json())

    # --- richiesta: prima di accettare nessuno vede niente
    r = marco.post("/friends/requests", json={"code": gcode.lower().replace("-", " ")})
    check(r.status_code == 200 and r.json()["status"] == "outgoing", r.text)
    req_id = r.json()["id"]
    check(marco.post("/friends/requests", json={"code": gcode}).status_code == 409, "doppia richiesta")
    check(marco.get(f"/friends/{gcode}").status_code == 404, "non ancora amici: niente dati")
    gi = giulia.get("/friends").json()
    check([x["name"] for x in gi["incoming"]] == ["Marco Bellini"], gi["incoming"])
    check(marco.get("/friends").json()["outgoing"][0]["code"] == gcode, "richiesta inviata visibile")
    check(luca.post(f"/friends/requests/{req_id}/accept").status_code == 404, "un terzo non può accettare")
    check(marco.post(f"/friends/requests/{req_id}/accept").status_code == 404, "il mittente non può accettare")
    check(giulia.post(f"/friends/requests/{req_id}/accept").status_code == 200, "accetta")

    # --- amici; privacy chiusa per default
    mf = marco.get("/friends").json()["friends"]
    check(len(mf) == 1 and mf[0]["code"] == gcode and mf[0]["shares"] == "none", mf)
    check(mf[0]["general_average"] is None and mf[0]["trend"] is None, "con privacy none niente media")
    d = marco.get(f"/friends/{gcode}").json()
    check(set(d["shared"]) == LEVEL_KEYS["none"], d["shared"])
    check(d["comparison"] is None, "niente confronto")

    # --- ogni livello: mai oltre il consentito
    expected_avg = round((8 + 5 + 7) / 3, 2)
    for level in friends.LEVELS:
        check(giulia.put("/friends/privacy", json={"level": level}).status_code == 200, level)
        shared = marco.get(f"/friends/{gcode}").json()["shared"]
        check(set(shared) == LEVEL_KEYS[level], f"{level}: chiavi {set(shared)}")
        blob = json.dumps(shared)
        check("NOTA PRIVATA" not in blob and "PROF SEGRETO" not in blob, "note e docenti non si condividono")
        if level != "none":
            check(shared["general_average"] == expected_avg, f"media {shared['general_average']} != {expected_avg}")
            check(shared["updated_at"], "timestamp dello snapshot")
            check(shared["trend"] == round(expected_avg - 6.0, 2), f"tendenza {shared['trend']}")
        if level in ("subjects", "grades"):
            subs = {s["name"]: s for s in shared["subjects"]}
            check(set(subs) == {"MATEMATICA", "LINGUA E LETTERATURA ITALIANA"}, subs)  # Religione/Storia esclusi
            check(subs["MATEMATICA"]["average"] == 6.5 and subs["MATEMATICA"]["count"] == 2, subs)
        if level == "grades":
            check(len(shared["grades"]) == len(GIULIA_GRADES), shared["grades"])
            check(shared["grades"][0]["date"] == day(2), "ordinati dal più recente")
            excluded = [x for x in shared["grades"] if not x["counted"]]
            check(len(excluded) == 5, excluded)
        fl = marco.get("/friends").json()["friends"][0]
        check(fl["shares"] == level, fl)
        check((fl["general_average"] is None) == (level == "none"), fl)
    check(giulia.put("/friends/privacy", json={"level": "tutto"}).status_code == 422, "livello invalido")

    # massimo 30 voti
    many = [grade("MATEMATICA", 7, i) for i in range(45)]
    main.save_user_year_snapshot(username="S7654321X", school_year=main.current_school_year(), kind="voti",
                                 payload={"grades": many})
    check(len(marco.get(f"/friends/{gcode}").json()["shared"]["grades"]) == 30, "solo gli ultimi 30 voti")
    main.save_user_year_snapshot(username="S7654321X", school_year=main.current_school_year(), kind="voti",
                                 payload={"grades": GIULIA_GRADES})

    # --- eccezione per amico
    check(giulia.put(f"/friends/{mcode}/privacy", json={"level": "average"}).status_code == 200, "override")
    shared = marco.get(f"/friends/{gcode}").json()["shared"]
    check(set(shared) == LEVEL_KEYS["average"], f"override non rispettato: {set(shared)}")
    check(giulia.get(f"/friends/{mcode}").json()["my_override"] == "average", "override visibile a chi lo imposta")
    check(giulia.put(f"/friends/{mcode}/privacy", json={"level": None}).status_code == 200, "reset override")
    check(set(marco.get(f"/friends/{gcode}").json()["shared"]) == LEVEL_KEYS["grades"], "torna al globale")
    check(luca.put(f"/friends/{gcode}/privacy", json={"level": "grades"}).status_code == 404, "override solo tra amici")

    # --- confronto solo se entrambi condividono le medie per materia
    check(marco.get(f"/friends/{gcode}").json()["comparison"] is None, "Marco non condivide: niente confronto")
    marco.put("/friends/privacy", json={"level": "subjects"})
    cmp_ = marco.get(f"/friends/{gcode}").json()["comparison"]
    check(cmp_ and {s["name"] for s in cmp_["subjects"]} == {"MATEMATICA", "LINGUA E LETTERATURA ITALIANA", "STORIA"}, cmp_)
    storia = next(s for s in cmp_["subjects"] if s["name"] == "STORIA")
    check(storia["friend"] is None and storia["me"] == 7.5, storia)  # Giulia non ha medie in Storia
    check(cmp_["me"] == round((6 + 9 + 7.5) / 3, 2) and cmp_["friend"] == expected_avg, cmp_)
    # Giulia vede le medie per materia di Marco ma non i suoi voti
    check(set(giulia.get(f"/friends/{mcode}").json()["shared"]) == LEVEL_KEYS["subjects"], "livello di Marco")

    # --- un non-amico non vede niente
    check(luca.get(f"/friends/{gcode}").status_code == 404, "non-amico: 404")
    check(luca.delete(f"/friends/{gcode}").status_code == 404, "non-amico: niente rimozione")
    check(luca.get("/friends").json()["friends"] == [], "Luca non ha amici")

    # --- ricerca: stessa classe e scuola, solo righe visibili
    res = giulia.get("/friends/search", params={"q": "luc"}).json()["items"]
    check([x["name"] for x in res] == ["Luca Moretti"], res)  # niente Lucia (nascosta) né altre classi
    check(res[0]["code"] == lcode and res[0]["status"] == "none", res)
    check(giulia.get("/friends/search", params={"q": "sara"}).json()["items"] == [], "altra classe esclusa")
    check(giulia.get("/friends/search", params={"q": "giulia"}).json()["items"] == [], "se stessi esclusi")
    res = giulia.get("/friends/search", params={"q": "bell mar"}).json()["items"]
    check(res and res[0]["status"] == "friend", res)
    check(giulia.get("/friends/search", params={"q": "l"}).json()["items"] == [], "query troppo corta")

    # --- rifiuto e attesa prima di poter richiedere di nuovo
    r = luca.post("/friends/requests", json={"code": gcode})
    check(r.status_code == 200, r.text)
    check(giulia.post(f"/friends/requests/{r.json()['id']}/decline").status_code == 200, "rifiuta")
    check(luca.post("/friends/requests", json={"code": gcode}).status_code == 429, "cooldown dopo il rifiuto")
    check(luca.get(f"/friends/{gcode}").status_code == 404, "rifiutato: niente dati")

    # --- richiesta reciproca = amicizia
    r = luca.post("/friends/requests", json={"code": mcode})
    check(r.status_code == 200 and r.json()["status"] == "outgoing", r.text)
    r = marco.post("/friends/requests", json={"code": lcode})
    check(r.status_code == 200 and r.json()["status"] == "friend", r.text)
    check(luca.get(f"/friends/{mcode}").status_code == 200, "amici dopo richiesta reciproca")

    # --- annulla richiesta inviata
    with main.db_lock, main.get_db_connection() as conn:
        x = friends._ensure_user_row(conn, username="S5000005X", full_name="Extra Uno")
        conn.commit()
    r = luca.post("/friends/requests", json={"code": x["code"]})
    check(marco.delete(f"/friends/requests/{r.json()['id']}").status_code == 404, "solo il mittente annulla")
    check(luca.delete(f"/friends/requests/{r.json()['id']}").status_code == 200, "annulla")
    check(luca.get("/friends").json()["outgoing"] == [], "annullata")

    # --- blocco
    check(marco.post("/friends/blocks", json={"code": lcode}).status_code == 200, "blocca")
    check(marco.get(f"/friends/{lcode}").status_code == 404 and luca.get(f"/friends/{mcode}").status_code == 404, "blocco toglie l'amicizia")
    check(luca.post("/friends/requests", json={"code": mcode}).status_code == 404, "bloccato non può richiedere")
    check(luca.post("/friends/lookup", json={"code": mcode}).status_code == 404, "bloccato non vede chi è")
    check(marco.post("/friends/requests", json={"code": lcode}).status_code == 409, "chi blocca deve sbloccare")
    check(marco.get("/friends").json()["blocked"][0]["code"] == lcode, "elenco bloccati")
    check(marco.delete(f"/friends/blocks/{lcode}").status_code == 200, "sblocca")
    check(marco.get("/friends").json()["blocked"] == [], "sbloccato")

    # --- rimuovi amico
    check(marco.delete(f"/friends/{gcode}").status_code == 200, "rimuovi")
    check(marco.get(f"/friends/{gcode}").status_code == 404 and giulia.get(f"/friends/{mcode}").status_code == 404, "rimosso")
    check(giulia.get("/friends").json()["friends"] == [], "rimosso da entrambi")

    # --- limiti: richieste in sospeso, rate limit, numero di amici, codici sbagliati
    extra = []
    with main.db_lock, main.get_db_connection() as conn:
        for i in range(8):
            extra.append(friends._ensure_user_row(conn, username=f"S90000{i:02d}X", full_name=f"Extra {i}")["code"])
        conn.commit()
    old = (friends.MAX_PENDING, friends.REQUEST_RATE_MAX, friends.MAX_FRIENDS, friends.LOOKUP_FAIL_MAX)
    try:
        friends.MAX_PENDING = 2
        with main.db_lock, main.get_db_connection() as conn:
            conn.execute("DELETE FROM friend_request_log")
            conn.commit()
        check(giulia.post("/friends/requests", json={"code": extra[0]}).status_code == 200, "1")
        check(giulia.post("/friends/requests", json={"code": extra[1]}).status_code == 200, "2")
        r = giulia.post("/friends/requests", json={"code": extra[2]})
        check(r.status_code == 429 and "attesa" in r.json()["detail"], r.text)
        friends.MAX_PENDING = 20
        friends.REQUEST_RATE_MAX = 3
        check(giulia.post("/friends/requests", json={"code": extra[2]}).status_code == 200, "3")
        r = giulia.post("/friends/requests", json={"code": extra[3]})
        check(r.status_code == 429 and "troppe" in r.json()["detail"], r.text)
        friends.REQUEST_RATE_MAX = 100
        friends.MAX_FRIENDS = 1
        with main.db_lock, main.get_db_connection() as conn:
            friends._make_friends(conn, "7654321", friends.user_key("S9000007X"))
            conn.commit()
        r = giulia.post("/friends/requests", json={"code": lcode})
        check(r.status_code == 409 and "limite" in r.json()["detail"], r.text)
        r = luca.post("/friends/requests", json={"code": gcode})
        check(r.status_code == 409, f"l'altro ha già troppi amici: {r.text}")
        friends.LOOKUP_FAIL_MAX = 3
        friends._lookup_fails.clear()
        for _ in range(3):
            luca.post("/friends/lookup", json={"code": "ZZZZ-ZZZZ"})
        check(luca.post("/friends/lookup", json={"code": gcode}).status_code == 429, "troppi codici sbagliati")
    finally:
        friends.MAX_PENDING, friends.REQUEST_RATE_MAX, friends.MAX_FRIENDS, friends.LOOKUP_FAIL_MAX = old
        friends._lookup_fails.clear()

    # --- anteprima di cosa vedono gli amici e snapshot senza timestamp
    giulia.put("/friends/privacy", json={"level": "average"})
    p = giulia.get("/friends/preview").json()
    check(set(p["shared"]) == LEVEL_KEYS["average"], p)
    check(set(giulia.get("/friends/preview", params={"level": "grades"}).json()["shared"]) == LEVEL_KEYS["grades"], "preview livello")
    check(friends._payload_timestamp({"grades": []}) is None, "timestamp sconosciuto")
    check(friends.compute_stats([])["general_average"] is None, "nessun voto")

    for c in (giulia, marco, luca):
        c.__exit__(None, None, None)
    print("test_friends: OK")


if __name__ == "__main__":
    main_test()
