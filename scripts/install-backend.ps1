param(
  [string]$Python = $env:FOLIO_PYTHON
)

$ErrorActionPreference = "Stop"

# Backend install. The default requirements are CPU-safe for ordinary Windows
# PCs. GPU users can separately install backend\requirements-gpu.txt after this
# succeeds. Override Python with $env:FOLIO_PYTHON or pass -Python.

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"

if (-not $Python) {
  $pythonCandidates = @(
    (Join-Path $backend ".venv\Scripts\python.exe"),
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"),
    "python"
  )
  foreach ($candidate in $pythonCandidates) {
    if ($candidate -eq "python" -or (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $Python = $candidate
      break
    }
  }
}

Write-Host "Using Python: $Python"

& $Python -m pip install -r (Join-Path $backend "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Backend requirements install failed" }

# Cheap post-install sanity check. This verifies Supertonic/Kokoro runtime
# imports without downloading or loading model weights.
& $Python -c "import onnxruntime as ort; import supertonic, huggingface_hub, soundfile; print('tts deps OK; providers=', ort.get_available_providers())"
if ($LASTEXITCODE -ne 0) { throw "Post-install import check failed" }

Write-Host "Backend dependencies installed successfully."
