from fastapi import (
    FastAPI,
    HTTPException,
    Depends,
    Response,
    Cookie,
    Request,
    Body,
    Query,
    WebSocket,
    WebSocketDisconnect,
    BackgroundTasks,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
from ClasseVivaAPI import Utente, RequestURLs
import os
import re
import sqlite3
import time
import secrets
import json
import hashlib
import copy
import requests
from math import ceil
from threading import Lock
from typing import Optional, Any

app = FastAPI()

DEV_MODE = os.getenv("DEV_MODE", "").strip().lower() in {"1", "true", "yes"}
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


class ApiPrefixMiddleware(BaseHTTPMiddleware):
    """In dev, riscrive /api/* verso /* come fa Nginx in produzione."""

    async def dispatch(self, request, call_next):
        path = request.scope.get("path", "")
        if path == "/api":
            request.scope["path"] = "/"
        elif path.startswith("/api/"):
            request.scope["path"] = path[4:] or "/"
        return await call_next(request)


if DEV_MODE:
    app.add_middleware(ApiPrefixMiddleware)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Header di sicurezza base per ridurre XSS/clickjacking/sniffing."""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if request.url.scheme == "https" or COOKIE_SECURE:
            response.headers.setdefault(
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
            )
        return response


app.add_middleware(SecurityHeadersMiddleware)


def parse_allowed_origins() -> list[str]:
    default_origins = ",".join([
        "https://spaggiari2.federicoscutariu.it",
        "http://localhost",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "capacitor://localhost",
        "ionic://localhost",
    ])
    raw = os.getenv("ALLOWED_ORIGINS", default_origins)
    origins = [item.strip() for item in raw.split(",") if item.strip()]
    return origins or ["*"]


app.add_middleware(
    CORSMiddleware,
    allow_origins=parse_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_PATH = os.getenv("DATABASE_PATH", os.path.join("data", "spaggiari2.db"))
SESSION_TTL = 60 * 30  # 30 minuti
# Cache per-sessione della risposta /session/me: entro questa finestra non si tocca Spaggiari.
SESSION_ME_CACHE_TTL = int(os.getenv("SESSION_ME_CACHE_TTL", "60"))
# Cache per-sessione della student card (condivisa tra /session/me e /card).
CARD_CACHE_TTL = int(os.getenv("CARD_CACHE_TTL", "300"))
# Cache globale per ogni chiamata upstream ClasseViva: ogni endpoint viene chiamato
# al massimo una volta ogni 5 minuti per utente/argomenti.
UPSTREAM_ENDPOINT_CACHE_TTL = int(os.getenv("UPSTREAM_ENDPOINT_CACHE_TTL", "300"))
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "true").strip().lower() not in {"0", "false", "no"}
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "S10371278X").strip()
ADMIN_SESSION_TTL = 60 * 30  # allineato alla sessione principale
ADMIN_ALLOW_BOOTSTRAP = os.getenv("ADMIN_ALLOW_BOOTSTRAP", "").strip().lower() in {"1", "true", "yes"}
LOGIN_RATE_LIMIT_WINDOW = int(os.getenv("LOGIN_RATE_LIMIT_WINDOW", "300"))
LOGIN_RATE_LIMIT_MAX = int(os.getenv("LOGIN_RATE_LIMIT_MAX", "25"))
ORARIO_CLASS_PATTERN = re.compile(r"^[A-Z0-9]{1,16}$")
DEFAULT_EASTER_EGG_USERNAMES = (
    "S10371217U,aaronrai829@gmail.com,S10371278X,510371115,S9456217C,S10371066B"
)
GAME_GODOT_INDEX = os.path.join(PUBLIC_DIR, "game", "godot", "index.html")


def parse_easter_egg_usernames() -> set[str]:
    raw = os.getenv("EASTER_EGG_USERNAMES", DEFAULT_EASTER_EGG_USERNAMES)
    return {item.strip() for item in raw.split(",") if item.strip()}


EASTER_EGG_USERNAMES = parse_easter_egg_usernames()


def normalize_username(value: Any) -> str:
    """Username canonico per confronti locali (admin, easter egg, evidenziazione)."""
    return str(value or "").strip().upper()


def username_aliases(value: Any, ident: Optional[Any] = None) -> set[str]:
    """Varianti locali dello stesso account, senza chiamate upstream.

    CVV-API espone spesso uid completo (es. S10371278X) e ident numerico
    (es. 10371278). Per permessi/admin/classifiche li consideriamo alias.
    """
    aliases: set[str] = set()
    for raw in (value, ident):
        s = normalize_username(raw)
        if not s:
            continue
        aliases.add(s)
        if s[0:1] in {"S", "G"}:
            no_prefix = s[1:]
            aliases.add(no_prefix)
            digits = "".join(ch for ch in no_prefix if ch.isdigit())
            if digits:
                aliases.add(digits)
                aliases.add(f"S{digits}")
                aliases.add(f"G{digits}")
        digits = "".join(ch for ch in s if ch.isdigit())
        if digits:
            aliases.add(digits)
            aliases.add(f"S{digits}")
            aliases.add(f"G{digits}")
    return {item for item in aliases if item}


ADMIN_USERNAME_ALIASES = username_aliases(ADMIN_USERNAME)
EASTER_EGG_USERNAME_ALIASES = set()
for _egg_username in EASTER_EGG_USERNAMES:
    EASTER_EGG_USERNAME_ALIASES.update(username_aliases(_egg_username))


# ---- session store in memoria ----
sessions: dict[str, dict] = {}
admin_sessions: dict[str, dict] = {}
sessions_lock = Lock()
db_lock = Lock()
login_attempts_lock = Lock()
login_attempts: dict[str, list[float]] = {}
upstream_cache_lock = Lock()
upstream_cache_locks: dict[str, Lock] = {}
upstream_cache: dict[str, tuple[float, Any]] = {}


class LoginBody(BaseModel):
    username: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=1, max_length=256)


class AgendaBody(BaseModel):
    start: Optional[str] = None  # YYYYMMDD
    end: Optional[str] = None    # YYYYMMDD


class LeaderboardUpdateBody(BaseModel):
    class_code: Optional[str] = None
    school_code: Optional[str] = None
    full_name: Optional[str] = None
    hours: float
    visible_in_leaderboard: bool = True


class AverageLeaderboardUpdateBody(BaseModel):
    class_code: Optional[str] = None
    school_code: Optional[str] = None
    full_name: Optional[str] = None
    subject_name: str
    period_key: str
    period_label: Optional[str] = None
    average: float
    visible_in_leaderboard: bool = True


class AdminLoginBody(BaseModel):
    password: str


class AdminVisibilityBody(BaseModel):
    visible_in_leaderboard: bool


class AnnouncementUpdateBody(BaseModel):
    title: str
    body_markdown: str
    enabled: bool = True


class BadgeCreateBody(BaseModel):
    label: str = Field(..., min_length=1, max_length=32)
    text_color: str = Field(default="#ffffff", max_length=32)
    background_color: str = Field(default="rgba(59, 130, 246, 0.16)", max_length=64)
    border_color: str = Field(default="rgba(59, 130, 246, 0.35)", max_length=64)


class BadgeUpdateBody(BaseModel):
    label: Optional[str] = Field(default=None, min_length=1, max_length=32)
    text_color: Optional[str] = Field(default=None, max_length=32)
    background_color: Optional[str] = Field(default=None, max_length=64)
    border_color: Optional[str] = Field(default=None, max_length=64)


class BadgeBatchBody(BaseModel):
    badge_id: int
    usernames: list[str] = Field(default_factory=list)
    action: str = Field(..., pattern="^(assign|remove)$")


class ConnectionManager:
    def __init__(self):
        self.active_connections: set[WebSocket] = set()
        self.lock = Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        with self.lock:
            self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        with self.lock:
            self.active_connections.discard(websocket)

    async def broadcast(self, message: dict):
        payload = json.dumps(message)
        with self.lock:
            connections = list(self.active_connections)

        stale_connections = []
        for websocket in connections:
            try:
                await websocket.send_text(payload)
            except Exception:
                stale_connections.append(websocket)

        if stale_connections:
            with self.lock:
                for websocket in stale_connections:
                    self.active_connections.discard(websocket)


ws_manager = ConnectionManager()
admin_ws_manager = ConnectionManager()
ADMIN_LOGIN_EVENTS_MAX = 80
recent_admin_login_events: list[dict] = []
admin_events_lock = Lock()

GENERAL_AVERAGE_SUBJECT = "Media generale"
GENERAL_AVERAGE_PERIOD_KEY = "generale"


def ensure_data_dir():
    db_dir = os.path.dirname(DATABASE_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)


def get_db_connection() -> sqlite3.Connection:
    ensure_data_dir()
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db_lock:
        with get_db_connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS leaderboard_entries (
                    username TEXT PRIMARY KEY,
                    full_name TEXT,
                    class_code TEXT,
                    school_code TEXT,
                    hours REAL NOT NULL DEFAULT 0,
                    visible_in_leaderboard INTEGER NOT NULL DEFAULT 1,
                    updated_at REAL NOT NULL
                )
                """
            )
            # Add school_code column if missing (migration for existing DBs)
            try:
                conn.execute("ALTER TABLE leaderboard_entries ADD COLUMN school_code TEXT")
            except Exception:
                pass

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS average_leaderboard_entries_scoped (
                    username TEXT NOT NULL,
                    full_name TEXT,
                    class_code TEXT,
                    school_code TEXT,
                    subject_name TEXT NOT NULL,
                    period_key TEXT NOT NULL,
                    period_label TEXT,
                    average REAL NOT NULL DEFAULT 0,
                    visible_in_leaderboard INTEGER NOT NULL DEFAULT 1,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (username, subject_name, period_key)
                )
                """
            )
            # Add school_code column if missing (migration for existing DBs)
            try:
                conn.execute("ALTER TABLE average_leaderboard_entries_scoped ADD COLUMN school_code TEXT")
            except Exception:
                pass

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS site_announcement (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    title TEXT NOT NULL DEFAULT '',
                    body_markdown TEXT NOT NULL DEFAULT '',
                    enabled INTEGER NOT NULL DEFAULT 0,
                    content_version TEXT NOT NULL DEFAULT '',
                    updated_at REAL NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS announcement_views (
                    username TEXT NOT NULL,
                    content_version TEXT NOT NULL,
                    viewed_at REAL NOT NULL,
                    PRIMARY KEY (username, content_version)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_badges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    label TEXT NOT NULL UNIQUE,
                    text_color TEXT NOT NULL DEFAULT '#ffffff',
                    background_color TEXT NOT NULL DEFAULT 'rgba(59, 130, 246, 0.16)',
                    border_color TEXT NOT NULL DEFAULT 'rgba(59, 130, 246, 0.35)',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_badge_assignments (
                    username TEXT NOT NULL,
                    badge_id INTEGER NOT NULL,
                    assigned_at REAL NOT NULL,
                    PRIMARY KEY (username, badge_id),
                    FOREIGN KEY (badge_id) REFERENCES user_badges(id) ON DELETE CASCADE
                )
                """
            )

            existing = conn.execute("SELECT id FROM site_announcement WHERE id = 1").fetchone()
            if not existing:
                conn.execute(
                    """
                    INSERT INTO site_announcement (id, title, body_markdown, enabled, content_version, updated_at)
                    VALUES (1, '', '', 0, '', ?)
                    """,
                    (time.time(),),
                )

            conn.commit()


def _dedup_leaderboard(conn: sqlite3.Connection):
    """
    Remove duplicate leaderboard entries: for each group of (full_name, class_code, school_code),
    keep only the row with the most recent updated_at and delete the others.
    """
    rows = conn.execute(
        """
        SELECT username, full_name, class_code, school_code, updated_at
        FROM leaderboard_entries
        ORDER BY updated_at DESC
        """
    ).fetchall()

    seen: dict[tuple, str] = {}  # key -> username to keep
    to_delete: list[str] = []

    for row in rows:
        key = (
            (row["full_name"] or "").strip().lower(),
            (row["class_code"] or "").strip().upper(),
            (row["school_code"] or "").strip().upper(),
        )
        if key in seen:
            to_delete.append(row["username"])
        else:
            seen[key] = row["username"]

    for username in to_delete:
        conn.execute("DELETE FROM leaderboard_entries WHERE username = ?", (username,))

    return len(to_delete)


def _dedup_average_leaderboard(conn: sqlite3.Connection):
    """
    Remove duplicate average leaderboard entries: for each group of
    (full_name, class_code, school_code, subject_name, period_key),
    keep only the row with the most recent updated_at.
    """
    rows = conn.execute(
        """
        SELECT username, full_name, class_code, school_code, subject_name, period_key, updated_at
        FROM average_leaderboard_entries_scoped
        ORDER BY updated_at DESC
        """
    ).fetchall()

    seen: dict[tuple, str] = {}
    to_delete: list[tuple] = []

    for row in rows:
        key = (
            (row["full_name"] or "").strip().lower(),
            (row["class_code"] or "").strip().upper(),
            (row["school_code"] or "").strip().upper(),
            (row["subject_name"] or "").strip(),
            (row["period_key"] or "").strip().lower(),
        )
        if key in seen:
            to_delete.append((row["username"], row["subject_name"], row["period_key"]))
        else:
            seen[key] = row["username"]

    for (username, subject_name, period_key) in to_delete:
        conn.execute(
            "DELETE FROM average_leaderboard_entries_scoped WHERE username = ? AND subject_name = ? AND period_key = ?",
            (username, subject_name, period_key),
        )

    return len(to_delete)


@app.on_event("startup")
def on_startup():
    init_db()
    with db_lock:
        with get_db_connection() as conn:
            n1 = _dedup_leaderboard(conn)
            n2 = _dedup_average_leaderboard(conn)
            conn.commit()
            if n1 or n2:
                print(f"[startup] Rimossi duplicati: {n1} da leaderboard, {n2} da average_leaderboard")


def row_to_entry(row: sqlite3.Row | None):
    if row is None:
        return None
    return {
        "username": row["username"],
        "full_name": row["full_name"] or row["username"],
        "class_code": row["class_code"],
        "school_code": row["school_code"],
        "hours": row["hours"],
        "visible_in_leaderboard": bool(row["visible_in_leaderboard"]),
        "updated_at": row["updated_at"],
    }


def upsert_leaderboard_entry(*, username: str, full_name: Optional[str], class_code: Optional[str], school_code: Optional[str], hours: float, visible_in_leaderboard: bool):
    now = time.time()
    normalized_username = username.strip()
    normalized_full_name = (full_name or "").strip() or normalized_username
    normalized_class = (class_code or "").strip().upper() or None
    normalized_school = (school_code or "").strip().upper() or None

    with db_lock:
        with get_db_connection() as conn:
            # Check if another username already exists with same (full_name, class_code, school_code)
            existing = conn.execute(
                """
                SELECT username FROM leaderboard_entries
                WHERE lower(trim(full_name)) = lower(?) AND upper(trim(coalesce(class_code,''))) = upper(?) AND upper(trim(coalesce(school_code,''))) = upper(?)
                AND username != ?
                """,
                (
                    normalized_full_name,
                    normalized_class or "",
                    normalized_school or "",
                    normalized_username,
                ),
            ).fetchone()

            if existing:
                # Merge: update the existing canonical entry with latest data and delete this username's entry
                old_username = existing["username"]
                conn.execute(
                    """
                    UPDATE leaderboard_entries SET
                        hours = ?,
                        visible_in_leaderboard = ?,
                        updated_at = ?
                    WHERE username = ?
                    """,
                    (float(hours), 1 if visible_in_leaderboard else 0, now, old_username),
                )
                # Remove stale duplicate if it exists
                conn.execute("DELETE FROM leaderboard_entries WHERE username = ? AND username != ?", (normalized_username, old_username))
                conn.commit()
                row = conn.execute(
                    "SELECT username, full_name, class_code, school_code, hours, visible_in_leaderboard, updated_at FROM leaderboard_entries WHERE username = ?",
                    (old_username,),
                ).fetchone()
            else:
                conn.execute(
                    """
                    INSERT INTO leaderboard_entries (
                        username,
                        full_name,
                        class_code,
                        school_code,
                        hours,
                        visible_in_leaderboard,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(username) DO UPDATE SET
                        full_name = excluded.full_name,
                        class_code = excluded.class_code,
                        school_code = excluded.school_code,
                        hours = excluded.hours,
                        visible_in_leaderboard = excluded.visible_in_leaderboard,
                        updated_at = excluded.updated_at
                    """,
                    (
                        normalized_username,
                        normalized_full_name,
                        normalized_class,
                        normalized_school,
                        float(hours),
                        1 if visible_in_leaderboard else 0,
                        now,
                    ),
                )
                conn.commit()
                row = conn.execute(
                    "SELECT username, full_name, class_code, school_code, hours, visible_in_leaderboard, updated_at FROM leaderboard_entries WHERE username = ?",
                    (normalized_username,),
                ).fetchone()
    return row_to_entry(row)


def delete_leaderboard_entry(username: str) -> bool:
    normalized_username = username.strip()
    with db_lock:
        with get_db_connection() as conn:
            cur = conn.execute("DELETE FROM leaderboard_entries WHERE username = ?", (normalized_username,))
            conn.commit()
            return cur.rowcount > 0


def get_leaderboard_entry(username: str):
    normalized_username = username.strip()
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT username, full_name, class_code, school_code, hours, visible_in_leaderboard, updated_at FROM leaderboard_entries WHERE username = ?",
            (normalized_username,),
        ).fetchone()
    return row_to_entry(row)


def list_leaderboard_entries():
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT username, full_name, class_code, school_code, hours, visible_in_leaderboard, updated_at FROM leaderboard_entries"
        ).fetchall()
    return [row_to_entry(row) for row in rows]


def row_to_average_entry(row: sqlite3.Row | None):
    if row is None:
        return None
    return {
        "username": row["username"],
        "full_name": row["full_name"] or row["username"],
        "class_code": row["class_code"],
        "school_code": row["school_code"],
        "subject_name": row["subject_name"],
        "period_key": row["period_key"],
        "period_label": row["period_label"] or row["period_key"],
        "average": row["average"],
        "visible_in_leaderboard": bool(row["visible_in_leaderboard"]),
        "updated_at": row["updated_at"],
    }


def upsert_average_leaderboard_entry(*, username: str, full_name: Optional[str], class_code: Optional[str], school_code: Optional[str], subject_name: str, period_key: str, period_label: Optional[str], average: float, visible_in_leaderboard: bool):
    now = time.time()
    normalized_username = username.strip()
    normalized_full_name = (full_name or "").strip() or normalized_username
    normalized_class = (class_code or "").strip().upper() or None
    normalized_school = (school_code or "").strip().upper() or None
    normalized_subject = (subject_name or "").strip()
    normalized_period_key = (period_key or "").strip().lower()
    normalized_period_label = (period_label or normalized_period_key).strip()

    if not normalized_subject:
        raise HTTPException(status_code=400, detail="subject_name richiesto")
    if not normalized_period_key:
        raise HTTPException(status_code=400, detail="period_key richiesto")

    with db_lock:
        with get_db_connection() as conn:
            # Check for duplicate: same (full_name, class_code, school_code, subject_name, period_key), different username
            existing = conn.execute(
                """
                SELECT username FROM average_leaderboard_entries_scoped
                WHERE lower(trim(full_name)) = lower(?)
                  AND upper(trim(coalesce(class_code,''))) = upper(?)
                  AND upper(trim(coalesce(school_code,''))) = upper(?)
                  AND subject_name = ?
                  AND period_key = ?
                  AND username != ?
                """,
                (
                    normalized_full_name,
                    normalized_class or "",
                    normalized_school or "",
                    normalized_subject,
                    normalized_period_key,
                    normalized_username,
                ),
            ).fetchone()

            if existing:
                old_username = existing["username"]
                conn.execute(
                    """
                    UPDATE average_leaderboard_entries_scoped SET
                        period_label = ?,
                        average = ?,
                        visible_in_leaderboard = ?,
                        updated_at = ?
                    WHERE username = ? AND subject_name = ? AND period_key = ?
                    """,
                    (
                        normalized_period_label,
                        float(average),
                        1 if visible_in_leaderboard else 0,
                        now,
                        old_username,
                        normalized_subject,
                        normalized_period_key,
                    ),
                )
                # Remove stale entry for this username if it exists
                conn.execute(
                    "DELETE FROM average_leaderboard_entries_scoped WHERE username = ? AND subject_name = ? AND period_key = ? AND username != ?",
                    (normalized_username, normalized_subject, normalized_period_key, old_username),
                )
                conn.commit()
                row = conn.execute(
                    """
                    SELECT username, full_name, class_code, school_code, subject_name, period_key, period_label, average, visible_in_leaderboard, updated_at
                    FROM average_leaderboard_entries_scoped
                    WHERE username = ? AND subject_name = ? AND period_key = ?
                    """,
                    (old_username, normalized_subject, normalized_period_key),
                ).fetchone()
            else:
                conn.execute(
                    """
                    INSERT INTO average_leaderboard_entries_scoped (
                        username,
                        full_name,
                        class_code,
                        school_code,
                        subject_name,
                        period_key,
                        period_label,
                        average,
                        visible_in_leaderboard,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(username, subject_name, period_key) DO UPDATE SET
                        full_name = excluded.full_name,
                        class_code = excluded.class_code,
                        school_code = excluded.school_code,
                        period_label = excluded.period_label,
                        average = excluded.average,
                        visible_in_leaderboard = excluded.visible_in_leaderboard,
                        updated_at = excluded.updated_at
                    """,
                    (
                        normalized_username,
                        normalized_full_name,
                        normalized_class,
                        normalized_school,
                        normalized_subject,
                        normalized_period_key,
                        normalized_period_label,
                        float(average),
                        1 if visible_in_leaderboard else 0,
                        now,
                    ),
                )
                conn.commit()
                row = conn.execute(
                    """
                    SELECT username, full_name, class_code, school_code, subject_name, period_key, period_label, average, visible_in_leaderboard, updated_at
                    FROM average_leaderboard_entries_scoped
                    WHERE username = ? AND subject_name = ? AND period_key = ?
                    """,
                    (normalized_username, normalized_subject, normalized_period_key),
                ).fetchone()
    return row_to_average_entry(row)


def delete_average_leaderboard_entry(username: str, subject_name: Optional[str] = None, period_key: Optional[str] = None) -> bool:
    normalized_username = username.strip()
    normalized_subject = (subject_name or "").strip()
    normalized_period_key = (period_key or "").strip().lower()
    with db_lock:
        with get_db_connection() as conn:
            if normalized_subject and normalized_period_key:
                cur = conn.execute(
                    "DELETE FROM average_leaderboard_entries_scoped WHERE username = ? AND subject_name = ? AND period_key = ?",
                    (normalized_username, normalized_subject, normalized_period_key),
                )
            else:
                cur = conn.execute(
                    "DELETE FROM average_leaderboard_entries_scoped WHERE username = ?",
                    (normalized_username,),
                )
            conn.commit()
            return cur.rowcount > 0


def get_average_leaderboard_entry(username: str, subject_name: str, period_key: str):
    normalized_username = username.strip()
    normalized_subject = (subject_name or "").strip()
    normalized_period_key = (period_key or "").strip().lower()
    with get_db_connection() as conn:
        row = conn.execute(
            """
            SELECT username, full_name, class_code, school_code, subject_name, period_key, period_label, average, visible_in_leaderboard, updated_at
            FROM average_leaderboard_entries_scoped
            WHERE username = ? AND subject_name = ? AND period_key = ?
            """,
            (normalized_username, normalized_subject, normalized_period_key),
        ).fetchone()
    return row_to_average_entry(row)


def list_all_average_leaderboard_entries():
    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT username, full_name, class_code, school_code, subject_name, period_key, period_label, average, visible_in_leaderboard, updated_at
            FROM average_leaderboard_entries_scoped
            ORDER BY updated_at DESC
            """
        ).fetchall()
    return [row_to_average_entry(row) for row in rows]


def is_general_average_entry(entry: dict) -> bool:
    subject = (entry.get("subject_name") or "").strip()
    period_key = (entry.get("period_key") or "").strip().lower()
    return subject == GENERAL_AVERAGE_SUBJECT and period_key == GENERAL_AVERAGE_PERIOD_KEY


def list_average_leaderboard_users_for_admin():
    entries = list_all_average_leaderboard_entries()
    grouped: dict[str, list[dict]] = {}

    for entry in entries:
        username = (entry.get("username") or "").strip()
        if not username:
            continue
        grouped.setdefault(username, []).append(entry)

    result = []
    for username, rows in grouped.items():
        general_rows = [row for row in rows if is_general_average_entry(row)]
        pick = general_rows[0] if general_rows else max(rows, key=lambda row: row.get("updated_at", 0))
        result.append(
            {
                "username": username,
                "full_name": pick.get("full_name") or username,
                "average": pick.get("average", 0),
                "visible_in_leaderboard": any(row.get("visible_in_leaderboard") for row in rows),
                "updated_at": pick.get("updated_at"),
                "entries_count": len(rows),
            }
        )

    result.sort(key=lambda item: (-float(item.get("average", 0)), item.get("username", "").lower()))
    return result


def update_leaderboard_visibility(username: str, visible: bool) -> bool:
    normalized_username = username.strip()
    with db_lock:
        with get_db_connection() as conn:
            cur = conn.execute(
                "UPDATE leaderboard_entries SET visible_in_leaderboard = ?, updated_at = ? WHERE username = ?",
                (1 if visible else 0, time.time(), normalized_username),
            )
            conn.commit()
            return cur.rowcount > 0


def update_average_leaderboard_visibility(username: str, subject_name: str, period_key: str, visible: bool) -> bool:
    normalized_username = username.strip()
    with db_lock:
        with get_db_connection() as conn:
            cur = conn.execute(
                """
                UPDATE average_leaderboard_entries_scoped
                SET visible_in_leaderboard = ?, updated_at = ?
                WHERE username = ? AND subject_name = ? AND period_key = ?
                """,
                (1 if visible else 0, time.time(), normalized_username, subject_name.strip(), period_key.strip()),
            )
            conn.commit()
            return cur.rowcount > 0


def update_average_leaderboard_visibility_for_user(username: str, visible: bool) -> bool:
    normalized_username = username.strip()
    with db_lock:
        with get_db_connection() as conn:
            cur = conn.execute(
                """
                UPDATE average_leaderboard_entries_scoped
                SET visible_in_leaderboard = ?, updated_at = ?
                WHERE username = ?
                """,
                (1 if visible else 0, time.time(), normalized_username),
            )
            conn.commit()
            return cur.rowcount > 0


def list_average_leaderboard_entries(subject_name: str, period_key: str):
    normalized_subject = (subject_name or "").strip()
    normalized_period_key = (period_key or "").strip().lower()
    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT username, full_name, class_code, school_code, subject_name, period_key, period_label, average, visible_in_leaderboard, updated_at
            FROM average_leaderboard_entries_scoped
            WHERE subject_name = ? AND period_key = ?
            """,
            (normalized_subject, normalized_period_key),
        ).fetchall()
    return [row_to_average_entry(row) for row in rows]


def _normalize_badge_color(value: Optional[str], fallback: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return fallback
    # Accetta hex, rgb/rgba/hsl/hsla o CSS var(). Evita caratteri pericolosi.
    if re.fullmatch(r"#[0-9A-Fa-f]{3,8}", raw):
        return raw
    if re.fullmatch(r"rgba?\([0-9.,%\s]+\)", raw):
        return raw
    if re.fullmatch(r"hsla?\([0-9.,%\s]+\)", raw):
        return raw
    if re.fullmatch(r"var\(--[A-Za-z0-9_-]+\)", raw):
        return raw
    return fallback


def row_to_badge(row: sqlite3.Row | None) -> Optional[dict]:
    if not row:
        return None
    return {
        "id": int(row["id"]),
        "label": row["label"],
        "text_color": row["text_color"],
        "background_color": row["background_color"],
        "border_color": row["border_color"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_badges() -> list[dict]:
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT id, label, text_color, background_color, border_color, created_at, updated_at FROM user_badges ORDER BY lower(label)"
        ).fetchall()
    return [row_to_badge(row) for row in rows if row]


def create_badge(*, label: str, text_color: str, background_color: str, border_color: str) -> dict:
    clean_label = label.strip()
    if not clean_label:
        raise HTTPException(status_code=400, detail="Nome badge richiesto")
    now = time.time()
    with db_lock:
        with get_db_connection() as conn:
            try:
                cur = conn.execute(
                    """
                    INSERT INTO user_badges (label, text_color, background_color, border_color, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        clean_label,
                        _normalize_badge_color(text_color, "#ffffff"),
                        _normalize_badge_color(background_color, "rgba(59, 130, 246, 0.16)"),
                        _normalize_badge_color(border_color, "rgba(59, 130, 246, 0.35)"),
                        now,
                        now,
                    ),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=409, detail="Badge già esistente")
            row = conn.execute(
                "SELECT id, label, text_color, background_color, border_color, created_at, updated_at FROM user_badges WHERE id = ?",
                (cur.lastrowid,),
            ).fetchone()
    badge = row_to_badge(row)
    if not badge:
        raise HTTPException(status_code=500, detail="Badge non creato")
    return badge


def update_badge(badge_id: int, body: BadgeUpdateBody) -> dict:
    fields = []
    values: list[Any] = []
    if body.label is not None:
        label = body.label.strip()
        if not label:
            raise HTTPException(status_code=400, detail="Nome badge richiesto")
        fields.append("label = ?")
        values.append(label)
    if body.text_color is not None:
        fields.append("text_color = ?")
        values.append(_normalize_badge_color(body.text_color, "#ffffff"))
    if body.background_color is not None:
        fields.append("background_color = ?")
        values.append(_normalize_badge_color(body.background_color, "rgba(59, 130, 246, 0.16)"))
    if body.border_color is not None:
        fields.append("border_color = ?")
        values.append(_normalize_badge_color(body.border_color, "rgba(59, 130, 246, 0.35)"))
    if not fields:
        raise HTTPException(status_code=400, detail="Nessuna modifica")
    fields.append("updated_at = ?")
    values.append(time.time())
    values.append(int(badge_id))
    with db_lock:
        with get_db_connection() as conn:
            try:
                cur = conn.execute(f"UPDATE user_badges SET {', '.join(fields)} WHERE id = ?", values)
                conn.commit()
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=409, detail="Badge già esistente")
            if cur.rowcount <= 0:
                raise HTTPException(status_code=404, detail="Badge non trovato")
            row = conn.execute(
                "SELECT id, label, text_color, background_color, border_color, created_at, updated_at FROM user_badges WHERE id = ?",
                (int(badge_id),),
            ).fetchone()
    badge = row_to_badge(row)
    if not badge:
        raise HTTPException(status_code=404, detail="Badge non trovato")
    return badge


def delete_badge(badge_id: int) -> bool:
    with db_lock:
        with get_db_connection() as conn:
            conn.execute("DELETE FROM user_badge_assignments WHERE badge_id = ?", (int(badge_id),))
            cur = conn.execute("DELETE FROM user_badges WHERE id = ?", (int(badge_id),))
            conn.commit()
            return cur.rowcount > 0


def list_user_badges(username: Optional[str], ident: Optional[Any] = None) -> list[dict]:
    aliases = username_aliases(username, ident)
    if not aliases:
        return []
    placeholders = ",".join("?" for _ in aliases)
    with get_db_connection() as conn:
        rows = conn.execute(
            f"""
            SELECT DISTINCT b.id, b.label, b.text_color, b.background_color, b.border_color, b.created_at, b.updated_at
            FROM user_badges b
            JOIN user_badge_assignments a ON a.badge_id = b.id
            WHERE upper(trim(a.username)) IN ({placeholders})
            ORDER BY lower(b.label)
            """,
            tuple(aliases),
        ).fetchall()
    return [row_to_badge(row) for row in rows if row]


def _canonical_badge_username(username: str) -> str:
    return str(username or "").strip()


def apply_badge_batch(*, badge_id: int, usernames: list[str], action: str) -> dict:
    clean_usernames = []
    seen = set()
    for username in usernames:
        clean = _canonical_badge_username(username)
        if not clean:
            continue
        key = normalize_username(clean)
        if key in seen:
            continue
        seen.add(key)
        clean_usernames.append(clean)
    if not clean_usernames:
        raise HTTPException(status_code=400, detail="Nessun utente selezionato")
    with db_lock:
        with get_db_connection() as conn:
            badge = conn.execute("SELECT id FROM user_badges WHERE id = ?", (int(badge_id),)).fetchone()
            if not badge:
                raise HTTPException(status_code=404, detail="Badge non trovato")
            now = time.time()
            changed = 0
            if action == "assign":
                for username in clean_usernames:
                    cur = conn.execute(
                        """
                        INSERT OR IGNORE INTO user_badge_assignments (username, badge_id, assigned_at)
                        VALUES (?, ?, ?)
                        """,
                        (username, int(badge_id), now),
                    )
                    changed += cur.rowcount
            elif action == "remove":
                for username in clean_usernames:
                    alias_set = username_aliases(username)
                    placeholders = ",".join("?" for _ in alias_set)
                    cur = conn.execute(
                        f"DELETE FROM user_badge_assignments WHERE badge_id = ? AND upper(trim(username)) IN ({placeholders})",
                        (int(badge_id), *tuple(alias_set)),
                    )
                    changed += cur.rowcount
            else:
                raise HTTPException(status_code=400, detail="Azione non valida")
            conn.commit()
    return {"requested": len(clean_usernames), "changed": changed, "usernames": clean_usernames}


def collect_known_users(query: Optional[str] = None, limit: int = 80) -> list[dict]:
    users: dict[str, dict] = {}

    def add_user(username: Any, full_name: Any = None, class_code: Any = None, school_code: Any = None, source: str = "db"):
        raw_username = str(username or "").strip()
        if not raw_username:
            return
        key = normalize_username(raw_username)
        existing = users.get(key, {})
        users[key] = {
            "username": existing.get("username") or raw_username,
            "full_name": existing.get("full_name") or (str(full_name).strip() if full_name else None),
            "class_code": existing.get("class_code") or (str(class_code).strip().upper() if class_code else None),
            "school_code": existing.get("school_code") or (str(school_code).strip().upper() if school_code else None),
            "sources": sorted(set(existing.get("sources", [])) | {source}),
        }

    for row in list_leaderboard_entries():
        add_user(row.get("username"), row.get("full_name"), row.get("class_code"), row.get("school_code"), "assenze")
    for row in list_all_average_leaderboard_entries():
        add_user(row.get("username"), row.get("full_name"), row.get("class_code"), row.get("school_code"), "voti")
    with sessions_lock:
        for sess in sessions.values():
            if sess.get("expires", 0) < time.time():
                continue
            profile = sess.get("profile") if isinstance(sess.get("profile"), dict) else {}
            add_user(
                sess.get("username") or getattr(sess.get("user"), "uid", None),
                profile.get("full_name"),
                profile.get("class_code"),
                profile.get("school_code"),
                "sessione",
            )
    with get_db_connection() as conn:
        rows = conn.execute("SELECT DISTINCT username FROM user_badge_assignments").fetchall()
    for row in rows:
        add_user(row["username"], source="badge")

    needle = (query or "").strip().lower()
    result = []
    for item in users.values():
        haystack = " ".join([
            str(item.get("username") or ""),
            str(item.get("full_name") or ""),
            str(item.get("class_code") or ""),
            str(item.get("school_code") or ""),
        ]).lower()
        if needle and needle not in haystack:
            continue
        item["badges"] = list_user_badges(item.get("username"))
        result.append(item)
    result.sort(key=lambda item: ((item.get("full_name") or item.get("username") or "").lower()))
    return result[: max(1, min(int(limit), 200))]


def invalidate_session_me_caches_for_badges() -> None:
    with sessions_lock:
        for sess in sessions.values():
            sess["me_cache"] = None
            profile = sess.get("profile")
            if isinstance(profile, dict):
                profile.pop("badges", None)



def enrich_entry_with_badges(entry: dict) -> dict:
    enriched = dict(entry)
    enriched["badges"] = list_user_badges(enriched.get("username"))
    return enriched


async def broadcast_leaderboard_change(action: str, username: str):
    await ws_manager.broadcast(
        {
            "type": "leaderboard_changed",
            "action": action,
            "username": username,
            "timestamp": time.time(),
        }
    )


async def broadcast_average_leaderboard_change(action: str, username: str):
    await ws_manager.broadcast(
        {
            "type": "average_leaderboard_changed",
            "action": action,
            "username": username,
            "timestamp": time.time(),
        }
    )



def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def check_login_rate_limit(client_ip: str):
    now = time.time()
    with login_attempts_lock:
        attempts = login_attempts.get(client_ip, [])
        attempts = [ts for ts in attempts if now - ts < LOGIN_RATE_LIMIT_WINDOW]
        if len(attempts) >= LOGIN_RATE_LIMIT_MAX:
            raise HTTPException(
                status_code=429,
                detail="Troppi tentativi di login. Riprova tra qualche minuto.",
            )
        attempts.append(now)
        login_attempts[client_ip] = attempts


def purge_expired_sessions():
    now = time.time()
    with sessions_lock:
        expired = [sid for sid, sess in sessions.items() if sess.get("expires", 0) < now]
        for sid in expired:
            sessions.pop(sid, None)
        expired_admin = [
            sid for sid, sess in admin_sessions.items() if sess.get("expires", 0) < now
        ]
        for sid in expired_admin:
            admin_sessions.pop(sid, None)


def destroy_session(session_id: Optional[str], admin_session_id: Optional[str] = None):
    if session_id:
        with sessions_lock:
            sessions.pop(session_id, None)
    if admin_session_id:
        with sessions_lock:
            admin_sessions.pop(admin_session_id, None)


def _first_saved_profile_for_user(username: str, ident: Optional[Any] = None) -> dict:
    """Recupera nome/classe/scuola già salvati nel DB locale, senza upstream."""
    aliases = username_aliases(username, ident)
    for alias in aliases:
        item = get_leaderboard_entry(alias)
        if item:
            return {
                "full_name": item.get("full_name"),
                "class_code": item.get("class_code"),
                "school_code": item.get("school_code"),
            }
    for row in list_all_average_leaderboard_entries():
        if normalize_username(row.get("username")) in aliases:
            return {
                "full_name": row.get("full_name"),
                "class_code": row.get("class_code"),
                "school_code": row.get("school_code"),
            }
    return {"full_name": None, "class_code": None, "school_code": None}


def _extract_class_code_from_card_fields(fields: dict) -> Optional[str]:
    for key in ("classDesc", "classCode", "classe", "clsDesc", "clsCode", "className"):
        raw = str(fields.get(key) or "").strip().upper()
        if not raw:
            continue
        raw = raw.replace(" ", "")
        match = re.search(r"(\\d{1,2}[A-Z]{1,4})", raw)
        return match.group(1) if match else raw[:16]
    return None


def build_session_profile(u: Utente, card_res: Optional[dict] = None) -> dict:
    username = get_session_username(u)
    profile = {
        "username": username,
        "full_name": None,
        "school_code": None,
        "class_code": None,
        "is_admin": is_admin_username(username),
        "easter_egg_eligible": is_easter_egg_username(username),
    }

    # 1) Dati locali già salvati (zero richieste upstream).
    saved = _first_saved_profile_for_user(username, getattr(u, "ident", None))
    profile.update({k: v for k, v in saved.items() if v})

    # 2) Card già disponibile in cache/sessione: arricchisce senza nuove chiamate.
    if isinstance(card_res, dict):
        try:
            fields = extract_student_card_fields(card_res)
            full_name = f"{(fields.get('firstName') or '').strip()} {(fields.get('lastName') or '').strip()}".strip()
            if full_name:
                profile["full_name"] = full_name
            school_code = (
                str(fields.get("schCode") or fields.get("miurSchoolCode") or "").strip().upper()
                or None
            )
            if school_code:
                profile["school_code"] = school_code
            class_code = _extract_class_code_from_card_fields(fields)
            if class_code:
                profile["class_code"] = class_code
        except Exception:
            pass

    return profile

def get_session_record(session_id: Optional[str]) -> dict:
    purge_expired_sessions()
    if not session_id:
        raise HTTPException(status_code=401, detail="Non loggato")

    with sessions_lock:
        if session_id not in sessions:
            raise HTTPException(status_code=401, detail="Non loggato")

        sess = sessions[session_id]
        if sess["expires"] < time.time():
            sessions.pop(session_id, None)
            raise HTTPException(status_code=401, detail="Sessione scaduta")

        # rinnova TTL a ogni richiesta
        sess["expires"] = time.time() + SESSION_TTL
        return sess


def get_session_user(session_id: Optional[str]) -> Utente:
    return get_session_record(session_id)["user"]


async def websocket_auth(websocket: WebSocket) -> Utente:
    session_id = websocket.cookies.get("session_id")
    if not session_id:
        await websocket.close(code=4401, reason="Non loggato")
        raise WebSocketDisconnect(code=4401)

    try:
        return get_session_user(session_id)
    except HTTPException:
        await websocket.close(code=4401, reason="Sessione non valida")
        raise WebSocketDisconnect(code=4401)


def current_user(request: Request, session_id: Optional[str] = Cookie(default=None)):
    return get_session_user(session_id)


def get_session_username(user: Utente) -> str:
    username = getattr(user, "_app_username", None) or getattr(user, "uid", None)
    if not username:
        raise HTTPException(status_code=401, detail="Utente non valido")
    return str(username).strip()


# ---- cache upstream ClasseViva: 1 call / 5 minuti / utente / endpoint ----
def _cache_user_key_from_values(uid: Optional[str], ident: Optional[str] = None) -> str:
    raw = str(uid or ident or "unknown").strip().lower()
    return hashlib.sha256(raw.encode("utf-8", errors="ignore")).hexdigest()


def _cache_user_key(u: Utente) -> str:
    return _cache_user_key_from_values(
        getattr(u, "uid", None),
        getattr(u, "ident", None),
    )


def _cache_key(parts: list[Any]) -> str:
    payload = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8", errors="ignore")).hexdigest()


def _get_cache_lock(key: str) -> Lock:
    with upstream_cache_lock:
        lock = upstream_cache_locks.get(key)
        if lock is None:
            lock = upstream_cache_locks[key] = Lock()
        return lock


def _get_cached_value(key: str, *, clone: bool = True) -> Optional[Any]:
    now = time.time()
    with upstream_cache_lock:
        cached = upstream_cache.get(key)
        if not cached:
            return None
        expires, value = cached
        if expires <= now:
            upstream_cache.pop(key, None)
            return None
        return copy.deepcopy(value) if clone else value


def _set_cached_value(key: str, value: Any, *, ttl: int = UPSTREAM_ENDPOINT_CACHE_TTL, clone: bool = True) -> None:
    stored = copy.deepcopy(value) if clone else value
    with upstream_cache_lock:
        upstream_cache[key] = (time.time() + ttl, stored)


def cached_call(key: str, fetcher, *, ttl: int = UPSTREAM_ENDPOINT_CACHE_TTL, clone: bool = True) -> Any:
    cached = _get_cached_value(key, clone=clone)
    if cached is not None:
        return cached

    lock = _get_cache_lock(key)
    with lock:
        cached = _get_cached_value(key, clone=clone)
        if cached is not None:
            return cached
        value = fetcher()
        # Gli errori non vengono cachati: solo una risposta valida popola la cache.
        _set_cached_value(key, value, ttl=ttl, clone=clone)
        return copy.deepcopy(value) if clone else value


def cached_login_user(username: str, password: str) -> Utente:
    normalized_username = username.strip()
    # Include la password hashata: evita di accettare una password errata solo perché
    # lo stesso utente ha fatto login correttamente nei 5 minuti precedenti.
    password_hash = hashlib.sha256(password.encode("utf-8", errors="ignore")).hexdigest()
    user_key = _cache_user_key_from_values(normalized_username)
    key = _cache_key(["cvv-login", user_key, password_hash])

    def fetch_login() -> Utente:
        user = Utente(uid=normalized_username, pwd=password)
        user.login()
        # Mantiene l'username digitato come identità app: niente round-trip extra.
        user._app_username = normalized_username
        user.uid = normalized_username
        return user

    return cached_call(key, fetch_login, ttl=UPSTREAM_ENDPOINT_CACHE_TTL, clone=False)


def _response_json_or_error(resp: Any, *, context: str) -> Any:
    if hasattr(resp, "status_code"):
        raise_for_upstream_http_status(resp.status_code, context=context)
        try:
            return resp.json()
        except ValueError:
            return {}
    if hasattr(resp, "json"):
        try:
            return resp.json()
        except ValueError:
            return {}
    return resp


def cached_cvv_request_json(u: Utente, endpoint_name: str, request_url: Any, *args: Any) -> Any:
    key = _cache_key(["cvv-request", _cache_user_key(u), endpoint_name, list(args)])

    def fetch() -> Any:
        resp = u.request(request_url, *args)
        return _response_json_or_error(resp, context=f"{endpoint_name} upstream")

    return cached_call(key, fetch)


def _format_request_url(request_url: Any, *args: Any) -> str:
    template = request_url[0] if isinstance(request_url, (list, tuple)) else str(request_url)
    return template.format(*args)


def cached_cvv_direct_json(u: Utente, endpoint_name: str, request_url: Any, *args: Any, timeout: int = 20) -> Any:
    url = _format_request_url(request_url, *args)
    key = _cache_key(["cvv-direct", _cache_user_key(u), endpoint_name, url])

    def fetch() -> Any:
        try:
            resp = requests.get(url, headers=u.get_headers(), timeout=timeout)
        except requests.RequestException as e:
            raise UpstreamUnavailable(f"Spaggiari irraggiungibile: {e}")
        raise_for_upstream_http_status(resp.status_code, context=f"{endpoint_name} upstream")
        try:
            return resp.json()
        except ValueError:
            return {}

    return cached_call(key, fetch)


def cached_agenda_json(u: Utente, start: str, end: str) -> Any:
    user_ident = getattr(u, "ident", None) or getattr(u, "uid", None)
    if not user_ident:
        raise HTTPException(status_code=500, detail="Impossibile determinare ident utente")
    return cached_cvv_direct_json(u, "agenda", RequestURLs.agenda, user_ident, start, end, timeout=20)

def cached_external_get_json_for_user(
    u: Utente,
    endpoint_name: str,
    url: str,
    *,
    params: Optional[dict[str, Any]] = None,
    timeout: int = 20,
) -> Any:
    normalized_params = params or {}
    key = _cache_key(["external-get", _cache_user_key(u), endpoint_name, url, normalized_params])

    def fetch() -> Any:
        resp = requests.get(url, params=normalized_params, timeout=timeout)
        if resp.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"{endpoint_name}: {resp.status_code}")
        try:
            return resp.json()
        except ValueError:
            return {}

    return cached_call(key, fetch)


def is_admin_username(username: str) -> bool:
    return bool(username_aliases(username) & ADMIN_USERNAME_ALIASES)


def is_easter_egg_username(username: str) -> bool:
    return bool(username_aliases(username) & EASTER_EGG_USERNAME_ALIASES)


def godot_export_available() -> bool:
    if not os.path.isfile(GAME_GODOT_INDEX):
        return False
    try:
        with open(GAME_GODOT_INDEX, "r", encoding="utf-8", errors="ignore") as handle:
            sample = handle.read(1200).lower()
        # Placeholder lasciato nel repo finché non carichi l'export reale.
        return "sostituisci questa cartella" not in sample
    except OSError:
        return False


def create_admin_session(main_session_id: str) -> str:
    admin_sid = secrets.token_urlsafe(32)
    with sessions_lock:
        admin_sessions[admin_sid] = {
            "session_id": main_session_id,
            "expires": time.time() + ADMIN_SESSION_TTL,
        }
    return admin_sid


def clear_admin_session(admin_session_id: Optional[str]):
    if not admin_session_id:
        return
    with sessions_lock:
        admin_sessions.pop(admin_session_id, None)


def set_admin_cookie(response: Response, admin_sid: str):
    response.set_cookie(
        key="admin_session_id",
        value=admin_sid,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        max_age=ADMIN_SESSION_TTL,
    )


def clear_admin_cookie(response: Response):
    response.delete_cookie(key="admin_session_id", httponly=True, samesite="lax", secure=COOKIE_SECURE)


def validate_admin_access(
    session_id: Optional[str],
    admin_session_id: Optional[str],
) -> Utente:
    if not admin_session_id:
        raise HTTPException(status_code=401, detail="Accesso admin non autorizzato")

    with sessions_lock:
        admin_sess = admin_sessions.get(admin_session_id)
        if not admin_sess or admin_sess["expires"] < time.time():
            admin_sessions.pop(admin_session_id, None)
            raise HTTPException(status_code=401, detail="Sessione admin scaduta")

        if admin_sess["session_id"] != session_id:
            raise HTTPException(status_code=401, detail="Sessione admin non valida")

        admin_sess["expires"] = time.time() + ADMIN_SESSION_TTL

    user = get_session_user(session_id)
    username = get_session_username(user)
    if not is_admin_username(username):
        raise HTTPException(status_code=403, detail="Accesso negato")
    return user


def current_admin(
    request: Request,
    session_id: Optional[str] = Cookie(default=None),
    admin_session_id: Optional[str] = Cookie(default=None, alias="admin_session_id"),
):
    return validate_admin_access(session_id, admin_session_id)


def count_active_sessions() -> int:
    now = time.time()
    with sessions_lock:
        return sum(1 for sess in sessions.values() if sess["expires"] >= now)


def list_active_session_usernames() -> list[str]:
    return [item["username"] for item in build_active_sessions_snapshot()]


def build_active_sessions_snapshot() -> list[dict]:
    now = time.time()
    items: list[dict] = []
    with sessions_lock:
        for sess in sessions.values():
            if sess["expires"] < now:
                continue
            uid = getattr(sess["user"], "uid", None)
            if not uid:
                continue
            items.append(
                {
                    "username": str(uid).strip(),
                    "full_name": (sess.get("profile") or {}).get("full_name") if isinstance(sess.get("profile"), dict) else None,
                    "badges": list_user_badges(str(uid).strip(), getattr(sess.get("user"), "ident", None)),
                    "logged_at": sess.get("created_at", now),
                }
            )
    items.sort(key=lambda item: item.get("logged_at", 0), reverse=True)
    return items


def record_admin_login_event(username: str) -> dict:
    event = {
        "type": "user_login",
        "username": username.strip(),
        "badges": list_user_badges(username),
        "timestamp": time.time(),
    }
    with admin_events_lock:
        recent_admin_login_events.insert(0, event)
        del recent_admin_login_events[ADMIN_LOGIN_EVENTS_MAX:]
    return event


async def broadcast_admin_login(username: str):
    event = record_admin_login_event(username)
    snapshot = build_active_sessions_snapshot()
    await admin_ws_manager.broadcast(
        {
            **event,
            "active_sessions": snapshot,
            "active_sessions_count": len(snapshot),
        }
    )


# ---- LOGIN UNA VOLTA ----
def create_session(u: Utente, username: Optional[str] = None) -> str:
    if username:
        u._app_username = username.strip()
        u.uid = username.strip()
    sid = secrets.token_urlsafe(32)
    now = time.time()
    with sessions_lock:
        sessions[sid] = {
            "user": u,
            "username": get_session_username(u),
            "created_at": now,
            "expires": now + SESSION_TTL,
            "me_lock": Lock(),  # anti-burst: serializza /session/me della stessa sessione
            "me_cache": None,   # (scadenza_epoch, risposta)
            "card_lock": Lock(),
            "card_cache": None,  # (scadenza_epoch, card_json) condivisa con /session/me
        }
    return sid


@app.post("/login")
def login(
    body: LoginBody,
    response: Response,
    request: Request,
    background_tasks: BackgroundTasks,
):
    client_ip = get_client_ip(request)
    check_login_rate_limit(client_ip)
    try:
        u = cached_login_user(body.username, body.password)

        sid = create_session(u, body.username.strip())
        username = body.username.strip()
        background_tasks.add_task(broadcast_admin_login, username)

        response.set_cookie(
            key="session_id",
            value=sid,
            httponly=True,
            samesite="lax",
            secure=COOKIE_SECURE,
            max_age=SESSION_TTL,
            path="/",
        )
        return {"ok": True, "user": username}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.get("/session/me")
def session_me(
    response: Response,
    session_id: Optional[str] = Cookie(default=None),
):
    sess = get_session_record(session_id)
    u = sess["user"]

    # Cache hit veloce, nessuna chiamata a Spaggiari.
    cached = sess.get("me_cache")
    if cached and cached[0] > time.time():
        return cached[1]

    # ponytail: lock per-sessione, il burst di /session/me al login collassa in 1 sola fetch upstream
    me_lock = sess.get("me_lock")
    if me_lock is None:
        me_lock = sess["me_lock"] = Lock()
    with me_lock:
        # double-check: un'altra richiesta del burst potrebbe aver già popolato la cache.
        cached = sess.get("me_cache")
        if cached and cached[0] > time.time():
            return cached[1]
        try:
            # Una sola card (cache condivisa con /card): valida la sessione e alimenta il profilo.
            card_res = fetch_card_cached(sess)
        except UpstreamUnavailable:
            # Rate limit / Spaggiari giù: NON sloggare. Se ho una /session/me vecchia la riuso.
            if cached:
                return cached[1]
            raise
        except HTTPException:
            # Solo 401/403 reale → sessione scaduta upstream → logout.
            sess["me_cache"] = None
            destroy_session(session_id)
            response.delete_cookie(
                key="session_id",
                httponly=True,
                samesite="lax",
                secure=COOKIE_SECURE,
                path="/",
            )
            clear_admin_cookie(response)
            raise

        profile = build_session_profile(u, card_res=card_res)
        _store_session_profile(sess, profile)
        result = {"ok": True, "authenticated": True, **profile}
        result["badges"] = list_user_badges(profile.get("username"), getattr(u, "ident", None))
        sess["me_cache"] = (time.time() + SESSION_ME_CACHE_TTL, result)
        return result


@app.post("/logout")
def logout(
    response: Response,
    session_id: Optional[str] = Cookie(default=None),
    admin_session_id: Optional[str] = Cookie(default=None, alias="admin_session_id"),
):
    destroy_session(session_id, admin_session_id)
    response.delete_cookie(key="session_id", httponly=True, samesite="lax", secure=COOKIE_SECURE, path="/")
    clear_admin_cookie(response)
    return {"ok": True}


async def websocket_admin_auth(websocket: WebSocket) -> Utente:
    session_id = websocket.cookies.get("session_id")
    admin_session_id = websocket.cookies.get("admin_session_id")
    if not admin_session_id:
        await websocket.close(code=4403, reason="Accesso admin non autorizzato")
        raise WebSocketDisconnect(code=4403)

    try:
        return validate_admin_access(session_id, admin_session_id)
    except HTTPException:
        await websocket.close(code=4403, reason="Accesso admin non valido")
        raise WebSocketDisconnect(code=4403)


@app.websocket("/ws/admin")
async def admin_ws(websocket: WebSocket):
    try:
        await websocket_admin_auth(websocket)
        await admin_ws_manager.connect(websocket)
        with admin_events_lock:
            recent_logins = list(recent_admin_login_events)
        snapshot = build_active_sessions_snapshot()
        await websocket.send_text(
            json.dumps(
                {
                    "type": "admin_ready",
                    "active_sessions": snapshot,
                    "active_sessions_count": len(snapshot),
                    "recent_logins": recent_logins,
                    "timestamp": time.time(),
                }
            )
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        admin_ws_manager.disconnect(websocket)
    except Exception:
        admin_ws_manager.disconnect(websocket)
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/leaderboard")
async def leaderboard_ws(websocket: WebSocket):
    try:
        await websocket_auth(websocket)
        await ws_manager.connect(websocket)
        await websocket.send_text(json.dumps({"type": "leaderboard_ready", "timestamp": time.time()}))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception:
        ws_manager.disconnect(websocket)
        try:
            await websocket.close()
        except Exception:
            pass


# ---- endpoint che riusano la sessione ----
@app.post("/assenze")
def assenze(u: Utente = Depends(current_user)):
    try:
        assenze = cached_cvv_request_json(u, "assenze", RequestURLs.assenze)
        return {"ok": True, "assenze": assenze}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


def raise_for_upstream_http_status(status_code: int, *, context: str = "upstream") -> None:
    if status_code in {401, 403}:
        raise HTTPException(
            status_code=401,
            detail="Sessione Spaggiari scaduta, effettua nuovamente il login",
        )
    if status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Risultato {context}: {status_code}")


@app.post("/agenda")
def agenda(u: Utente = Depends(current_user), body: AgendaBody = Body(default=AgendaBody())):
    try:
        start = body.start or time.strftime("%Y%m%d")
        end = body.end or start
        data = cached_agenda_json(u, start, end)
        return {"ok": True, "agenda": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

MARCONI_ORARIO_API = "https://apps.marconivr.it/orario/api.php"
MARCONI_ORARIO_CVERS = "-1"
MARCONI_MIUR_SCHOOL_CODE = "VRTF03000V"
MARCONI_SCHOOL_CODES = {"VRIT0007", "VRTF03000V", MARCONI_MIUR_SCHOOL_CODE}
ORARIO_ACCESS_DENIED_DETAIL = (
    "Al momento la funzione orario è disponibile solo per gli studenti dell'Istituto Marconi."
)


def extract_student_card_fields(card_res) -> dict:
    if not isinstance(card_res, dict):
        return {}
    inner = card_res.get("card") if isinstance(card_res.get("card"), dict) else card_res
    if isinstance(inner, dict) and isinstance(inner.get("card"), dict):
        inner = inner["card"]
    return inner if isinstance(inner, dict) else {}


def is_marconi_school_code(value: Any) -> bool:
    code = str(value or "").strip().upper()
    return bool(code and code in MARCONI_SCHOOL_CODES)


def is_marconi_student_card(card_res) -> bool:
    fields = extract_student_card_fields(card_res)
    miur = str(fields.get("miurSchoolCode") or fields.get("miurDivisionCode") or "").strip().upper()
    sch_code = str(fields.get("schCode") or fields.get("schoolCode") or "").strip().upper()
    label = " ".join(
        str(fields.get(key) or "")
        for key in ("schName", "schDedication", "schCity", "schProv", "schCode")
    ).lower()
    name_ok = "marconi" in label
    code_ok = is_marconi_school_code(miur) or is_marconi_school_code(sch_code)
    if miur and not code_ok and not name_ok:
        return False
    if code_ok:
        return True
    return name_ok


class UpstreamUnavailable(HTTPException):
    """Spaggiari ha risposto male (429/5xx) o irraggiungibile: NON è logout."""

    def __init__(self, detail: str):
        super().__init__(status_code=503, detail=detail)


def _fetch_student_card_raw(u: Utente) -> dict:
    """Chiama /card tramite cache globale per utente/endpoint.

    La cache evita più di una chiamata upstream /card ogni 5 minuti per utente,
    condividendo il risultato tra /session/me, /card e controlli leaderboard.
    """
    if not getattr(u, "is_logged_in", False):
        raise HTTPException(status_code=401, detail="Utente non loggato")
    try:
        data = cached_cvv_direct_json(u, "card", RequestURLs.card, u.ident, timeout=15)
    except HTTPException:
        raise
    except Exception as e:
        raise UpstreamUnavailable(f"Card non valida: {e}")
    return data if isinstance(data, dict) else {}


def fetch_student_card_or_401(u: Utente) -> dict:
    return _fetch_student_card_raw(u)


def fetch_card_cached(sess: dict) -> dict:
    """Card condivisa tra /session/me e /card. Su rate limit serve la copia stale."""
    now = time.time()
    cached = sess.get("card_cache")
    if cached and cached[0] > now:
        return cached[1]

    lock = sess.get("card_lock")
    if lock is None:
        lock = sess["card_lock"] = Lock()
    with lock:
        cached = sess.get("card_cache")
        if cached and cached[0] > now:
            return cached[1]
        try:
            card = _fetch_student_card_raw(sess["user"])
        except UpstreamUnavailable:
            # Rate limit / blip: se ho una card vecchia in cache la riuso comunque.
            if cached:
                return cached[1]
            raise
        sess["card_cache"] = (time.time() + CARD_CACHE_TTL, card)
        return card


def _parse_float_like(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace(",", ".").strip()
        number = ""
        dot_seen = False
        sign_allowed = True
        for ch in cleaned:
            if sign_allowed and ch in {"+", "-"}:
                number += ch
                sign_allowed = False
            elif ch.isdigit():
                number += ch
                sign_allowed = False
            elif ch == "." and not dot_seen:
                number += ch
                dot_seen = True
                sign_allowed = False
            elif number:
                break
        if number and number not in {"+", "-", ".", "+.", "-."}:
            try:
                return float(number)
            except ValueError:
                return None
    return None


def _extract_first_lesson_class_code(agenda_res: Any) -> Optional[str]:
    if not isinstance(agenda_res, dict):
        return None
    payload = agenda_res.get("agenda", agenda_res)
    events: list[Any] = []
    if isinstance(payload, list):
        events = payload
    elif isinstance(payload, dict):
        if isinstance(payload.get("agenda"), list):
            events = payload["agenda"]
        else:
            for value in payload.values():
                if isinstance(value, list):
                    events = value
                    break

    for event in events:
        if not isinstance(event, dict):
            continue
        class_desc = str(event.get("classDesc") or "").strip()
        if not class_desc:
            continue
        return class_desc.split(" ")[0].strip().upper() or None
    return None


def get_user_profile_for_leaderboards(u: Utente, card_res: Optional[dict] = None) -> dict:
    """Profilo per classifiche usando prima cache/sessione/DB.

    Non chiama agenda/card se non viene passato card_res: così gli update non
    generano richieste extra solo per capire chi è l'utente.
    """
    username = get_session_username(u)
    saved = _first_saved_profile_for_user(username, getattr(u, "ident", None))
    full_name = saved.get("full_name")
    school_code = saved.get("school_code")
    class_code = saved.get("class_code")

    if isinstance(card_res, dict):
        card_fields = extract_student_card_fields(card_res)
        card_full_name = f"{(card_fields.get('firstName') or '').strip()} {(card_fields.get('lastName') or '').strip()}".strip()
        full_name = card_full_name or full_name
        school_code = (
            str(card_fields.get("schCode") or card_fields.get("miurSchoolCode") or "").strip().upper()
            or school_code
        )
        class_code = _extract_class_code_from_card_fields(card_fields) or class_code

    return {
        "full_name": full_name or None,
        "school_code": (school_code or None),
        "class_code": (class_code or None),
    }

def calculate_absence_hours_from_payload(assenze_payload: Any) -> float:
    events: list[Any] = []
    if isinstance(assenze_payload, dict):
        assenze = assenze_payload.get("assenze")
        if isinstance(assenze, dict) and isinstance(assenze.get("events"), list):
            events = assenze.get("events") or []
        elif isinstance(assenze_payload.get("events"), list):
            events = assenze_payload.get("events") or []
    elif isinstance(assenze_payload, list):
        events = assenze_payload

    total_hours = 0.0
    for event in events:
        if not isinstance(event, dict):
            continue
        code = str(event.get("evtCode") or "").strip().upper()
        if code == "ABA0":
            total_hours += 6.0
        elif code in {"ABU0", "ABR0", "ABR1"}:
            total_hours += float(_parse_float_like(event.get("evtValue")) or 0.0)

    if total_hours <= 0:
        return 0.0
    if total_hours <= 102:
        discount = (total_hours / 102) * 4
    elif total_hours <= 136:
        discount = 4 + ((total_hours - 102) / (136 - 102)) * (15 - 4)
    elif total_hours <= 263:
        discount = 15 + ((total_hours - 136) / (263 - 136)) * (33 - 15)
    else:
        discount = 33 + ((total_hours - 263) / (263 - 136)) * (33 - 15)
    return max(0.0, total_hours - round(discount))


def calculate_general_average_from_payload(voti_payload: Any) -> float:
    grades: list[Any] = []
    if isinstance(voti_payload, dict):
        voti = voti_payload.get("voti", voti_payload)
        if isinstance(voti, dict) and isinstance(voti.get("grades"), list):
            grades = voti.get("grades") or []
        elif isinstance(voti, list):
            grades = voti
    elif isinstance(voti_payload, list):
        grades = voti_payload

    values: list[float] = []
    for voto in grades:
        if not isinstance(voto, dict):
            continue
        subject = str(voto.get("subjectDesc") or "").upper()
        if "RELIGIONE" in subject:
            continue
        if str(voto.get("displayValue") or "").strip().upper() == "A":
            continue
        if str(voto.get("color") or "").strip().lower() == "blue":
            continue
        value = _parse_float_like(voto.get("decimalValue"))
        if value is None:
            continue
        values.append(value)

    if not values:
        return 0.0
    return sum(values) / len(values)


def _session_profile_from_cache(sess: dict) -> dict:
    """Profilo locale per /orario: usa solo /session/me/session/DB, zero chiamate upstream."""
    cached_me = sess.get("me_cache")
    if cached_me and isinstance(cached_me[1], dict):
        data = cached_me[1]
        return {
            "username": data.get("username") or sess.get("username"),
            "full_name": data.get("full_name"),
            "school_code": data.get("school_code"),
            "class_code": data.get("class_code"),
            "is_admin": data.get("is_admin"),
            "easter_egg_eligible": data.get("easter_egg_eligible"),
            "badges": data.get("badges") or [],
        }

    profile = sess.get("profile")
    if isinstance(profile, dict):
        return profile

    # Ultimo fallback solo locale: leaderboard DB + uid/ident. Non chiama ClasseViva.
    return build_session_profile(sess["user"], card_res=None)


def _store_session_profile(sess: dict, profile: dict) -> None:
    sess["profile"] = {
        "username": profile.get("username") or sess.get("username"),
        "full_name": profile.get("full_name"),
        "school_code": profile.get("school_code"),
        "class_code": profile.get("class_code"),
        "is_admin": profile.get("is_admin"),
        "easter_egg_eligible": profile.get("easter_egg_eligible"),
        "badges": profile.get("badges") or [],
    }


def is_marconi_session_profile(profile: dict) -> bool:
    return is_marconi_school_code(profile.get("school_code"))


def require_marconi_orario_access_from_session(session_id: Optional[str]) -> tuple[dict, dict]:
    sess = get_session_record(session_id)
    profile = _session_profile_from_cache(sess)
    if not is_marconi_session_profile(profile):
        raise HTTPException(status_code=403, detail=ORARIO_ACCESS_DENIED_DETAIL)
    return sess, profile


def require_marconi_orario_access(u: Utente) -> dict:
    # Backward-compatible fallback: usa comunque la cache globale per /card.
    card_res = fetch_student_card_or_401(u)
    if not is_marconi_student_card(card_res):
        raise HTTPException(status_code=403, detail=ORARIO_ACCESS_DENIED_DETAIL)
    return card_res


@app.get("/orario/eligible")
def orario_eligible(session_id: Optional[str] = Cookie(default=None)):
    try:
        sess = get_session_record(session_id)
        profile = _session_profile_from_cache(sess)
        eligible = is_marconi_session_profile(profile)
        return {
            "ok": True,
            "eligible": eligible,
            "detail": None if eligible else ORARIO_ACCESS_DENIED_DETAIL,
            "class_code": profile.get("class_code"),
            "school_code": profile.get("school_code"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/orario/meta")
def orario_meta(session_id: Optional[str] = Cookie(default=None)):
    sess, _profile = require_marconi_orario_access_from_session(session_id)
    u = sess["user"]
    try:
        payload = cached_external_get_json_for_user(
            u,
            "orario_meta",
            MARCONI_ORARIO_API,
            params={"CVers": MARCONI_ORARIO_CVERS},
            timeout=20,
        )
        return {"ok": True, "meta": payload}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/orario/class")
def orario_class(
    class_name: str = Query(..., min_length=1, max_length=16, alias="class"),
    session_id: Optional[str] = Cookie(default=None),
):
    sess, _profile = require_marconi_orario_access_from_session(session_id)
    u = sess["user"]
    code = class_name.strip().upper()
    if not ORARIO_CLASS_PATTERN.match(code):
        raise HTTPException(status_code=400, detail="Codice classe non valido")
    try:
        payload = cached_external_get_json_for_user(
            u,
            "orario_class",
            MARCONI_ORARIO_API,
            params={"class": code, "CVers": MARCONI_ORARIO_CVERS},
            timeout=20,
        )
        entries = payload if isinstance(payload, list) else []
        return {"ok": True, "class": code, "entries": entries}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/didattica")
def didattica(u: Utente = Depends(current_user)):
    try:
        didattica = cached_cvv_request_json(u, "didattica", RequestURLs.didattica)
        return {"ok": True, "didattica": didattica}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/libri")
def libri(u: Utente = Depends(current_user)):
    try:
        libri = cached_cvv_request_json(u, "libri", RequestURLs.libri)
        return {"ok": True, "libri": libri}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/calendario")
def calendario(u: Utente = Depends(current_user)):
    try:
        calendario = cached_cvv_request_json(u, "calendario", RequestURLs.calendario)
        return {"ok": True, "calendario": calendario}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/card")
def card(
    request: Request,
    session_id: Optional[str] = Cookie(default=None),
):
    sess = get_session_record(session_id)
    card_res = fetch_card_cached(sess)
    return {"ok": True, "card": card_res}


@app.post("/voti")
def voti(u: Utente = Depends(current_user)):
    try:
        voti = cached_cvv_request_json(u, "voti", RequestURLs.voti)
        return {"ok": True, "voti": voti}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/lezioni_oggi")
def lezioni_oggi(u: Utente = Depends(current_user)):
    try:
        lezioni_oggi = cached_cvv_request_json(u, "lezioni_oggi", RequestURLs.lezioni_oggi)
        return {"ok": True, "lezioni_oggi": lezioni_oggi}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/lezioni_giorno")
def lezioni_giorno(u: Utente = Depends(current_user)):
    try:
        lezioni_giorno = cached_cvv_request_json(u, "lezioni_giorno", RequestURLs.lezioni_giorno)
        return {"ok": True, "lezioni_giorno": lezioni_giorno}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/note")
def note(u: Utente = Depends(current_user)):
    try:
        note = cached_cvv_request_json(u, "note", RequestURLs.note)
        return {"ok": True, "note": note}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/periods")
def periods(u: Utente = Depends(current_user)):
    try:
        periods = cached_cvv_request_json(u, "periods", RequestURLs.periods)
        return {"ok": True, "periods": periods}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/materie")
def materie(u: Utente = Depends(current_user)):
    try:
        materie = cached_cvv_request_json(u, "materie", RequestURLs.materie)
        return {"ok": True, "materie": materie}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/noticeboard")
def noticeboard(u: Utente = Depends(current_user)):
    try:
        noticeboard = cached_cvv_request_json(u, "noticeboard", RequestURLs.noticeboard)
        return {"ok": True, "noticeboard": noticeboard}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/documenti")
def documenti(u: Utente = Depends(current_user)):
    try:
        documenti = cached_cvv_request_json(u, "documenti", RequestURLs.documenti)
        return {"ok": True, "documenti": documenti}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/leaderboard/me")
def get_my_leaderboard_entry(u: Utente = Depends(current_user)):
    try:
        session_username = getattr(u, "uid", None)
        if not session_username:
            raise HTTPException(status_code=400, detail="Username sessione non disponibile")

        item = get_leaderboard_entry(session_username)
        if not item:
            for alias in username_aliases(session_username, getattr(u, "ident", None)):
                item = get_leaderboard_entry(alias)
                if item:
                    break
        return {
            "ok": True,
            "item": item,
            "default_visible_in_leaderboard": True,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/leaderboard/update")
async def update_leaderboard(
    body: LeaderboardUpdateBody,
    u: Utente = Depends(current_user),
):
    try:
        session_username = getattr(u, "uid", None)
        if not session_username:
            raise HTTPException(status_code=400, detail="Username sessione non disponibile")

        profile = get_user_profile_for_leaderboards(u)
        assenze_payload = cached_cvv_request_json(u, "assenze", RequestURLs.assenze)
        computed_hours = calculate_absence_hours_from_payload(assenze_payload)

        existing = get_leaderboard_entry(session_username)
        saved = upsert_leaderboard_entry(
            username=session_username,
            full_name=body.full_name or profile.get("full_name") or (existing.get("full_name") if existing else None),
            class_code=body.class_code or profile.get("class_code") or (existing.get("class_code") if existing else None),
            school_code=body.school_code or profile.get("school_code") or (existing.get("school_code") if existing else None),
            hours=float(computed_hours),
            visible_in_leaderboard=bool(body.visible_in_leaderboard),
        )

        await broadcast_leaderboard_change("upsert", session_username.strip())

        return {
            "ok": True,
            "saved": saved,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/leaderboard/me")
async def delete_my_leaderboard_entry(u: Utente = Depends(current_user)):
    try:
        session_username = getattr(u, "uid", None)
        if not session_username:
            raise HTTPException(status_code=400, detail="Username sessione non disponibile")

        removed = delete_leaderboard_entry(session_username)
        if removed:
            await broadcast_leaderboard_change("delete", session_username.strip())

        return {
            "ok": True,
            "removed": removed,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def filter_entries_by_search_query(entries: list[dict], query: Optional[str]) -> list[dict]:
    needle = (query or "").strip().lower()
    if not needle:
        return entries

    filtered: list[dict] = []
    for entry in entries:
        haystack = " ".join(
            [
                str(entry.get("full_name") or ""),
                str(entry.get("username") or ""),
                str(entry.get("class_code") or ""),
            ]
        ).lower()
        if needle in haystack:
            filtered.append(entry)
    return filtered


@app.get("/leaderboard")
def get_leaderboard(
    type: str = Query(default="global"),
    class_code: Optional[str] = Query(default=None),
    school_code: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
    u: Utente = Depends(current_user),
):
    try:
        entries = list_leaderboard_entries()

        if type not in {"global", "class"}:
            raise HTTPException(status_code=400, detail="type deve essere 'global' o 'class'")

        normalized_class = class_code.strip().upper() if class_code else None
        normalized_school = school_code.strip().upper() if school_code else None

        entries = [entry for entry in entries if entry.get("visible_in_leaderboard", True)]

        if type == "class":
            if not normalized_class:
                raise HTTPException(status_code=400, detail="class_code richiesto per la classifica di classe")
            entries = [
                entry for entry in entries
                if (entry.get("class_code") or "").upper() == normalized_class
                and (
                    normalized_school is None
                    or (entry.get("school_code") or "").upper() == normalized_school
                )
            ]

        entries.sort(key=lambda x: (-float(x.get("hours", 0)), x.get("username", "").lower()))
        entries = filter_entries_by_search_query(entries, q)

        total_items = len(entries)
        total_pages = max(1, ceil(total_items / page_size))

        if page > total_pages and total_items > 0:
            page = total_pages

        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        page_items = entries[start_idx:end_idx]

        current_aliases = username_aliases(get_session_username(u), getattr(u, "ident", None))
        enriched_items = []
        for idx, item in enumerate(page_items, start=start_idx + 1):
            item_is_me = normalize_username(item.get("username")) in current_aliases
            enriched_items.append(
                {
                    "rank": idx,
                    "username": item.get("username"),
                    "full_name": item.get("full_name") or item.get("username"),
                    "class_code": item.get("class_code"),
                    "school_code": item.get("school_code"),
                    "hours": item.get("hours", 0),
                    "visible_in_leaderboard": item.get("visible_in_leaderboard", True),
                    "updated_at": item.get("updated_at"),
                    "is_me": item_is_me,
                    "badges": list_user_badges(item.get("username")),
                }
            )

        return {
            "ok": True,
            "scope": type,
            "class_code": normalized_class if type == "class" else None,
            "school_code": normalized_school if type == "class" else None,
            "page": page,
            "page_size": page_size,
            "total_items": total_items,
            "total_pages": total_pages,
            "search_query": (q or "").strip() or None,
            "items": enriched_items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/average-leaderboard/me")
def get_my_average_leaderboard_entry(
    subject_name: str = Query(...),
    period_key: str = Query(...),
    u: Utente = Depends(current_user),
):
    try:
        session_username = getattr(u, "uid", None)
        if not session_username:
            raise HTTPException(status_code=400, detail="Username sessione non disponibile")

        item = get_average_leaderboard_entry(session_username, subject_name, period_key)
        if not item:
            for alias in username_aliases(session_username, getattr(u, "ident", None)):
                item = get_average_leaderboard_entry(alias, subject_name, period_key)
                if item:
                    break
        return {
            "ok": True,
            "item": item,
            "default_visible_in_leaderboard": True,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/average-leaderboard/update")
async def update_average_leaderboard(
    body: AverageLeaderboardUpdateBody,
    u: Utente = Depends(current_user),
):
    try:
        session_username = getattr(u, "uid", None)
        if not session_username:
            raise HTTPException(status_code=400, detail="Username sessione non disponibile")

        profile = get_user_profile_for_leaderboards(u)
        voti_payload = cached_cvv_request_json(u, "voti", RequestURLs.voti)
        computed_average = calculate_general_average_from_payload(voti_payload)

        normalized_subject = body.subject_name.strip()
        normalized_period_key = body.period_key.strip().lower()
        if normalized_subject != GENERAL_AVERAGE_SUBJECT or normalized_period_key != GENERAL_AVERAGE_PERIOD_KEY:
            raise HTTPException(status_code=400, detail="Solo la media generale può essere aggiornata")

        existing = get_average_leaderboard_entry(
            session_username,
            normalized_subject,
            normalized_period_key,
        )

        saved = upsert_average_leaderboard_entry(
            username=session_username,
            full_name=body.full_name or profile.get("full_name") or (existing.get("full_name") if existing else None),
            class_code=body.class_code or profile.get("class_code") or (existing.get("class_code") if existing else None),
            school_code=body.school_code or profile.get("school_code") or (existing.get("school_code") if existing else None),
            subject_name=normalized_subject,
            period_key=normalized_period_key,
            period_label=body.period_label,
            average=float(computed_average),
            visible_in_leaderboard=bool(body.visible_in_leaderboard),
        )

        await broadcast_average_leaderboard_change("upsert", session_username.strip())

        return {
            "ok": True,
            "saved": saved,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/average-leaderboard/me")
async def delete_my_average_leaderboard_entry(u: Utente = Depends(current_user)):
    try:
        session_username = getattr(u, "uid", None)
        if not session_username:
            raise HTTPException(status_code=400, detail="Username sessione non disponibile")

        removed = delete_average_leaderboard_entry(session_username)
        if removed:
            await broadcast_average_leaderboard_change("delete", session_username.strip())

        return {
            "ok": True,
            "removed": removed,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/average-leaderboard")
def get_average_leaderboard(
    type: str = Query(default="global"),
    class_code: Optional[str] = Query(default=None),
    school_code: Optional[str] = Query(default=None),
    subject_name: str = Query(...),
    period_key: str = Query(...),
    q: Optional[str] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
    u: Utente = Depends(current_user),
):
    try:
        entries = list_average_leaderboard_entries(subject_name, period_key)

        if type not in {"global", "class"}:
            raise HTTPException(status_code=400, detail="type deve essere 'global' o 'class'")

        normalized_class = class_code.strip().upper() if class_code else None
        normalized_school = school_code.strip().upper() if school_code else None
        normalized_subject = subject_name.strip()
        normalized_period_key = period_key.strip().lower()

        entries = [entry for entry in entries if entry.get("visible_in_leaderboard", True)]

        if type == "class":
            if not normalized_class:
                raise HTTPException(status_code=400, detail="class_code richiesto per la classifica di classe")
            entries = [
                entry for entry in entries
                if (entry.get("class_code") or "").upper() == normalized_class
                and (
                    normalized_school is None
                    or (entry.get("school_code") or "").upper() == normalized_school
                )
            ]

        entries.sort(key=lambda x: (-float(x.get("average", 0)), x.get("username", "").lower()))
        entries = filter_entries_by_search_query(entries, q)

        total_items = len(entries)
        total_pages = max(1, ceil(total_items / page_size))

        if page > total_pages and total_items > 0:
            page = total_pages

        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        page_items = entries[start_idx:end_idx]

        current_aliases = username_aliases(get_session_username(u), getattr(u, "ident", None))
        enriched_items = []
        for idx, item in enumerate(page_items, start=start_idx + 1):
            item_is_me = normalize_username(item.get("username")) in current_aliases
            enriched_items.append(
                {
                    "rank": idx,
                    "username": item.get("username"),
                    "full_name": item.get("full_name") or item.get("username"),
                    "class_code": item.get("class_code"),
                    "school_code": item.get("school_code"),
                    "subject_name": item.get("subject_name"),
                    "period_key": item.get("period_key"),
                    "period_label": item.get("period_label"),
                    "average": item.get("average", 0),
                    "visible_in_leaderboard": item.get("visible_in_leaderboard", True),
                    "updated_at": item.get("updated_at"),
                    "is_me": item_is_me,
                    "badges": list_user_badges(item.get("username")),
                }
            )

        return {
            "ok": True,
            "scope": type,
            "class_code": normalized_class if type == "class" else None,
            "school_code": normalized_school if type == "class" else None,
            "subject_name": normalized_subject,
            "period_key": normalized_period_key,
            "period_label": page_items[0].get("period_label") if page_items else normalized_period_key,
            "page": page,
            "page_size": page_size,
            "total_items": total_items,
            "total_pages": total_pages,
            "search_query": (q or "").strip() or None,
            "items": enriched_items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---- ANNUNCI / CHANGELOG MODAL ----
def announcement_content_version(title: str, body_markdown: str) -> str:
    payload = f"{title.strip()}\n---\n{body_markdown.strip()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def row_to_announcement(row: sqlite3.Row | None):
    if not row:
        return {
            "title": "",
            "body_markdown": "",
            "enabled": False,
            "content_version": "",
            "updated_at": 0,
        }
    return {
        "title": row["title"] or "",
        "body_markdown": row["body_markdown"] or "",
        "enabled": bool(row["enabled"]),
        "content_version": row["content_version"] or "",
        "updated_at": row["updated_at"],
    }


def get_site_announcement():
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT title, body_markdown, enabled, content_version, updated_at FROM site_announcement WHERE id = 1"
        ).fetchone()
    return row_to_announcement(row)


def save_site_announcement(*, title: str, body_markdown: str, enabled: bool):
    current = get_site_announcement()
    new_version = announcement_content_version(title, body_markdown)
    version_changed = new_version != (current.get("content_version") or "")
    now = time.time()

    with db_lock:
        with get_db_connection() as conn:
            conn.execute(
                """
                INSERT INTO site_announcement (id, title, body_markdown, enabled, content_version, updated_at)
                VALUES (1, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    body_markdown = excluded.body_markdown,
                    enabled = excluded.enabled,
                    content_version = excluded.content_version,
                    updated_at = excluded.updated_at
                """,
                (title.strip(), body_markdown, 1 if enabled else 0, new_version, now),
            )
            if version_changed and new_version:
                conn.execute(
                    "DELETE FROM announcement_views WHERE content_version != ?",
                    (new_version,),
                )
            conn.commit()

    saved = get_site_announcement()
    return saved, version_changed


def user_has_seen_announcement(username: str, content_version: str) -> bool:
    if not content_version:
        return True
    normalized_username = username.strip()
    with get_db_connection() as conn:
        row = conn.execute(
            """
            SELECT 1 FROM announcement_views
            WHERE username = ? AND content_version = ?
            """,
            (normalized_username, content_version),
        ).fetchone()
    return row is not None


def mark_announcement_viewed(username: str, content_version: str):
    normalized_username = username.strip()
    if not normalized_username or not content_version:
        return
    now = time.time()
    with db_lock:
        with get_db_connection() as conn:
            conn.execute(
                """
                INSERT INTO announcement_views (username, content_version, viewed_at)
                VALUES (?, ?, ?)
                ON CONFLICT(username, content_version) DO UPDATE SET viewed_at = excluded.viewed_at
                """,
                (normalized_username, content_version, now),
            )
            conn.commit()


def count_announcement_views(content_version: str) -> int:
    if not content_version:
        return 0
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM announcement_views WHERE content_version = ?",
            (content_version,),
        ).fetchone()
    return int(row["c"]) if row else 0


@app.get("/announcement/me")
def announcement_for_user(u: Utente = Depends(current_user)):
    username = get_session_username(u)
    announcement = get_site_announcement()
    version = announcement.get("content_version") or ""
    enabled = bool(announcement.get("enabled")) and bool(version)
    has_title_or_body = bool(announcement.get("title", "").strip()) or bool(
        announcement.get("body_markdown", "").strip()
    )
    should_show = (
        enabled
        and has_title_or_body
        and not user_has_seen_announcement(username, version)
    )
    return {
        "ok": True,
        "should_show": should_show,
        "title": announcement.get("title", ""),
        "body_markdown": announcement.get("body_markdown", ""),
        "content_version": version,
    }


@app.post("/announcement/dismiss")
def dismiss_announcement(u: Utente = Depends(current_user)):
    username = get_session_username(u)
    announcement = get_site_announcement()
    version = announcement.get("content_version") or ""
    if version:
        mark_announcement_viewed(username, version)
    return {"ok": True}


@app.get("/admin/announcement")
def admin_get_announcement(_: Utente = Depends(current_admin)):
    announcement = get_site_announcement()
    version = announcement.get("content_version") or ""
    return {
        "ok": True,
        "announcement": announcement,
        "views_count": count_announcement_views(version),
    }


@app.put("/admin/announcement")
def admin_save_announcement(body: AnnouncementUpdateBody, _: Utente = Depends(current_admin)):
    saved, version_changed = save_site_announcement(
        title=body.title,
        body_markdown=body.body_markdown,
        enabled=bool(body.enabled),
    )
    version = saved.get("content_version") or ""
    return {
        "ok": True,
        "announcement": saved,
        "version_changed": version_changed,
        "views_count": count_announcement_views(version),
    }


# ---- EASTER EGG (gioco Godot) ----
@app.get("/easter-egg/eligible")
def easter_egg_eligible(u: Utente = Depends(current_user)):
    username = get_session_username(u)
    return {
        "ok": True,
        "eligible": is_easter_egg_username(username),
        "username": username,
        "game_ready": godot_export_available(),
        "game_url": "/game/godot/index.html",
        "launcher_url": "/game/",
    }


# ---- ADMIN ----
@app.get("/admin/eligible")
def admin_eligible(u: Utente = Depends(current_user)):
    username = get_session_username(u)
    return {"ok": True, "eligible": is_admin_username(username), "username": username}


@app.get("/admin/status")
def admin_status(
    u: Utente = Depends(current_user),
    session_id: Optional[str] = Cookie(default=None),
    admin_session_id: Optional[str] = Cookie(default=None, alias="admin_session_id"),
):
    username = get_session_username(u)
    if not is_admin_username(username):
        return {"ok": True, "authenticated": False, "eligible": False}

    try:
        validate_admin_access(session_id, admin_session_id)
        return {"ok": True, "authenticated": True, "eligible": True, "username": username}
    except HTTPException:
        return {"ok": True, "authenticated": False, "eligible": True, "username": username}


@app.post("/admin/bootstrap")
def admin_bootstrap(
    response: Response,
    u: Utente = Depends(current_user),
    session_id: Optional[str] = Cookie(default=None),
):
    if not ADMIN_ALLOW_BOOTSTRAP:
        raise HTTPException(status_code=403, detail="Bootstrap admin disabilitato")

    username = get_session_username(u)
    if not is_admin_username(username):
        raise HTTPException(status_code=403, detail="Accesso negato")

    if not session_id:
        raise HTTPException(status_code=401, detail="Sessione non valida")

    admin_sid = create_admin_session(session_id)
    set_admin_cookie(response, admin_sid)
    return {"ok": True, "username": username}


@app.post("/admin/login")
def admin_login(
    body: AdminLoginBody,
    response: Response,
    u: Utente = Depends(current_user),
    session_id: Optional[str] = Cookie(default=None),
    admin_session_id: Optional[str] = Cookie(default=None, alias="admin_session_id"),
):
    username = get_session_username(u)
    if not is_admin_username(username):
        raise HTTPException(status_code=403, detail="Accesso negato")

    if not session_id:
        raise HTTPException(status_code=401, detail="Sessione non valida")

    try:
        cached_login_user(username, body.password)
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))

    clear_admin_session(admin_session_id)
    admin_sid = create_admin_session(session_id)
    set_admin_cookie(response, admin_sid)
    return {"ok": True, "username": username}


@app.post("/admin/logout")
def admin_logout(
    response: Response,
    admin_session_id: Optional[str] = Cookie(default=None, alias="admin_session_id"),
):
    clear_admin_session(admin_session_id)
    clear_admin_cookie(response)
    return {"ok": True}


@app.get("/admin/overview")
def admin_overview(_: Utente = Depends(current_admin)):
    with db_lock:
        with get_db_connection() as conn:
            assenze_count = conn.execute("SELECT COUNT(*) AS c FROM leaderboard_entries").fetchone()["c"]

    average_users = list_average_leaderboard_users_for_admin()

    return {
        "ok": True,
        "admin_username": ADMIN_USERNAME,
        "active_sessions": count_active_sessions(),
        "active_usernames": list_active_session_usernames(),
        "active_session_details": build_active_sessions_snapshot(),
        "leaderboard_entries": assenze_count,
        "average_leaderboard_entries": len(average_users),
        "database_path": DATABASE_PATH,
    }


@app.get("/admin/leaderboard")
def admin_leaderboard(_: Utente = Depends(current_admin)):
    entries = [enrich_entry_with_badges(item) for item in list_leaderboard_entries()]
    return {"ok": True, "items": entries}


@app.patch("/admin/leaderboard/{username}/visibility")
async def admin_leaderboard_visibility(
    username: str,
    body: AdminVisibilityBody,
    _: Utente = Depends(current_admin),
):
    updated = update_leaderboard_visibility(username, body.visible_in_leaderboard)
    if not updated:
        raise HTTPException(status_code=404, detail="Voce non trovata")
    await broadcast_leaderboard_change("upsert", username.strip())
    item = get_leaderboard_entry(username)
    return {"ok": True, "item": item}


@app.delete("/admin/leaderboard/{username}")
async def admin_delete_leaderboard(username: str, _: Utente = Depends(current_admin)):
    removed = delete_leaderboard_entry(username)
    if removed:
        await broadcast_leaderboard_change("delete", username.strip())
    return {"ok": True, "removed": removed}


@app.get("/admin/average-leaderboard")
def admin_average_leaderboard(_: Utente = Depends(current_admin)):
    entries = [enrich_entry_with_badges(item) for item in list_average_leaderboard_users_for_admin()]
    return {"ok": True, "items": entries}


@app.patch("/admin/average-leaderboard/{username}/visibility")
async def admin_average_leaderboard_visibility(
    username: str,
    body: AdminVisibilityBody,
    subject_name: Optional[str] = Query(default=None),
    period_key: Optional[str] = Query(default=None),
    _: Utente = Depends(current_admin),
):
    if subject_name and period_key:
        updated = update_average_leaderboard_visibility(
            username,
            subject_name,
            period_key,
            body.visible_in_leaderboard,
        )
    else:
        updated = update_average_leaderboard_visibility_for_user(
            username,
            body.visible_in_leaderboard,
        )
    if not updated:
        raise HTTPException(status_code=404, detail="Voce non trovata")
    await broadcast_average_leaderboard_change("upsert", username.strip())
    items = list_average_leaderboard_users_for_admin()
    item = next((row for row in items if row.get("username") == username.strip()), None)
    return {"ok": True, "item": item}


@app.delete("/admin/average-leaderboard/{username}")
async def admin_delete_average_leaderboard(
    username: str,
    subject_name: Optional[str] = Query(default=None),
    period_key: Optional[str] = Query(default=None),
    _: Utente = Depends(current_admin),
):
    removed = delete_average_leaderboard_entry(username, subject_name, period_key)
    if removed:
        await broadcast_average_leaderboard_change("delete", username.strip())
    return {"ok": True, "removed": removed}




@app.get("/admin/users/search")
def admin_search_users(
    q: Optional[str] = Query(default=None),
    limit: int = Query(default=80, ge=1, le=200),
    _: Utente = Depends(current_admin),
):
    return {"ok": True, "items": collect_known_users(q, limit)}


@app.get("/admin/badges")
def admin_list_badges(_: Utente = Depends(current_admin)):
    return {"ok": True, "items": list_badges()}


@app.post("/admin/badges")
async def admin_create_badge(body: BadgeCreateBody, _: Utente = Depends(current_admin)):
    badge = create_badge(
        label=body.label,
        text_color=body.text_color,
        background_color=body.background_color,
        border_color=body.border_color,
    )
    invalidate_session_me_caches_for_badges()
    await broadcast_leaderboard_change("badge", "*")
    await broadcast_average_leaderboard_change("badge", "*")
    return {"ok": True, "badge": badge}


@app.patch("/admin/badges/{badge_id}")
async def admin_update_badge(badge_id: int, body: BadgeUpdateBody, _: Utente = Depends(current_admin)):
    badge = update_badge(badge_id, body)
    invalidate_session_me_caches_for_badges()
    await broadcast_leaderboard_change("badge", "*")
    await broadcast_average_leaderboard_change("badge", "*")
    return {"ok": True, "badge": badge}


@app.delete("/admin/badges/{badge_id}")
async def admin_delete_badge(badge_id: int, _: Utente = Depends(current_admin)):
    removed = delete_badge(badge_id)
    invalidate_session_me_caches_for_badges()
    await broadcast_leaderboard_change("badge", "*")
    await broadcast_average_leaderboard_change("badge", "*")
    return {"ok": True, "removed": removed}


@app.post("/admin/badges/batch")
async def admin_badge_batch(body: BadgeBatchBody, _: Utente = Depends(current_admin)):
    result = apply_badge_batch(badge_id=body.badge_id, usernames=body.usernames, action=body.action)
    invalidate_session_me_caches_for_badges()
    await broadcast_leaderboard_change("badge", "*")
    await broadcast_average_leaderboard_change("badge", "*")
    return {"ok": True, **result}

if DEV_MODE and os.path.isdir(PUBLIC_DIR):
    app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")
