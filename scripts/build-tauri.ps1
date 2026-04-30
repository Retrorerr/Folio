$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

if (Test-Path $cargoBin) {
  $env:PATH = "$cargoBin;$env:PATH"
}

& (Join-Path $PSScriptRoot "build-backend.ps1")

$signingKeyPath = Join-Path $root ".tauri\folio-updater.key"
if (Test-Path $signingKeyPath) {
  $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $signingKeyPath
}

npm --prefix $root install
npm --prefix (Join-Path $root "frontend") install
npm --prefix $root exec tauri -- build
