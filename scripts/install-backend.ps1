param(
  [string]$Python = $env:FOLIO_PYTHON
)

$ErrorActionPreference = "Stop"

# Backend install. Chatterbox Turbo now uses the official ONNXRuntime model
# repo directly, so the old chatterbox-tts two-phase/no-deps workaround is gone.
# Override Python with $env:FOLIO_PYTHON or pass -Python.

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"

if (-not $Python) {
  $venvPython = Join-Path $backend ".venv\Scripts\python.exe"
  if (Test-Path $venvPython) {
    $Python = $venvPython
  } else {
    $python313 = Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"
    if (Test-Path $python313) {
      $Python = $python313
    } else {
      $Python = "python"
    }
  }
}

Write-Host "Using Python: $Python"

& $Python -m pip install -r (Join-Path $backend "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Backend requirements install failed" }

# Cheap post-install sanity check. This verifies ONNXRuntime/provider imports
# without downloading or loading Chatterbox weights.
& $Python -c "import onnxruntime as ort; import transformers, huggingface_hub, librosa, soundfile; print('chatterbox onnx deps OK; providers=', ort.get_available_providers())"
if ($LASTEXITCODE -ne 0) { throw "Post-install import check failed" }

Write-Host "Backend dependencies installed successfully."
