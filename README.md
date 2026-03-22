# media-voti

Small FastAPI + frontend project to query ClasseViva-like API and present data.

## Novità incluse

- la pagina **Assenze** non mostra più il popup iniziale
- la visibilità in classifica è gestita solo dal toggle **compari / scompari**
- di default un nuovo utente **compare** in classifica
- le entry della classifica sono salvate in **SQLite**, quindi restano anche dopo il riavvio del backend
- aggiornamento **in tempo reale** per tutti i client quando una entry viene aggiunta, nascosta, mostrata o aggiornata

## Variabili ambiente

Puoi copiare `.env.example` oppure esportarle direttamente:

- `ALLOWED_ORIGINS` → dominio frontend autorizzato, es. `https://tuodominio.it`
- `DATABASE_PATH` → file SQLite persistente, es. `/opt/spaggiari2/data/spaggiari2.db`
- `COOKIE_SECURE` → `true` in produzione HTTPS, `false` solo in sviluppo locale

## Run (development)

1. Crea virtualenv e installa dipendenze:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Avvia il backend:

```bash
export ALLOWED_ORIGINS=http://localhost:5500
export DATABASE_PATH=$(pwd)/data/spaggiari2.db
export COOKIE_SECURE=false
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

3. Servi il frontend e apri `http://localhost:5500`.

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

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
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
