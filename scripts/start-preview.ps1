param(
    [switch]$Restart,
    [switch]$ForcePorts
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$backendDir = Join-Path $root "backend"
$frontendDir = Join-Path $root "frontend"
$backendPython = Join-Path $backendDir ".venv\Scripts\python.exe"
$pidDir = Join-Path $backendDir "preview-pids"
$sessionId = [guid]::NewGuid().ToString("N")
$heartbeatFile = Join-Path $pidDir "preview-heartbeat-$sessionId.txt"
$disconnectFile = Join-Path $pidDir "preview-disconnect-$sessionId.txt"
$rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd("\").ToLowerInvariant()
$apiTokenBytes = [byte[]]::new(32)
$apiTokenRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $apiTokenRng.GetBytes($apiTokenBytes)
}
finally {
    $apiTokenRng.Dispose()
}
$apiToken = -join ($apiTokenBytes | ForEach-Object { $_.ToString("x2") })

New-Item -ItemType Directory -Force -Path $pidDir | Out-Null

function Quote-CmdArg([string]$Value) {
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Test-ExistingFile([string]$Path) {
    return $Path -and [System.IO.Path]::IsPathRooted($Path) -and (Test-Path -LiteralPath $Path -PathType Leaf)
}

function Get-ProcessCommandContext([int]$ProcessId) {
    $lines = @()
    $current = $ProcessId
    for ($i = 0; $i -lt 6 -and $current -gt 0; $i++) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
        if (!$processInfo) {
            break
        }
        if ($processInfo.CommandLine) {
            $lines += [string]$processInfo.CommandLine
        }
        $current = [int]$processInfo.ParentProcessId
    }
    return ($lines -join "`n").ToLowerInvariant()
}

function Test-PreviewProcess([int]$ProcessId, [int]$Port = 0) {
    $context = Get-ProcessCommandContext $ProcessId
    if (!$context -or !$context.Contains($rootFull)) {
        return $false
    }
    if ($Port -eq 8000) {
        return $context -match "uvicorn|folio-backend|\\backend"
    }
    if ($Port -eq 5173) {
        return $context -match "vite|npm-cli|\\frontend"
    }
    return $true
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
        if (Test-PreviewProcess $process.Id) {
            Stop-Process -Id $process.Id -Force
        }
        else {
            Write-Warning "Skipping stale $Name pid $($process.Id); command line does not match this preview."
        }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Stop-PortListener([int]$Port, [switch]$Force) {
    $listeners = netstat -ano | Select-String -Pattern "LISTENING" | Where-Object {
        $_.Line -match "^\s*TCP\s+\S+:$Port\s+"
    }

    foreach ($listener in $listeners) {
        $parts = ($listener.Line.Trim() -split "\s+")
        $processId = [int]$parts[-1]
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            if ($Force -or (Test-PreviewProcess $process.Id $Port)) {
                Stop-Process -Id $process.Id -Force
            }
            else {
                Write-Warning "Skipping process $processId on port $Port; use -ForcePorts to stop unrelated listeners."
            }
        }
    }
}

function Test-HttpOk([string]$Url) {
    try {
        $headers = @{}
        if ($Url -like "*/api/*" -and $apiToken) {
            $headers["X-Folio-Api-Token"] = $apiToken
        }
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $headers -TimeoutSec 2
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
    }
    catch {
        return $false
    }
}

function Test-BackendReady([string]$Url) {
    try {
        $headers = @{ "X-Folio-Api-Token" = $apiToken }
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $headers -TimeoutSec 2
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
            return $false
        }
        $payload = $response.Content | ConvertFrom-Json
        $properties = @($payload.PSObject.Properties.Name)
        return ($properties -contains "active_tts_engine") -and ($properties -contains "tts_engines")
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

function Wait-BackendReady([string]$Url, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Test-BackendReady $Url) {
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

function Reset-LogFile([string]$Path) {
    $parent = Split-Path -Parent $Path
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Set-Content -LiteralPath $Path -Value "" -Encoding UTF8
}

function Test-PythonModule([string]$PythonExe, [string]$ModuleName) {
    if (!$PythonExe) {
        return $false
    }

    try {
        & $PythonExe -c "import $ModuleName" *> $null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

function Resolve-BackendPython {
    $candidates = @()
    if ($env:FOLIO_PYTHON) {
        $candidates += $env:FOLIO_PYTHON
    }
    $candidates += (Join-Path $backendDir ".venv\Scripts\python.exe")
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand -and (Test-ExistingFile $pythonCommand.Source)) {
        $candidates += $pythonCommand.Source
    }

    foreach ($candidate in $candidates) {
        if ((Test-ExistingFile $candidate) -and (Test-PythonModule $candidate "uvicorn")) {
            return $candidate
        }
    }

    throw "Unable to locate a Python runtime with uvicorn. Set FOLIO_PYTHON to a compatible python.exe."
}

function Resolve-NodeCommand {
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

        foreach ($candidate in ($npmCliCandidates | Where-Object { Test-ExistingFile $_ } | Select-Object -Unique)) {
            return [pscustomobject]@{
                NodeExe = $nodeExe
                NpmCli  = $candidate
            }
        }
    }

    throw "Unable to locate node/npm for preview launch. Set FOLIO_NODE and FOLIO_NPM_CLI to compatible paths."
}

if ($Restart) {
    Stop-RecordedProcess "frontend"
    Stop-RecordedProcess "backend"
    Stop-RecordedProcess "watchdog"
    Stop-PortListener 5173 -Force:$ForcePorts
    Stop-PortListener 8000 -Force:$ForcePorts
    Get-ChildItem -Path $pidDir -Filter "preview-heartbeat-*.txt" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $pidDir -Filter "preview-disconnect-*.txt" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
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

$initialBackendReady = Test-BackendReady $localBackendUrl
$initialFrontendReady = Test-HttpOk $localFrontendUrl

if ((!$Restart) -and (!$initialBackendReady -or !$initialFrontendReady)) {
    Stop-RecordedProcess "frontend"
    Stop-RecordedProcess "backend"
    Stop-RecordedProcess "watchdog"
    Stop-PortListener 5173 -Force:$ForcePorts
    Stop-PortListener 8000 -Force:$ForcePorts
    Get-ChildItem -Path $pidDir -Filter "preview-heartbeat-*.txt" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $pidDir -Filter "preview-disconnect-*.txt" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

$backendPython = Resolve-BackendPython

if (!(Test-BackendReady $localBackendUrl)) {
    $backendOut = Join-Path $backendDir "preview-backend.out.log"
    $backendErr = Join-Path $backendDir "preview-backend.err.log"
    Reset-LogFile $backendOut
    Reset-LogFile $backendErr
    $backendCommand = "cd /d $(Quote-CmdArg $backendDir) && set ""FOLIO_API_TOKEN=$apiToken"" && set ""FOLIO_ALLOWED_HOSTS=127.0.0.1,localhost,::1"" && set ""FOLIO_PREVIEW_HEARTBEAT_FILE=$heartbeatFile"" && set ""FOLIO_PREVIEW_DISCONNECT_FILE=$disconnectFile"" && $(Quote-CmdArg $backendPython) -m uvicorn main:app --host 127.0.0.1 --port 8000 >> $(Quote-CmdArg $backendOut) 2>> $(Quote-CmdArg $backendErr)"
    Start-DetachedCmd "backend" $backendCommand
}

if (!(Test-HttpOk $localFrontendUrl)) {
    $frontendOut = Join-Path $frontendDir "preview-vite.out.log"
    $frontendErr = Join-Path $frontendDir "preview-vite.err.log"
    Reset-LogFile $frontendOut
    Reset-LogFile $frontendErr
    $nodeCommand = Resolve-NodeCommand
    $nodeExe = $nodeCommand.NodeExe
    $nodeDir = Split-Path -Parent $nodeExe
    $npmCli = $nodeCommand.NpmCli
    $frontendCommand = "cd /d $(Quote-CmdArg $frontendDir) && set ""PATH=$nodeDir;%PATH%"" && set ""VITE_FOLIO_API_TOKEN=$apiToken"" && set ""VITE_PREVIEW_WATCHDOG=1"" && set ""VITE_PREVIEW_SESSION_ID=$sessionId"" && $(Quote-CmdArg $nodeExe) $(Quote-CmdArg $npmCli) run dev -- --host 0.0.0.0 >> $(Quote-CmdArg $frontendOut) 2>> $(Quote-CmdArg $frontendErr)"
    Start-DetachedCmd "frontend" $frontendCommand
}

$watchdogCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File $(Quote-CmdArg (Join-Path $PSScriptRoot 'preview-watchdog.ps1')) -PidDir $(Quote-CmdArg $pidDir) -HeartbeatFile $(Quote-CmdArg $heartbeatFile) -DisconnectFile $(Quote-CmdArg $disconnectFile) -FrontendPort 5173 -BackendPort 8000 -HeartbeatTimeoutSeconds 180"
Start-DetachedCmd "watchdog" $watchdogCommand

$backendReady = Wait-BackendReady $localBackendUrl 30
$frontendReady = Wait-HttpOk $localFrontendUrl 30

if (!$backendReady -or !$frontendReady) {
    Write-Host "Preview did not become ready."
    Write-Host "Backend ready:  $backendReady"
    Write-Host "Frontend ready: $frontendReady"
    Write-Host "Backend logs:   backend\preview-backend.out.log / backend\preview-backend.err.log"
    Write-Host "Frontend logs:  frontend\preview-vite.out.log / frontend\preview-vite.err.log"
    exit 1
}

Write-Host "Preview ready:"
Write-Host "  Frontend local:   $localFrontendUrl"
Write-Host "  Frontend browser: $browserFrontendUrl"
Write-Host "  Backend:          $localBackendUrl"
Write-Host ""
Write-Host "Open this URL in a browser:"
Write-Host $browserFrontendUrl
