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

# ---- session store in memoria ----
sessions: dict[str, dict] = {}
admin_sessions: dict[str, dict] = {}
sessions_lock = Lock()
db_lock = Lock()
login_attempts_lock = Lock()
login_attempts: dict[str, list[float]] = {}


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


def build_session_profile(u: Utente) -> dict:
    username = get_session_username(u)
    profile = {
        "username": username,
        "full_name": None,
        "school_code": None,
        "class_code": None,
        "is_admin": is_admin_username(username),
        "easter_egg_eligible": is_easter_egg_username(username),
    }
    try:
        lb_profile = get_user_profile_for_leaderboards(u)
        profile["full_name"] = lb_profile.get("full_name")
        profile["school_code"] = lb_profile.get("school_code")
        profile["class_code"] = lb_profile.get("class_code")
    except HTTPException:
        pass
    return profile


def get_session_user(session_id: Optional[str]) -> Utente:
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
        return sess["user"]


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
    username = getattr(user, "uid", None)
    if not username:
        raise HTTPException(status_code=401, detail="Utente non valido")
    return str(username).strip()


def is_admin_username(username: str) -> bool:
    return username.strip() == ADMIN_USERNAME


def is_easter_egg_username(username: str) -> bool:
    return username.strip() in EASTER_EGG_USERNAMES


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
                    "logged_at": sess.get("created_at", now),
                }
            )
    items.sort(key=lambda item: item.get("logged_at", 0), reverse=True)
    return items


def record_admin_login_event(username: str) -> dict:
    event = {
        "type": "user_login",
        "username": username.strip(),
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
def create_session(u: Utente) -> str:
    sid = secrets.token_urlsafe(32)
    now = time.time()
    with sessions_lock:
        sessions[sid] = {
            "user": u,
            "created_at": now,
            "expires": now + SESSION_TTL,
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
        u = Utente(uid=body.username, pwd=body.password)
        u.login()

        sid = create_session(u)
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
def session_me(u: Utente = Depends(current_user)):
  profile = build_session_profile(u)
  return {"ok": True, "authenticated": True, **profile}


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
        assenze = u.request(RequestURLs.assenze).json()
        return {"ok": True, "assenze": assenze}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/agenda")
def agenda(u: Utente = Depends(current_user), body: AgendaBody = Body(default=AgendaBody())):
    try:
        start = body.start or time.strftime("%Y%m%d")
        end = body.end or start

        user_ident = getattr(u, "ident", None) or getattr(u, "uid", None)
        if not user_ident:
            raise HTTPException(status_code=500, detail="Impossibile determinare ident utente")

        try:
            url_template = RequestURLs.agenda[0]
            formatted_url = url_template.format(user_ident, start, end)
        except Exception as e:
            print("Errore nella formattazione url agenda:", e)
            formatted_url = None

        try:
            resp = u.request(RequestURLs.agenda, start, end)
            if hasattr(resp, "status_code"):
                if resp.status_code >= 400:
                    print(f"u.request returned status {resp.status_code}, falling back to direct request")
                else:
                    try:
                        agenda = resp.json()
                    except Exception:
                        agenda = {}
                    return {"ok": True, "agenda": agenda}
            else:
                try:
                    agenda = resp.json()
                except Exception:
                    agenda = resp
                return {"ok": True, "agenda": agenda}
        except Exception as lib_exc:
            print("u.request error:", repr(lib_exc))

        if formatted_url:
            try:
                headers = {}
                try:
                    headers = u.get_headers()
                except Exception:
                    pass
                upstream = requests.get(formatted_url, headers=headers, timeout=20)
                if upstream.status_code >= 400:
                    raise HTTPException(status_code=502, detail=f"Risultato upstream: {upstream.status_code}")
                try:
                    data = upstream.json()
                except Exception:
                    data = {}
                return {"ok": True, "agenda": data}
            except HTTPException:
                raise
            except Exception as e:
                print("Richiesta diretta upstream ha failato:", repr(e))
                raise HTTPException(status_code=502, detail="Upstream non raggiungibile, fai un check ai log")
        else:
            raise HTTPException(status_code=502, detail="Formattazione upstream url agenda fallita")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


MARCONI_ORARIO_API = "https://apps.marconivr.it/orario/api.php"
MARCONI_ORARIO_CVERS = "-1"
MARCONI_MIUR_SCHOOL_CODE = "VRTF03000V"
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


def is_marconi_student_card(card_res) -> bool:
    fields = extract_student_card_fields(card_res)
    miur = (
        (fields.get("miurSchoolCode") or fields.get("miurDivisionCode") or "")
        .strip()
        .upper()
    )
    label = " ".join(
        str(fields.get(key) or "")
        for key in ("schName", "schDedication", "schCity", "schProv", "schCode")
    ).lower()
    name_ok = "marconi" in label
    miur_ok = miur == MARCONI_MIUR_SCHOOL_CODE

    if miur and not miur_ok:
        return False
    if miur_ok:
        return True
    return name_ok


def fetch_student_card_or_401(u: Utente) -> dict:
    try:
        return u.request(RequestURLs.card).json()
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


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


def get_user_profile_for_leaderboards(u: Utente) -> dict:
    card_res = fetch_student_card_or_401(u)
    card_fields = extract_student_card_fields(card_res)
    full_name = f"{(card_fields.get('firstName') or '').strip()} {(card_fields.get('lastName') or '').strip()}".strip()
    school_code = (
        (card_fields.get("schCode") or card_fields.get("miurSchoolCode") or "").strip().upper()
        or None
    )

    class_code = None
    today = time.strftime("%Y%m%d")
    try:
        agenda_res = u.request(RequestURLs.agenda, today, today).json()
        class_code = _extract_first_lesson_class_code(agenda_res)
    except Exception:
        class_code = None

    return {
        "full_name": full_name or None,
        "school_code": school_code,
        "class_code": class_code,
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


def require_marconi_orario_access(u: Utente) -> dict:
    card_res = fetch_student_card_or_401(u)
    if not is_marconi_student_card(card_res):
        raise HTTPException(status_code=403, detail=ORARIO_ACCESS_DENIED_DETAIL)
    return card_res


@app.get("/orario/eligible")
def orario_eligible(u: Utente = Depends(current_user)):
    try:
        card_res = fetch_student_card_or_401(u)
        eligible = is_marconi_student_card(card_res)
        return {
            "ok": True,
            "eligible": eligible,
            "detail": None if eligible else ORARIO_ACCESS_DENIED_DETAIL,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/orario/meta")
def orario_meta(u: Utente = Depends(current_user)):
    require_marconi_orario_access(u)
    try:
        upstream = requests.get(
            MARCONI_ORARIO_API,
            params={"CVers": MARCONI_ORARIO_CVERS},
            timeout=20,
        )
        if upstream.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"Orario Marconi: {upstream.status_code}")
        return {"ok": True, "meta": upstream.json()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/orario/class")
def orario_class(
    class_name: str = Query(..., min_length=1, max_length=16, alias="class"),
    u: Utente = Depends(current_user),
):
    require_marconi_orario_access(u)
    code = class_name.strip().upper()
    if not ORARIO_CLASS_PATTERN.match(code):
        raise HTTPException(status_code=400, detail="Codice classe non valido")
    try:
        upstream = requests.get(
            MARCONI_ORARIO_API,
            params={"class": code, "CVers": MARCONI_ORARIO_CVERS},
            timeout=20,
        )
        if upstream.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"Orario Marconi: {upstream.status_code}")
        payload = upstream.json()
        entries = payload if isinstance(payload, list) else []
        return {"ok": True, "class": code, "entries": entries}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/didattica")
def didattica(u: Utente = Depends(current_user)):
    try:
        didattica = u.request(RequestURLs.didattica).json()
        return {"ok": True, "didattica": didattica}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/libri")
def libri(u: Utente = Depends(current_user)):
    try:
        libri = u.request(RequestURLs.libri).json()
        return {"ok": True, "libri": libri}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/calendario")
def calendario(u: Utente = Depends(current_user)):
    try:
        calendario = u.request(RequestURLs.calendario).json()
        return {"ok": True, "calendario": calendario}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/card")
def card(request: Request, u: Utente = Depends(current_user)):
    try:
        card_res = u.request(RequestURLs.card).json()

        return {"ok": True, "card": card_res}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/voti")
def voti(u: Utente = Depends(current_user)):
    try:
        voti = u.request(RequestURLs.voti).json()
        return {"ok": True, "voti": voti}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/lezioni_oggi")
def lezioni_oggi(u: Utente = Depends(current_user)):
    try:
        lezioni_oggi = u.request(RequestURLs.lezioni_oggi).json()
        return {"ok": True, "lezioni_oggi": lezioni_oggi}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/lezioni_giorno")
def lezioni_giorno(u: Utente = Depends(current_user)):
    try:
        lezioni_giorno = u.request(RequestURLs.lezioni_giorno).json()
        return {"ok": True, "lezioni_giorno": lezioni_giorno}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/note")
def note(u: Utente = Depends(current_user)):
    try:
        note = u.request(RequestURLs.note).json()
        return {"ok": True, "note": note}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/periods")
def periods(u: Utente = Depends(current_user)):
    try:
        periods = u.request(RequestURLs.periods).json()
        return {"ok": True, "periods": periods}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/materie")
def materie(u: Utente = Depends(current_user)):
    try:
        materie = u.request(RequestURLs.materie).json()
        return {"ok": True, "materie": materie}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/noticeboard")
def noticeboard(u: Utente = Depends(current_user)):
    try:
        noticeboard = u.request(RequestURLs.noticeboard).json()
        return {"ok": True, "noticeboard": noticeboard}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/documenti")
def documenti(u: Utente = Depends(current_user)):
    try:
        documenti = u.request(RequestURLs.documenti).json()
        return {"ok": True, "documenti": documenti}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.get("/leaderboard/me")
def get_my_leaderboard_entry(u: Utente = Depends(current_user)):
    try:
        session_username = getattr(u, "uid", None)
        if not session_username:
            raise HTTPException(status_code=400, detail="Username sessione non disponibile")

        item = get_leaderboard_entry(session_username)
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
        assenze_payload = u.request(RequestURLs.assenze).json()
        computed_hours = calculate_absence_hours_from_payload(assenze_payload)

        existing = get_leaderboard_entry(session_username)
        saved = upsert_leaderboard_entry(
            username=session_username,
            full_name=profile.get("full_name") or existing.get("full_name") if existing else None,
            class_code=profile.get("class_code") or existing.get("class_code") if existing else None,
            school_code=profile.get("school_code") or existing.get("school_code") if existing else None,
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


@app.get("/leaderboard")
def get_leaderboard(
    type: str = Query(default="global"),
    class_code: Optional[str] = Query(default=None),
    school_code: Optional[str] = Query(default=None),
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

        total_items = len(entries)
        total_pages = max(1, ceil(total_items / page_size))

        if page > total_pages and total_items > 0:
            page = total_pages

        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        page_items = entries[start_idx:end_idx]

        enriched_items = []
        for idx, item in enumerate(page_items, start=start_idx + 1):
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
        voti_payload = u.request(RequestURLs.voti).json()
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
            full_name=profile.get("full_name") or existing.get("full_name") if existing else None,
            class_code=profile.get("class_code") or existing.get("class_code") if existing else None,
            school_code=profile.get("school_code") or existing.get("school_code") if existing else None,
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

        total_items = len(entries)
        total_pages = max(1, ceil(total_items / page_size))

        if page > total_pages and total_items > 0:
            page = total_pages

        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        page_items = entries[start_idx:end_idx]

        enriched_items = []
        for idx, item in enumerate(page_items, start=start_idx + 1):
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
        verify_user = Utente(uid=username, pwd=body.password)
        verify_user.login()
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
    entries = list_leaderboard_entries()
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
    entries = list_average_leaderboard_users_for_admin()
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


if DEV_MODE and os.path.isdir(PUBLIC_DIR):
    app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")
