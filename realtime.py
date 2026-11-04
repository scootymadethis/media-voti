"""Aggiornamenti in tempo reale per utente (WebSocket /ws/events).

Ogni dispositivo connesso apre un WebSocket autenticato con il cookie di sessione e viene
registrato sotto la "chiave studente" (le cifre dello username, come friends.user_key), così tutti
i dispositivi dello stesso studente ricevono gli stessi eventi. Gli eventi sono piccoli e non
contengono dati personali: dicono solo COSA è cambiato ({"type": "friends"}, {"type": "notifiche",
"kinds": [...]}, ...); la pagina ricarica da sola i dati che le servono con le API normali.

publish() si può chiamare da qualunque thread (route sincrone, thread di keep-alive/sync):
l'invio avviene sul loop asyncio del server, senza bloccare chi pubblica.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any, Iterable, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

_lock = threading.Lock()
# chiave studente -> {websocket: loop su cui vive}. Il loop è per socket: in produzione è uno solo,
# nei test ogni TestClient ha il suo.
_clients: dict[str, dict[WebSocket, asyncio.AbstractEventLoop]] = {}

MAX_SOCKETS_PER_USER = 12


def _core():
    import main as core
    return core


def key_for_username(username: Any) -> str:
    import friends
    return friends.user_key(username)


def _register(key: str, ws: WebSocket, loop: asyncio.AbstractEventLoop) -> bool:
    with _lock:
        group = _clients.setdefault(key, {})
        if len(group) >= MAX_SOCKETS_PER_USER:
            return False
        group[ws] = loop
        return True


def _unregister(key: str, ws: WebSocket) -> None:
    with _lock:
        group = _clients.get(key)
        if group is None:
            return
        group.pop(ws, None)
        if not group:
            _clients.pop(key, None)


def connected_count(key: str) -> int:
    with _lock:
        return len(_clients.get(key, ()))


async def _send(targets: list[tuple[str, WebSocket]], payload: str) -> None:
    for key, ws in targets:
        try:
            await asyncio.wait_for(ws.send_text(payload), timeout=5)
        except Exception:
            _unregister(key, ws)


def publish(keys: Iterable[Any], event: dict) -> None:
    """Invia un evento a tutti i dispositivi connessi degli studenti indicati (chiavi o username)."""
    wanted = sorted({str(k) for k in keys if k})
    if not wanted:
        return
    normalized = sorted({key_for_username(k) for k in wanted})
    by_loop: dict[asyncio.AbstractEventLoop, list[tuple[str, WebSocket]]] = {}
    with _lock:
        for k in normalized:
            for ws, loop in _clients.get(k, {}).items():
                by_loop.setdefault(loop, []).append((k, ws))
    if not by_loop:
        return
    payload = json.dumps({**event, "at": time.time()}, ensure_ascii=False)
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    for loop, targets in by_loop.items():
        if loop.is_closed():
            continue
        if running is loop:
            loop.create_task(_send(targets, payload))
        else:
            asyncio.run_coroutine_threadsafe(_send(targets, payload), loop)


def publish_user(username: Any, event: dict) -> None:
    publish([key_for_username(username)], event)


@router.websocket("/ws/events")
async def events_ws(websocket: WebSocket):
    core = _core()
    try:
        user = await core.websocket_auth(websocket)
    except WebSocketDisconnect:
        return
    key = key_for_username(core.normalize_username(core.get_session_username(user)))
    await websocket.accept()
    if not _register(key, websocket, asyncio.get_running_loop()):
        await websocket.close(code=4429, reason="Troppe connessioni")
        return
    try:
        await websocket.send_text(json.dumps({"type": "ready", "at": time.time()}))
        while True:
            msg = await websocket.receive_text()
            if msg == "ping":
                await websocket.send_text('{"type":"pong"}')
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _unregister(key, websocket)
