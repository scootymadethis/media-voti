# AGENTS.md

## Cursor Cloud specific instructions

### What this is
Single product ("Aulera", repo `media-voti`, previously shown as Spaggiari 2): a FastAPI backend (`main.py`) plus a
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
  The ClasseViva client lives in `classeviva_client.py` (replaces the old `cvv-api`
  package, same `Utente`/`RequestURLs` interface). `POST /api/login` now fails when
  Spaggiari rejects the login: 401 for wrong credentials, 403 when the school only allows
  SPID/CIE, 503 for rate limit / outage / rejected API key; the `detail` is shown in the UI.
  `CLASSEVIVA_USER_AGENT`, `CLASSEVIVA_API_KEY`, `CLASSEVIVA_BASE_URL` override the app
  identity sent to Spaggiari (the key is rotated periodically upstream).
- Since Sept 2026 (Legge 182/2025) many schools allow ClasseViva access ONLY via SPID/CIE,
  so username/password login no longer works for those users.
  `scripts/check_spid_session.py` checks whether a SPID-obtained web session (`PHPSESSID`)
  is usable from the server; run it manually with your own session, it is not automated.
- SPID/CIE support (see `docs/spid-cie.md`): `WebSessionUtente` authenticates with the
  ClasseViva web cookie against `/rest/w1` (same paths/payloads as `/rest/v1`). The Android
  app (`public/spid-app.js`) captures the cookie after the official login; PCs are linked
  from the phone via QR/code (`/pair/*`, page `public/collega/`). To try it locally without
  the app, run with `ALLOW_MANUAL_WEB_SESSION_LOGIN=true` and use the dev field in the
  SPID panel of the login page (needs a real `PHPSESSID`).

### Tests / lint / build
- Automated self-check: `.venv/bin/python scripts/test_session_me_cache.py`. It imports
  `main` directly and does NOT run the startup `init_db()`, so it needs a DB that already
  has the tables — run it with `DATABASE_PATH` pointing at a DB the app has already booted
  against, otherwise it fails with `no such table: user_badges`.
- `scripts/test_web_session_pairing.py` tests web-session login, PC pairing and device
  revoke with a mocked Spaggiari (no network).
- `scripts/test_classeviva_client.py` tests the ClasseViva client and `POST /login` with
  mocked upstream responses (no network); same `DATABASE_PATH` caveat as above.
- There is no lint config (no ruff/flake8/eslint) and no build step for the web app; the
  frontend is served as static files.
