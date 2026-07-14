param(
  [switch]$Debug,
  [string[]]$Targets = @('aarch64', 'armv7', 'i686', 'x86_64'),
  [switch]$ForceNative
)

$ErrorActionPreference = 'Stop'

function Get-FullPath([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-ChildPath([string]$Path, [string]$Root, [string]$Purpose) {
  $fullPath = Get-FullPath $Path
  $fullRoot = Get-FullPath $Root
  if ($fullPath -eq $fullRoot -or -not $fullPath.StartsWith($fullRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to $Purpose outside the expected root: $fullPath (root: $fullRoot)"
  }
  return $fullPath
}

function Remove-SafeDirectory([string]$Path, [string]$Root) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $checked = Assert-ChildPath $Path $Root 'remove a generated directory'
  Remove-Item -LiteralPath $checked -Recurse -Force
}

function Test-NonEmptyRegularFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  return $item.Length -gt 0 -and -not (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Remove-OldArtifacts([string]$Directory, [string]$Extension) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
  foreach ($file in (Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter "*.$Extension" -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $file.FullName -Force
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$java = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { 'C:\Program Files\Android\Android Studio\jbr' }
$ndk = if ($env:NDK_HOME) { $env:NDK_HOME } else {
  $ndkRoots = Get-ChildItem (Join-Path $sdk 'ndk') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
  if ($ndkRoots) { $ndkRoots[0].FullName } else { $null }
}

if (-not (Test-Path (Join-Path $java 'bin\java.exe') -PathType Leaf)) { throw "JAVA_HOME is not usable: $java" }
if (-not (Test-Path (Join-Path $sdk 'platform-tools\adb.exe') -PathType Leaf)) { throw "Android SDK is not usable: $sdk" }
if (-not $ndk -or -not (Test-Path (Join-Path $ndk 'toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe') -PathType Leaf)) {
  throw "NDK_HOME is not usable: $ndk"
}
$ndkProperties = Join-Path $ndk 'source.properties'
$ndkRevision = if (Test-Path -LiteralPath $ndkProperties) {
  ((Get-Content -LiteralPath $ndkProperties | Select-String '^Pkg.Revision\s*=\s*(.+)$').Matches.Groups[1].Value).Trim()
} else { Split-Path $ndk -Leaf }
$ndkMajor = 0
if (-not [int]::TryParse(($ndkRevision -split '\.')[0], [ref]$ndkMajor) -or $ndkMajor -lt 27) {
  throw "Folio requires Android NDK r27 or newer for 16 KB page-size support; found '$ndkRevision'"
}

$env:JAVA_HOME = $java
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:NDK_HOME = $ndk
$env:Path = "C:\Program Files\nodejs;$env:Path"

$targetInfo = @{
  aarch64 = @{ Rust = 'aarch64-linux-android'; Abi = 'arm64-v8a'; Arch = 'arm64'; Flavor = 'Arm64'; Api = '24' }
  armv7   = @{ Rust = 'armv7-linux-androideabi'; Abi = 'armeabi-v7a'; Arch = 'arm'; Flavor = 'Arm'; Api = '24' }
  i686    = @{ Rust = 'i686-linux-android'; Abi = 'x86'; Arch = 'x86'; Flavor = 'X86'; Api = '24' }
  x86_64  = @{ Rust = 'x86_64-linux-android'; Abi = 'x86_64'; Arch = 'x86_64'; Flavor = 'X86_64'; Api = '24' }
}
$Targets = @($Targets | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($Targets.Count -eq 0) { throw 'At least one Android target is required' }
foreach ($target in $Targets) {
  if (-not $targetInfo.ContainsKey($target)) { throw "Unsupported Android target: $target" }
}
if (-not $Debug) {
  $missingReleaseTargets = @($targetInfo.Keys | Where-Object { $Targets -notcontains $_ })
  if ($missingReleaseTargets.Count -gt 0) {
    throw "Release packaging requires all four ABIs so the universal artifact is complete. Missing targets: $($missingReleaseTargets -join ', ')"
  }
}

$signingInit = Join-Path $repoRoot 'scripts\android-release-signing.init.gradle'
if (-not $Debug) {
  $requiredSigning = @(
    'FOLIO_ANDROID_KEYSTORE',
    'FOLIO_ANDROID_KEYSTORE_PASSWORD',
    'FOLIO_ANDROID_KEY_ALIAS',
    'FOLIO_ANDROID_KEY_PASSWORD'
  )
  $missingSigning = @($requiredSigning | Where-Object { -not [Environment]::GetEnvironmentVariable($_) })
  if ($missingSigning.Count -gt 0) {
    throw "Release signing is required. Set these environment variables outside the repository, then retry: $($missingSigning -join ', '). See docs/android.md."
  }
  if (-not (Test-Path -LiteralPath $env:FOLIO_ANDROID_KEYSTORE -PathType Leaf)) {
    throw "FOLIO_ANDROID_KEYSTORE does not name a readable keystore file: $env:FOLIO_ANDROID_KEYSTORE"
  }
  $env:FOLIO_ANDROID_KEYSTORE = (Resolve-Path -LiteralPath $env:FOLIO_ANDROID_KEYSTORE).Path
  if (-not (Test-Path -LiteralPath $signingInit -PathType Leaf)) { throw "Release signing helper is missing: $signingInit" }
}

$npm = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { throw "npm.cmd was not found at $npm" }
$cargo = (Get-Command cargo -ErrorAction Stop).Source
$androidRoot = Join-Path $repoRoot 'src-tauri\gen\android'
$artifactOutputRoot = Join-Path $repoRoot 'dist\android'

Push-Location $repoRoot
try {
  $env:VITE_FOLIO_PLATFORM = 'android'
  Remove-Item Env:VITE_API_BASE -ErrorAction SilentlyContinue
  & $npm --prefix frontend run build
  if ($LASTEXITCODE -ne 0) { throw 'Android frontend build failed' }

  if (-not (Test-Path (Join-Path $androidRoot 'gradlew.bat') -PathType Leaf)) {
    & $npm exec -- tauri android init --ci
    if ($LASTEXITCODE -ne 0) { throw 'Tauri Android project initialization failed' }
  }

  & (Join-Path $repoRoot 'scripts\sync-android-branding.ps1') -AndroidRoot $androidRoot
  if ($LASTEXITCODE -ne 0) { throw 'Android branding synchronization failed' }

  # Platform config explicitly clears bundle.resources, but older generated
  # projects can retain a copied Windows sidecar tree. Never package it.
  $generatedResources = Join-Path $androidRoot 'app\src\main\assets\resources'
  if (Test-Path -LiteralPath $generatedResources) {
    Remove-SafeDirectory $generatedResources $androidRoot
  }

  $espeakArgs = @{ Targets = $Targets; Force = $ForceNative }
  & (Join-Path $repoRoot 'scripts\build-espeak-android.ps1') @espeakArgs
  if ($LASTEXITCODE -ne 0) { throw 'eSpeak NG Android bridge build failed' }

  $profile = if ($Debug) { 'debug' } else { 'release' }
  $profileName = if ($Debug) { 'Debug' } else { 'Release' }
  $toolchainBin = Join-Path $ndk 'toolchains\llvm\prebuilt\windows-x86_64\bin'

  foreach ($target in $Targets) {
    $info = $targetInfo[$target]
    $cc = switch ($target) {
      'aarch64' { Join-Path $toolchainBin "aarch64-linux-android$($info.Api)-clang.cmd" }
      'armv7' { Join-Path $toolchainBin "armv7a-linux-androideabi$($info.Api)-clang.cmd" }
      'i686' { Join-Path $toolchainBin "i686-linux-android$($info.Api)-clang.cmd" }
      'x86_64' { Join-Path $toolchainBin "x86_64-linux-android$($info.Api)-clang.cmd" }
    }
    if (-not (Test-Path -LiteralPath $cc -PathType Leaf)) { throw "NDK C compiler wrapper is missing: $cc" }

    $env:TARGET_CC = $cc
    $env:AR = Join-Path $toolchainBin 'llvm-ar.exe'
    $env:CC = $cc
    $linkerKey = $info.Rust.ToUpperInvariant().Replace('-', '_')
    Set-Item "Env:CARGO_TARGET_${linkerKey}_LINKER" $cc
    $rustFlagsName = "CARGO_TARGET_${linkerKey}_RUSTFLAGS"
    $pageFlags = '-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384'
    Set-Item "Env:$rustFlagsName" $pageFlags

    $cargoArgs = @(
      'build', '--package', 'folio', '--manifest-path', (Join-Path $repoRoot 'src-tauri\Cargo.toml'),
      '--target', $info.Rust, '--features', 'tauri/custom-protocol', '--lib'
    )
    if (-not $Debug) { $cargoArgs += '--release' }
    & $cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) { throw "Rust Android library build failed for $target" }

    $library = Join-Path $repoRoot "src-tauri\target\$($info.Rust)\$profile\libfolio.so"
    if (-not (Test-NonEmptyRegularFile $library)) { throw "Rust Android library was not produced as a regular, non-empty file: $library" }
    $jniDir = Join-Path $androidRoot "app\src\main\jniLibs\$($info.Abi)"
    $jniLibrary = Join-Path $jniDir 'libfolio.so'
    New-Item -ItemType Directory -Force -Path $jniDir | Out-Null
    if (Test-Path -LiteralPath $jniLibrary) {
      $existing = Get-Item -LiteralPath $jniLibrary -Force
      if ($existing.PSIsContainer) { throw "JNI destination is unexpectedly a directory: $jniLibrary" }
      Remove-Item -LiteralPath $jniLibrary -Force
    }
    Copy-Item -LiteralPath $library -Destination $jniLibrary -Force
    if (-not (Test-NonEmptyRegularFile $jniLibrary)) { throw "JNI library copy is empty or still a link: $jniLibrary" }
    $sourceHash = (Get-FileHash -LiteralPath $library -Algorithm SHA256).Hash
    $copiedHash = (Get-FileHash -LiteralPath $jniLibrary -Algorithm SHA256).Hash
    if ($sourceHash -ne $copiedHash) { throw "JNI library copy verification failed for $target" }
  }

  $gradleTasks = @()
  if ($Debug) {
    foreach ($target in $Targets) {
      $gradleTasks += "assemble$($targetInfo[$target].Flavor)Debug"
      Remove-OldArtifacts (Join-Path $androidRoot "app\build\outputs\apk\$($targetInfo[$target].Arch)\debug") 'apk'
    }
  } else {
    foreach ($target in $Targets) {
      $gradleTasks += "assemble$($targetInfo[$target].Flavor)Release"
      Remove-OldArtifacts (Join-Path $androidRoot "app\build\outputs\apk\$($targetInfo[$target].Arch)\release") 'apk'
    }
    $gradleTasks += @('bundleArm64Release', 'assembleUniversalRelease', 'bundleUniversalRelease')
    Remove-OldArtifacts (Join-Path $androidRoot 'app\build\outputs\bundle\arm64Release') 'aab'
    Remove-OldArtifacts (Join-Path $androidRoot 'app\build\outputs\apk\universal\release') 'apk'
    Remove-OldArtifacts (Join-Path $androidRoot 'app\build\outputs\bundle\universalRelease') 'aab'
  }

  $targetList = $Targets -join ','
  $archList = (($Targets | ForEach-Object { $targetInfo[$_].Arch }) -join ',')
  $abiList = (($Targets | ForEach-Object { $targetInfo[$_].Abi }) -join ',')
  $gradleArgs = @($gradleTasks)
  $gradleArgs += @("-PtargetList=$targetList", "-ParchList=$archList", "-PabiList=$abiList")
  foreach ($target in $Targets) {
    $gradleArgs += @('-x', "rustBuild$($targetInfo[$target].Flavor)$profileName")
  }
  if (-not $Debug) {
    $gradleArgs += @('-x', 'rustBuildUniversalRelease', '--init-script', $signingInit)
  }
  $gradleArgs += '--no-daemon'

  Push-Location $androidRoot
  try {
    & (Join-Path $androidRoot 'gradlew.bat') @gradleArgs
    if ($LASTEXITCODE -ne 0) { throw "Gradle Android $profile packaging failed" }
  } finally {
    Pop-Location
  }

  $artifacts = @()
  if ($Debug) {
    foreach ($target in $Targets) {
      $artifacts += Get-ChildItem (Join-Path $androidRoot "app\build\outputs\apk\$($targetInfo[$target].Arch)\debug") -File -Filter '*.apk' -ErrorAction SilentlyContinue
    }
  } else {
    foreach ($target in $Targets) {
      $artifacts += Get-ChildItem (Join-Path $androidRoot "app\build\outputs\apk\$($targetInfo[$target].Arch)\release") -File -Filter '*.apk' -ErrorAction SilentlyContinue
    }
    $artifacts += Get-ChildItem (Join-Path $androidRoot 'app\build\outputs\bundle\arm64Release') -File -Filter '*.aab' -ErrorAction SilentlyContinue
    $artifacts += Get-ChildItem (Join-Path $androidRoot 'app\build\outputs\apk\universal\release') -File -Filter '*.apk' -ErrorAction SilentlyContinue
    $artifacts += Get-ChildItem (Join-Path $androidRoot 'app\build\outputs\bundle\universalRelease') -File -Filter '*.aab' -ErrorAction SilentlyContinue
  }
  $artifacts = @($artifacts | Where-Object { $_ -and $_.Length -gt 0 } | Sort-Object FullName -Unique)
  $requiredArtifactCount = if ($Debug) { $Targets.Count } else { $Targets.Count + 3 }
  if ($artifacts.Count -ne $requiredArtifactCount) {
    throw "Expected $requiredArtifactCount fresh Android artifacts but found $($artifacts.Count) under $androidRoot\app\build\outputs"
  }

  $androidConfig = Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri\tauri.android.conf.json') -Raw | ConvertFrom-Json
  $version = $androidConfig.version
  $correspondingSource = $null
  if (-not $Debug) {
    $sourceStagingRoot = Join-Path $repoRoot '.android-build\release-source'
    $correspondingSource = Join-Path $sourceStagingRoot "Folio-$version-espeak-corresponding-source.zip"
    & (Join-Path $repoRoot 'scripts\New-AndroidCorrespondingSource.ps1') `
      -OutputPath $correspondingSource -AppVersion $version -NdkRevision $ndkRevision
    if ($LASTEXITCODE -ne 0 -or -not (Test-NonEmptyRegularFile $correspondingSource)) {
      throw 'Deterministic eSpeak NG Corresponding Source creation failed'
    }
  }

  $checkArgs = @{
    SkipShared = $true
    Targets = $Targets
    Artifacts = @($artifacts.FullName)
    RequireRelease = (-not $Debug)
  }
  if ($correspondingSource) { $checkArgs.CorrespondingSource = $correspondingSource }
  & (Join-Path $repoRoot 'scripts\check-android.ps1') @checkArgs
  if ($LASTEXITCODE -ne 0) { throw 'Android artifact verification failed' }

  $espeakState = Get-Content -LiteralPath (Join-Path $repoRoot '.android-build\espeak-ng\markers\assets.json') -Raw | ConvertFrom-Json
  $misakiState = Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri\plugins\android\src\main\assets\misaki-en\SOURCE.json') -Raw | ConvertFrom-Json
  $deliveryRoot = Join-Path $artifactOutputRoot $profile
  New-Item -ItemType Directory -Force -Path $deliveryRoot | Out-Null
  $delivered = @()
  foreach ($artifact in $artifacts) {
    $flavor = if ($artifact.FullName -match '[\\/]universal(?:Release)?[\\/]') { 'universal' }
      elseif ($artifact.FullName -match '[\\/]arm64(?:Release)?[\\/]') { 'arm64-v8a' }
      elseif ($artifact.FullName -match '[\\/]x86_64(?:Release)?[\\/]') { 'x86_64' }
      elseif ($artifact.FullName -match '[\\/]x86(?:Release)?[\\/]') { 'x86' }
      elseif ($artifact.FullName -match '[\\/]arm(?:Release)?[\\/]') { 'armeabi-v7a' }
      else { throw "Could not infer Android artifact flavor from $($artifact.FullName)" }
    $extension = $artifact.Extension.TrimStart('.').ToLowerInvariant()
    $destination = Join-Path $deliveryRoot "Folio-$version-$flavor-$profile.$extension"
    Copy-Item -LiteralPath $artifact.FullName -Destination $destination -Force
    if ((Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) {
      throw "Delivered artifact copy verification failed: $destination"
    }
    $delivered += Get-Item -LiteralPath $destination
  }
  $deliveredSource = $null
  if ($correspondingSource) {
    $sourceDestination = Join-Path $deliveryRoot (Split-Path $correspondingSource -Leaf)
    Copy-Item -LiteralPath $correspondingSource -Destination $sourceDestination -Force
    if ((Get-FileHash -LiteralPath $correspondingSource -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $sourceDestination -Algorithm SHA256).Hash) {
      throw "Delivered Corresponding Source copy verification failed: $sourceDestination"
    }
    $deliveredSource = Get-Item -LiteralPath $sourceDestination
  }

  $certificateApk = $delivered | Where-Object Extension -eq '.apk' | Select-Object -First 1
  $latestBuildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object Name -Descending | Select-Object -First 1
  $apksigner = Join-Path $latestBuildTools.FullName 'apksigner.bat'
  $certificateOutput = @(& $apksigner verify --print-certs $certificateApk.FullName 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Could not read delivered APK signing identity: $($certificateApk.FullName)" }
  $digestMatch = [regex]::Match(($certificateOutput -join "`n"), '(?i)certificate SHA-256 digest:\s*([0-9a-f]{64})')
  $dnMatch = [regex]::Match(($certificateOutput -join "`n"), '(?i)certificate DN:\s*(.+)')
  if (-not $digestMatch.Success) { throw "Could not parse delivered APK signing fingerprint: $($certificateApk.FullName)" }
  $certificateDigest = $digestMatch.Groups[1].Value.ToLowerInvariant()
  $localQaDigest = 'f0e990eaadf212afaf1c73808ca55d52afe6c486df20d342f5fbbab1c376429f'
  $signingPurpose = if ($Debug) { 'android-debug-only' } elseif ($certificateDigest -eq $localQaDigest) { 'folio-local-qa-only' } else { 'externally-supplied-release-key' }

  $manifest = @{
    schema = 1
    product = 'Folio'
    version = $version
    profile = $profile
    ndkRevision = $ndkRevision
    targets = $Targets
    createdUtc = [DateTime]::UtcNow.ToString('o')
    signing = @{
      purpose = $signingPurpose
      certificateDn = if ($dnMatch.Success) { $dnMatch.Groups[1].Value.Trim() } else { $null }
      certificateSha256 = $certificateDigest
      productionPlayUploadKey = if ($signingPurpose -eq 'folio-local-qa-only' -or $Debug) { $false } else { $null }
    }
    nativeSources = @{
      espeakNg = @{
        version = $espeakState.sourceVersion
        revision = $espeakState.sourceRevision
        dataProvider = $espeakState.dataProvider
        dataFingerprint = $espeakState.dataFingerprint
      }
      misaki = @{
        version = $misakiState.upstreamVersion
        revision = $misakiState.upstreamRevision
        usSha256 = $misakiState.outputs.'us.lex.gz'.sha256
        gbSha256 = $misakiState.outputs.'gb.lex.gz'.sha256
      }
    }
    artifacts = @($delivered | ForEach-Object {
      @{
        file = $_.Name
        bytes = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    })
  }
  if ($deliveredSource) {
    $manifest['correspondingSource'] = @{
      file = $deliveredSource.Name
      bytes = $deliveredSource.Length
      sha256 = (Get-FileHash -LiteralPath $deliveredSource.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      component = 'eSpeak NG 1.52.0 plus Folio Android JNI glue and build scripts'
    }
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $deliveryRoot 'build-manifest.json') -Encoding UTF8

  Write-Host 'Verified Android artifacts:'
  $delivered | ForEach-Object { Write-Host $_.FullName }
  if ($deliveredSource) { Write-Host $deliveredSource.FullName }
} finally {
  Pop-Location
}
