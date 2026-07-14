[CmdletBinding()]
param(
  [switch]$Native,
  [string]$AvdName = 'Folio_API36_Tablet_x86_64',
  [string]$DeviceSerial,
  [int]$BootTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sdkRoot = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$adbPath = Join-Path $sdkRoot 'platform-tools\adb.exe'
$emulatorPath = Join-Path $sdkRoot 'emulator\emulator.exe'
$packageName = 'com.folio.reader'
$activityName = "$packageName/.MainActivity"
$script:AdbPath = $adbPath
$script:DeviceSerial = $DeviceSerial
$script:LogcatJob = $null
$script:EmulatorProcess = $null
$script:DevProcess = $null
$script:PreviewHost = $null
$script:LaunchGraceUntil = [DateTime]::UtcNow.AddSeconds(30)

function Assert-Tool([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Name was not found at '$Path'. Set ANDROID_HOME/ANDROID_SDK_ROOT or install the Android SDK component."
  }
}

Assert-Tool $adbPath 'adb'
Assert-Tool $emulatorPath 'Android emulator'

$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$javaHome = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { 'C:\Program Files\Android\Android Studio\jbr' }
if (Test-Path -LiteralPath (Join-Path $javaHome 'bin\java.exe') -PathType Leaf) {
  $env:JAVA_HOME = $javaHome
}

# Tauri's development build invokes Cargo directly instead of going through
# build-android.ps1. Keep its JNI library compatible with Android's 16 KB page
# images as well; otherwise a dev run can overwrite the verified 0x4000-aligned
# libfolio.so with a 0x1000-aligned copy that Android 15 rejects at dlopen.
$androidPageFlags = '-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384'
foreach ($rustTarget in @('X86_64_LINUX_ANDROID', 'AARCH64_LINUX_ANDROID', 'ARMV7_LINUX_ANDROIDEABI', 'I686_LINUX_ANDROID')) {
  $rustFlagsName = "CARGO_TARGET_${rustTarget}_RUSTFLAGS"
  $existingFlags = [Environment]::GetEnvironmentVariable($rustFlagsName, 'Process')
  if ($existingFlags -notmatch 'max-page-size(?:=|,)16384') {
    Set-Item "Env:$rustFlagsName" (($existingFlags, $androidPageFlags | Where-Object { $_ }) -join ' ')
  }
}

. (Join-Path $PSScriptRoot 'resolve-node-tools.ps1')
$nodeTools = Resolve-NodeTools

function Get-ConnectedAndroidSerials {
  foreach ($line in (& $script:AdbPath devices 2>$null)) {
    if ($line -match '^(?<serial>\S+)\s+device(?:\s|$)') {
      $matches.serial
    }
  }
}

function Get-AvdNameForSerial([string]$Serial) {
  ((& $script:AdbPath -s $Serial shell getprop ro.boot.qemu.avd_name 2>$null) | Out-String).Trim()
}

function Find-TargetDevice {
  $serials = @(Get-ConnectedAndroidSerials)
  if ($script:DeviceSerial) {
    if ($serials -contains $script:DeviceSerial) { return $script:DeviceSerial }
    return $null
  }

  foreach ($serial in $serials) {
    if ((Get-AvdNameForSerial $serial) -eq $AvdName) {
      return $serial
    }
  }
  return $null
}

function Start-TargetEmulator {
  $existing = Find-TargetDevice
  if ($existing) {
    $script:DeviceSerial = $existing
    return
  }

  Write-Host "Starting visible Android emulator '$AvdName'..." -ForegroundColor Cyan
  $script:EmulatorProcess = Start-Process `
    -FilePath $emulatorPath `
    -ArgumentList @('-avd', $AvdName, '-netdelay', 'none', '-netspeed', 'full', '-gpu', 'auto') `
    -WorkingDirectory (Split-Path -Parent $emulatorPath) `
    -WindowStyle Normal `
    -PassThru

  $deadline = [DateTime]::UtcNow.AddSeconds($BootTimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $found = Find-TargetDevice
    if ($found) {
      $script:DeviceSerial = $found
      return
    }
    Start-Sleep -Seconds 2
  }

  throw "Timed out waiting for emulator AVD '$AvdName' to appear in adb."
}

function Wait-ForAndroidBoot {
  if (-not $script:DeviceSerial) {
    $script:DeviceSerial = Find-TargetDevice
  }
  if (-not $script:DeviceSerial) {
    throw "The target emulator '$AvdName' is not connected."
  }

  Write-Host "Waiting for Android boot on $script:DeviceSerial..." -ForegroundColor Cyan
  $deadline = [DateTime]::UtcNow.AddSeconds($BootTimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $boot = ((& $script:AdbPath -s $script:DeviceSerial shell getprop sys.boot_completed 2>$null) | Out-String).Trim()
    $deviceBoot = ((& $script:AdbPath -s $script:DeviceSerial shell getprop dev.bootcomplete 2>$null) | Out-String).Trim()
    if ($boot -eq '1' -and $deviceBoot -eq '1') {
      Write-Host "Android is ready on $script:DeviceSerial." -ForegroundColor Green
      return
    }
    Start-Sleep -Seconds 2
  }

  throw "Timed out waiting for Android boot on $script:DeviceSerial."
}

function Test-FolioInstalled {
  $path = ((& $script:AdbPath -s $script:DeviceSerial shell pm path $packageName 2>$null) | Out-String).Trim()
  return $path -match '^package:'
}

function Get-FolioPid {
  $pidText = ((& $script:AdbPath -s $script:DeviceSerial shell pidof -s $packageName 2>$null) | Out-String).Trim()
  if ($pidText -match '^\d+$') { return $pidText }
  return $null
}

function Start-FolioApp {
  if (-not (Test-FolioInstalled)) { return $false }
  & $script:AdbPath -s $script:DeviceSerial shell am start -n $activityName 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

function Get-PreviewHostAddress {
  if ($env:FOLIO_ANDROID_PREVIEW_HOST) {
    return $env:FOLIO_ANDROID_PREVIEW_HOST
  }

  $configuration = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
    Select-Object -First 1)
  if ($configuration -and $configuration.IPv4Address) {
    return $configuration.IPv4Address.IPAddress
  }

  return '127.0.0.1'
}

function Start-FocusedLogcat {
  if ($script:LogcatJob) {
    Stop-Job -Job $script:LogcatJob -ErrorAction SilentlyContinue
    Remove-Job -Job $script:LogcatJob -Force -ErrorAction SilentlyContinue
  }

  & $script:AdbPath -s $script:DeviceSerial logcat -c 2>$null | Out-Null
  $script:LogcatJob = Start-Job -ScriptBlock {
    param($Adb, $Serial)
    & $Adb -s $Serial logcat -v time `
      -s 'Folio:I' 'Tauri:I' 'FolioMobilePlugin:D' 'OnDeviceModelManager:D' 'AndroidRuntime:E' 'WebView:E' '*:S'
  } -ArgumentList $script:AdbPath, $script:DeviceSerial

  Write-Host 'Focused logcat: Folio/Tauri/runtime errors only.' -ForegroundColor DarkGray
}

function Drain-FocusedLogcat {
  if (-not $script:LogcatJob) { return }
  foreach ($line in @(Receive-Job -Job $script:LogcatJob -ErrorAction SilentlyContinue)) {
    Write-Host "[android] $line"
  }
  if ($script:LogcatJob.State -in @('Failed', 'Stopped', 'Completed')) {
    Write-Warning "Focused logcat stopped: $($script:LogcatJob.State)."
    Remove-Job -Job $script:LogcatJob -Force -ErrorAction SilentlyContinue
    $script:LogcatJob = $null
    Start-FocusedLogcat
  }
}

function Invoke-NativeBuild {
  $buildScript = Join-Path $repoRoot 'scripts\build-android.ps1'
  $buildShell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $buildShell) { $buildShell = (Get-Command powershell -ErrorAction Stop).Source }

  Write-Host 'Building incremental x86_64 Android debug APK...' -ForegroundColor Cyan
  & $buildShell -NoProfile -ExecutionPolicy Bypass -File $buildScript -Debug -Targets x86_64
  if ($LASTEXITCODE -ne 0) { throw 'Incremental Android debug build failed.' }

  $apkPath = Join-Path $repoRoot 'dist\android\debug\Folio-0.1.12-x86_64-debug.apk'
  Assert-Tool $apkPath 'Folio debug APK'

  Write-Host "Installing $apkPath..." -ForegroundColor Cyan
  & $script:AdbPath -s $script:DeviceSerial install -r $apkPath
  if ($LASTEXITCODE -ne 0) { throw 'adb install -r failed.' }

  & $script:AdbPath -s $script:DeviceSerial shell am force-stop $packageName | Out-Null
  if (-not (Start-FolioApp)) { throw "Unable to launch $activityName after native install." }
  $script:LaunchGraceUntil = [DateTime]::UtcNow.AddSeconds(15)
  Write-Host 'Native APK installed and Folio relaunched.' -ForegroundColor Green
}

function Start-TauriAndroidDev {
  $watchFolder = Join-Path $repoRoot 'src-tauri\plugins\android'
  $arguments = @(
    ('"' + $nodeTools.NpmCli + '"'),
    '--prefix', ('"' + $repoRoot + '"'),
    'exec', 'tauri', '--',
    # Tauri resolves Android devices by AVD name; adb/logcat use the serial.
    'android', 'dev', $AvdName,
    '--host', $script:PreviewHost,
    '--no-dev-server-wait',
    '--additional-watch-folders', ('"' + $watchFolder + '"')
  )

  Write-Host "Starting Tauri Android dev mode on $script:DeviceSerial..." -ForegroundColor Cyan
  return Start-Process `
    -FilePath $nodeTools.NodeExe `
    -ArgumentList $arguments `
    -WorkingDirectory $repoRoot `
    -NoNewWindow `
    -PassThru
}

function Monitor-Preview([System.Diagnostics.Process]$DevProcess) {
  $missingSince = $null
  $nextAppCheck = [DateTime]::UtcNow

  while ($true) {
    Drain-FocusedLogcat

    if ($DevProcess -and $DevProcess.HasExited) {
      return $DevProcess.ExitCode
    }

    if ([DateTime]::UtcNow -ge $nextAppCheck) {
      $nextAppCheck = [DateTime]::UtcNow.AddSeconds(2)
      $appPid = Get-FolioPid
      if ($appPid) {
        $missingSince = $null
      } elseif ([DateTime]::UtcNow -ge $script:LaunchGraceUntil -and (Test-FolioInstalled)) {
        if (-not $missingSince) { $missingSince = [DateTime]::UtcNow }
        if (([DateTime]::UtcNow - $missingSince).TotalSeconds -ge 10) {
          Write-Warning 'Folio is no longer running; relaunching it.'
          if (Start-FolioApp) {
            Write-Host 'Folio relaunched.' -ForegroundColor Green
          }
          $missingSince = $null
          $script:LaunchGraceUntil = [DateTime]::UtcNow.AddSeconds(8)
        }
      }
    }

    Start-Sleep -Milliseconds 500
  }
}

function Stop-PreviewResources {
  if ($script:LogcatJob) {
    Stop-Job -Job $script:LogcatJob -ErrorAction SilentlyContinue
    Remove-Job -Job $script:LogcatJob -Force -ErrorAction SilentlyContinue
    $script:LogcatJob = $null
  }
  if ($script:DevProcess -and -not $script:DevProcess.HasExited) {
    Stop-Process -Id $script:DevProcess.Id -Force -ErrorAction SilentlyContinue
    $script:DevProcess = $null
  }
}

try {
  Start-TargetEmulator
  Wait-ForAndroidBoot
  $script:PreviewHost = Get-PreviewHostAddress
  Write-Host "Using preview host $script:PreviewHost for the emulator dev server." -ForegroundColor DarkGray
  Start-FocusedLogcat

  if ($Native) {
    Invoke-NativeBuild
    Monitor-Preview $null | Out-Null
  } else {
    $restartDelay = 2
    while ($true) {
      $script:DevProcess = Start-TauriAndroidDev
      $script:LaunchGraceUntil = [DateTime]::UtcNow.AddSeconds(30)
      $exitCode = Monitor-Preview $script:DevProcess
      if ($exitCode -eq 0) {
        Write-Host 'Tauri Android dev process exited; restarting it.' -ForegroundColor Yellow
      } else {
        Write-Warning "Tauri Android dev process exited with code $exitCode; restarting it."
      }
      Start-Sleep -Seconds $restartDelay
      $restartDelay = [Math]::Min($restartDelay + 2, 10)
    }
  }
}
finally {
  Stop-PreviewResources
}
