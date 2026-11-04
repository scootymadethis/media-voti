"""Amici e condivisione dei voti (router incluso da main.py).

Contratto con main.py:
- `router`: APIRouter con le route (main lo include prima del mount statico).
- `init_tables(conn)`: crea le tabelle (chiamata da main.init_db()).
Le funzioni di main (sessione, snapshot, alias) si importano in modo pigro con `import main as core`
dentro le funzioni (main importa questo modulo alla fine, quando è già completo).
"""
from fastapi import APIRouter

router = APIRouter()


def init_tables(conn) -> None:
    pass
