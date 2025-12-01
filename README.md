# media-voti

Small FastAPI + frontend project to query ClasseViva-like API and present data.

## Run (development)

1. Create a virtual env and install dependencies (example):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt  # if you have one
pip install uvicorn fastapi
```

2. Start the backend:

```powershell
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

3. Serve the frontend (e.g. Live Server on port 5500) and open `http://localhost:5500`.

## Notes

- The backend sets a `session_id` cookie (`SameSite=None; Secure`) and the frontend uses `fetch(..., credentials: 'include')`.
- For development you may serve frontend from the same origin to avoid CORS/cookie issues.
