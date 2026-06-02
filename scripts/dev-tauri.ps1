$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
. (Join-Path $PSScriptRoot "resolve-node-tools.ps1")
$nodeTools = Resolve-NodeTools
$apiTokenBytes = [byte[]]::new(32)
$apiTokenRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $apiTokenRng.GetBytes($apiTokenBytes)
}
finally {
  $apiTokenRng.Dispose()
}
$apiToken = -join ($apiTokenBytes | ForEach-Object { $_.ToString("x2") })

$env:PYTHONUNBUFFERED = "1"
$env:KOKORO_CORS_ORIGINS = "tauri://localhost,http://tauri.localhost,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8000,http://localhost:8000"
$env:FOLIO_API_TOKEN = $apiToken
$env:VITE_FOLIO_API_TOKEN = $apiToken
$env:FOLIO_ALLOWED_HOSTS = "127.0.0.1,localhost,::1"

Start-Process -WindowStyle Hidden -FilePath "python" -ArgumentList @(
  "-m", "uvicorn", "main:app",
  "--host", "127.0.0.1",
  "--port", "8000"
) -WorkingDirectory $backend

& $nodeTools.NodeExe $nodeTools.NpmCli --prefix (Join-Path $root "frontend") run dev -- --host 127.0.0.1
