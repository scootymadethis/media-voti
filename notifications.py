"""Novità dal registro e notifiche (router incluso da main.py).

Contratto con main.py:
- `router`: APIRouter con le route.
- `init_tables(conn)`: crea le tabelle (chiamata da main.init_db()).
- `sync_session(user, username) -> Optional[bool]`: chiamata dal thread di keep-alive di main per
  ogni sessione ClasseViva in uso. Scarica le sezioni, confronta con lo stato salvato, crea le
  notifiche. Deve restituire True (sessione valida), False (ClasseViva ha rifiutato la sessione)
  o None (non verificabile: rete, 429, 5xx). Se non è implementata, main usa user.ping().
"""
from typing import Optional

from fastapi import APIRouter

router = APIRouter()


def init_tables(conn) -> None:
    pass


def sync_session(user, username: str) -> Optional[bool]:
    return user.ping()
