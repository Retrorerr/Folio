param(
    [switch]$SkipInstall,
    [switch]$LintOnly
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$venv = Join-Path $backend ".venv"
$python = Join-Path $venv "Scripts\python.exe"

function Test-ExistingFile([string]$Path) {
    return $Path -and [System.IO.Path]::IsPathRooted($Path) -and (Test-Path -LiteralPath $Path -PathType Leaf)
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
    $version = Get-PythonMajorMinor $PythonExe
    return $version -match "^3\.(10|11|12|13)$"
}

$seedPython = $env:FOLIO_PYTHON
if (!(Test-ExistingFile $seedPython)) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        $seedPython = $pythonCommand.Source
    }
}
if (!(Test-ExistingFile $seedPython) -or !(Test-CompatiblePython $seedPython)) {
    throw "Unable to locate a Python 3.10-3.13 interpreter. Set FOLIO_PYTHON to a compatible python.exe."
}

if ((Test-Path -LiteralPath $python -PathType Leaf) -and !(Test-CompatiblePython $python)) {
    $resolvedVenv = [System.IO.Path]::GetFullPath($venv)
    $resolvedBackend = [System.IO.Path]::GetFullPath($backend)
    if (!$resolvedVenv.StartsWith($resolvedBackend, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove venv outside backend directory: $resolvedVenv"
    }
    Remove-Item -LiteralPath $venv -Recurse -Force
}

if (!(Test-Path -LiteralPath $python -PathType Leaf)) {
    & $seedPython -m venv $venv
}

if (!$SkipInstall) {
    & $python -m pip install -r (Join-Path $backend "requirements-dev.txt")
}

& $python -m ruff check $backend
if ($LASTEXITCODE -ne 0 -or $LintOnly) { exit $LASTEXITCODE }

& $python -m pytest (Join-Path $backend "tests")
exit $LASTEXITCODE
