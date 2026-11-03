"""Client minimale per le API REST di ClasseViva (Spaggiari).

Sostituisce la libreria `cvv-api` (ClasseVivaAPI) mantenendo la stessa interfaccia
usata da main.py (`Utente`, `RequestURLs`), ma:

- costruisce il body JSON del login in modo corretto (password con `"` o `\\` funzionano);
- solleva un'eccezione esplicita se il login fallisce, invece di stampare un messaggio
  e restituire comunque un utente "non loggato";
- distingue credenziali errate, accesso consentito solo con SPID/CIE, chiave API
  scaduta e Spaggiari non raggiungibile, così l'utente vede il motivo reale;
- non conserva la password in memoria dopo il login;
- non stampa nei log il contenuto delle risposte (voti, assenze, ...).

User-Agent, chiave API e URL base sono configurabili via variabili d'ambiente, perché
Spaggiari cambia periodicamente la chiave dell'app ufficiale.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional

import requests

log = logging.getLogger("classeviva")

BASE_URL = os.getenv("CLASSEVIVA_BASE_URL", "https://web.spaggiari.eu/rest/v1").rstrip("/")
USER_AGENT = os.getenv("CLASSEVIVA_USER_AGENT", "CVVS/std/4.1.7 Android/10")
API_KEY = os.getenv("CLASSEVIVA_API_KEY", "Tg1NWEwNGIgIC0K")
LOGIN_TIMEOUT = float(os.getenv("CLASSEVIVA_LOGIN_TIMEOUT", "20"))


def default_headers() -> dict[str, str]:
    return {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Z-Dev-ApiKey": API_KEY,
    }


# ===== Errori di login =====
class ClasseVivaLoginError(Exception):
    """Errore generico di login. `user_message` è pensato per essere mostrato all'utente."""

    status_code = 401

    def __init__(self, user_message: str, *, upstream_status: Optional[int] = None, upstream_detail: str = ""):
        super().__init__(user_message)
        self.user_message = user_message
        self.upstream_status = upstream_status
        self.upstream_detail = upstream_detail


class InvalidCredentials(ClasseVivaLoginError):
    status_code = 401


class DigitalIdentityRequired(ClasseVivaLoginError):
    """La scuola ha disattivato username/password: serve SPID o CIE."""

    status_code = 403


class ClasseVivaUnavailable(ClasseVivaLoginError):
    """Spaggiari giù, rate limit, chiave API non più valida o risposta inattesa."""

    status_code = 503


MSG_INVALID_CREDENTIALS = (
    "Credenziali non valide. Se la tua scuola ha attivato l'accesso solo con SPID o CIE, "
    "username e password di ClasseViva non funzionano più."
)
MSG_SPID_REQUIRED = (
    "La tua scuola consente l'accesso a ClasseViva solo con SPID o CIE: "
    "username e password non sono più abilitati."
)
MSG_RATE_LIMITED = "Troppi tentativi: Spaggiari ha bloccato temporaneamente l'accesso. Riprova più tardi."
MSG_API_KEY = "Spaggiari ha rifiutato la chiave dell'app: Aulera va aggiornata. Riprova più tardi."
MSG_UNAVAILABLE = "Spaggiari non è raggiungibile in questo momento. Riprova tra qualche minuto."

# Parole che, nel messaggio di errore di Spaggiari, indicano l'obbligo di identità digitale.
_SPID_HINTS = re.compile(r"\bspid\b|\bcie\b|identit[aà]\s+digitale|carta\s+d.identit", re.IGNORECASE)
_APIKEY_HINTS = re.compile(r"api\s*key|apikey", re.IGNORECASE)


def _upstream_detail(resp: requests.Response) -> str:
    """Estrae un testo leggibile dalla risposta di errore di Spaggiari (JSON o testo)."""
    try:
        data = resp.json()
    except ValueError:
        return (resp.text or "").strip()[:300]
    if not isinstance(data, dict):
        return str(data)[:300]
    parts = []
    for key in ("error", "message", "info", "detail", "statusText"):
        value = data.get(key)
        if value and isinstance(value, (str, int)):
            parts.append(str(value))
    return " | ".join(parts)[:300] if parts else json.dumps(data, ensure_ascii=False)[:300]


def classify_login_failure(status_code: int, detail: str) -> ClasseVivaLoginError:
    """Traduce una risposta di errore del login nell'eccezione più specifica possibile."""
    kwargs = {"upstream_status": status_code, "upstream_detail": detail}
    if _SPID_HINTS.search(detail or ""):
        return DigitalIdentityRequired(MSG_SPID_REQUIRED, **kwargs)
    if _APIKEY_HINTS.search(detail or ""):
        return ClasseVivaUnavailable(MSG_API_KEY, **kwargs)
    if status_code == 429:
        return ClasseVivaUnavailable(MSG_RATE_LIMITED, **kwargs)
    if status_code >= 500:
        return ClasseVivaUnavailable(MSG_UNAVAILABLE, **kwargs)
    if status_code in (400, 401, 403, 404, 422):
        return InvalidCredentials(MSG_INVALID_CREDENTIALS, **kwargs)
    return ClasseVivaUnavailable(MSG_UNAVAILABLE, **kwargs)


# ===== Utente =====
class Utente:
    def __init__(self, uid: str):
        self.uid = uid
        self.ident = ""
        self.token = ""
        self.first_name = ""
        self.last_name = ""
        self.token_expire: Optional[str] = None
        self.is_logged_in = False

    def login(self, password: str) -> dict:
        """Esegue il login con username/password. Solleva ClasseVivaLoginError se fallisce."""
        body = {"ident": None, "pass": password, "uid": self.uid}
        try:
            resp = requests.post(
                RequestURLs.login[0],
                headers=default_headers(),
                data=json.dumps(body),
                timeout=LOGIN_TIMEOUT,
            )
        except requests.RequestException as exc:
            raise ClasseVivaUnavailable(MSG_UNAVAILABLE, upstream_detail=str(exc)) from exc

        if resp.status_code != 200:
            detail = _upstream_detail(resp)
            err = classify_login_failure(resp.status_code, detail)
            log.warning(
                "Login ClasseViva fallito: HTTP %s (%s) -> %s",
                resp.status_code,
                detail,
                type(err).__name__,
            )
            raise err

        try:
            data = resp.json()
        except ValueError as exc:
            raise ClasseVivaUnavailable(MSG_UNAVAILABLE, upstream_status=200, upstream_detail="risposta non JSON") from exc

        token = data.get("token") if isinstance(data, dict) else None
        raw_ident = str(data.get("ident") or "") if isinstance(data, dict) else ""
        digits = re.search(r"\d+", raw_ident)
        if not token or not digits:
            # 200 senza token: Spaggiari chiede un'azione (es. scelta profilo o cambio password).
            detail = _upstream_detail(resp)
            log.warning("Login ClasseViva: risposta 200 senza token/ident (%s)", detail)
            if _SPID_HINTS.search(detail):
                raise DigitalIdentityRequired(MSG_SPID_REQUIRED, upstream_status=200, upstream_detail=detail)
            raise ClasseVivaUnavailable(
                "Spaggiari ha risposto in modo inatteso al login. Prova ad accedere dal sito ufficiale.",
                upstream_status=200,
                upstream_detail=detail,
            )

        self.ident = digits.group()
        self.token = token
        self.first_name = str(data.get("firstName") or "")
        self.last_name = str(data.get("lastName") or "")
        self.token_expire = data.get("expire")
        self.is_logged_in = True
        return data

    def request(self, request_url: tuple, params: Any = None) -> Optional[requests.Response]:
        """Compatibile con cvv-api: restituisce la Response se 200, altrimenti None."""
        if not self.is_logged_in:
            return None
        url = request_url[0].format(self.ident, params)
        method = request_url[1] if len(request_url) > 1 else "get"
        if method == "get":
            response = requests.get(url, headers=self.get_headers(), timeout=20)
        else:
            response = requests.post(url, headers=self.get_headers(), timeout=20)
        if response.status_code == 200:
            return response
        log.info("Richiesta ClasseViva %s fallita: HTTP %s", request_url[0], response.status_code)
        return None

    def get_headers(self) -> dict[str, str]:
        headers = default_headers()
        headers["Z-Auth-Token"] = self.token
        return headers


# ===== Request URLs =====
class RequestURLs:
    base_url: str = BASE_URL
    students_url: str = f"{base_url}/students/{{}}"  # Student Ident

    assenze: tuple = (f"{students_url}/absences/details", "get")
    agenda: tuple = (f"{students_url}/agenda/all/{{}}/{{}}", "get")  # Inizio / Fine (YYYYMMDD)
    didattica: tuple = (f"{students_url}/didactics", "get")
    libri: tuple = (f"{students_url}/schoolbooks", "get")
    calendario: tuple = (f"{students_url}/calendar/all", "get")
    card: tuple = (f"{students_url}/card", "get")
    voti: tuple = (f"{students_url}/grades", "get")
    lezioni_oggi: tuple = (f"{students_url}/lessons/today", "get")
    lezioni_giorno: tuple = (f"{students_url}/lessons/{{}}", "get")  # Giorno (YYYYMMDD)
    note: tuple = (f"{students_url}/notes/all", "get")
    periods: tuple = (f"{students_url}/periods", "get")
    materie: tuple = (f"{students_url}/subjects", "get")

    login: tuple = (f"{base_url}/auth/login", "post")
    noticeboard: tuple = (f"{students_url}/noticeboard", "post")
    documenti: tuple = (f"{students_url}/documents", "post")
