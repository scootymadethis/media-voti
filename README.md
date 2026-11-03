# Aulera

Client non ufficiale del registro elettronico ClasseViva (repo `media-voti`): un backend FastAPI
(`main.py`) e un'app web a pagina singola (`public/`), più le app Android e iPhone (Capacitor) che
la incapsulano. Dal 2026 l'accesso avviene **solo con SPID o CIE**.

## Cosa fa

- **Oggi**: media, lezioni del giorno, prossimi impegni, ultimi voti, bacheca e presenze.
- **Voti**: medie per materia e periodo, andamento, obiettivo ("quanto mi serve") e simulatore.
- **Agenda e compiti** (con "fatto"), **orario** (settimana intera anche da telefono), **assenze**, **lezioni**.
- **Bacheca** con allegati, **note**, **didattica** (file e link dei docenti), **documenti**, **libri**.
- **Classifiche** di classe e d'istituto (media e assenze) in tempo reale, con visibilità a scelta.
- **Dispositivi**: il PC si collega dal telefono con un QR o un codice.
- Pannello **admin** (sessioni, classifiche, badge, annuncio).

## Struttura

| Percorso | Contenuto |
|---|---|
| `main.py` | API FastAPI (sessioni, proxy verso ClasseViva, classifiche, admin) |
| `classeviva_client.py` | Client ClasseViva con la sessione web (`/rest/w1`) ottenuta via SPID/CIE |
| `public/index.html` | Shell della SPA (import map con la versione degli asset) |
| `public/app/` | `main.js` (router e struttura), `ui.js`, `api.js`, `state.js`, `grades.js`, `views/*.js` |
| `public/styles/` | Design system (`app.css`) e stili delle viste |
| `android/`, `ios/` | App Capacitor 7 con il plugin nativo `SpaggiariLogin` |
| `app-shell/` | Pagina offline delle app (le app caricano il sito pubblicato) |
| `docs/spid-cie.md` | Come funzionano accesso SPID/CIE, collegamento del PC e build delle app |

## Variabili ambiente

- `ALLOWED_ORIGINS` → domini autorizzati, es. `https://tuodominio.it`
- `DATABASE_PATH` → file SQLite persistente, es. `/opt/spaggiari2/data/spaggiari2.db`
- `COOKIE_SECURE` → `true` in produzione HTTPS, `false` solo in sviluppo locale
- `ADMIN_USERNAME` → codice ClasseViva dell'amministratore; `ADMIN_PANEL_PASSWORD` (opzionale) → password aggiuntiva per il pannello
- Altre opzioni (codici di collegamento, link ai file, ...) in [`docs/spid-cie.md`](docs/spid-cie.md).

## Sviluppo

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Con un ClasseViva **finto** (dati di esempio, nessun account necessario):

```bash
.venv/bin/python scripts/dev_fake_server.py
```

Apri `http://127.0.0.1:8000` e, nel riquadro di accesso, usa *Sviluppo: accedi con un cookie di sessione* con un valore
qualsiasi di almeno 16 caratteri. Con un account vero, avvia il backend normale con `DEV_MODE=true` e
`ALLOW_MANUAL_WEB_SESSION_LOGIN=true` e incolla il tuo `PHPSESSID` (vedi `docs/spid-cie.md`).

Usa sempre `127.0.0.1`, non `localhost`: `localhost` è riservato all'app Capacitor.

Quando cambi il frontend, aggiorna la versione `?v=` nella import map di `public/index.html` (e nei `<link>` CSS):
così i browser non usano file vecchi dalla cache.

Test: `scripts/test_web_session_pairing.py`, `test_session_me_cache.py`, `test_agenda_422.py`,
`test_historical_class.py`, `test_school_year.py` (con `DATABASE_PATH` su un DB temporaneo).

## Setup Linux consigliato (produzione)

Esempio con:

- backend FastAPI su `127.0.0.1:8000`
- frontend statico servito da Nginx
- database SQLite persistente in `/opt/spaggiari2/data/spaggiari2.db`
- systemd per avvio automatico

### 1) Creazione cartelle

```bash
sudo mkdir -p /opt/spaggiari2/app
sudo mkdir -p /opt/spaggiari2/data
sudo mkdir -p /var/www/spaggiari2
```

Copia il progetto in `/opt/spaggiari2/app` e il contenuto di `public/` in `/var/www/spaggiari2`.

### 2) Ambiente Python

```bash
cd /opt/spaggiari2/app
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### 3) Variabili ambiente

Crea `/opt/spaggiari2/app/.env`:

```env
ALLOWED_ORIGINS=https://tuodominio.it
DATABASE_PATH=/opt/spaggiari2/data/spaggiari2.db
COOKIE_SECURE=true
```

### 4) Servizio systemd

Crea `/etc/systemd/system/spaggiari2.service`:

```ini
[Unit]
Description=Spaggiari2 FastAPI backend
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/opt/spaggiari2/app
EnvironmentFile=/opt/spaggiari2/app/.env
ExecStart=/opt/spaggiari2/app/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Poi:

```bash
sudo chown -R www-data:www-data /opt/spaggiari2
sudo systemctl daemon-reload
sudo systemctl enable --now spaggiari2
sudo systemctl status spaggiari2
```

### 5) Configurazione Nginx

Crea `/etc/nginx/sites-available/spaggiari2.conf`:

```nginx
server {
    listen 80;
    server_name tuodominio.it;

    root /var/www/spaggiari2;
    index index.html;

    # SPA: i percorsi dell'app (/oggi, /voti, ...) servono index.html.
    # index.html va sempre rivalidato: contiene la versione degli asset (import map).
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }

    # JS/CSS hanno ?v=N nell'URL: possono stare in cache a lungo.
    location ~* ^/(app|styles|vendor)/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_buffering off;  # download dei file in streaming
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ws/ {
        proxy_pass http://127.0.0.1:8000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Attiva il sito:

```bash
sudo ln -s /etc/nginx/sites-available/spaggiari2.conf /etc/nginx/sites-enabled/spaggiari2.conf
sudo nginx -t
sudo systemctl reload nginx
```

### 6) HTTPS

Per mantenere `COOKIE_SECURE=true`, metti il sito sotto HTTPS. Esempio con certbot:

```bash
sudo apt update
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d tuodominio.it
```

## Database

Non devi creare tabelle a mano: il backend inizializza SQLite automaticamente al boot.

Tabella usata:

- `leaderboard_entries`
  - `username` (PK)
  - `full_name`
  - `class_code`
  - `hours`
  - `visible_in_leaderboard`
  - `updated_at`

## Note

- Le sessioni login restano in memoria, ma **la classifica no**: quella ora è persistente su SQLite.
- Il realtime usa WebSocket su `/ws/leaderboard` (esposto al frontend tramite `/api/ws/leaderboard`).
- Se cambi dominio, aggiorna `ALLOWED_ORIGINS`.
