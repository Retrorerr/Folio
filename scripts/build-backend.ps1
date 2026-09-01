$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$dist = Join-Path $root "dist\backend"
$resources = Join-Path $root "src-tauri\resources"
$binResources = Join-Path $resources "bin"
$pythonExe = $env:FOLIO_PYTHON

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

if (-not $pythonExe) {
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
      $pythonExe = $candidate
      break
    }
  }
}

if (-not $pythonExe -or !(Test-ExistingPython $pythonExe) -or !(Test-CompatiblePython $pythonExe)) {
  throw "Unable to locate a Python 3.10-3.13 interpreter. Set FOLIO_PYTHON to a compatible python.exe."
}

# Install backend dependencies for Kokoro and Supertonic local inference.
& (Join-Path $PSScriptRoot "install-backend.ps1") -Python $pythonExe
& $pythonExe -m pip install pyinstaller

if (Test-Path $dist) {
  Remove-Item -Recurse -Force $dist
}

& $pythonExe -m PyInstaller `
  --clean `
  --noconfirm `
  --name folio-backend `
  --version-file (Join-Path $backend "windows-version-info.txt") `
  --distpath $dist `
  --workpath (Join-Path $root "build\pyinstaller") `
  --specpath (Join-Path $root "build") `
  --paths $backend `
  --add-data "$backend\misaki_data;misaki_data" `
  --collect-all kokoro_onnx `
  --collect-submodules supertonic `
  --collect-data supertonic `
  --collect-all espeakng_loader `
  --collect-binaries onnxruntime `
  --collect-submodules huggingface_hub `
  --collect-data huggingface_hub `
  --collect-data language_tags `
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

$distInternal = Join-Path $dist "folio-backend\_internal"
$frozenInternal = Join-Path $binResources "folio-backend\_internal"

function Remove-FolioBundledBackendResidue([string]$InternalDir) {
  if (-not (Test-Path -LiteralPath $InternalDir)) { return }

  $packagedTorch = Join-Path $InternalDir "torch"
  if (Test-Path $packagedTorch) {
    Remove-Item -Recurse -Force $packagedTorch
  }

  $onnxRuntimeCapi = Join-Path $InternalDir "onnxruntime\capi"
  foreach ($providerDll in @("onnxruntime_providers_cuda.dll", "onnxruntime_providers_tensorrt.dll")) {
    $providerPath = Join-Path $onnxRuntimeCapi $providerDll
    if (Test-Path $providerPath) {
      Remove-Item -Force $providerPath
    }
  }

  # PyInstaller's ONNXRuntime helpers are useful for model conversion and
  # optimization, but Folio only needs local CPU inference at runtime. They pull
  # in large transitive tooling such as pandas/openpyxl, so strip them from the
  # sidecar after collection.
  $bundleCleanupRoots = @(
    "onnxruntime\tools",
    "onnxruntime\transformers",
    "pandas",
    "pandas.libs",
    "openpyxl",
    "openpyxl-*.dist-info",
    "pandas-*.dist-info",
    "et_xmlfile",
    "et_xmlfile-*.dist-info"
  )
  foreach ($relative in $bundleCleanupRoots) {
    if ($relative.Contains("\")) {
      $candidate = Join-Path $InternalDir $relative
      $matches = @(Get-Item -LiteralPath $candidate -ErrorAction SilentlyContinue)
    } else {
      $candidate = Join-Path $InternalDir $relative
      $matches = @(Get-ChildItem -Path $candidate -Force -ErrorAction SilentlyContinue)
    }
    foreach ($match in $matches) {
      if ($match -and (Test-Path -LiteralPath $match.FullName)) {
        Remove-Item -LiteralPath $match.FullName -Recurse -Force
      }
    }
  }
}

function Compress-FolioBabelLocaleData([string]$InternalDir) {
  if (-not (Test-Path -LiteralPath $InternalDir)) { return }

  $localeDir = Join-Path $InternalDir "babel\locale-data"
  if (-not (Test-Path -LiteralPath $localeDir)) { return }

  # Folio's packaged backend uses English UI/runtime messages. PyInstaller
  # pulls every Babel locale through transitive dependencies, so keep the
  # English/root locale data and remove the rest from the sidecar.
  $keepLocales = @(
    "root.dat",
    "en.dat",
    "en_001.dat",
    "en_150.dat",
    "en_GB.dat",
    "en_US.dat",
    "LICENSE.unicode"
  )

  Get-ChildItem -LiteralPath $localeDir -File -Filter "*.dat" -Force |
    Where-Object { $keepLocales -notcontains $_.Name } |
    Remove-Item -Force
}

Remove-FolioBundledBackendResidue $distInternal
Remove-FolioBundledBackendResidue $frozenInternal
Compress-FolioBabelLocaleData $distInternal
Compress-FolioBabelLocaleData $frozenInternal
