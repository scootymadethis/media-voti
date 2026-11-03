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
  --schema         stampa la struttura (solo chiavi e tipi) delle risposte che Aulera usa,
                   per confrontare le API web con quelle dell'app. Nessun dato personale.
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


def shape(value, depth: int = 0, max_depth: int = 4):
    """Struttura di un valore JSON SENZA i dati: chiavi, tipi e lunghezza delle liste."""
    if isinstance(value, dict):
        if depth >= max_depth:
            return f"dict({len(value)})"
        return {k: shape(v, depth + 1, max_depth) for k, v in sorted(value.items())}
    if isinstance(value, list):
        if not value:
            return "list(0)"
        return {f"list({len(value)}) di": shape(value[0], depth + 1, max_depth)}
    if value is None:
        return "null"
    return type(value).__name__


def schema_dump(session: requests.Session, student_id: str) -> None:
    """Confronta i percorsi stile app (v1) con quelli del sito (w1) sulle API web.

    Solo letture: nessuna richiesta modifica dati (niente 'segna come letto' ecc.).
    """
    import json
    from datetime import date, timedelta

    today = date.today()
    d_from = today.strftime("%Y%m%d")
    d_to = (today + timedelta(days=7)).strftime("%Y%m%d")
    s = f"{WEB}/rest/w1/students/{student_id}"
    # (nome Aulera, metodo, percorso stile v1, percorso alternativo w1 se diverso)
    checks = [
        ("card", "GET", f"{s}/card", None),
        ("voti", "GET", f"{s}/grades", f"{s}/grades26"),
        ("assenze", "GET", f"{s}/absences/details", f"{s}/absences/details/"),
        ("agenda", "GET", f"{s}/agenda/all/{d_from}/{d_to}", f"{s}/agendav2/all/{d_from}/{d_to}"),
        ("didattica", "GET", f"{s}/didactics", None),
        ("libri", "GET", f"{s}/schoolbooks", f"{s}/schoolbooks/index"),
        ("calendario", "GET", f"{s}/calendar/all", None),
        ("lezioni_oggi", "GET", f"{s}/lessons/today", None),
        ("lezioni_giorno", "GET", f"{s}/lessons/{d_from}", None),
        ("note", "GET", f"{s}/notes/all", f"{s}/notes/all/"),
        ("periods", "GET", f"{s}/periods", None),
        ("materie", "GET", f"{s}/subjects", None),
        ("noticeboard", "POST", f"{s}/noticeboard", None),
        ("noticeboard_get", "GET", f"{s}/noticeboard", None),
        ("documenti", "POST", f"{s}/documents", None),
    ]
    print("\n=== STRUTTURA DELLE RISPOSTE (nessun dato personale) ===")
    print("Copia tutto il blocco qui sotto e mandalo.\n----- INIZIO -----")
    for name, method, url, alt in checks:
        for label, target in (("stile-app", url), ("alternativo", alt)):
            if not target:
                continue
            try:
                r = session.request(method, target, timeout=20)
            except requests.RequestException as exc:
                print(f"[{name} {label}] errore di rete: {type(exc).__name__}")
                continue
            path = target.split(student_id, 1)[-1]
            line = f"[{name} {label}] {method} ...{path} -> HTTP {r.status_code}"
            if r.status_code == 200 and "json" in r.headers.get("Content-Type", ""):
                try:
                    line += "\n" + json.dumps(shape(r.json()), indent=1, ensure_ascii=False)
                except ValueError:
                    line += " (JSON non valido)"
            print(line)
    print("----- FINE -----")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--watch", type=int, default=0, metavar="MINUTI")
    parser.add_argument(
        "--schema",
        action="store_true",
        help="stampa la struttura (solo chiavi e tipi, nessun valore) delle risposte usate da Aulera",
    )
    args = parser.parse_args()

    phpsessid = os.getenv("CVV_PHPSESSID") or getpass.getpass("Valore del cookie PHPSESSID: ").strip()
    if not phpsessid:
        print("Nessun cookie fornito.")
        return 2

    session = requests.Session()
    session.headers["User-Agent"] = SERVER_UA
    session.cookies.set("PHPSESSID", phpsessid, domain=".spaggiari.eu", path="/")

    started = time.time()
    ok, student_id = check_once(session)
    print("\nRISULTATO:", "la sessione FUNZIONA dal server" if ok else "la sessione NON funziona dal server")
    if not ok:
        print("Possibili cause: cookie copiato male, sessione già scaduta, oppure sessione legata a IP/browser.")
        return 1
    if args.schema and student_id:
        schema_dump(session, student_id)

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
