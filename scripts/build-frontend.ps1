$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$isAndroid = $env:TAURI_ENV_PLATFORM -eq 'android' -or
  $env:TAURI_ENV_TARGET_TRIPLE -match 'android' -or
  -not [string]::IsNullOrWhiteSpace($env:TAURI_ANDROID_PROJECT_PATH)
if ($isAndroid) {
  $env:VITE_FOLIO_PLATFORM = 'android'
  Remove-Item Env:VITE_API_BASE -ErrorAction SilentlyContinue
} else {
  $env:VITE_FOLIO_PLATFORM = 'desktop'
  $env:VITE_API_BASE = "http://127.0.0.1:8000"
}
. (Join-Path $PSScriptRoot "resolve-node-tools.ps1")
$nodeTools = Resolve-NodeTools

& $nodeTools.NodeExe $nodeTools.NpmCli --prefix (Join-Path $root "frontend") run build
