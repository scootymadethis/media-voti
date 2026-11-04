"""Self-check di sincronizzazione periodica e notifiche (notifications.py).

ClasseViva è simulato e cambia nel tempo: nessuna chiamata di rete. Esegui:
    .venv/bin/python scripts/test_notifications.py
"""
import copy
import json
import os
import sys
import tempfile
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
# DB sempre isolato: il test conta tutte le sessioni presenti nel DB.
os.environ["DATABASE_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ["CLASSEVIVA_KEEPALIVE_SECONDS"] = "0"
os.environ["NOTIF_CALL_PAUSE"] = "0"
os.environ["NOTIF_MIN_SYNC_GAP"] = "0"

import requests  # noqa: E402

import classeviva_client as cv  # noqa: E402

TODAY = date.today()


def day(n):
    return (TODAY + timedelta(days=n)).isoformat()


def initial_data():
    return {
        "grades": [
            {"evtId": 1, "subjectDesc": "MATEMATICA", "decimalValue": 8.0, "displayValue": "8", "evtDate": day(-5),
             "componentDesc": "Scritto", "periodPos": 1, "noAverage": False, "canceled": False},
            {"evtId": 2, "subjectDesc": "STORIA", "decimalValue": 6.0, "displayValue": "6", "evtDate": day(-3),
             "componentDesc": "Orale", "periodPos": 1, "noAverage": False, "canceled": False},
        ],
        "noticeboard": [{"pubId": 500, "pubDT": f"{day(-4)}T10:00:00+01:00", "cntTitle": "Assemblea di istituto",
                         "cntCategory": "Circolare", "evtCode": "CF", "readStatus": False}],
        "notes": {"NTTE": [{"evtId": 70, "authorName": "ROSSI ANNA", "evtDate": day(-8), "evtText": "x"}],
                  "NTCL": [], "NTWN": [], "NTST": []},
        "agenda": [{"evtId": 900, "evtCode": "AGHW", "evtDatetimeBegin": f"{day(2)}T08:00:00+01:00", "subjectDesc": "INFORMATICA",
                    "notes": "Esercizi pag. 12"}],
        "absences": [{"evtId": 300, "evtCode": "ABA0", "evtDate": day(-10), "isJustified": True}],
        "didactics": [{"teacherId": "A1", "teacherName": "VERDI LUCA", "folders": [
            {"folderId": 7, "folderName": "Reti", "contents": [{"contentId": 4001, "contentName": "Slide subnetting"}]}]}],
    }


STUDENTS = {
    "cookieAAAAAAAAAAAAAAAA": {"ident": "1111111", "nome": "Giulia", "cognome": "Conti", "data": initial_data()},
    "cookieBBBBBBBBBBBBBBBB": {"ident": "2222222", "nome": "Marco", "cognome": "Bellini", "data": initial_data()},
}
MODE = {"value": "ok"}  # ok | expired | down | 503
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
        return copy.deepcopy(self._payload)

    def close(self):
        pass

    def iter_content(self, chunk_size=1):
        return iter(())


def fake_upstream(method, url, headers=None, **kwargs):
    cookie = (headers or {}).get("Cookie", "").replace("PHPSESSID=", "")
    student = STUDENTS.get(cookie)
    calls.append((cookie, url.split("/rest/w1", 1)[-1]))
    if MODE["value"] == "down":
        raise requests.ConnectionError("rete giù")
    if MODE["value"] == "503":
        return FakeResponse(503, {"error": "busy"})
    if student is None or MODE["value"] == "expired":
        return FakeResponse(302, None, "text/html")
    sid, d = student["ident"], student["data"]
    if url.endswith("/misc/whoami"):
        return FakeResponse(200, {"id": f"S{sid}", "nome": student["nome"], "cognome": student["cognome"], "account_type": "S"})
    base = f"/rest/w1/students/{sid}"
    if base not in url:
        return FakeResponse(404, {"error": "wrong student"})
    p = url.split(base, 1)[1]
    if p == "/card":
        return FakeResponse(200, {"card": {"ident": f"S{sid}X", "firstName": student["nome"], "lastName": student["cognome"]}})
    if p == "/grades":
        return FakeResponse(200, {"grades": d["grades"]})
    if p == "/noticeboard":
        return FakeResponse(200, {"items": d["noticeboard"]})
    if p == "/notes/all":
        return FakeResponse(200, d["notes"])
    if p.startswith("/agenda/all/"):
        return FakeResponse(200, {"agenda": d["agenda"]})
    if p == "/absences/details":
        return FakeResponse(200, {"events": d["absences"]})
    if p == "/didactics":
        return FakeResponse(200, {"didacticts": d["didactics"]})
    return FakeResponse(200, {})


cv.requests.get = lambda url, headers=None, **kw: fake_upstream("GET", url, headers, **kw)
cv.requests.request = lambda method, url, headers=None, **kw: fake_upstream(method, url, headers, **kw)

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
import notifications as nt  # noqa: E402

A, B = "cookieAAAAAAAAAAAAAAAA", "cookieBBBBBBBBBBBBBBBB"
UA = {"User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"}


def login(client, cookie):
    r = client.post("/login/web-session", json={"phpsessid": cookie}, headers=UA)
    assert r.status_code == 200, r.text
    return r.json()["user"]


def session_user(username):
    with main.sessions_lock:
        for sess in main.sessions.values():
            if sess["username"] == username:
                return sess["user"]
    raise AssertionError("sessione non trovata")


def notifs(username):
    with main.get_db_connection() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM notifications WHERE username = ? ORDER BY id", (nt._uname(username),))]


def paths_since(n, cookie=A):
    return [p.split("/", 3)[-1] if p.startswith("/students/") else p for c, p in calls[n:] if c == cookie]


def reset_rate_limits():
    nt._last_sync.clear()
    nt._last_manual.clear()


def main_test():
    with TestClient(main.app) as ca, TestClient(main.app) as cb:
        ua = login(ca, A)
        ub = login(cb, B)
        assert ua == "S1111111X" and ub == "S2222222X", (ua, ub)
        user_a = session_user(ua)
        da = STUDENTS[A]["data"]

        # --- primo sync: scarica tutte le sezioni, nessuna notifica, snapshot dei voti salvato
        n0 = len(calls)
        assert nt.sync_session(user_a, ua) is True
        first = paths_since(n0)
        assert len(first) == 6, first
        assert notifs(ua) == [], notifs(ua)
        assert set(nt._sync_state(ua)) == set(nt.KINDS)
        snap = main.get_user_year_snapshot(username=ua, school_year=main.current_school_year(), kind="voti")
        assert snap and len(snap["grades"]) == 2, snap
        assert ca.get("/notifiche/conteggio").json() == {"ok": True, "unread": 0, "latest_id": 0}

        # --- novità: voto, comunicazione, nota (le note sono a giri alterni)
        da["grades"].append({"evtId": 3, "subjectDesc": "LINGUA E LETTERATURA ITALIANA", "decimalValue": 7.5, "displayValue": "7½",
                             "evtDate": day(0), "componentDesc": "Scritto", "canceled": False})
        da["noticeboard"].insert(0, {"pubId": 501, "pubDT": f"{day(0)}T09:00:00+01:00", "cntTitle": "Uscita didattica classi quinte",
                                     "cntCategory": "Comunicazione", "evtCode": "CF"})
        da["notes"]["NTCL"].append({"evtId": 71, "authorName": "VERDI LUCA", "evtDate": day(0)})
        n1 = len(calls)
        assert nt.sync_session(user_a, ua) is True  # giro 1: voti, bacheca, agenda, assenze
        round1 = paths_since(n1)
        assert len(round1) == 4 and not any("notes" in p or "didactics" in p for p in round1), round1
        got = notifs(ua)
        assert [n["kind"] for n in got] == ["voti", "bacheca"], got
        assert got[0]["title"] == "Nuovo voto in Lingua e letteratura italiana", got[0]
        assert got[0]["body"].startswith("Voto 7½ · Scritto · oggi"), got[0]
        assert got[1]["title"] == "Nuova comunicazione" and got[1]["body"] == "Uscita didattica classi quinte"
        assert got[1]["url"] == "/bacheca?id=501", got[1]
        n2 = len(calls)
        assert nt.sync_session(user_a, ua) is True  # giro 2: voti, bacheca, note, didattica
        round2 = paths_since(n2)
        assert any("notes" in p for p in round2) and any("didactics" in p for p in round2), round2
        got = notifs(ua)
        assert got[-1]["kind"] == "note" and got[-1]["title"] == "Nuova nota disciplinare", got[-1]
        assert got[-1]["body"].startswith("Da Verdi Luca"), got[-1]
        assert len(got) == 3, got  # niente doppioni

        # --- raggruppamento: 4 voti insieme → una notifica
        for i, (s, v) in enumerate([("MATEMATICA", "9"), ("STORIA", "5-"), ("LINGUA INGLESE", "7"), ("INFORMATICA", "10")]):
            da["grades"].append({"evtId": 10 + i, "subjectDesc": s, "displayValue": v, "decimalValue": 7, "evtDate": day(0), "canceled": False})
        nt.sync_session(user_a, ua)
        last = notifs(ua)[-1]
        assert last["title"] == "4 nuovi voti" and "e altri 1" in last["body"], last
        assert last["url"] == "/voti"

        # --- agenda, assenze, didattica (forzando tutte le sezioni)
        da["agenda"].append({"evtId": 901, "evtCode": "AGNT", "evtDatetimeBegin": f"{day(1)}T08:00:00+01:00",
                             "subjectDesc": "MATEMATICA", "notes": "Verifica scritta sulle derivate"})
        da["absences"].append({"evtId": 301, "evtCode": "ABR0", "evtDate": day(0), "evtHPos": 2, "isJustified": False})
        da["didactics"][0]["folders"][0]["contents"].append({"contentId": 4002, "contentName": "Esercizi VLAN"})
        before = len(notifs(ua))
        alive, created = nt.run_sync(user_a, ua, force_all=True)
        assert alive is True and created == 3, (alive, created)
        new = {n["kind"]: n for n in notifs(ua)[before:]}
        assert new["agenda"]["title"] == "Nuova verifica di Matematica" and new["agenda"]["body"].startswith("Domani · Verifica"), new
        assert new["assenze"]["title"] == "Ritardo registrato" and "2ª ora" in new["assenze"]["body"] and "da giustificare" in new["assenze"]["body"], new
        assert new["didattica"]["url"] == "/didattica?cartella=A1~7" and "Esercizi VLAN" in new["didattica"]["body"], new

        # --- agenda: un evento vecchio che entra ora nella finestra dei 14 giorni non è "nuovo"
        with main.get_db_connection() as conn:
            conn.execute("UPDATE notif_sync_state SET meta = ? WHERE username = ? AND kind = 'agenda'",
                         (json.dumps({"end": day(10)}), nt._uname(ua)))
            conn.commit()
        da["agenda"].append({"evtId": 902, "evtCode": "AGHW", "evtDatetimeBegin": f"{day(13)}T08:00:00+01:00", "subjectDesc": "STORIA", "notes": "Cap. 4"})
        before = len(notifs(ua))
        nt.run_sync(user_a, ua, force_all=True)
        assert len(notifs(ua)) == before, notifs(ua)[before:]

        # --- preferenze: voti disattivati → nessuna notifica, ma il voto è "visto"
        r = ca.get("/notifiche/preferenze")
        assert r.json()["prefs"] == {k: True for k in nt.KINDS}, r.text
        r = ca.put("/notifiche/preferenze", json={"voti": False})
        assert r.json()["prefs"]["voti"] is False and r.json()["prefs"]["bacheca"] is True, r.text
        da["grades"].append({"evtId": 20, "subjectDesc": "STORIA", "displayValue": "8", "evtDate": day(0), "canceled": False})
        before = len(notifs(ua))
        nt.sync_session(user_a, ua)
        assert len(notifs(ua)) == before
        ca.put("/notifiche/preferenze", json={"voti": True})
        nt.sync_session(user_a, ua)
        assert len(notifs(ua)) == before, "riattivare i voti non deve notificare il voto già visto"
        assert cb.get("/notifiche/preferenze").json()["prefs"]["voti"] is True  # preferenze per utente

        # --- API: elenco, paginazione, conteggio, lette
        total = len(notifs(ua))
        r = ca.get("/notifiche?limit=3").json()
        assert len(r["items"]) == 3 and r["has_more"] and r["unread"] == total, r
        ids = [it["id"] for it in r["items"]]
        assert ids == sorted(ids, reverse=True)
        assert set(r["items"][0]) >= {"id", "kind", "title", "body", "url", "created_at", "read"}
        r2 = ca.get(f"/notifiche?limit=50&before_id={ids[-1]}").json()
        assert all(it["id"] < ids[-1] for it in r2["items"]) and len(r2["items"]) == total - 3
        c = ca.get("/notifiche/conteggio").json()
        assert c["unread"] == total and c["latest_id"] == ids[0], c
        r = ca.post("/notifiche/letto", json={"ids": ids[:2]}).json()
        assert r["unread"] == total - 2, r
        assert [it["read"] for it in ca.get("/notifiche?limit=3").json()["items"]] == [True, True, False]

        # --- isolamento: B non vede né può segnare le notifiche di A
        assert cb.get("/notifiche").json()["items"] == []
        cb.post("/notifiche/letto", json={"ids": ids})
        cb.post("/notifiche/letto", json={"all": True})
        assert ca.get("/notifiche/conteggio").json()["unread"] == total - 2
        user_b = session_user(ub)
        nt.sync_session(user_b, ub)
        STUDENTS[B]["data"]["grades"].append({"evtId": 99, "subjectDesc": "FISICA", "displayValue": "6", "evtDate": day(0)})
        nt.sync_session(user_b, ub)
        assert [n["title"] for n in notifs(ub)] == ["Nuovo voto in Fisica"]
        assert cb.get("/notifiche/conteggio").json()["unread"] == 1
        assert ca.get("/notifiche/conteggio").json()["unread"] == total - 2
        r = ca.post("/notifiche/letto", json={"all": True}).json()
        assert r["unread"] == 0 and cb.get("/notifiche/conteggio").json()["unread"] == 1

        # --- sync manuale con limite 1/minuto
        reset_rate_limits()
        da["noticeboard"].insert(0, {"pubId": 502, "pubDT": f"{day(0)}T11:00:00+01:00", "cntTitle": "Sciopero", "cntCategory": "Avviso"})
        r = ca.post("/notifiche/sincronizza")
        assert r.status_code == 200 and r.json()["new"] == 1 and r.json()["unread"] == 1, r.text
        assert notifs(ua)[-1]["title"] == "Nuovo avviso"
        r = ca.post("/notifiche/sincronizza")
        assert r.status_code == 429 and "riprova" in r.json()["detail"], r.text

        # --- rete giù / 5xx → None (sessione non toccata)
        MODE["value"] = "down"
        assert nt.sync_session(user_a, ua) is None
        MODE["value"] = "503"
        assert nt.sync_session(user_a, ua) is None
        reset_rate_limits()
        assert ca.post("/notifiche/sincronizza").status_code == 503
        MODE["value"] = "ok"
        assert ca.get("/notifiche/conteggio").status_code == 200

        # --- pulizia: massimo 200 notifiche per utente
        for i in range(230):
            nt.add_notification(ub, "bacheca", f"Test {i}", "", "/bacheca")
        assert len(notifs(ub)) == 200 and notifs(ub)[-1]["title"] == "Test 229"
        assert len(notifs(ua)) > 0  # l'altro utente non viene toccato

        # --- keep-alive con utente nuovo (senza ident): l'ident si recupera dal DB
        fresh = cv.WebSessionUtente(B)
        assert nt.sync_session(fresh, ub) is True and fresh.ident == "2222222"

        # --- sessione rifiutata → False; il keep-alive chiude i dispositivi
        MODE["value"] = "expired"
        assert nt.sync_session(user_a, ua) is False
        reset_rate_limits()
        outcome = main.keepalive_pass()
        assert outcome["expired"] == 2, outcome
        assert ca.get("/notifiche/conteggio").status_code == 401
        MODE["value"] = "ok"

        # --- sync manuale con sessione rifiutata → 401
        reset_rate_limits()
        login(ca, A)
        MODE["value"] = "expired"
        r = ca.post("/notifiche/sincronizza")
        assert r.status_code == 401, r.text
        MODE["value"] = "ok"

        # --- senza sessione → 401
        with TestClient(main.app) as anon:
            assert anon.get("/notifiche").status_code == 401
            assert anon.get("/notifiche/conteggio").status_code == 401


def test_texts():
    today = date(2026, 11, 4)  # mercoledì
    assert nt.day_label("2026-11-04", today) == "Oggi"
    assert nt.day_label("2026-11-05T08:00:00+01:00", today) == "Domani"
    assert nt.day_label("2026-11-09", today) == "Lunedì 9 nov"
    assert nt.subject_name("LINGUA E LETTERATURA ITALIANA") == "Lingua e letteratura italiana"
    assert nt.subject_name("TPSIT") == "TPSIT"
    assert nt.person_name("ROSSI ANNA") == "Rossi Anna"
    out = nt._build("bacheca", [{"pubId": i, "cntTitle": f"Circolare {i}"} for i in range(3)], today)
    assert out == [("3 nuove comunicazioni", "Circolare 0, Circolare 1 e altri 1", "/bacheca")], out
    out = nt._build("note", [{"_type": "NTTE"}, {"_type": "NTTE"}, {"_type": "NTCL"}], today)
    assert out[0][0] == "3 nuove note" and out[0][1] == "2 annotazioni, 1 nota disciplinare", out
    assert nt._build("voti", [{"evtId": 1, "canceled": True, "displayValue": "4"}], today) == []


if __name__ == "__main__":
    test_texts()
    main_test()
    print("OK: test notifiche superati")
