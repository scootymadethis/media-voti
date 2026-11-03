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
from urllib.parse import urljoin, urlparse

log = logging.getLogger("classeviva")

BASE_URL = os.getenv("CLASSEVIVA_BASE_URL", "https://web.spaggiari.eu/rest/v1").rstrip("/")
# API del sito web (stessi percorsi e formati di /rest/v1, autenticate dal cookie PHPSESSID).
# Sono le uniche raggiungibili con una sessione ottenuta tramite SPID/CIE.
WEB_BASE_URL = os.getenv("CLASSEVIVA_WEB_BASE_URL", "https://web.spaggiari.eu/rest/w1").rstrip("/")
WEB_USER_AGENT = os.getenv(
    "CLASSEVIVA_WEB_USER_AGENT",
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
)
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
MSG_WEB_SESSION_INVALID = "Accesso a ClasseViva non completato o scaduto. Rifai l'accesso con SPID o CIE."

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

    # --- punti di estensione usati da main.py per le chiamate dirette ---
    auth_mode = "password"

    def resolve(self, request_url: tuple) -> tuple:
        """URL/metodo effettivi per questo tipo di utente (identità per il login classico)."""
        return request_url

    def http_get(self, url: str, timeout: float = 20) -> requests.Response:
        return requests.get(url, headers=self.get_headers(), timeout=timeout)


class _SyntheticResponse:
    """Risposta finta per segnalare a main.py una sessione web scaduta come HTTP 401."""

    def __init__(self, status_code: int):
        self.status_code = status_code
        self.text = ""
        self.headers: dict[str, str] = {}

    def json(self):
        raise ValueError("nessun JSON")

    def close(self):
        pass

    def iter_content(self, chunk_size=1):
        return iter(())


class WebSessionUtente(Utente):
    """Utente autenticato con il cookie di sessione del sito ClasseViva.

    È il risultato di un login fatto sul sito ufficiale (anche con SPID o CIE): Aulera non
    vede mai le credenziali, riceve solo il cookie PHPSESSID. Le API /rest/w1 hanno gli
    stessi percorsi e formati di /rest/v1, quindi main.py non cambia: cambiano solo URL
    base e autenticazione. Unica differenza nota: la bacheca si legge in GET.
    """

    auth_mode = "web"
    _METHOD_OVERRIDES = {"/noticeboard": "get"}

    def __init__(self, phpsessid: str):
        super().__init__(uid="")
        self.phpsessid = phpsessid.strip()
        self.account_type = ""

    def update_session(self, phpsessid: str) -> None:
        self.phpsessid = phpsessid.strip()

    def get_headers(self) -> dict[str, str]:
        return {
            "User-Agent": WEB_USER_AGENT,
            "Accept": "application/json",
            "Cookie": f"PHPSESSID={self.phpsessid}",
        }

    def resolve(self, request_url: tuple) -> tuple:
        url = request_url[0]
        if url.startswith(BASE_URL):
            url = WEB_BASE_URL + url[len(BASE_URL):]
        method = request_url[1] if len(request_url) > 1 else "get"
        for suffix, override in self._METHOD_OVERRIDES.items():
            if url.endswith(suffix):
                method = override
        return (url, method)

    @staticmethod
    def _is_session_response(resp: requests.Response) -> bool:
        """Una sessione scaduta può tornare come redirect o pagina HTML di login."""
        if 300 <= resp.status_code < 400:
            return False
        if resp.status_code == 200:
            return "json" in (resp.headers.get("Content-Type") or "")
        return True

    def http_get(self, url: str, timeout: float = 20):
        if url.startswith(BASE_URL):
            url = WEB_BASE_URL + url[len(BASE_URL):]
        resp = requests.get(url, headers=self.get_headers(), timeout=timeout, allow_redirects=False)
        if not self._is_session_response(resp):
            return _SyntheticResponse(401)
        return resp

    def request(self, request_url: tuple, params: Any = None):
        """Esegue la richiesta e restituisce SEMPRE la risposta (anche di errore).

        Così main.py vede i 401 (sessione scaduta → logout) invece di un payload vuoto.
        Una risposta non JSON o un redirect al login diventano un 401 sintetico.
        """
        if not self.is_logged_in:
            return _SyntheticResponse(401)
        url, method = self.resolve(request_url)
        url = url.format(self.ident, params)
        response = requests.request(
            method.upper(), url, headers=self.get_headers(), timeout=20, allow_redirects=False
        )
        if not self._is_session_response(response):
            return _SyntheticResponse(401)
        if response.status_code != 200:
            log.info("Richiesta ClasseViva web %s: HTTP %s", request_url[0], response.status_code)
        return response

    def call(self, method: str, path: str, timeout: float = 20):
        """Chiamata JSON su un percorso relativo a /students/{ident} (es. "/notes/all")."""
        url = f"{WEB_BASE_URL}/students/{self.ident}{path}"
        headers = self.get_headers()
        data = None
        if method.upper() == "POST":
            # Come il sito ufficiale: POST con corpo vuoto form-urlencoded.
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            data = b""
        response = requests.request(
            method.upper(), url, headers=headers, data=data, timeout=timeout, allow_redirects=False
        )
        if not self._is_session_response(response):
            return _SyntheticResponse(401)
        return response

    def download(self, method: str, path: str, timeout: float = 60):
        """Scarica un file (allegato, materiale didattico, documento) in streaming.

        Segue al massimo 3 redirect; il cookie di sessione viene inviato solo ai server
        *.spaggiari.eu, mai a domini esterni. Restituisce la Response aperta (stream=True).
        """
        url = path if path.startswith("https://") else f"{WEB_BASE_URL}/students/{self.ident}{path}"
        for _ in range(4):
            host = (urlparse(url).hostname or "").lower()
            trusted = host == "spaggiari.eu" or host.endswith(".spaggiari.eu")
            headers = self.get_headers() if trusted else {"User-Agent": WEB_USER_AGENT}
            headers["Accept"] = "*/*"
            data = None
            if method.upper() == "POST":
                headers["Content-Type"] = "application/x-www-form-urlencoded"
                data = b""
            resp = requests.request(
                method.upper(), url, headers=headers, data=data, timeout=timeout, allow_redirects=False, stream=True
            )
            if 300 <= resp.status_code < 400 and resp.headers.get("Location"):
                url = urljoin(url, resp.headers["Location"])
                resp.close()
                if "login" in url.lower() and trusted:
                    return _SyntheticResponse(401)
                method = "GET"
                continue
            return resp
        return _SyntheticResponse(502)

    def login_from_session(self) -> dict:
        """Verifica il cookie con /misc/whoami e /card. Solleva ClasseVivaLoginError se non valido."""
        try:
            who = requests.get(
                f"{WEB_BASE_URL}/misc/whoami",
                headers=self.get_headers(),
                timeout=LOGIN_TIMEOUT,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise ClasseVivaUnavailable(MSG_UNAVAILABLE, upstream_detail=str(exc)) from exc
        if who.status_code >= 500 or who.status_code == 429:
            raise classify_login_failure(who.status_code, _upstream_detail(who))
        if not self._is_session_response(who) or who.status_code != 200:
            raise InvalidCredentials(MSG_WEB_SESSION_INVALID, upstream_status=who.status_code)
        try:
            data = who.json()
        except ValueError as exc:
            raise InvalidCredentials(MSG_WEB_SESSION_INVALID, upstream_status=200) from exc
        digits = re.search(r"\d+", str((data or {}).get("id") or ""))
        if not digits:
            raise InvalidCredentials(MSG_WEB_SESSION_INVALID, upstream_status=200, upstream_detail="whoami senza id")
        self.ident = digits.group()
        self.account_type = str(data.get("account_type") or "")
        self.first_name = str(data.get("nome") or "")
        self.last_name = str(data.get("cognome") or "")
        self.is_logged_in = True

        # Username = ident della card (es. S1234567X), lo stesso del login con password,
        # così classifiche e badge restano collegati allo stesso studente.
        username = ""
        try:
            card_resp = self.http_get(f"{WEB_BASE_URL}/students/{self.ident}/card", timeout=LOGIN_TIMEOUT)
            if card_resp.status_code == 200:
                card = (card_resp.json() or {}).get("card") or {}
                username = str(card.get("ident") or "").strip()
        except (requests.RequestException, ValueError):
            username = ""
        self.uid = username or f"S{self.ident}"
        return data


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
