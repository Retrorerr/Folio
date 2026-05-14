param(
    [switch]$Restart
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$backendDir = Join-Path $root "backend"
$frontendDir = Join-Path $root "frontend"
$backendPython = Join-Path $backendDir ".venv\Scripts\python.exe"
$pidDir = Join-Path $backendDir "codex-preview-pids"

if (!(Test-Path $backendPython)) {
    $backendPython = "python"
}

New-Item -ItemType Directory -Force -Path $pidDir | Out-Null

function Quote-CmdArg([string]$Value) {
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Stop-RecordedProcess([string]$Name) {
    $pidFile = Join-Path $pidDir "$Name.pid"
    if (!(Test-Path $pidFile)) {
        return
    }

    $recordedPid = (Get-Content $pidFile -Raw).Trim()
    if (!$recordedPid) {
        return
    }

    $process = Get-Process -Id ([int]$recordedPid) -ErrorAction SilentlyContinue
    if ($process) {
        Stop-Process -Id $process.Id -Force
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Stop-PortListener([int]$Port) {
    $listeners = netstat -ano | Select-String -Pattern "LISTENING" | Where-Object {
        $_.Line -match "^\s*TCP\s+\S+:$Port\s+"
    }

    foreach ($listener in $listeners) {
        $parts = ($listener.Line.Trim() -split "\s+")
        $processId = [int]$parts[-1]
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -Id $process.Id -Force
        }
    }
}

function Test-HttpOk([string]$Url) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    }
    catch {
        return $false
    }
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Test-HttpOk $Url) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Start-DetachedCmd([string]$Name, [string]$Command) {
    $process = Start-Process `
        -FilePath "cmd.exe" `
        -ArgumentList @("/c", $Command) `
        -WindowStyle Hidden `
        -PassThru

    Set-Content -LiteralPath (Join-Path $pidDir "$Name.pid") -Value $process.Id -Encoding ASCII
}

if ($Restart) {
    Stop-RecordedProcess "frontend"
    Stop-RecordedProcess "backend"
    Stop-PortListener 5173
    Stop-PortListener 8000
    Start-Sleep -Seconds 1
}

$localBackendUrl = "http://127.0.0.1:8000/api/status"
$localFrontendUrl = "http://127.0.0.1:5173/"
$lanAddress = (
    ipconfig |
        Select-String -Pattern "IPv4 Address" |
        ForEach-Object { ($_ -split ":\s*", 2)[1].Trim() } |
        Where-Object { $_ -and $_ -notlike "127.*" -and $_ -notlike "10.2.*" } |
        Select-Object -First 1
)
if (!$lanAddress) {
    $lanAddress = "127.0.0.1"
}
$browserFrontendUrl = "http://${lanAddress}:5173/"

if (!(Test-HttpOk $localBackendUrl)) {
    $backendOut = Join-Path $backendDir "codex-preview-backend.out.log"
    $backendErr = Join-Path $backendDir "codex-preview-backend.err.log"
    $backendCommand = "cd /d $(Quote-CmdArg $backendDir) && $(Quote-CmdArg $backendPython) -m uvicorn main:app --host 127.0.0.1 --port 8000 >> $(Quote-CmdArg $backendOut) 2>> $(Quote-CmdArg $backendErr)"
    Start-DetachedCmd "backend" $backendCommand
}

if (!(Test-HttpOk $localFrontendUrl)) {
    $frontendOut = Join-Path $frontendDir "codex-preview-vite.out.log"
    $frontendErr = Join-Path $frontendDir "codex-preview-vite.err.log"
    $frontendCommand = "cd /d $(Quote-CmdArg $frontendDir) && npm.cmd run dev -- --host 0.0.0.0 >> $(Quote-CmdArg $frontendOut) 2>> $(Quote-CmdArg $frontendErr)"
    Start-DetachedCmd "frontend" $frontendCommand
}

$backendReady = Wait-HttpOk $localBackendUrl 30
$frontendReady = Wait-HttpOk $localFrontendUrl 30

if (!$backendReady -or !$frontendReady) {
    Write-Host "Codex preview did not become ready."
    Write-Host "Backend ready:  $backendReady"
    Write-Host "Frontend ready: $frontendReady"
    Write-Host "Backend logs:   backend\codex-preview-backend.out.log / backend\codex-preview-backend.err.log"
    Write-Host "Frontend logs:  frontend\codex-preview-vite.out.log / frontend\codex-preview-vite.err.log"
    exit 1
}

Write-Host "Codex preview ready:"
Write-Host "  Frontend local:   $localFrontendUrl"
Write-Host "  Frontend browser: $browserFrontendUrl"
Write-Host "  Backend:          $localBackendUrl"
Write-Host ""
Write-Host "Open this in the Codex in-app browser:"
Write-Host $browserFrontendUrl
