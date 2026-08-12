$ErrorActionPreference = "Stop"

function Test-ExistingFile([string]$Path) {
  return $Path -and [System.IO.Path]::IsPathRooted($Path) -and (Test-Path -LiteralPath $Path -PathType Leaf)
}

function Resolve-NodeTools {
  $nodeCandidates = @()
  if ($env:FOLIO_NODE) {
    $nodeCandidates += $env:FOLIO_NODE
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node -and (Test-ExistingFile $node.Source)) {
    $nodeCandidates += $node.Source
  }

  foreach ($nodeExe in ($nodeCandidates | Where-Object { Test-ExistingFile $_ } | Select-Object -Unique)) {
    $nodeDir = Split-Path -Parent $nodeExe
    $npmCliCandidates = @()
    if ($env:FOLIO_NPM_CLI) {
      $npmCliCandidates += $env:FOLIO_NPM_CLI
    }
    $npmCliCandidates += (Join-Path $nodeDir "node_modules\npm\bin\npm-cli.js")
    $npmCliCandidates += (Join-Path $env:ProgramFiles "nodejs\node_modules\npm\bin\npm-cli.js")
    $npmCliCandidates += (Join-Path ${env:ProgramFiles(x86)} "nodejs\node_modules\npm\bin\npm-cli.js")

    foreach ($npmCli in ($npmCliCandidates | Where-Object { Test-ExistingFile $_ } | Select-Object -Unique)) {
      return [pscustomobject]@{
        NodeExe = $nodeExe
        NpmCli  = $npmCli
      }
    }
  }

  throw "Unable to locate node/npm. Set FOLIO_NODE and FOLIO_NPM_CLI to compatible paths."
}
