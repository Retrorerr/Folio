$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"

$env:PYTHONUNBUFFERED = "1"
$env:KOKORO_CORS_ORIGINS = "tauri://localhost,http://tauri.localhost,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8000,http://localhost:8000"

Start-Process -WindowStyle Hidden -FilePath "python" -ArgumentList @(
  "-m", "uvicorn", "main:app",
  "--host", "127.0.0.1",
  "--port", "8000"
) -WorkingDirectory $backend

npm --prefix (Join-Path $root "frontend") run dev -- --host 127.0.0.1
