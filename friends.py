"""Amici e condivisione dei voti (router incluso da main.py).

Contratto con main.py:
- `router`: APIRouter con le route (main lo include prima del mount statico).
- `init_tables(conn)`: crea le tabelle (chiamata da main.init_db()).
Le funzioni di main (sessione, snapshot, alias) si importano in modo pigro con `import main as core`
dentro le funzioni (main importa questo modulo alla fine, quando è già completo).

Modello:
- Ogni studente è identificato da una chiave stabile (`key`): le cifre dello username ClasseViva
  (S10371278X, 10371278 e G10371278 sono la stessa persona, come `core.username_aliases`).
- Ogni studente ha un codice amico di 8 caratteri (alfabeto senza 0/O/1/I), mostrato come K7PQ-4XZ2.
  Il codice è anche l'identificativo pubblico usato dal client: gli username non escono mai.
- I dati condivisi arrivano solo dagli snapshot `user_year_snapshots` (kind "voti") dell'anno in corso,
  scritti da /voti: mai una chiamata a ClasseViva con la sessione dell'amico.
- Privacy chiusa per default: livello "none". Livelli: none < average < subjects < grades.
  Eccezione per singolo amico (`friend_overrides`), altrimenti vale il livello globale.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from datetime import date, timedelta
from threading import Lock
from typing import Any, Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query
from pydantic import BaseModel, Field

router = APIRouter()

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # niente 0/O/1/I
CODE_LEN = 8
LEVELS = ("none", "average", "subjects", "grades")
LEVEL_RANK = {lvl: i for i, lvl in enumerate(LEVELS)}

MAX_FRIENDS = int(os.getenv("FRIENDS_MAX", "50"))
MAX_PENDING = int(os.getenv("FRIENDS_MAX_PENDING", "20"))
# Rate limit sulle richieste inviate (persistito in DB): N richieste per finestra.
REQUEST_RATE_MAX = int(os.getenv("FRIENDS_REQUEST_RATE_MAX", "10"))
REQUEST_RATE_WINDOW = int(os.getenv("FRIENDS_REQUEST_RATE_WINDOW", "600"))
REQUEST_DAILY_MAX = int(os.getenv("FRIENDS_REQUEST_DAILY_MAX", "40"))
# Dopo un rifiuto non si può richiedere di nuovo la stessa persona per qualche giorno.
DECLINE_COOLDOWN = int(os.getenv("FRIENDS_DECLINE_COOLDOWN", str(3 * 86400)))
# Codici sbagliati (anti-enumerazione): in memoria, per utente.
LOOKUP_FAIL_MAX = int(os.getenv("FRIENDS_LOOKUP_FAIL_MAX", "20"))
LOOKUP_FAIL_WINDOW = 3600
PROFILE_REFRESH = 600
LAST_GRADES = 30
TREND_DAYS = 21
SEARCH_LIMIT = 20

_lookup_fails: dict[str, list[float]] = {}
_lookup_lock = Lock()


def init_tables(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS friend_users (
            user_key TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            code TEXT NOT NULL UNIQUE,
            full_name TEXT,
            class_code TEXT,
            school_code TEXT,
            privacy TEXT NOT NULL DEFAULT 'none',
            profile_at REAL NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS friendships (
            a_key TEXT NOT NULL,
            b_key TEXT NOT NULL,
            created_at REAL NOT NULL,
            PRIMARY KEY (a_key, b_key)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(b_key)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS friend_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_key TEXT NOT NULL,
            to_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at REAL NOT NULL,
            responded_at REAL,
            UNIQUE (from_key, to_key)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_key, status)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS friend_overrides (
            owner_key TEXT NOT NULL,
            friend_key TEXT NOT NULL,
            level TEXT NOT NULL,
            updated_at REAL NOT NULL,
            PRIMARY KEY (owner_key, friend_key)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS friend_blocks (
            blocker_key TEXT NOT NULL,
            blocked_key TEXT NOT NULL,
            created_at REAL NOT NULL,
            PRIMARY KEY (blocker_key, blocked_key)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS friend_request_log (
            user_key TEXT NOT NULL,
            at REAL NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_friend_request_log ON friend_request_log(user_key, at)")


# ---------------------------------------------------------------- tempo reale

def _live(keys, action: str, **extra) -> None:
    """Avvisa subito i dispositivi aperti degli studenti coinvolti (realtime.py)."""
    try:
        import realtime
        realtime.publish(keys, {"type": "friends", "action": action, **extra})
    except Exception:
        pass  # mai bloccare la richiesta per un avviso


# ---------------------------------------------------------------- identità

def user_key(username: Any) -> str:
    """Chiave stabile: le cifre dello username (S123X, 123, G123 → "123")."""
    import main as core

    norm = core.normalize_username(username)
    digits = "".join(ch for ch in norm if ch.isdigit())
    return digits or norm


def normalize_code(value: Any) -> Optional[str]:
    raw = re.sub(r"[\s\-_.]", "", str(value or "")).upper()
    if len(raw) != CODE_LEN or any(ch not in CODE_ALPHABET for ch in raw):
        return None
    return raw


def format_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}" if code and len(code) == CODE_LEN else code


def _new_code(conn) -> str:
    for _ in range(50):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
        if not conn.execute("SELECT 1 FROM friend_users WHERE code = ?", (code,)).fetchone():
            return code
    raise HTTPException(status_code=503, detail="Riprova tra un attimo")


def _ensure_user_row(conn, *, username: str, full_name=None, class_code=None, school_code=None,
                     profile_at: Optional[float] = None) -> dict:
    """Crea (o aggiorna) la riga dello studente. Deve girare dentro db_lock."""
    import main as core

    key = user_key(username)
    if not key:
        raise HTTPException(status_code=401, detail="Utente non valido")
    row = conn.execute("SELECT * FROM friend_users WHERE user_key = ?", (key,)).fetchone()
    now = time.time()
    cls = core.normalize_class_code(class_code) if class_code else None
    sch = str(school_code).strip().upper() if school_code else None
    name = str(full_name).strip() if full_name else None
    if row is None:
        conn.execute(
            """INSERT INTO friend_users (user_key, username, code, full_name, class_code, school_code, privacy,
                                         profile_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'none', ?, ?)""",
            (key, core.normalize_username(username), _new_code(conn), name, cls, sch, profile_at or 0, now),
        )
    elif profile_at is not None:
        conn.execute(
            """UPDATE friend_users SET username = ?, full_name = COALESCE(?, full_name),
                      class_code = COALESCE(?, class_code), school_code = COALESCE(?, school_code), profile_at = ?
               WHERE user_key = ?""",
            (core.normalize_username(username), name, cls, sch, profile_at, key),
        )
    return dict(conn.execute("SELECT * FROM friend_users WHERE user_key = ?", (key,)).fetchone())


def _me(session_id: Optional[str] = Cookie(default=None)) -> dict:
    """Dipendenza: riga dello studente in sessione (creata alla prima richiesta, con codice)."""
    import main as core

    sess = core.get_session_record(session_id)
    user = sess["user"]
    username = core.normalize_username(core.get_session_username(user))
    key = user_key(username)
    with core.get_db_connection() as conn:
        row = conn.execute("SELECT * FROM friend_users WHERE user_key = ?", (key,)).fetchone()
    if row is not None and row["full_name"] and time.time() - float(row["profile_at"] or 0) < PROFILE_REFRESH:
        out = dict(row)
    else:
        profile: dict = {}
        try:
            profile = core._session_profile_from_cache(sess) or {}
        except Exception:
            profile = {}
        if not profile.get("full_name") or not profile.get("class_code"):
            try:
                saved = core._first_saved_profile_for_user(username, getattr(user, "ident", None))
                profile = {**{k: v for k, v in saved.items() if v}, **{k: v for k, v in profile.items() if v}}
            except Exception:
                pass
        if not profile.get("full_name"):
            first = getattr(user, "first_name", "") or ""
            last = getattr(user, "last_name", "") or ""
            if (first + last).strip():
                profile["full_name"] = f"{first} {last}".strip()
        with core.db_lock:
            with core.get_db_connection() as conn:
                out = _ensure_user_row(
                    conn, username=username, full_name=profile.get("full_name"),
                    class_code=profile.get("class_code"), school_code=profile.get("school_code"),
                    profile_at=time.time(),
                )
                conn.commit()
    out["session_username"] = username
    return out


def _user_by_code(conn, code: str) -> Optional[dict]:
    row = conn.execute("SELECT * FROM friend_users WHERE code = ?", (code,)).fetchone()
    return dict(row) if row else None


def _users_by_keys(conn, keys) -> dict[str, dict]:
    keys = list({k for k in keys if k})
    if not keys:
        return {}
    ph = ",".join("?" for _ in keys)
    rows = conn.execute(f"SELECT * FROM friend_users WHERE user_key IN ({ph})", keys).fetchall()
    return {r["user_key"]: dict(r) for r in rows}


def _pair(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


def _are_friends(conn, a: str, b: str) -> Optional[float]:
    row = conn.execute("SELECT created_at FROM friendships WHERE a_key = ? AND b_key = ?", _pair(a, b)).fetchone()
    return float(row["created_at"]) if row else None


def _friend_keys(conn, key: str) -> list[tuple[str, float]]:
    rows = conn.execute(
        "SELECT a_key, b_key, created_at FROM friendships WHERE a_key = ? OR b_key = ?", (key, key)
    ).fetchall()
    return [((r["b_key"] if r["a_key"] == key else r["a_key"]), float(r["created_at"])) for r in rows]


def _count_friends(conn, key: str) -> int:
    return conn.execute("SELECT COUNT(*) FROM friendships WHERE a_key = ? OR b_key = ?", (key, key)).fetchone()[0]


def _is_blocked(conn, a: str, b: str) -> bool:
    """True se uno dei due ha bloccato l'altro."""
    return conn.execute(
        """SELECT 1 FROM friend_blocks WHERE (blocker_key = ? AND blocked_key = ?)
           OR (blocker_key = ? AND blocked_key = ?)""",
        (a, b, b, a),
    ).fetchone() is not None


def _level_for(conn, owner: dict, friend_key: str) -> str:
    """Livello che `owner` condivide con `friend_key` (eccezione per amico, altrimenti globale)."""
    row = conn.execute(
        "SELECT level FROM friend_overrides WHERE owner_key = ? AND friend_key = ?", (owner["user_key"], friend_key)
    ).fetchone()
    level = row["level"] if row else owner.get("privacy")
    return level if level in LEVEL_RANK else "none"


def _override_for(conn, owner_key: str, friend_key: str) -> Optional[str]:
    row = conn.execute(
        "SELECT level FROM friend_overrides WHERE owner_key = ? AND friend_key = ?", (owner_key, friend_key)
    ).fetchone()
    return row["level"] if row and row["level"] in LEVEL_RANK else None


def _public_person(user: dict) -> dict:
    import main as core

    try:
        badges = core.list_user_badges(user.get("username"))
    except Exception:
        badges = []
    return {
        "code": format_code(user["code"]),
        "name": user.get("full_name") or "Studente",
        "class_code": user.get("class_code"),
        "badges": [
            {k: b.get(k) for k in ("id", "label", "text_color", "background_color", "border_color")}
            for b in badges if b
        ],
    }


# ---------------------------------------------------------------- voti e medie
# Stesse regole di public/app/grades.js (escludi Religione, voti blu, "A", annullati, noAverage).

def _grade_value(g: dict) -> Optional[float]:
    raw = g.get("decimalValue")
    if raw is None or raw == "":
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if raw == raw and raw not in (float("inf"), float("-inf")) else None
    m = re.search(r"-?\d+(?:\.\d+)?", str(raw).replace(",", "."))
    return float(m.group(0)) if m else None


def _excluded(g: Any) -> bool:
    if not isinstance(g, dict):
        return True
    if g.get("canceled") or g.get("noAverage"):
        return True
    if "RELIGIONE" in str(g.get("subjectDesc") or "").upper():
        return True
    if str(g.get("displayValue") or "").strip().upper() == "A":
        return True
    if str(g.get("color") or "").strip().lower() == "blue":
        return True
    return _grade_value(g) is None


def extract_grades(payload: Any) -> list[dict]:
    v = payload.get("voti", payload) if isinstance(payload, dict) else payload
    lst = v if isinstance(v, list) else (v.get("grades") if isinstance(v, dict) else None)
    if not isinstance(lst, list):
        return []
    out = [g for g in lst if isinstance(g, dict)]
    out.sort(key=lambda g: str(g.get("evtDate") or ""), reverse=True)
    return out


def _avg(grades: list[dict]) -> Optional[float]:
    vals = [_grade_value(g) for g in grades if not _excluded(g)]
    return sum(vals) / len(vals) if vals else None


def compute_stats(grades: list[dict], today: Optional[date] = None) -> dict:
    """Media generale (media semplice dei voti validi), tendenza, medie per materia."""
    today = today or date.today()
    general = _avg(grades)
    cutoff = (today - timedelta(days=TREND_DAYS)).isoformat()
    older = [g for g in grades if str(g.get("evtDate") or "")[:10] < cutoff]
    recent_valid = [g for g in grades if str(g.get("evtDate") or "")[:10] >= cutoff and not _excluded(g)]
    before = _avg(older)
    trend = round(general - before, 2) if (general is not None and before is not None and recent_valid) else None
    buckets: dict[str, list[dict]] = {}
    for g in grades:
        name = str(g.get("subjectDesc") or "Materia").strip()
        buckets.setdefault(name, []).append(g)
    subjects = []
    for name, gs in buckets.items():
        counted = [g for g in gs if not _excluded(g)]
        if not counted:
            continue  # niente media (es. Religione): non si mostra
        subjects.append({"name": name, "average": round(_avg(counted), 2), "count": len(counted)})
    subjects.sort(key=lambda s: s["name"].lower())
    return {
        "general_average": round(general, 2) if general is not None else None,
        "trend": trend,
        "count": sum(1 for g in grades if not _excluded(g)),
        "subjects": subjects,
    }


def _component(g: dict) -> str:
    try:
        pos = int(g.get("componentPos") or 0)
    except (TypeError, ValueError):
        pos = 0
    return {1: "Scritto", 2: "Orale", 3: "Pratico"}.get(pos) or str(g.get("componentDesc") or "")


def _payload_timestamp(payload: Any) -> Optional[float]:
    if not isinstance(payload, dict):
        return None
    for k in ("_saved_at", "saved_at", "updated_at", "fetched_at", "synced_at"):
        v = payload.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    return None


def load_voti_snapshot(username: str, school_year: Optional[str] = None) -> tuple[Optional[Any], Optional[float]]:
    """(payload, aggiornato_il) dello snapshot voti dell'anno in corso; cerca su tutti gli alias."""
    import main as core

    year = school_year or core.current_school_year()
    aliases = sorted(core.username_aliases(username))
    if aliases:
        ph = ",".join("?" for _ in aliases)
        try:
            with core.get_db_connection() as conn:
                row = conn.execute(
                    f"""SELECT payload, updated_at FROM user_year_snapshots
                        WHERE school_year = ? AND kind = 'voti' AND upper(trim(username)) IN ({ph})
                        ORDER BY updated_at DESC LIMIT 1""",
                    (year, *aliases),
                ).fetchone()
        except Exception:
            row = None
        if row is not None:
            try:
                payload = json.loads(row["payload"])
            except (TypeError, ValueError):
                payload = None
            if payload is not None:
                ts = _payload_timestamp(payload) or (float(row["updated_at"]) if row["updated_at"] else None)
                return payload, ts
    payload = core.get_user_year_snapshot(username=username, school_year=year, kind="voti")
    return payload, _payload_timestamp(payload)


def shared_view(owner: dict, level: str) -> dict:
    """Quello che un amico vede di `owner` con il livello dato. NIENTE oltre il livello."""
    level = level if level in LEVEL_RANK else "none"
    out: dict = {"level": level}
    if level == "none":
        return out
    payload, ts = load_voti_snapshot(owner["username"])
    grades = extract_grades(payload) if payload is not None else []
    out["has_data"] = bool(grades)
    out["updated_at"] = ts
    stats = compute_stats(grades)
    out["general_average"] = stats["general_average"]
    out["trend"] = stats["trend"]
    if LEVEL_RANK[level] >= LEVEL_RANK["subjects"]:
        out["count"] = stats["count"]
        out["subjects"] = stats["subjects"]
    if LEVEL_RANK[level] >= LEVEL_RANK["grades"]:
        out["grades"] = [
            {
                "subject": str(g.get("subjectDesc") or "").strip(),
                "date": str(g.get("evtDate") or "")[:10],
                "display": str(g.get("displayValue") or "").strip() or "—",
                "value": _grade_value(g),
                "counted": not _excluded(g),
                "component": _component(g),
            }
            for g in grades[:LAST_GRADES]
        ]
    return out


# ---------------------------------------------------------------- limiti

def _check_request_rate(conn, key: str) -> None:
    now = time.time()
    conn.execute("DELETE FROM friend_request_log WHERE at < ?", (now - 86400,))
    recent = conn.execute(
        "SELECT COUNT(*) FROM friend_request_log WHERE user_key = ? AND at >= ?", (key, now - REQUEST_RATE_WINDOW)
    ).fetchone()[0]
    daily = conn.execute("SELECT COUNT(*) FROM friend_request_log WHERE user_key = ?", (key,)).fetchone()[0]
    if recent >= REQUEST_RATE_MAX or daily >= REQUEST_DAILY_MAX:
        raise HTTPException(status_code=429, detail="Hai inviato troppe richieste. Riprova più tardi.")


def _check_lookup_allowed(key: str) -> None:
    now = time.time()
    with _lookup_lock:
        fails = [t for t in _lookup_fails.get(key, []) if now - t < LOOKUP_FAIL_WINDOW]
        _lookup_fails[key] = fails
        if len(fails) >= LOOKUP_FAIL_MAX:
            raise HTTPException(status_code=429, detail="Troppi codici sbagliati. Riprova tra un'ora.")


def _record_lookup_fail(key: str) -> None:
    with _lookup_lock:
        _lookup_fails.setdefault(key, []).append(time.time())


def _resolve_code(conn, me: dict, value: Any) -> dict:
    """Studente dal codice (con rate limit sui codici sbagliati)."""
    _check_lookup_allowed(me["user_key"])
    code = normalize_code(value)
    if not code:
        _record_lookup_fail(me["user_key"])
        raise HTTPException(status_code=400, detail="Codice non valido: sono 8 caratteri, es. K7PQ-4XZ2.")
    target = _user_by_code(conn, code)
    if target is None:
        _record_lookup_fail(me["user_key"])
        raise HTTPException(status_code=404, detail="Nessuno studente con questo codice.")
    return target


def _relation(conn, me_key: str, other_key: str) -> str:
    if me_key == other_key:
        return "self"
    if conn.execute("SELECT 1 FROM friend_blocks WHERE blocker_key = ? AND blocked_key = ?", (me_key, other_key)).fetchone():
        return "blocked"
    if _is_blocked(conn, me_key, other_key):
        return "unavailable"
    if _are_friends(conn, me_key, other_key):
        return "friend"
    if conn.execute("SELECT 1 FROM friend_requests WHERE from_key = ? AND to_key = ? AND status = 'pending'", (me_key, other_key)).fetchone():
        return "outgoing"
    if conn.execute("SELECT 1 FROM friend_requests WHERE from_key = ? AND to_key = ? AND status = 'pending'", (other_key, me_key)).fetchone():
        return "incoming"
    return "none"


def _make_friends(conn, a: str, b: str) -> None:
    conn.execute("INSERT OR IGNORE INTO friendships (a_key, b_key, created_at) VALUES (?, ?, ?)", (*_pair(a, b), time.time()))
    conn.execute(
        "DELETE FROM friend_requests WHERE (from_key = ? AND to_key = ?) OR (from_key = ? AND to_key = ?)", (a, b, b, a)
    )


def _unfriend(conn, a: str, b: str) -> None:
    conn.execute("DELETE FROM friendships WHERE a_key = ? AND b_key = ?", _pair(a, b))
    conn.execute(
        "DELETE FROM friend_overrides WHERE (owner_key = ? AND friend_key = ?) OR (owner_key = ? AND friend_key = ?)",
        (a, b, b, a),
    )


# ---------------------------------------------------------------- modelli

class CodeBody(BaseModel):
    code: str = Field(..., min_length=1, max_length=32)


class LevelBody(BaseModel):
    level: Optional[str] = Field(default=None, max_length=16)


def _check_level(level: Optional[str], *, allow_null: bool) -> Optional[str]:
    if level is None and allow_null:
        return None
    if level not in LEVEL_RANK:
        raise HTTPException(status_code=422, detail="Livello di condivisione non valido")
    return level


# ---------------------------------------------------------------- route

@router.get("/friends")
def friends_overview(me: dict = Depends(_me)):
    """Tutto quello che serve alla vista Amici: codice, amici, richieste, bloccati, privacy."""
    import main as core

    key = me["user_key"]
    with core.get_db_connection() as conn:
        friends = _friend_keys(conn, key)
        incoming = conn.execute(
            "SELECT id, from_key, created_at FROM friend_requests WHERE to_key = ? AND status = 'pending' ORDER BY created_at DESC",
            (key,),
        ).fetchall()
        outgoing = conn.execute(
            "SELECT id, to_key, created_at FROM friend_requests WHERE from_key = ? AND status = 'pending' ORDER BY created_at DESC",
            (key,),
        ).fetchall()
        blocked = conn.execute(
            "SELECT blocked_key, created_at FROM friend_blocks WHERE blocker_key = ? ORDER BY created_at DESC", (key,)
        ).fetchall()
        people = _users_by_keys(
            conn,
            [k for k, _ in friends] + [r["from_key"] for r in incoming] + [r["to_key"] for r in outgoing]
            + [r["blocked_key"] for r in blocked],
        )
        friend_items = []
        for fkey, since in friends:
            friend = people.get(fkey)
            if not friend:
                continue
            their_level = _level_for(conn, friend, key)
            view = shared_view(friend, their_level)
            friend_items.append({
                **_public_person(friend),
                "since": since,
                "shares": their_level,
                "my_level": _level_for(conn, me, fkey),
                "my_override": _override_for(conn, key, fkey),
                "general_average": view.get("general_average"),
                "trend": view.get("trend"),
                "updated_at": view.get("updated_at"),
                "has_data": view.get("has_data", False),
            })
    friend_items.sort(key=lambda f: (f["name"] or "").lower())
    own_payload, own_ts = load_voti_snapshot(me["username"])
    return {
        "ok": True,
        "me": {
            **_public_person(me),
            "privacy": me.get("privacy") if me.get("privacy") in LEVEL_RANK else "none",
            "school_code": me.get("school_code"),
            "has_snapshot": bool(extract_grades(own_payload)) if own_payload is not None else False,
            "updated_at": own_ts,
        },
        "friends": friend_items,
        "incoming": [
            {"id": r["id"], "created_at": r["created_at"], **_public_person(people[r["from_key"]])}
            for r in incoming if r["from_key"] in people
        ],
        "outgoing": [
            {"id": r["id"], "created_at": r["created_at"], **_public_person(people[r["to_key"]])}
            for r in outgoing if r["to_key"] in people
        ],
        "blocked": [
            {"created_at": r["created_at"], **_public_person(people[r["blocked_key"]])}
            for r in blocked if r["blocked_key"] in people
        ],
        "limits": {"friends": MAX_FRIENDS, "pending": MAX_PENDING},
        "levels": list(LEVELS),
    }


@router.get("/friends/preview")
def friends_preview(level: Optional[str] = Query(default=None), me: dict = Depends(_me)):
    """Anteprima: cosa vedono di me i miei amici (con il livello globale o quello indicato)."""
    lvl = _check_level(level, allow_null=True) or (me.get("privacy") if me.get("privacy") in LEVEL_RANK else "none")
    return {"ok": True, "person": _public_person(me), "shared": shared_view(me, lvl)}


@router.get("/friends/search")
def friends_search(q: str = Query(default="", max_length=60), me: dict = Depends(_me)):
    """Compagni della stessa classe e scuola presenti nelle classifiche (solo righe visibili)."""
    import main as core

    needle = " ".join(q.strip().lower().split())
    my_class = core.normalize_class_code(me.get("class_code"))
    my_school = str(me.get("school_code") or "").strip().upper()
    if not my_class or not my_school:
        return {"ok": True, "items": [], "reason": "no_class"}
    if len(needle) < 2:
        return {"ok": True, "items": [], "reason": "short"}
    year = core.current_school_year()
    rows = []
    with core.get_db_connection() as conn:
        for table in ("leaderboard_entries", "average_leaderboard_entries_scoped"):
            try:
                rows.extend(conn.execute(
                    f"""SELECT username, full_name, class_code, school_code, updated_at FROM {table}
                        WHERE school_year = ? AND visible_in_leaderboard = 1
                          AND upper(trim(school_code)) = ? AND full_name IS NOT NULL""",
                    (year, my_school),
                ).fetchall())
            except Exception:
                continue
    found: dict[str, dict] = {}
    for r in rows:
        if core.normalize_class_code(r["class_code"]) != my_class:
            continue
        name = str(r["full_name"] or "").strip()
        if not name:
            continue
        words = name.lower().split()
        hay = " ".join(words)
        if needle not in hay and not all(any(w.startswith(p) for w in words) for p in needle.split()):
            continue
        k = user_key(r["username"])
        if not k or k == me["user_key"] or k in found:
            continue
        found[k] = {"username": r["username"], "full_name": name}
        if len(found) >= SEARCH_LIMIT * 2:
            break
    items = []
    with core.db_lock:
        with core.get_db_connection() as conn:
            for k, info in found.items():
                if _is_blocked(conn, me["user_key"], k):
                    continue
                row = conn.execute("SELECT * FROM friend_users WHERE user_key = ?", (k,)).fetchone()
                if row is None:
                    # Chi compare in classifica riceve il suo codice (servirà quando aprirà Amici).
                    row = _ensure_user_row(conn, username=info["username"], full_name=info["full_name"],
                                           class_code=my_class, school_code=my_school)
                else:
                    row = dict(row)
                person = _public_person(row)
                person["name"] = row.get("full_name") or info["full_name"]
                person["class_code"] = my_class
                items.append({**person, "status": _relation(conn, me["user_key"], k)})
            conn.commit()
    items.sort(key=lambda it: it["name"].lower())
    return {"ok": True, "items": items[:SEARCH_LIMIT]}


@router.post("/friends/lookup")
def friends_lookup(body: CodeBody, me: dict = Depends(_me)):
    """Chi c'è dietro un codice (per confermare prima di inviare la richiesta)."""
    import main as core

    with core.get_db_connection() as conn:
        target = _resolve_code(conn, me, body.code)
        status = _relation(conn, me["user_key"], target["user_key"])
    if status == "unavailable":
        raise HTTPException(status_code=404, detail="Nessuno studente con questo codice.")
    person = _public_person(target)
    if status == "self":
        person["badges"] = person.get("badges") or []
    return {"ok": True, "person": person, "status": status}


@router.post("/friends/requests")
def friends_request(body: CodeBody, me: dict = Depends(_me)):
    """Invia una richiesta di amicizia (o accetta quella che l'altro ti aveva già mandato)."""
    import main as core

    key = me["user_key"]
    with core.db_lock:
        with core.get_db_connection() as conn:
            target = _resolve_code(conn, me, body.code)
            tkey = target["user_key"]
            status = _relation(conn, key, tkey)
            if status == "self":
                raise HTTPException(status_code=400, detail="Questo è il tuo codice.")
            if status == "blocked":
                raise HTTPException(status_code=409, detail="Hai bloccato questo studente: sbloccalo per aggiungerlo.")
            if status == "unavailable":
                raise HTTPException(status_code=404, detail="Nessuno studente con questo codice.")
            if status == "friend":
                raise HTTPException(status_code=409, detail="Siete già amici.")
            if status == "outgoing":
                raise HTTPException(status_code=409, detail="Richiesta già inviata.")
            if _count_friends(conn, key) >= MAX_FRIENDS:
                raise HTTPException(status_code=409, detail=f"Hai raggiunto il limite di {MAX_FRIENDS} amici.")
            if _count_friends(conn, tkey) >= MAX_FRIENDS:
                raise HTTPException(status_code=409, detail="Questo studente ha già il numero massimo di amici.")
            if status == "incoming":
                # Ti aveva già chiesto l'amicizia: inviarla vale come accettare.
                _make_friends(conn, key, tkey)
                conn.commit()
                _live([tkey], "accepted", name=me.get("full_name") or "")
                _live([key], "accepted_by_me")
                return {"ok": True, "status": "friend", "person": _public_person(target)}
            out_pending = conn.execute(
                "SELECT COUNT(*) FROM friend_requests WHERE from_key = ? AND status = 'pending'", (key,)
            ).fetchone()[0]
            if out_pending >= MAX_PENDING:
                raise HTTPException(status_code=429, detail=f"Hai già {MAX_PENDING} richieste in attesa: aspetta che rispondano.")
            in_pending = conn.execute(
                "SELECT COUNT(*) FROM friend_requests WHERE to_key = ? AND status = 'pending'", (tkey,)
            ).fetchone()[0]
            if in_pending >= MAX_PENDING:
                raise HTTPException(status_code=429, detail="Questo studente ha troppe richieste in attesa. Riprova più tardi.")
            prev = conn.execute(
                "SELECT status, responded_at FROM friend_requests WHERE from_key = ? AND to_key = ?", (key, tkey)
            ).fetchone()
            if prev is not None and prev["status"] == "declined" and time.time() - float(prev["responded_at"] or 0) < DECLINE_COOLDOWN:
                raise HTTPException(status_code=429, detail="Hai già chiesto l'amicizia a questo studente di recente. Riprova tra qualche giorno.")
            _check_request_rate(conn, key)
            now = time.time()
            conn.execute("DELETE FROM friend_requests WHERE from_key = ? AND to_key = ?", (key, tkey))
            cur = conn.execute(
                "INSERT INTO friend_requests (from_key, to_key, status, created_at) VALUES (?, ?, 'pending', ?)",
                (key, tkey, now),
            )
            conn.execute("INSERT INTO friend_request_log (user_key, at) VALUES (?, ?)", (key, now))
            conn.commit()
            _live([tkey], "request", name=me.get("full_name") or "")
            _live([key], "sent")
            return {"ok": True, "status": "outgoing", "id": cur.lastrowid, "person": _public_person(target)}


def _incoming_request(conn, me_key: str, request_id: int):
    row = conn.execute(
        "SELECT * FROM friend_requests WHERE id = ? AND to_key = ? AND status = 'pending'", (request_id, me_key)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Richiesta non trovata.")
    return row


@router.post("/friends/requests/{request_id}/accept")
def friends_accept(request_id: int, me: dict = Depends(_me)):
    import main as core

    key = me["user_key"]
    with core.db_lock:
        with core.get_db_connection() as conn:
            row = _incoming_request(conn, key, request_id)
            if _count_friends(conn, key) >= MAX_FRIENDS:
                raise HTTPException(status_code=409, detail=f"Hai raggiunto il limite di {MAX_FRIENDS} amici.")
            if _count_friends(conn, row["from_key"]) >= MAX_FRIENDS:
                raise HTTPException(status_code=409, detail="Questo studente ha già il numero massimo di amici.")
            _make_friends(conn, key, row["from_key"])
            conn.commit()
    _live([row["from_key"]], "accepted", name=me.get("full_name") or "")
    _live([key], "accepted_by_me")
    return {"ok": True}


@router.post("/friends/requests/{request_id}/decline")
def friends_decline(request_id: int, me: dict = Depends(_me)):
    import main as core

    with core.db_lock:
        with core.get_db_connection() as conn:
            row = _incoming_request(conn, me["user_key"], request_id)
            conn.execute(
                "UPDATE friend_requests SET status = 'declined', responded_at = ? WHERE id = ?", (time.time(), request_id)
            )
            conn.commit()
    _live([me["user_key"], row["from_key"]], "declined")
    return {"ok": True}


@router.delete("/friends/requests/{request_id}")
def friends_cancel(request_id: int, me: dict = Depends(_me)):
    """Annulla una richiesta inviata."""
    import main as core

    with core.db_lock:
        with core.get_db_connection() as conn:
            req = conn.execute(
                "SELECT to_key FROM friend_requests WHERE id = ? AND from_key = ? AND status = 'pending'", (request_id, me["user_key"])
            ).fetchone()
            cur = conn.execute(
                "DELETE FROM friend_requests WHERE id = ? AND from_key = ? AND status = 'pending'", (request_id, me["user_key"])
            )
            conn.commit()
    if not cur.rowcount:
        raise HTTPException(status_code=404, detail="Richiesta non trovata.")
    _live([me["user_key"], req["to_key"] if req else None], "cancelled")
    return {"ok": True}


@router.put("/friends/privacy")
def friends_set_privacy(body: LevelBody, me: dict = Depends(_me)):
    import main as core

    level = _check_level(body.level, allow_null=False)
    with core.db_lock:
        with core.get_db_connection() as conn:
            conn.execute("UPDATE friend_users SET privacy = ? WHERE user_key = ?", (level, me["user_key"]))
            conn.commit()
            friend_keys = [k for k, _ in _friend_keys(conn, me["user_key"])]
    _live([me["user_key"], *friend_keys], "shared", code=format_code(me["code"]))
    return {"ok": True, "privacy": level}


@router.post("/friends/blocks")
def friends_block(body: CodeBody, me: dict = Depends(_me)):
    """Blocca: toglie l'amicizia e le richieste; l'altro non può più trovarti né scriverti."""
    import main as core

    key = me["user_key"]
    with core.db_lock:
        with core.get_db_connection() as conn:
            target = _resolve_code(conn, me, body.code)
            tkey = target["user_key"]
            if tkey == key:
                raise HTTPException(status_code=400, detail="Non puoi bloccare te stesso.")
            _unfriend(conn, key, tkey)
            conn.execute(
                "DELETE FROM friend_requests WHERE (from_key = ? AND to_key = ?) OR (from_key = ? AND to_key = ?)",
                (key, tkey, tkey, key),
            )
            conn.execute(
                "INSERT OR IGNORE INTO friend_blocks (blocker_key, blocked_key, created_at) VALUES (?, ?, ?)",
                (key, tkey, time.time()),
            )
            conn.commit()
    _live([key, tkey], "removed")
    return {"ok": True}


@router.delete("/friends/blocks/{code}")
def friends_unblock(code: str, me: dict = Depends(_me)):
    import main as core

    norm = normalize_code(code)
    if not norm:
        raise HTTPException(status_code=400, detail="Codice non valido.")
    with core.db_lock:
        with core.get_db_connection() as conn:
            target = _user_by_code(conn, norm)
            if target is None:
                raise HTTPException(status_code=404, detail="Studente non trovato.")
            conn.execute(
                "DELETE FROM friend_blocks WHERE blocker_key = ? AND blocked_key = ?", (me["user_key"], target["user_key"])
            )
            conn.commit()
    _live([me["user_key"]], "unblocked")
    return {"ok": True}


def _friend_by_code(conn, me: dict, code: str) -> tuple[dict, float]:
    norm = normalize_code(code)
    target = _user_by_code(conn, norm) if norm else None
    since = _are_friends(conn, me["user_key"], target["user_key"]) if target else None
    if target is None or since is None or target["user_key"] == me["user_key"]:
        raise HTTPException(status_code=404, detail="Non siete amici.")
    return target, since


@router.get("/friends/{code}")
def friends_detail(code: str, me: dict = Depends(_me)):
    """Profilo condiviso dall'amico (solo ciò che il suo livello consente) + confronto reciproco."""
    import main as core

    with core.get_db_connection() as conn:
        friend, since = _friend_by_code(conn, me, code)
        their_level = _level_for(conn, friend, me["user_key"])
        my_level = _level_for(conn, me, friend["user_key"])
        my_override = _override_for(conn, me["user_key"], friend["user_key"])
    shared = shared_view(friend, their_level)
    out = {
        "ok": True,
        "person": {**_public_person(friend), "since": since},
        "shared": shared,
        "my_level": my_level,
        "my_override": my_override,
        "my_global": me.get("privacy") if me.get("privacy") in LEVEL_RANK else "none",
        "comparison": None,
    }
    # Confronto per materia solo se entrambi condividono almeno le medie per materia.
    if LEVEL_RANK[their_level] >= LEVEL_RANK["subjects"] and LEVEL_RANK[my_level] >= LEVEL_RANK["subjects"]:
        mine = shared_view(me, "subjects")
        theirs = {s["name"]: s["average"] for s in shared.get("subjects") or []}
        own = {s["name"]: s["average"] for s in mine.get("subjects") or []}
        out["comparison"] = {
            "me": mine.get("general_average"),
            "friend": shared.get("general_average"),
            "subjects": [
                {"name": n, "me": own.get(n), "friend": theirs.get(n)}
                for n in sorted(set(theirs) | set(own), key=str.lower)
            ],
        }
    return out


@router.put("/friends/{code}/privacy")
def friends_set_override(code: str, body: LevelBody, me: dict = Depends(_me)):
    """Eccezione per un amico (level=null → torna al livello globale)."""
    import main as core

    level = _check_level(body.level, allow_null=True)
    with core.db_lock:
        with core.get_db_connection() as conn:
            friend, _ = _friend_by_code(conn, me, code)
            if level is None:
                conn.execute(
                    "DELETE FROM friend_overrides WHERE owner_key = ? AND friend_key = ?", (me["user_key"], friend["user_key"])
                )
            else:
                conn.execute(
                    """INSERT INTO friend_overrides (owner_key, friend_key, level, updated_at) VALUES (?, ?, ?, ?)
                       ON CONFLICT(owner_key, friend_key) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at""",
                    (me["user_key"], friend["user_key"], level, time.time()),
                )
            conn.commit()
    _live([me["user_key"], friend["user_key"]], "shared", code=format_code(me["code"]))
    return {"ok": True, "my_override": level}


@router.delete("/friends/{code}")
def friends_remove(code: str, me: dict = Depends(_me)):
    import main as core

    with core.db_lock:
        with core.get_db_connection() as conn:
            friend, _ = _friend_by_code(conn, me, code)
            _unfriend(conn, me["user_key"], friend["user_key"])
            conn.commit()
    _live([me["user_key"], friend["user_key"]], "removed")
    return {"ok": True}
