"""Test di fattibilità: una sessione ClasseViva ottenuta con SPID/CIE funziona dal server?

Serve a decidere se Aulera può usare il login SPID/CIE fatto nell'app (WebView) e poi
"prestato" al backend. Va eseguito SUL SERVER di Aulera (IP diverso dal browser), con
la TUA sessione.

Come ottenere il cookie:
  1. Dal PC apri https://web.spaggiari.eu e accedi con "Entra con SPID" o "Entra con CIE".
  2. Strumenti per sviluppatori (F12) -> Applicazione/Archiviazione -> Cookie ->
     https://web.spaggiari.eu -> copia il valore di PHPSESSID.
  3. Sul server:  .venv/bin/python scripts/check_spid_session.py
     (il valore viene chiesto senza mostrarlo; in alternativa variabile CVV_PHPSESSID).

Opzioni:
  --watch MINUTI   ripete il controllo ogni 5 minuti per misurare quanto dura la sessione
                   (si ferma alla prima risposta non valida o dopo MINUTI minuti).

Lo script non stampa dati personali: solo codici HTTP, tipo di risposta e nomi dei campi.
Non salva il cookie da nessuna parte. Al termine fai logout da ClasseViva nel browser.
"""
from __future__ import annotations

import argparse
import getpass
import os
import sys
import time

import requests

WEB = "https://web.spaggiari.eu"
# User-Agent volutamente diverso da quello del browser: simula la richiesta dal backend.
SERVER_UA = "Aulera-session-check/1.0"


def describe(resp: requests.Response) -> str:
    ctype = resp.headers.get("Content-Type", "").split(";")[0]
    info = f"HTTP {resp.status_code}, {ctype or 'senza content-type'}"
    if resp.history:
        info += f", rediretto a {resp.url.split('?')[0]}"
    if "json" in ctype:
        try:
            data = resp.json()
            if isinstance(data, dict):
                info += f", campi: {sorted(data.keys())[:12]}"
        except ValueError:
            pass
    return info


def looks_logged_in(resp: requests.Response) -> bool:
    if resp.status_code != 200:
        return False
    if "login" in resp.url.lower():
        return False
    return "json" in resp.headers.get("Content-Type", "")


def find_student_id(data) -> str | None:
    """Cerca l'id numerico dello studente nella risposta di whoami senza stamparla."""
    if isinstance(data, dict):
        for key in ("id", "studentId", "ident", "usrId"):
            value = data.get(key)
            if value:
                digits = "".join(ch for ch in str(value) if ch.isdigit())
                if digits:
                    return digits
        for value in data.values():
            found = find_student_id(value)
            if found:
                return found
    elif isinstance(data, list):
        for item in data:
            found = find_student_id(item)
            if found:
                return found
    return None


def check_once(session: requests.Session) -> tuple[bool, str | None]:
    print("\n1) GET /rest/w1/misc/whoami (API web basate su cookie)")
    r = session.get(f"{WEB}/rest/w1/misc/whoami", timeout=20)
    print("   ", describe(r))
    ok = looks_logged_in(r)
    student_id = None
    if ok:
        try:
            student_id = find_student_id(r.json())
        except ValueError:
            pass
        print("    id studente trovato:", "sì" if student_id else "no")

    if student_id:
        print(f"\n2) GET /rest/w1/students/<id>/card")
        r2 = session.get(f"{WEB}/rest/w1/students/{student_id}/card", timeout=20)
        print("   ", describe(r2))

        print(f"\n3) GET /rest/v1/students/<id>/card con solo il cookie (API dell'app, di solito vogliono un token)")
        r3 = session.get(f"{WEB}/rest/v1/students/{student_id}/card", timeout=20)
        print("   ", describe(r3))
    return ok, student_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--watch", type=int, default=0, metavar="MINUTI")
    args = parser.parse_args()

    phpsessid = os.getenv("CVV_PHPSESSID") or getpass.getpass("Valore del cookie PHPSESSID: ").strip()
    if not phpsessid:
        print("Nessun cookie fornito.")
        return 2

    session = requests.Session()
    session.headers["User-Agent"] = SERVER_UA
    session.cookies.set("PHPSESSID", phpsessid, domain=".spaggiari.eu", path="/")

    started = time.time()
    ok, _ = check_once(session)
    print("\nRISULTATO:", "la sessione FUNZIONA dal server" if ok else "la sessione NON funziona dal server")
    if not ok:
        print("Possibili cause: cookie copiato male, sessione già scaduta, oppure sessione legata a IP/browser.")
        return 1

    if args.watch > 0:
        deadline = started + args.watch * 60
        print(f"\nControllo ogni 5 minuti per max {args.watch} minuti (Ctrl+C per fermare)...")
        try:
            while time.time() < deadline:
                time.sleep(300)
                r = session.get(f"{WEB}/rest/w1/misc/whoami", timeout=20)
                elapsed = int((time.time() - started) / 60)
                alive = looks_logged_in(r)
                print(f"  dopo {elapsed} min: {'valida' if alive else 'NON valida'} ({describe(r)})")
                if not alive:
                    print(f"\nLa sessione è durata circa {elapsed} minuti (con una richiesta ogni 5 minuti).")
                    return 0
        except KeyboardInterrupt:
            pass
        print(f"\nSessione ancora valida dopo {int((time.time() - started) / 60)} minuti.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
