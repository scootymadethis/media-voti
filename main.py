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
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel
from ClasseVivaAPI import Utente, RequestURLs
import os
import sqlite3
import time
import secrets
import json
import requests
from math import ceil
from threading import Lock
from typing import Optional

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

# ---- session store in memoria ----
sessions: dict[str, dict] = {}
admin_sessions: dict[str, dict] = {}
sessions_lock = Lock()
db_lock = Lock()


class LoginBody(BaseModel):
    username: str
    password: str


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


def get_session_user(session_id: Optional[str]) -> Utente:
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
    now = time.time()
    usernames: list[str] = []
    with sessions_lock:
        for sess in sessions.values():
            if sess["expires"] < now:
                continue
            uid = getattr(sess["user"], "uid", None)
            if uid:
                usernames.append(str(uid).strip())
    return sorted(set(usernames))


# ---- LOGIN UNA VOLTA ----
def create_session(u: Utente, pwd: str) -> str:
    sid = secrets.token_urlsafe(32)
    with sessions_lock:
        sessions[sid] = {
            "user": u,
            "password": pwd,  # TEMP
            "expires": time.time() + SESSION_TTL,
        }
    return sid


@app.post("/login")
def login(body: LoginBody, response: Response):
    try:
        u = Utente(uid=body.username, pwd=body.password)
        u.login()

        sid = create_session(u, body.password)

        response.set_cookie(
            key="session_id",
            value=sid,
            httponly=True,
            samesite="lax",
            secure=COOKIE_SECURE,
        )
        return {"ok": True, "user": body.username}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


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

        try:
            sid = request.cookies.get("session_id")
            with sessions_lock:
                if sid in sessions:
                    password = sessions[sid].get("password")
                    if password:
                        sessions[sid]["password"] = None
        except Exception as log_err:
            print(f"Errore durante il salvataggio della sessione: {log_err}")

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

        saved = upsert_leaderboard_entry(
            username=session_username,
            full_name=body.full_name,
            class_code=body.class_code,
            school_code=body.school_code,
            hours=float(body.hours),
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

        saved = upsert_average_leaderboard_entry(
            username=session_username,
            full_name=body.full_name,
            class_code=body.class_code,
            school_code=body.school_code,
            subject_name=body.subject_name,
            period_key=body.period_key,
            period_label=body.period_label,
            average=float(body.average),
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
            voti_count = conn.execute("SELECT COUNT(*) AS c FROM average_leaderboard_entries_scoped").fetchone()["c"]

    return {
        "ok": True,
        "admin_username": ADMIN_USERNAME,
        "active_sessions": count_active_sessions(),
        "active_usernames": list_active_session_usernames(),
        "leaderboard_entries": assenze_count,
        "average_leaderboard_entries": voti_count,
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
    entries = list_all_average_leaderboard_entries()
    return {"ok": True, "items": entries}


@app.patch("/admin/average-leaderboard/{username}/visibility")
async def admin_average_leaderboard_visibility(
    username: str,
    subject_name: str = Query(...),
    period_key: str = Query(...),
    body: AdminVisibilityBody = Body(...),
    _: Utente = Depends(current_admin),
):
    updated = update_average_leaderboard_visibility(
        username,
        subject_name,
        period_key,
        body.visible_in_leaderboard,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Voce non trovata")
    await broadcast_average_leaderboard_change("upsert", username.strip())
    item = get_average_leaderboard_entry(username, subject_name, period_key)
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
