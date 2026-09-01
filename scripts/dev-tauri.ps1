$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
. (Join-Path $PSScriptRoot "resolve-node-tools.ps1")
$nodeTools = Resolve-NodeTools
$isAndroid = $env:TAURI_ENV_PLATFORM -eq 'android' -or
  $env:TAURI_ENV_TARGET_TRIPLE -match 'android' -or
  -not [string]::IsNullOrWhiteSpace($env:TAURI_ANDROID_PROJECT_PATH)

if ($isAndroid) {
  $env:VITE_FOLIO_PLATFORM = 'android'
  Remove-Item Env:VITE_API_BASE -ErrorAction SilentlyContinue
  & $nodeTools.NodeExe $nodeTools.NpmCli --prefix (Join-Path $root "frontend") run dev -- --host 0.0.0.0
  exit $LASTEXITCODE
}

function Get-PythonMajorMinor([string]$PythonExe) {
  try {
    return (& $PythonExe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
  }
  catch {
    return ""
  }
}

function Test-CompatiblePython([string]$PythonExe) {
  return (Get-PythonMajorMinor $PythonExe) -match "^3\.(10|11|12|13)$"
}

$pythonCandidates = @()
if ($env:FOLIO_PYTHON) {
  $pythonCandidates += $env:FOLIO_PYTHON
}
$pythonCandidates += (Join-Path $backend ".venv\Scripts\python.exe")
foreach ($version in @("313", "312", "311", "310")) {
  $pythonCandidates += (Join-Path $env:LOCALAPPDATA "Programs\Python\Python$version\python.exe")
}
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if ($pythonCommand -and (Test-ExistingFile $pythonCommand.Source)) {
  $pythonCandidates += $pythonCommand.Source
}

$pythonExe = $null
foreach ($candidate in $pythonCandidates) {
  if ((Test-ExistingFile $candidate) -and (Test-CompatiblePython $candidate)) {
    $pythonExe = $candidate
    break
  }
}
if (-not $pythonExe) {
  throw "Unable to locate a Python 3.10-3.13 interpreter. Set FOLIO_PYTHON to a compatible python.exe."
}

$env:VITE_FOLIO_PLATFORM = 'desktop'
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

Start-Process -WindowStyle Hidden -FilePath $pythonExe -ArgumentList @(
  "-m", "uvicorn", "main:app",
  "--host", "127.0.0.1",
  "--port", "8000"
) -WorkingDirectory $backend

& $nodeTools.NodeExe $nodeTools.NpmCli --prefix (Join-Path $root "frontend") run dev -- --host 127.0.0.1
