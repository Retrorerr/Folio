$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot "build-backend.ps1")

npm --prefix $root install
npm --prefix (Join-Path $root "frontend") install
npm --prefix $root exec tauri -- build
