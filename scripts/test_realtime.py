"""Self-check degli aggiornamenti in tempo reale (realtime.py, /ws/events).

Riusa gli studenti finti di test_friends (ClasseViva simulato, nessuna rete). Esegui:
    .venv/bin/python scripts/test_realtime.py
"""
import os
import queue
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_friends as tf  # noqa: E402  (imposta DB temporaneo e ClasseViva finto)

main = tf.main
TestClient = tf.TestClient


def listen(client):
    """Apre /ws/events e mette gli eventi in una coda letta con timeout."""
    q: "queue.Queue[dict]" = queue.Queue()
    ctx = client.websocket_connect("/ws/events")
    ws = ctx.__enter__()
    first = ws.receive_json()
    assert first["type"] == "ready", first

    def pump():
        try:
            while True:
                q.put(ws.receive_json())
        except Exception:
            pass

    threading.Thread(target=pump, daemon=True).start()
    return ctx, ws, q


def expect(q, pred, what, timeout=5.0):
    seen = []
    while True:
        try:
            ev = q.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError(f"evento non arrivato: {what} (visti: {seen})")
        seen.append(ev)
        if pred(ev):
            return ev


def main_test():
    main.init_db()
    giulia = tf.login("cookieGiulia00000001")
    marco = tf.login("cookieMarco000000001")

    with TestClient(main.app) as anon:
        try:
            with anon.websocket_connect("/ws/events") as ws:
                ws.receive_json()
            raise AssertionError("un anonimo non deve potersi collegare")
        except AssertionError:
            raise
        except Exception:
            pass  # rifiutato: ok

    g_ctx, g_ws, gq = listen(giulia)
    m_ctx, m_ws, mq = listen(marco)

    gcode = giulia.get("/friends").json()["me"]["code"]
    r = marco.post("/friends/requests", json={"code": gcode})
    assert r.status_code == 200, r.text
    ev = expect(gq, lambda e: e.get("type") == "friends" and e.get("action") == "request", "richiesta a Giulia")
    assert (ev.get("name") or "").lower() == "marco bellini", ev
    expect(mq, lambda e: e.get("type") == "friends" and e.get("action") == "sent", "conferma sugli altri dispositivi di Marco")

    req_id = giulia.get("/friends").json()["incoming"][0]["id"]
    assert giulia.post(f"/friends/requests/{req_id}/accept").status_code == 200
    ev = expect(mq, lambda e: e.get("type") == "friends" and e.get("action") == "accepted", "accettazione a Marco")
    assert (ev.get("name") or "").lower() == "giulia conti", ev
    expect(gq, lambda e: e.get("action") == "accepted_by_me", "accettazione sui dispositivi di Giulia")

    # Giulia cambia cosa condivide → Marco (amico) lo sa subito
    assert giulia.put("/friends/privacy", json={"level": "grades"}).status_code == 200
    expect(mq, lambda e: e.get("action") == "shared" and e.get("code") == gcode, "condivisione cambiata")

    # Preferenze e compiti fatti arrivano agli altri dispositivi dello stesso studente
    assert giulia.put("/preferenze", json={"accent": "blue"}).status_code == 200
    expect(gq, lambda e: e.get("type") == "prefs", "preferenze")

    # Notifiche: il sync (thread di keep-alive) pubblica le sezioni cambiate
    import notifications
    notifications._live("S7654321X", {"type": "notifiche", "kinds": ["voti"], "created": 1})
    expect(gq, lambda e: e.get("type") == "notifiche" and e.get("kinds") == ["voti"], "notifiche dal sync")

    # Rimozione: entrambi aggiornano la lista
    assert marco.delete(f"/friends/{gcode}").status_code == 200
    expect(gq, lambda e: e.get("action") == "removed", "rimozione")

    for ctx in (g_ctx, m_ctx):
        try:
            ctx.__exit__(None, None, None)
        except Exception:
            pass
    for c in (giulia, marco):
        c.__exit__(None, None, None)
    print("test_realtime: OK")


if __name__ == "__main__":
    main_test()
