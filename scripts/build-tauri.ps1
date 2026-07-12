$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
. (Join-Path $PSScriptRoot "resolve-node-tools.ps1")
$nodeTools = Resolve-NodeTools

if (Test-Path $cargoBin) {
  $env:PATH = "$cargoBin;$env:PATH"
}

& (Join-Path $PSScriptRoot "build-backend.ps1")

$releaseResources = Join-Path $root "src-tauri\target\release\resources"
if (Test-Path $releaseResources) {
  Remove-Item -Recurse -Force $releaseResources
}

$signingKeyPath = Join-Path $root ".tauri\folio-updater.key"
if (Test-Path $signingKeyPath) {
  $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $signingKeyPath
}

& $nodeTools.NodeExe $nodeTools.NpmCli --prefix $root install
& $nodeTools.NodeExe $nodeTools.NpmCli --prefix (Join-Path $root "frontend") install
$tauriArgs = @("--prefix", $root, "exec", "tauri", "--", "build")
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
  # Local validation builds should still produce usable installers. Release
  # builds retain updater artifacts automatically when a signing key exists.
  $tauriArgs += @("--config", (Join-Path $root "src-tauri\tauri.local-build.conf.json"))
}

& $nodeTools.NodeExe $nodeTools.NpmCli @tauriArgs
exit $LASTEXITCODE
