$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$dist = Join-Path $root "dist\backend"
$resources = Join-Path $root "src-tauri\resources"
$binResources = Join-Path $resources "bin"
$pythonExe = $env:FOLIO_PYTHON

if (-not $pythonExe) {
  $pythonCandidates = @(
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"),
    (Join-Path $backend ".venv\Scripts\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"),
    "python"
  )
  foreach ($candidate in $pythonCandidates) {
    if ($candidate -eq "python" -or (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $pythonExe = $candidate
      break
    }
  }
}

# Install backend dependencies, including the ONNXRuntime Chatterbox adapter.
& (Join-Path $PSScriptRoot "install-backend.ps1") -Python $pythonExe
& $pythonExe -m pip install pyinstaller

if (Test-Path $dist) {
  Remove-Item -Recurse -Force $dist
}

& $pythonExe -m PyInstaller `
  --clean `
  --noconfirm `
  --name folio-backend `
  --distpath $dist `
  --workpath (Join-Path $root "build\pyinstaller") `
  --specpath (Join-Path $root "build") `
  --paths $backend `
  --collect-all kokoro_onnx `
  --collect-all espeakng_loader `
  --collect-all onnxruntime `
  --collect-all soundfile `
  --collect-all librosa `
  --collect-all tokenizers `
  --collect-all huggingface_hub `
  --collect-all perth `
  --collect-data language_tags `
  --collect-data transformers `
  --exclude-module torch `
  --exclude-module torchaudio `
  --exclude-module torchvision `
  --exclude-module triton `
  --hidden-import psutil `
  (Join-Path $backend "desktop_entry.py")

if (Test-Path $binResources) {
  Remove-Item -Recurse -Force $binResources
}
New-Item -ItemType Directory -Force -Path $binResources | Out-Null
Copy-Item -Recurse -Force (Join-Path $dist "folio-backend") $binResources

$frozenInternal = Join-Path $binResources "folio-backend\_internal"
$packagedTorch = Join-Path $frozenInternal "torch"
if (Test-Path $packagedTorch) {
  Remove-Item -Recurse -Force $packagedTorch
}

$onnxRuntimeCapi = Join-Path $frozenInternal "onnxruntime\capi"
foreach ($providerDll in @("onnxruntime_providers_cuda.dll", "onnxruntime_providers_tensorrt.dll")) {
  $providerPath = Join-Path $onnxRuntimeCapi $providerDll
  if (Test-Path $providerPath) {
    Remove-Item -Force $providerPath
  }
}
