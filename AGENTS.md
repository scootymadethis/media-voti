# AGENTS.md

## Cursor Cloud specific instructions

### What this is
Single product ("Spaggiari 2" / repo `media-voti`): a FastAPI backend (`main.py`) plus a
static vanilla-JS frontend (`public/`) and a SQLite DB. It is an unofficial client for the
Italian ClasseViva/Spaggiari school register. Python deps are in `requirements.txt`
(installed into `.venv` by the update script). The `package.json` is only for the optional
Capacitor Android build and is not needed to run the web app.

### Running the app (dev)
Run the backend from the repo root with the venv, e.g.:

```
DEV_MODE=true \
ALLOWED_ORIGINS="http://localhost:8000,http://127.0.0.1:8000" \
DATABASE_PATH=/tmp/spaggiari2data/spaggiari2.db \
COOKIE_SECURE=false \
.venv/bin/python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

With `DEV_MODE=true` a single Uvicorn process on `:8000` serves `public/` AND rewrites
`/api/*` → `/*` (mirrors the production Nginx setup), so no separate frontend server is
needed. See `README.md` / `scripts/dev-windows.ps1` for the split-server alternative
(uvicorn on `:8000` + `python -m http.server 5500 --directory public`).

### Non-obvious gotchas
- ACCESS THE DEV APP AT `http://127.0.0.1:8000`, NOT `http://localhost:8000`.
  `public/config.js` treats `hostname === "localhost"` as the Capacitor embedded app and
  points all API/WebSocket calls at the PRODUCTION server
  (`https://spaggiari2.federicoscutariu.it`). Using the `127.0.0.1` IP keeps requests on the
  local backend.
- `DATABASE_PATH` should point OUTSIDE the repo in dev (e.g. under `/tmp`). The committed
  `data/spaggiari2.db*` files are git-tracked and have a stale schema; letting the app write
  to them dirties the working tree. `init_db()` runs on FastAPI startup and creates all
  current tables (`CREATE TABLE IF NOT EXISTS`), so a fresh DB file is fully provisioned on
  first boot.
- Core functionality (login, grades, absences, leaderboards) requires REAL ClasseViva
  student credentials — an external dependency reached at `https://web.spaggiari.eu`.
  `POST /api/login` always returns `{"ok":true}` and creates a session, but the session is
  only usable if `cvv-api`'s `Utente.login()` actually succeeded; `GET /api/session/me`
  triggers the first real upstream fetch and returns 401 for an unauthenticated session.
  Invalid creds surface as "Password errata" in the UI (upstream returns HTTP 403).

### Tests / lint / build
- Automated self-check: `.venv/bin/python scripts/test_session_me_cache.py`. It imports
  `main` directly and does NOT run the startup `init_db()`, so it needs a DB that already
  has the tables — run it with `DATABASE_PATH` pointing at a DB the app has already booted
  against, otherwise it fails with `no such table: user_badges`.
- There is no lint config (no ruff/flake8/eslint) and no build step for the web app; the
  frontend is served as static files.
