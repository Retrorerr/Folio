$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
. (Join-Path $PSScriptRoot "resolve-node-tools.ps1")
$nodeTools = Resolve-NodeTools

if (Test-Path $cargoBin) {
  $env:PATH = "$cargoBin;$env:PATH"
}

& $nodeTools.NodeExe $nodeTools.NpmCli --prefix $root exec tauri -- dev
