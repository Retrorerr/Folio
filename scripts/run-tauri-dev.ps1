$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

if (Test-Path $cargoBin) {
  $env:PATH = "$cargoBin;$env:PATH"
}

npm --prefix $root exec tauri -- dev
