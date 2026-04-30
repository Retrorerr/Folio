$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$env:VITE_API_BASE = "http://127.0.0.1:8000"

npm --prefix (Join-Path $root "frontend") run build
