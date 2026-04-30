$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$dist = Join-Path $root "dist\backend"
$resources = Join-Path $root "src-tauri\resources"
$binResources = Join-Path $resources "bin"
$modelResources = Join-Path $resources "backend\models"
$pythonExe = $env:FOLIO_PYTHON

if (-not $pythonExe) {
  $python313 = Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"
  if (Test-Path $python313) {
    $pythonExe = $python313
  } else {
    $pythonExe = "python"
  }
}

& $pythonExe -m pip install -r (Join-Path $backend "requirements.txt")
& $pythonExe -m pip install pyinstaller

if (Test-Path $dist) {
  Remove-Item -Recurse -Force $dist
}

& $pythonExe -m PyInstaller `
  --clean `
  --noconfirm `
  --onefile `
  --name folio-backend `
  --distpath $dist `
  --workpath (Join-Path $root "build\pyinstaller") `
  --specpath (Join-Path $root "build") `
  --paths $backend `
  --collect-all kokoro_onnx `
  --collect-all espeakng_loader `
  --collect-all onnxruntime `
  --collect-all soundfile `
  --collect-data language_tags `
  (Join-Path $backend "desktop_entry.py")

New-Item -ItemType Directory -Force -Path $binResources | Out-Null
Copy-Item -Force (Join-Path $dist "folio-backend.exe") (Join-Path $binResources "folio-backend.exe")

New-Item -ItemType Directory -Force -Path $modelResources | Out-Null
Copy-Item -Force (Join-Path $backend "models\kokoro-v1.0.onnx") $modelResources
Copy-Item -Force (Join-Path $backend "models\voices-v1.0.bin") $modelResources

$fallback = Join-Path $backend "models\kokoro-v1.0.int8.onnx"
if (Test-Path $fallback) {
  Copy-Item -Force $fallback $modelResources
}
