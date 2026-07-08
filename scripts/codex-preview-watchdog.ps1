param(
    [Parameter(Mandatory = $true)]
    [string]$PidDir,
    [Parameter(Mandatory = $true)]
    [string]$HeartbeatFile,
    [Parameter(Mandatory = $true)]
    [string]$DisconnectFile,
    [int]$HeartbeatTimeoutSeconds = 12,
    [int]$FrontendPort = 5173,
    [int]$BackendPort = 8000
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$repoRootFull = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd("\").ToLowerInvariant()

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
    if (!$context -or !$context.Contains($repoRootFull)) {
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

function Get-RecordedProcess([string]$Name) {
    $pidFile = Join-Path $PidDir "$Name.pid"
    if (!(Test-Path $pidFile)) {
        return $null
    }
    $recordedPid = (Get-Content $pidFile -Raw).Trim()
    if (!$recordedPid) {
        return $null
    }
    return Get-Process -Id ([int]$recordedPid) -ErrorAction SilentlyContinue
}

function Stop-RecordedProcess([string]$Name) {
    $pidFile = Join-Path $PidDir "$Name.pid"
    $process = Get-RecordedProcess $Name
    if ($process) {
        if (Test-PreviewProcess $process.Id) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
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
            if (Test-PreviewProcess $process.Id $Port) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Cleanup-Preview {
    Stop-RecordedProcess "frontend"
    Stop-RecordedProcess "backend"
    Stop-PortListener $FrontendPort
    Stop-PortListener $BackendPort
    Remove-Item -LiteralPath $HeartbeatFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $DisconnectFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $PidDir "watchdog.pid") -Force -ErrorAction SilentlyContinue
}

$startedAt = Get-Date
while ($true) {
    Start-Sleep -Seconds 2

    $frontend = Get-RecordedProcess "frontend"
    $backend = Get-RecordedProcess "backend"
    if (!$frontend -and !$backend) {
        Cleanup-Preview
        break
    }

    if (Test-Path $DisconnectFile) {
        Cleanup-Preview
        break
    }

    if (!(Test-Path $HeartbeatFile)) {
        if (((Get-Date) - $startedAt).TotalSeconds -gt $HeartbeatTimeoutSeconds) {
            Cleanup-Preview
            break
        }
        continue
    }

    $age = ((Get-Date) - (Get-Item $HeartbeatFile).LastWriteTime).TotalSeconds
    if ($age -gt $HeartbeatTimeoutSeconds) {
        Cleanup-Preview
        break
    }
}
