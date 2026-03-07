from fastapi import FastAPI, HTTPException, Depends, Response, Cookie, Request, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ClasseVivaAPI import Utente, RequestURLs
import time, secrets
from typing import Optional
import requests

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

# ---- session store in memoria ----
SESSION_TTL = 60 * 30  # 30 minuti
sessions: dict[str, dict] = {}

def create_session(u: Utente) -> str:
    sid = secrets.token_urlsafe(32)
    sessions[sid] = {"user": u, "expires": time.time() + SESSION_TTL}
    return sid

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
        "password": pwd, # salva password temporaneamente per mantenere la session
        "expires": time.time() + SESSION_TTL
    }
    return sid

@app.post("/login")
def login(body: LoginBody, response: Response):
    try:
        u = Utente(uid=body.username, pwd=body.password)
        u.login()

        # Passiamo anche la password alla sessione
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

        # formattazione url per debug
        try:
            url_template = RequestURLs.agenda[0]
            formatted_url = url_template.format(user_ident, start, end)
        except Exception as e:
            print("Errore nella formattazione url agenda:", e)
            formatted_url = None

        # prova call alla library
        try:
            resp = u.request(RequestURLs.agenda, start, end)
            if hasattr(resp, "status_code"):
                if resp.status_code >= 400:
                    # fallback alla richiesta manuale in caso non funzioni la library
                    print(f"u.request returna status {resp.status_code}, fallback alla richiesta manuale")
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

        # fallback: call upstream directly to inspect response
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
            sid = request.cookies.get("session_id")
            if sid in sessions:
                password = sessions[sid].get("password")
                
                if password:
                    sessions[sid]["password"] = None
        except Exception as log_err:
            print(f"Errore durante la ricezione della risposta: {log_err}")

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