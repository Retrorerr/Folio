$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$env:VITE_API_BASE = "http://127.0.0.1:8000"
. (Join-Path $PSScriptRoot "resolve-node-tools.ps1")
$nodeTools = Resolve-NodeTools

& $nodeTools.NodeExe $nodeTools.NpmCli --prefix (Join-Path $root "frontend") run build
