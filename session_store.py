"""Persistenza delle sessioni Aulera e statistiche sulla durata delle sessioni ClasseViva.

- Le sessioni Aulera (una per dispositivo) sopravvivono a riavvii e deploy: sono salvate in
  SQLite con il cookie ClasseViva (PHPSESSID) CIFRATO. Il session id del browser non viene mai
  salvato in chiaro: la chiave della riga è il suo SHA-256.
- Cifratura solo con la libreria standard (niente dipendenze da installare sul server):
  keystream HMAC-SHA256 in modalità contatore + tag HMAC-SHA256 (encrypt-then-MAC), con chiavi
  separate derivate da un segreto. Il segreto arriva da AULERA_SECRET_KEY oppure da un file
  generato accanto al database (permessi 600).
- `cvv_session_stats` registra quando nasce e quando muore ogni sessione ClasseViva, per
  misurarne la durata reale (vedi /admin/session-stats).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from typing import Any, Iterable, Optional

_SECRET: Optional[bytes] = None


# ---------------------------------------------------------------- segreto e cifratura
def _load_secret(database_path: str) -> bytes:
    env = os.getenv("AULERA_SECRET_KEY", "").strip()
    if env:
        return hashlib.sha256(env.encode("utf-8")).digest()
    key_path = os.path.join(os.path.dirname(os.path.abspath(database_path)) or ".", "aulera-secret.key")
    if os.path.isfile(key_path):
        with open(key_path, "r", encoding="ascii") as fh:
            return bytes.fromhex(fh.read().strip())
    secret = secrets.token_bytes(32)
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="ascii") as fh:
        fh.write(secret.hex())
    return secret


def configure(database_path: str) -> None:
    global _SECRET
    _SECRET = _load_secret(database_path)


def _keys() -> tuple[bytes, bytes]:
    if _SECRET is None:
        raise RuntimeError("session_store.configure() non chiamato")
    enc = hmac.new(_SECRET, b"aulera/enc/v1", hashlib.sha256).digest()
    mac = hmac.new(_SECRET, b"aulera/mac/v1", hashlib.sha256).digest()
    return enc, mac


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        counter += 1
    return bytes(out[:length])


def seal(plaintext: str) -> str:
    enc, mac = _keys()
    nonce = secrets.token_bytes(16)
    data = plaintext.encode("utf-8")
    ct = bytes(a ^ b for a, b in zip(data, _keystream(enc, nonce, len(data))))
    tag = hmac.new(mac, b"v1" + nonce + ct, hashlib.sha256).digest()[:16]
    return "v1." + base64.urlsafe_b64encode(nonce + tag + ct).decode("ascii")


def unseal(token: str) -> Optional[str]:
    """Decifra; None se il dato è stato alterato o il segreto è cambiato."""
    try:
        if not token.startswith("v1."):
            return None
        raw = base64.urlsafe_b64decode(token[3:].encode("ascii"))
        nonce, tag, ct = raw[:16], raw[16:32], raw[32:]
        enc, mac = _keys()
        expected = hmac.new(mac, b"v1" + nonce + ct, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(tag, expected):
            return None
        return bytes(a ^ b for a, b in zip(ct, _keystream(enc, nonce, len(ct)))).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def sid_key(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def cookie_key(phpsessid: str) -> str:
    """Identificativo stabile (non reversibile) di una sessione ClasseViva, per le statistiche."""
    enc, _ = _keys()
    return hmac.new(enc, b"cvv:" + phpsessid.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


# ---------------------------------------------------------------- schema
def init_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS auth_sessions (
            sid_hash TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            ident TEXT,
            first_name TEXT,
            last_name TEXT,
            phpsessid_enc TEXT NOT NULL,
            cookie_key TEXT NOT NULL,
            device_id TEXT NOT NULL,
            device_label TEXT,
            linked_via TEXT,
            created_at REAL NOT NULL,
            last_seen REAL NOT NULL,
            expires REAL NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_auth_sessions_username ON auth_sessions(upper(username))")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_auth_sessions_cookie ON auth_sessions(cookie_key)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cvv_session_stats (
            cookie_key TEXT PRIMARY KEY,
            username TEXT,
            started_at REAL NOT NULL,
            last_ok_at REAL NOT NULL,
            checks INTEGER NOT NULL DEFAULT 0,
            ended_at REAL,
            end_reason TEXT
        )
        """
    )


# ---------------------------------------------------------------- sessioni
def save_session(conn: sqlite3.Connection, session_id: str, *, username: str, ident: str, first_name: str,
                 last_name: str, phpsessid: str, device_id: str, device_label: str, linked_via: Optional[str],
                 created_at: float, last_seen: float, expires: float) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO auth_sessions
        (sid_hash, username, ident, first_name, last_name, phpsessid_enc, cookie_key, device_id, device_label,
         linked_via, created_at, last_seen, expires)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (sid_key(session_id), username, ident, first_name, last_name, seal(phpsessid), cookie_key(phpsessid),
         device_id, device_label, linked_via, created_at, last_seen, expires),
    )


def load_session(conn: sqlite3.Connection, session_id: str) -> Optional[dict[str, Any]]:
    row = conn.execute("SELECT * FROM auth_sessions WHERE sid_hash = ?", (sid_key(session_id),)).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["phpsessid"] = unseal(data.pop("phpsessid_enc"))
    return data


def touch_session(conn: sqlite3.Connection, session_id: str, last_seen: float, expires: float) -> None:
    conn.execute("UPDATE auth_sessions SET last_seen = ?, expires = ? WHERE sid_hash = ?",
                 (last_seen, expires, sid_key(session_id)))


def delete_session(conn: sqlite3.Connection, session_id: str) -> None:
    conn.execute("DELETE FROM auth_sessions WHERE sid_hash = ?", (sid_key(session_id),))


def delete_device(conn: sqlite3.Connection, device_id: str, usernames: Iterable[str]) -> int:
    names = [u.upper() for u in usernames]
    if not names:
        return 0
    marks = ",".join("?" for _ in names)
    cur = conn.execute(f"DELETE FROM auth_sessions WHERE device_id = ? AND upper(username) IN ({marks})", (device_id, *names))
    return cur.rowcount


def sessions_for_users(conn: sqlite3.Connection, usernames: Iterable[str], now: float) -> list[dict[str, Any]]:
    names = [u.upper() for u in usernames]
    if not names:
        return []
    marks = ",".join("?" for _ in names)
    rows = conn.execute(
        f"""SELECT sid_hash, device_id, device_label, linked_via, created_at, last_seen, expires
            FROM auth_sessions WHERE upper(username) IN ({marks}) AND expires > ?""",
        (*names, now),
    ).fetchall()
    return [dict(r) for r in rows]


def update_cookie_for_users(conn: sqlite3.Connection, usernames: Iterable[str], phpsessid: str) -> None:
    """Nuovo login SPID: i dispositivi collegati dello stesso studente usano la nuova sessione."""
    names = [u.upper() for u in usernames]
    if not names:
        return
    marks = ",".join("?" for _ in names)
    conn.execute(
        f"UPDATE auth_sessions SET phpsessid_enc = ?, cookie_key = ? WHERE upper(username) IN ({marks})",
        (seal(phpsessid), cookie_key(phpsessid), *names),
    )


def delete_by_cookie(conn: sqlite3.Connection, key: str) -> int:
    return conn.execute("DELETE FROM auth_sessions WHERE cookie_key = ?", (key,)).rowcount


def purge_expired(conn: sqlite3.Connection, now: float) -> int:
    return conn.execute("DELETE FROM auth_sessions WHERE expires < ?", (now,)).rowcount


def live_cookies(conn: sqlite3.Connection, now: float) -> list[dict[str, Any]]:
    """Una riga per sessione ClasseViva ancora usata da almeno un dispositivo (per il keep-alive)."""
    rows = conn.execute(
        """SELECT cookie_key, username, ident, first_name, last_name, phpsessid_enc, MAX(last_seen) AS last_seen
           FROM auth_sessions WHERE expires > ? GROUP BY cookie_key""",
        (now,),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["phpsessid"] = unseal(d.pop("phpsessid_enc"))
        if d["phpsessid"]:
            out.append(d)
    return out


# ---------------------------------------------------------------- statistiche ClasseViva
def stats_started(conn: sqlite3.Connection, phpsessid: str, username: str, now: float) -> None:
    conn.execute(
        """INSERT INTO cvv_session_stats (cookie_key, username, started_at, last_ok_at, checks)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(cookie_key) DO UPDATE SET
               started_at = CASE WHEN ended_at IS NOT NULL THEN excluded.started_at ELSE started_at END,
               checks = CASE WHEN ended_at IS NOT NULL THEN 0 ELSE checks END,
               last_ok_at = excluded.last_ok_at,
               ended_at = NULL,
               end_reason = NULL""",
        (cookie_key(phpsessid), username, now, now),
    )


def stats_ok(conn: sqlite3.Connection, key: str, now: float) -> None:
    conn.execute("UPDATE cvv_session_stats SET last_ok_at = ?, checks = checks + 1 WHERE cookie_key = ? AND ended_at IS NULL",
                 (now, key))


def stats_ended(conn: sqlite3.Connection, key: str, now: float, reason: str) -> None:
    conn.execute("UPDATE cvv_session_stats SET ended_at = ?, end_reason = ? WHERE cookie_key = ? AND ended_at IS NULL",
                 (now, reason, key))


def stats_summary(conn: sqlite3.Connection, now: float, limit: int = 50) -> dict[str, Any]:
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM cvv_session_stats ORDER BY started_at DESC LIMIT ?", (limit,)
    ).fetchall()]
    expired = [r for r in rows if r.get("end_reason") == "scaduta"]
    # Durata "certa": dal login all'ultimo controllo andato a buon fine.
    lifetimes = sorted((r["last_ok_at"] - r["started_at"]) / 3600 for r in expired)
    active = [r for r in rows if r.get("ended_at") is None]
    median = None
    if lifetimes:
        mid = len(lifetimes) // 2
        median = lifetimes[mid] if len(lifetimes) % 2 else (lifetimes[mid - 1] + lifetimes[mid]) / 2
    return {
        "expired_count": len(expired),
        "median_hours": round(median, 2) if median is not None else None,
        "max_hours": round(lifetimes[-1], 2) if lifetimes else None,
        "longest_active_hours": round(max(((now - r["started_at"]) / 3600 for r in active), default=0), 2) if active else None,
        "active_count": len(active),
        "items": [
            {
                "username": r.get("username"),
                "started_at": r["started_at"],
                "last_ok_at": r["last_ok_at"],
                "ended_at": r.get("ended_at"),
                "end_reason": r.get("end_reason"),
                "checks": r.get("checks", 0),
                "alive_hours": round((r["last_ok_at"] - r["started_at"]) / 3600, 2),
            }
            for r in rows
        ],
    }
