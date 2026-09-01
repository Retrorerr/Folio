param(
  [string]$Python = $env:FOLIO_PYTHON
)

$ErrorActionPreference = "Stop"

# Backend install. The default requirements are CPU-safe for ordinary Windows
# PCs. GPU users can separately install backend\requirements-gpu.txt after this
# succeeds. Override Python with $env:FOLIO_PYTHON or pass -Python.

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"

function Test-ExistingPython([string]$Candidate) {
  return $Candidate -eq "python" -or (Test-Path -LiteralPath $Candidate -PathType Leaf)
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

if (-not $Python) {
  $pythonCandidates = @(
    (Join-Path $backend ".venv\Scripts\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python310\python.exe"),
    "python"
  )
  foreach ($candidate in $pythonCandidates) {
    if ((Test-ExistingPython $candidate) -and (Test-CompatiblePython $candidate)) {
      $Python = $candidate
      break
    }
  }
}

if (-not $Python -or !(Test-ExistingPython $Python) -or !(Test-CompatiblePython $Python)) {
  throw "Unable to locate a Python 3.10-3.13 interpreter. Set FOLIO_PYTHON to a compatible python.exe."
}

Write-Host "Using Python: $Python"

& $Python -m pip install -r (Join-Path $backend "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Backend requirements install failed" }

# Cheap post-install sanity check. This verifies Supertonic/Kokoro runtime
# imports without downloading or loading model weights.
& $Python -c "import onnxruntime as ort; import supertonic, huggingface_hub, soundfile; print('tts deps OK; providers=', ort.get_available_providers())"
if ($LASTEXITCODE -ne 0) { throw "Post-install import check failed" }

Write-Host "Backend dependencies installed successfully."
