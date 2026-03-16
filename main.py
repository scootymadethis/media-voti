from fastapi import FastAPI, HTTPException, Depends, Response, Cookie, Request, Body, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ClasseVivaAPI import Utente, RequestURLs
import time, secrets
from typing import Optional
import requests
from math import ceil
from threading import Lock

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://spaggiari2.federicoscutariu.it",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class LoginBody(BaseModel):
    username: str
    password: str

class AgendaBody(BaseModel):
    start: Optional[str] = None  # YYYYMMDD
    end: Optional[str] = None    # YYYYMMDD

class LeaderboardUpdateBody(BaseModel):
    class_code: Optional[str] = None
    full_name: Optional[str] = None
    hours: float
    visible_in_leaderboard: bool = True

# ---- session store in memoria ----
SESSION_TTL = 60 * 30  # 30 minuti
sessions: dict[str, dict] = {}

absence_hours_map: dict[str, dict] = {}
absence_hours_lock = Lock()

def get_session_user(session_id: Optional[str]) -> Utente:
    if not session_id or session_id not in sessions:
        raise HTTPException(status_code=401, detail="Non loggato")

    sess = sessions[session_id]
    if sess["expires"] < time.time():
        sessions.pop(session_id, None)
        raise HTTPException(status_code=401, detail="Sessione scaduta")

    # rinnova TTL a ogni richiesta
    sess["expires"] = time.time() + SESSION_TTL
    return sess["user"]

def current_user(request: Request, session_id: Optional[str] = Cookie(default=None)):
    return get_session_user(session_id)

# ---- LOGIN UNA VOLTA ----
def create_session(u: Utente, pwd: str) -> str:
    sid = secrets.token_urlsafe(32)
    sessions[sid] = {
        "user": u, 
        "password": pwd, # TEMP
        "expires": time.time() + SESSION_TTL
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
            secure=True
        )
        return {"ok": True, "user": body.username}
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))

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
        # qui non è un problema di login ma di chiamata esterna
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
    

# TODO: rendere funzionante lo store della sessione per mantenere il login fino ad un certo timeout
@app.post("/card")
def card(request: Request, u: Utente = Depends(current_user)):
    try:
        card_res = u.request(RequestURLs.card).json()
        
        try:
            first_name = card_res.get("card", {}).get("firstName", "N/D")
            last_name = card_res.get("card", {}).get("lastName", "N/D")
            full_name = f"{first_name} {last_name}"
            
            sid = request.cookies.get("session_id")
            if sid in sessions:
                username = u.uid
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

@app.post("/leaderboard/update")
def update_leaderboard(
    body: LeaderboardUpdateBody,
    u: Utente = Depends(current_user)
):
    try:
        session_username = getattr(u, "uid", None)
        if not session_username:
            raise HTTPException(status_code=400, detail="Username sessione non disponibile")

        normalized_username = session_username.strip()
        normalized_class = (body.class_code or "").strip().upper() or None
        normalized_full_name = (body.full_name or "").strip() or normalized_username
        normalized_hours = float(body.hours)
        visible_in_leaderboard = bool(body.visible_in_leaderboard)

        with absence_hours_lock:
            absence_hours_map[normalized_username] = {
                "username": normalized_username,
                "full_name": normalized_full_name,
                "class_code": normalized_class,
                "hours": normalized_hours,
                "visible_in_leaderboard": visible_in_leaderboard,
                "updated_at": time.time(),
            }

        return {
            "ok": True,
            "saved": absence_hours_map[normalized_username]
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        session_username = getattr(u, "uid", None)

        # opzionale ma consigliato: impedisce di scrivere per altri username
        if session_username and body.username != session_username:
            raise HTTPException(status_code=403, detail="Username non valido per questa sessione")

        normalized_username = body.username.strip()
        normalized_class = (body.class_code or "").strip().upper() or None
        normalized_hours = float(body.hours)

        with absence_hours_lock:
            absence_hours_map[normalized_username] = {
                "username": normalized_username,
                "class_code": normalized_class,
                "hours": normalized_hours,
                "updated_at": time.time(),
            }

        return {
            "ok": True,
            "saved": absence_hours_map[normalized_username]
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/leaderboard/me")
def delete_my_leaderboard_entry(u: Utente = Depends(current_user)):
    try:
        session_username = getattr(u, "uid", None)
        if not session_username:
            raise HTTPException(status_code=400, detail="Username sessione non disponibile")

        normalized_username = session_username.strip()

        with absence_hours_lock:
            removed = absence_hours_map.pop(normalized_username, None)

        return {
            "ok": True,
            "removed": removed is not None,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/leaderboard")
def get_leaderboard(
    type: str = Query(default="global"),
    class_code: Optional[str] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
    u: Utente = Depends(current_user),
):
    try:
        with absence_hours_lock:
            entries = list(absence_hours_map.values())

        if type not in {"global", "class"}:
            raise HTTPException(status_code=400, detail="type deve essere 'global' o 'class'")

        normalized_class = class_code.strip().upper() if class_code else None

        entries = [
            entry for entry in entries
            if entry.get("visible_in_leaderboard", True)
        ]

        if type == "class":
            if not normalized_class:
                raise HTTPException(status_code=400, detail="class_code richiesto per la classifica di classe")
            entries = [
                entry for entry in entries
                if (entry.get("class_code") or "").upper() == normalized_class
            ]

        # ordinamento: ore discendente, poi username crescente
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
            enriched_items.append({
                "rank": idx,
                "username": item.get("username"),
                "full_name": item.get("full_name") or item.get("username"),
                "class_code": item.get("class_code"),
                "hours": item.get("hours", 0),
                "visible_in_leaderboard": item.get("visible_in_leaderboard", True),
                "updated_at": item.get("updated_at"),
            })

        return {
            "ok": True,
            "scope": type,
            "class_code": normalized_class if type == "class" else None,
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