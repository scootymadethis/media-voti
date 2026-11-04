"""Novità dal registro e notifiche (router incluso da main.py).

Contratto con main.py:
- `router`: APIRouter con le route.
- `init_tables(conn)`: crea le tabelle (chiamata da main.init_db()).
- `sync_session(user, username) -> Optional[bool]`: chiamata dal thread di keep-alive di main per
  ogni sessione ClasseViva in uso. Scarica le sezioni, confronta con lo stato salvato, crea le
  notifiche. Deve restituire True (sessione valida), False (ClasseViva ha rifiutato la sessione)
  o None (non verificabile: rete, 429, 5xx). Se non è implementata, main usa user.ping().

Come funziona
- Ogni giro di keep-alive (CLASSEVIVA_KEEPALIVE_SECONDS, default 600 s) scarica voti e bacheca;
  note e agenda a giri alterni, assenze e didattica ogni tre giri (3–4 chiamate per giro, con una
  pausa tra l'una e l'altra). Una sezione mai vista viene scaricata subito e registrata come
  "già vista" senza notificare (primo sync = linea di base).
- Le novità diventano righe in `notifications` (max 200 per utente, 60 giorni). I tipi disattivati
  nelle preferenze vengono comunque segnati come visti: riattivarli non produce una raffica.
- Le route non hanno il prefisso /api (lo toglie Nginx) e si autenticano col cookie `session_id`,
  quindi funzionano anche dal worker nativo dell'app Android.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import date, datetime, timedelta
from typing import Any, Optional

import requests
from fastapi import APIRouter, Cookie, Depends, HTTPException, Query
from pydantic import BaseModel, Field

router = APIRouter()

KINDS = ("voti", "bacheca", "note", "agenda", "assenze", "didattica")
# Ogni quanti giri scaricare la sezione e con che sfasamento (per distribuire le chiamate).
SCHEDULE = {"voti": (1, 0), "bacheca": (1, 0), "note": (2, 0), "agenda": (2, 1), "assenze": (3, 1), "didattica": (3, 2)}
CALL_PAUSE = float(os.getenv("NOTIF_CALL_PAUSE", "0.4"))
MIN_SYNC_GAP = float(os.getenv("NOTIF_MIN_SYNC_GAP", "60"))  # due cookie dello stesso utente: un solo sync
MANUAL_SYNC_GAP = float(os.getenv("NOTIF_MANUAL_SYNC_GAP", "60"))
BASELINE_DELAY = float(os.getenv("NOTIF_BASELINE_DELAY", "15"))
MAX_PER_USER = 200
MAX_AGE_SECONDS = 60 * 86400
GROUP_AT = 3  # da 3 novità dello stesso tipo in su: una sola notifica riassuntiva
AGENDA_DAYS = 14

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_rounds: dict[str, int] = {}
_last_sync: dict[str, float] = {}
_last_manual: dict[str, float] = {}
_baseline_started: dict[str, float] = {}
_failing: dict[str, set] = {}


def _core():
    import main as core  # import pigro: main importa questo modulo alla fine

    return core


def _uname(username: Any) -> str:
    return str(username or "").strip().upper()


def _user_lock(key: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = _locks[key] = threading.Lock()
        return lock


# ====================================================================== tabelle
def init_tables(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            read INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(username, id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS notif_seen (
            username TEXT NOT NULL,
            kind TEXT NOT NULL,
            item_key TEXT NOT NULL,
            seen_at REAL NOT NULL,
            PRIMARY KEY (username, kind, item_key)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS notif_sync_state (
            username TEXT NOT NULL,
            kind TEXT NOT NULL,
            synced_at REAL NOT NULL,
            meta TEXT,
            PRIMARY KEY (username, kind)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS notif_prefs (
            username TEXT PRIMARY KEY,
            prefs TEXT NOT NULL,
            updated_at REAL NOT NULL
        )
        """
    )


def _db():
    return _core().get_db_connection()


def get_prefs(username: str) -> dict[str, bool]:
    prefs = {k: True for k in KINDS}
    with _db() as conn:
        row = conn.execute("SELECT prefs FROM notif_prefs WHERE username = ?", (_uname(username),)).fetchone()
    if row:
        try:
            saved = json.loads(row["prefs"]) or {}
            prefs.update({k: bool(v) for k, v in saved.items() if k in prefs})
        except (TypeError, ValueError):
            pass
    return prefs


def set_prefs(username: str, changes: dict[str, Optional[bool]]) -> dict[str, bool]:
    core = _core()
    with core.db_lock:
        prefs = get_prefs(username)
        prefs.update({k: bool(v) for k, v in changes.items() if k in prefs and v is not None})
        with _db() as conn:
            conn.execute(
                """INSERT INTO notif_prefs (username, prefs, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT(username) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at""",
                (_uname(username), json.dumps(prefs), time.time()),
            )
            conn.commit()
    return prefs


def _sync_state(username: str) -> dict[str, dict]:
    with _db() as conn:
        rows = conn.execute("SELECT kind, synced_at, meta FROM notif_sync_state WHERE username = ?", (_uname(username),)).fetchall()
    out = {}
    for r in rows:
        try:
            meta = json.loads(r["meta"]) if r["meta"] else {}
        except (TypeError, ValueError):
            meta = {}
        out[r["kind"]] = {"synced_at": r["synced_at"], "meta": meta}
    return out


def has_baseline(username: str) -> bool:
    with _db() as conn:
        return conn.execute("SELECT 1 FROM notif_sync_state WHERE username = ? LIMIT 1", (_uname(username),)).fetchone() is not None


def counts(username: str) -> dict[str, int]:
    with _db() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(read = 0), 0) AS unread, COALESCE(MAX(id), 0) AS latest FROM notifications WHERE username = ?",
            (_uname(username),),
        ).fetchone()
    return {"unread": int(row["unread"] or 0), "latest_id": int(row["latest"] or 0)}


def add_notification(username: str, kind: str, title: str, body: str = "", url: str = "", *, conn=None,
                     created_at: Optional[float] = None) -> int:
    """Inserisce una notifica (usata dal sync e dai test/strumenti di sviluppo)."""
    args = (_uname(username), kind, title[:160], body[:400], url[:300], created_at or time.time())
    sql = "INSERT INTO notifications (username, kind, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    if conn is not None:
        return conn.execute(sql, args).lastrowid
    core = _core()
    with core.db_lock:
        with _db() as c:
            nid = c.execute(sql, args).lastrowid
            _prune(c, _uname(username))
            c.commit()
    return nid


def _prune(conn, uname: str) -> None:
    conn.execute(
        """DELETE FROM notifications WHERE username = ? AND (created_at < ? OR id NOT IN (
               SELECT id FROM notifications WHERE username = ? ORDER BY id DESC LIMIT ?))""",
        (uname, time.time() - MAX_AGE_SECONDS, uname, MAX_PER_USER),
    )


# ====================================================================== testi
_MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"]
_DAYS = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]
_SMALL = {"e", "ed", "di", "del", "della", "dei", "delle", "degli", "da", "dal", "dalla", "a", "al", "alla", "ai",
          "in", "con", "per", "su", "tra", "fra", "il", "lo", "la", "le", "gli", "i", "o"}
_KEEP_UPPER = {"IRC", "TPSIT", "TPSI", "CLIL", "PCTO", "ICT", "IT", "UE", "ER"}


def subject_name(s: Any) -> str:
    words = str(s or "").strip().split()
    out = []
    for i, w in enumerate(words):
        if w.upper() in _KEEP_UPPER and w == w.upper():
            out.append(w.upper())
        elif i == 0:
            out.append(w[:1].upper() + w[1:].lower())
        else:
            out.append(w.lower())
    return " ".join(out)


def person_name(s: Any) -> str:
    return re.sub(r"(^|[\s'’(-])(\w)", lambda m: m.group(1) + m.group(2).upper(), str(s or "").strip().lower())


def _parse_day(value: Any) -> Optional[date]:
    m = re.match(r"^(\d{4})-?(\d{2})-?(\d{2})", str(value or ""))
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def day_label(value: Any, today: Optional[date] = None) -> str:
    """'Oggi', 'Domani', 'Ieri', 'Lunedì 10 nov'."""
    d = _parse_day(value)
    if not d:
        return ""
    today = today or date.today()
    diff = (d - today).days
    if diff == 0:
        return "Oggi"
    if diff == 1:
        return "Domani"
    if diff == -1:
        return "Ieri"
    label = f"{_DAYS[d.weekday()]} {d.day} {_MONTHS[d.month - 1]}"
    return label[:1].upper() + label[1:]


def _clip(s: Any, n: int = 90) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _join_preview(parts: list[str], limit: int = 3) -> str:
    parts = [p for p in parts if p]
    if len(parts) <= limit:
        return ", ".join(parts)
    return ", ".join(parts[:limit]) + f" e altri {len(parts) - limit}"


# ====================================================================== estrazione per sezione
NOTE_TYPES = {
    "NTTE": ("annotazione", "annotazioni", "Nuova annotazione"),
    "NTCL": ("nota disciplinare", "note disciplinari", "Nuova nota disciplinare"),
    "NTWN": ("richiamo", "richiami", "Nuovo richiamo"),
    "NTST": ("sanzione disciplinare", "sanzioni disciplinari", "Nuova sanzione disciplinare"),
}
ABSENCE_TYPES = {
    "ABA0": ("assenza", "assenze", "Assenza registrata"),
    "ABR0": ("ritardo", "ritardi", "Ritardo registrato"),
    "ABR1": ("ritardo breve", "ritardi brevi", "Ritardo breve registrato"),
    "ABU0": ("uscita anticipata", "uscite anticipate", "Uscita anticipata registrata"),
}
_TEST_RE = re.compile(r"verific|compito in classe|interrogazion|\btest\b|prova scritta|prova orale", re.IGNORECASE)


def _items(kind: str, data: Any) -> dict[str, dict]:
    """Elementi della sezione indicizzati per chiave stabile."""
    out: dict[str, dict] = {}
    if not isinstance(data, dict):
        return out
    if kind == "voti":
        for g in data.get("grades") or []:
            if isinstance(g, dict) and g.get("evtId") is not None:
                out[str(g["evtId"])] = g
    elif kind == "bacheca":
        for n in data.get("items") or []:
            if isinstance(n, dict) and n.get("pubId") is not None:
                out[str(n["pubId"])] = n
    elif kind == "note":
        for code, notes in data.items():
            if not isinstance(notes, list):
                continue
            for n in notes:
                if isinstance(n, dict) and n.get("evtId") is not None:
                    out[f"{code}:{n['evtId']}"] = {**n, "_type": code}
    elif kind == "agenda":
        for ev in data.get("agenda") or []:
            if isinstance(ev, dict) and ev.get("evtId") is not None:
                out[str(ev["evtId"])] = ev
    elif kind == "assenze":
        for ev in data.get("events") or []:
            if isinstance(ev, dict) and ev.get("evtId") is not None:
                out[f"{ev.get('evtCode') or ''}:{ev['evtId']}"] = ev
    elif kind == "didattica":
        teachers = data.get("didacticts") or data.get("didactics") or []
        for ti, t in enumerate(teachers if isinstance(teachers, list) else []):
            if not isinstance(t, dict):
                continue
            teacher = person_name(t.get("teacherName") or " ".join(filter(None, [t.get("teacherLastName"), t.get("teacherFirstName")])))
            tid = str(t.get("teacherId") if t.get("teacherId") is not None else f"t{ti}")
            for fi, f in enumerate(t.get("folders") or []):
                if not isinstance(f, dict):
                    continue
                folder_key = f"{tid}~{f.get('folderId') if f.get('folderId') is not None else fi}"
                for c in f.get("contents") or []:
                    if isinstance(c, dict) and c.get("contentId") is not None:
                        out[str(c["contentId"])] = {**c, "_teacher": teacher, "_folder": folder_key}
    return out


def _grade_label(g: dict) -> str:
    return str(g.get("displayValue") or "").strip() or "—"


def _build(kind: str, new: list[dict], today: date) -> list[tuple[str, str, str]]:
    """(titolo, testo, url) per le novità di un tipo; raggruppa da GROUP_AT in su."""
    if kind == "voti":
        new = [g for g in new if not g.get("canceled")]
    if kind == "bacheca":
        new = [n for n in new if str(n.get("cntStatus") or "").lower() != "deleted"]
    if not new:
        return []
    many = len(new) >= GROUP_AT
    if kind == "voti":
        new.sort(key=lambda g: str(g.get("evtDate") or ""), reverse=True)
        if many:
            preview = _join_preview([f"{subject_name(g.get('subjectDesc'))} {_grade_label(g)}" for g in new])
            return [(f"{len(new)} nuovi voti", preview, "/voti")]
        out = []
        for g in new:
            bits = [f"Voto {_grade_label(g)}", str(g.get("componentDesc") or "").strip(), day_label(g.get("evtDate"), today).lower()]
            out.append((f"Nuovo voto in {subject_name(g.get('subjectDesc')) or 'una materia'}", " · ".join(b for b in bits if b), "/voti"))
        return out
    if kind == "bacheca":
        new.sort(key=lambda n: str(n.get("pubDT") or ""), reverse=True)
        if many:
            return [(f"{len(new)} nuove comunicazioni", _join_preview([_clip(n.get("cntTitle"), 60) for n in new], 2), "/bacheca")]
        out = []
        for n in new:
            cat = str(n.get("cntCategory") or "").strip().lower()
            title = "Nuova circolare" if cat.startswith("circolar") else "Nuovo avviso" if cat.startswith("avvis") else "Nuova comunicazione"
            out.append((title, _clip(n.get("cntTitle") or "Senza titolo", 140), f"/bacheca?id={n.get('pubId')}"))
        return out
    if kind == "note":
        if many:
            by_type: dict[str, int] = {}
            for n in new:
                by_type[n["_type"]] = by_type.get(n["_type"], 0) + 1
            parts = [_plural(c, *NOTE_TYPES.get(t, ("nota", "note", ""))[:2]) for t, c in by_type.items()]
            return [(f"{len(new)} nuove note", _join_preview(parts, 4), "/note")]
        out = []
        for n in new:
            title = NOTE_TYPES.get(n["_type"], ("", "", "Nuova nota"))[2]
            bits = [f"Da {person_name(n.get('authorName'))}" if n.get("authorName") else "", day_label(n.get("evtDate"), today).lower()]
            out.append((title, " · ".join(b for b in bits if b), "/note"))
        return out
    if kind == "agenda":
        new.sort(key=lambda e: str(e.get("evtDatetimeBegin") or ""))
        is_test = lambda e: e.get("evtCode") != "AGHW" and bool(_TEST_RE.search(str(e.get("notes") or "")))  # noqa: E731
        if many:
            hw = sum(1 for e in new if e.get("evtCode") == "AGHW")
            tests = sum(1 for e in new if is_test(e))
            other = len(new) - hw - tests
            parts = [_plural(hw, "compito", "compiti") if hw else "", _plural(tests, "verifica", "verifiche") if tests else "",
                     _plural(other, "evento", "eventi") if other else ""]
            return [(f"{len(new)} novità in agenda", _join_preview(parts, 3), "/agenda")]
        out = []
        for e in new:
            subj = subject_name(e.get("subjectDesc"))
            if e.get("evtCode") == "AGHW":
                title = f"Nuovo compito di {subj}" if subj else "Nuovo compito"
            elif is_test(e):
                title = f"Nuova verifica di {subj}" if subj else "Nuova verifica"
            else:
                title = f"Nuovo evento: {subj}" if subj else "Nuovo evento in agenda"
            bits = [day_label(e.get("evtDatetimeBegin"), today), _clip(e.get("notes"), 90)]
            out.append((title, " · ".join(b for b in bits if b), "/agenda"))
        return out
    if kind == "assenze":
        new.sort(key=lambda e: str(e.get("evtDate") or ""), reverse=True)
        if many:
            by_type: dict[str, int] = {}
            for e in new:
                by_type[e.get("evtCode") or ""] = by_type.get(e.get("evtCode") or "", 0) + 1
            parts = [_plural(c, *ABSENCE_TYPES.get(t, ("evento", "eventi", ""))[:2]) for t, c in by_type.items()]
            return [(f"{len(new)} nuovi eventi in assenze", _join_preview(parts, 4), "/assenze")]
        out = []
        for e in new:
            title = ABSENCE_TYPES.get(e.get("evtCode") or "", ("", "", "Nuovo evento registrato"))[2]
            hpos = e.get("evtHPos")
            bits = [day_label(e.get("evtDate"), today), f"{hpos}ª ora" if hpos else "",
                    "da giustificare" if not e.get("isJustified") else ""]
            out.append((title, " · ".join(b for b in bits if b), "/assenze"))
        return out
    if kind == "didattica":
        if many:
            return [(f"{len(new)} nuovi materiali didattici", _join_preview([_clip(c.get("contentName"), 50) for c in new], 3), "/didattica")]
        return [("Nuovo materiale didattico", " · ".join(b for b in [_clip(c.get("contentName") or "Senza nome", 100), c.get("_teacher")] if b),
                 f"/didattica?cartella={c.get('_folder')}") for c in new]
    return []


# ====================================================================== sync
def _ensure_ident(user, username: str) -> str:
    ident = str(getattr(user, "ident", "") or "").strip()
    if ident:
        return ident
    core = _core()
    try:
        key = core.session_store.cookie_key(user.phpsessid)
        with _db() as conn:
            row = conn.execute(
                "SELECT ident FROM auth_sessions WHERE cookie_key = ? AND COALESCE(ident, '') <> '' LIMIT 1", (key,)
            ).fetchone()
        if row:
            ident = str(row["ident"]).strip()
    except Exception:  # noqa: BLE001 - tabella/chiave non disponibile: provo dallo username
        ident = ""
    if not ident:
        ident = "".join(ch for ch in str(username or "") if ch.isdigit())
    if ident:
        user.ident = ident
    return ident


def _fetch(user, kind: str, today: date) -> tuple[str, Any]:
    """('ok', dati) | ('expired', None) | ('unavailable', None) | ('error', None)."""
    if kind == "agenda":
        path = f"/agenda/all/{today:%Y%m%d}/{today + timedelta(days=AGENDA_DAYS):%Y%m%d}"
    else:
        path = {"voti": "/grades", "bacheca": "/noticeboard", "note": "/notes/all", "assenze": "/absences/details",
                "didattica": "/didactics"}[kind]
    try:
        resp = user.call("GET", path, timeout=20)
    except requests.RequestException:
        return "unavailable", None
    status = int(getattr(resp, "status_code", 0) or 0)
    if status == 401 or 300 <= status < 400:
        return "expired", None
    if status == 429 or status >= 500 or status == 0:
        return "unavailable", None
    if kind == "agenda" and status == 422:  # fuori anno scolastico
        return "ok", {"agenda": []}
    if status != 200:
        return "error", None
    try:
        return "ok", resp.json()
    except ValueError:
        return "error", None


def _invalidate_route_caches(username: str, kinds: set[str]) -> None:
    """Le route tengono 5 minuti di cache: dopo una novità la svuoto, così toccando la notifica si vede."""
    core = _core()
    try:
        user_key = core._cache_user_key_from_values(username)
        keys = []
        if "voti" in kinds:
            keys.append(core._cache_key(["cvv-request", user_key, "voti", []]))
        if "assenze" in kinds:
            keys.append(core._cache_key(["cvv-request", user_key, "assenze", []]))
        for kind, path in (("bacheca", "/noticeboard"), ("note", "/notes/all"), ("didattica", "/didactics")):
            if kind in kinds:
                keys.append(core._cache_key(["cvv-w1", user_key, "GET", path]))
        with core.upstream_cache_lock:
            for k in keys:
                core.upstream_cache.pop(k, None)
    except Exception:  # noqa: BLE001 - solo un'ottimizzazione
        pass


def _due_kinds(round_no: int, state: dict, force_all: bool, failing: set = frozenset()) -> list[str]:
    due = []
    for kind in KINDS:
        every, offset = SCHEDULE[kind]
        first_time = kind not in state and kind not in failing
        if force_all or first_time or round_no % every == offset % every:
            due.append(kind)
    return due


def _process(username: str, kind: str, data: Any, state: dict, prefs: dict, today: date) -> tuple[int, bool]:
    """Confronta con il visto, registra, crea le notifiche. Ritorna (notifiche create, ci sono novità)."""
    core = _core()
    uname = _uname(username)
    items = _items(kind, data)
    now = time.time()
    baseline = kind not in state
    meta: dict = {}
    if kind == "agenda":
        meta = {"end": (today + timedelta(days=AGENDA_DAYS)).isoformat()}
    created = 0
    with core.db_lock:
        with _db() as conn:
            seen = set()
            keys = list(items)
            for i in range(0, len(keys), 500):
                chunk = keys[i:i + 500]
                q = ",".join("?" for _ in chunk)
                seen.update(r[0] for r in conn.execute(
                    f"SELECT item_key FROM notif_seen WHERE username = ? AND kind = ? AND item_key IN ({q})", (uname, kind, *chunk)
                ).fetchall())
            new_keys = [k for k in keys if k not in seen]
            conn.executemany(
                "INSERT OR IGNORE INTO notif_seen (username, kind, item_key, seen_at) VALUES (?, ?, ?, ?)",
                [(uname, kind, k, now) for k in new_keys],
            )
            notify = [items[k] for k in new_keys]
            if kind == "agenda" and not baseline:
                # Solo ciò che è stato davvero aggiunto: non gli eventi già in calendario che
                # entrano ora nella finestra di 14 giorni, né quelli già passati.
                prev_end = _parse_day((state.get(kind) or {}).get("meta", {}).get("end")) or today
                notify = [e for e in notify if (d := _parse_day(e.get("evtDatetimeBegin"))) and today <= d <= prev_end]
            if not baseline and prefs.get(kind, True):
                for title, body, url in _build(kind, notify, today):
                    add_notification(uname, kind, title, body, url, conn=conn, created_at=now)
                    created += 1
                if created:
                    _prune(conn, uname)
            conn.execute(
                """INSERT INTO notif_sync_state (username, kind, synced_at, meta) VALUES (?, ?, ?, ?)
                   ON CONFLICT(username, kind) DO UPDATE SET synced_at = excluded.synced_at, meta = excluded.meta""",
                (uname, kind, now, json.dumps(meta)),
            )
            conn.commit()
    return created, bool(new_keys) and not baseline


def _save_snapshots(username: str, kind: str, data: Any) -> None:
    core = _core()
    try:
        if kind == "voti" and core.payload_has_grades(data):
            core.save_user_year_snapshot(username=username, school_year=core.current_school_year(), kind="voti", payload=data)
        elif kind == "assenze" and core.payload_has_absences(data):
            core.save_user_year_snapshot(username=username, school_year=core.current_school_year(), kind="assenze", payload=data)
    except Exception as exc:  # noqa: BLE001
        print(f"[notifiche] snapshot {kind} non salvato: {exc}")


def run_sync(user, username: str, *, force_all: bool = False) -> tuple[Optional[bool], int]:
    """Sincronizza un utente. Ritorna (esito come sync_session, notifiche create)."""
    if not hasattr(user, "call"):
        ping = getattr(user, "ping", None)
        return (ping() if callable(ping) else None), 0
    uname = _uname(username)
    if not uname or not _ensure_ident(user, username):
        return user.ping(), 0
    state = _sync_state(uname)
    prefs = get_prefs(uname)
    today = date.today()
    round_no = _rounds.get(uname, 0)
    created = 0
    any_ok = False
    changed: set[str] = set()
    failing = _failing.setdefault(uname, set())
    for i, kind in enumerate(_due_kinds(round_no, state, force_all, failing)):
        if i and CALL_PAUSE > 0:
            time.sleep(CALL_PAUSE)
        status, data = _fetch(user, kind, today)
        if status == "expired":
            return False, created
        if status == "unavailable":
            break  # rete/429/5xx: niente altre chiamate in questo giro
        if status != "ok":
            failing.add(kind)  # es. sezione disattivata dalla scuola: riprovo solo al suo turno
            continue
        failing.discard(kind)
        any_ok = True
        _save_snapshots(str(username).strip(), kind, data)
        n, has_new = _process(uname, kind, data, state, prefs, today)
        created += n
        if has_new:
            changed.add(kind)
    if any_ok:
        _rounds[uname] = round_no + 1
        _last_sync[uname] = time.time()
    if changed:
        _invalidate_route_caches(str(username).strip(), changed)
        _live(username, {"type": "notifiche", "kinds": sorted(changed), "created": created})
    # Una sezione arrivata basta a dire che la sessione è viva (anche se un'altra ha dato 5xx).
    return (True if any_ok else None), created


def _live(username: str, event: dict) -> None:
    """Avvisa subito i dispositivi aperti dello studente (realtime.py)."""
    try:
        import realtime
        realtime.publish_user(username, event)
    except Exception:
        pass


def sync_session(user, username: str) -> Optional[bool]:
    """Chiamata dal keep-alive: sostituisce il ping. Non solleva mai eccezioni."""
    try:
        uname = _uname(username)
        lock = _user_lock(uname)
        recent = time.time() - _last_sync.get(uname, 0) < MIN_SYNC_GAP
        if recent or not lock.acquire(blocking=False):
            # Stesso studente con un altro cookie, o sync manuale in corso: basta tenerlo vivo.
            return user.ping()
        try:
            alive, _ = run_sync(user, username)
            return alive
        finally:
            lock.release()
    except Exception as exc:  # noqa: BLE001 - il thread di keep-alive non deve morire
        print(f"[notifiche] sync non riuscito: {exc}")
        return None


def _maybe_start_baseline(user, username: str) -> None:
    """Dopo il login: prima linea di base subito (dopo una breve attesa), non al prossimo keep-alive."""
    core = _core()
    uname = _uname(username)
    if core.KEEPALIVE_INTERVAL <= 0 or not hasattr(user, "call"):
        return
    if time.time() - _baseline_started.get(uname, 0) < 600 or has_baseline(uname):
        return
    _baseline_started[uname] = time.time()

    def work():
        time.sleep(BASELINE_DELAY)  # lascia passare le richieste della prima schermata
        if has_baseline(uname):
            return
        alive = sync_session(user, username)
        if alive is False:
            core.end_classeviva_session(getattr(user, "phpsessid", None), "scaduta")

    threading.Thread(target=work, name=f"notif-baseline-{uname}", daemon=True).start()


# ====================================================================== API
def _session_user(session_id: Optional[str] = Cookie(default=None)):
    return _core().get_session_user(session_id)


def _row(r) -> dict:
    return {"id": r["id"], "kind": r["kind"], "title": r["title"], "body": r["body"], "url": r["url"],
            "created_at": r["created_at"], "read": bool(r["read"])}


@router.get("/notifiche")
def list_notifications(
    limit: int = Query(default=50, ge=1, le=200),
    before_id: Optional[int] = Query(default=None, ge=1),
    u=Depends(_session_user),
):
    username = _core().get_session_username(u)
    uname = _uname(username)
    _maybe_start_baseline(u, username)
    sql = "SELECT * FROM notifications WHERE username = ?"
    args: list[Any] = [uname]
    if before_id:
        sql += " AND id < ?"
        args.append(before_id)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit + 1)
    with _db() as conn:
        rows = conn.execute(sql, args).fetchall()
    c = counts(uname)
    return {"ok": True, "items": [_row(r) for r in rows[:limit]], "has_more": len(rows) > limit, **c,
            "last_sync": _last_sync.get(uname)}


@router.get("/notifiche/conteggio")
def count_notifications(u=Depends(_session_user)):
    username = _core().get_session_username(u)
    _maybe_start_baseline(u, username)
    return {"ok": True, **counts(username)}


class ReadBody(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=500)
    all: bool = False


@router.post("/notifiche/letto")
def mark_read(body: ReadBody, u=Depends(_session_user)):
    core = _core()
    uname = _uname(core.get_session_username(u))
    with core.db_lock:
        with _db() as conn:
            if body.all:
                conn.execute("UPDATE notifications SET read = 1 WHERE username = ? AND read = 0", (uname,))
            elif body.ids:
                q = ",".join("?" for _ in body.ids)
                conn.execute(f"UPDATE notifications SET read = 1 WHERE username = ? AND id IN ({q})", (uname, *body.ids))
            conn.commit()
    c = counts(uname)
    _live(uname, {"type": "notifiche", "kinds": [], "read": True, **c})
    return {"ok": True, **c}


class PrefsBody(BaseModel):
    voti: Optional[bool] = None
    bacheca: Optional[bool] = None
    note: Optional[bool] = None
    agenda: Optional[bool] = None
    assenze: Optional[bool] = None
    didattica: Optional[bool] = None


@router.get("/notifiche/preferenze")
def read_prefs(u=Depends(_session_user)):
    return {"ok": True, "prefs": get_prefs(_core().get_session_username(u))}


@router.put("/notifiche/preferenze")
def write_prefs(body: PrefsBody, u=Depends(_session_user)):
    return {"ok": True, "prefs": set_prefs(_core().get_session_username(u), body.model_dump())}


@router.post("/notifiche/sincronizza")
def force_sync(u=Depends(_session_user)):
    core = _core()
    username = core.get_session_username(u)
    uname = _uname(username)
    if not isinstance(u, core.WebSessionUtente):
        raise HTTPException(status_code=401, detail="Accedi di nuovo con SPID o CIE")
    wait = MANUAL_SYNC_GAP - (time.time() - _last_manual.get(uname, 0))
    if wait > 0:
        raise HTTPException(status_code=429, detail=f"Hai appena aggiornato: riprova tra {int(wait) + 1} secondi.")
    _last_manual[uname] = time.time()
    lock = _user_lock(uname)
    if not lock.acquire(timeout=30):
        raise HTTPException(status_code=503, detail="Aggiornamento già in corso, riprova tra poco.")
    try:
        alive, created = run_sync(u, username, force_all=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[notifiche] sync manuale non riuscito: {exc}")
        alive, created = None, 0
    finally:
        lock.release()
    if alive is False:
        core.end_classeviva_session(getattr(u, "phpsessid", None), "scaduta")
        raise HTTPException(status_code=401, detail="Sessione ClasseViva scaduta: accedi di nuovo con SPID o CIE.")
    if alive is None:
        raise HTTPException(status_code=503, detail="ClasseViva non risponde in questo momento. Riprova tra poco.")
    return {"ok": True, "new": created, **counts(uname), "last_sync": _last_sync.get(uname)}
