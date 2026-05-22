# Avvio locale su Windows: backend + frontend sulla porta 8000 (un solo processo).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path ".venv")) {
    python -m venv .venv
}

& ".\.venv\Scripts\Activate.ps1"

pip install -q -r requirements.txt

$env:DEV_MODE = "true"
$env:ALLOWED_ORIGINS = "http://localhost:8000,http://127.0.0.1:8000"
$env:DATABASE_PATH = Join-Path $Root "data\spaggiari2.db"
$env:COOKIE_SECURE = "false"

New-Item -ItemType Directory -Force -Path (Split-Path $env:DATABASE_PATH) | Out-Null

Write-Host ""
Write-Host "Spaggiari 2 - dev locale" -ForegroundColor Green
Write-Host "Apri nel browser: http://localhost:8000" -ForegroundColor Cyan
Write-Host "Premi Ctrl+C per fermare." -ForegroundColor DarkGray
Write-Host ""

python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
