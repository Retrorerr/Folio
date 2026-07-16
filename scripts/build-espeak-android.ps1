param(
  [string[]]$Targets = @('aarch64'),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$EspeakVersion = '1.52.0'
$EspeakRevision = '4870adfa25b1a32b4361592f1be8a40337c58d6c'
$EspeakRepository = 'https://github.com/espeak-ng/espeak-ng.git'
$EspeakDataProvider = 'espeakng-loader 0.2.4'
$EspeakDataFingerprint = '226190a2a2435b64f214f62c18961268e2b4a1dea13cabcc1e82be70bdf081b7'

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

function Invoke-Checked([string]$Description, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
}

function Get-FileSha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function Get-TreeFingerprint([string]$Root) {
  $fullRoot = Get-FullPath $Root
  $lines = foreach ($file in (Get-ChildItem -LiteralPath $fullRoot -Recurse -File | Sort-Object FullName)) {
    $relative = $file.FullName.Substring($fullRoot.Length + 1).Replace('\', '/')
    $hash = Get-FileSha256 $file.FullName
    "$relative|$($file.Length)|$hash"
  }
  $payload = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($payload))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Test-NonEmptyFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  return $item.Length -gt 0 -and -not (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$ndk = if ($env:NDK_HOME) { $env:NDK_HOME } else {
  $roots = Get-ChildItem (Join-Path $sdk 'ndk') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
  if ($roots) { $roots[0].FullName } else { $null }
}
$cmakeRoot = Get-ChildItem (Join-Path $sdk 'cmake') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
$cmakeBin = if ($cmakeRoot) { Join-Path $cmakeRoot.FullName 'bin' } else { $null }
$cmake = if ($cmakeBin) { Join-Path $cmakeBin 'cmake.exe' } else { $null }
$ninja = if ($cmakeBin) { Join-Path $cmakeBin 'ninja.exe' } else { $null }

if (-not (Test-Path -LiteralPath $cmake -PathType Leaf) -or -not (Test-Path -LiteralPath $ninja -PathType Leaf)) {
  throw "Android CMake/Ninja is missing under $sdk"
}
if (-not $ndk -or -not (Test-Path (Join-Path $ndk 'build\cmake\android.toolchain.cmake') -PathType Leaf)) {
  throw "Android NDK is missing under $sdk"
}
$ndkProperties = Join-Path $ndk 'source.properties'
$ndkRevision = if (Test-Path -LiteralPath $ndkProperties) {
  ((Get-Content -LiteralPath $ndkProperties | Select-String '^Pkg.Revision\s*=\s*(.+)$').Matches.Groups[1].Value).Trim()
} else { Split-Path $ndk -Leaf }
$ndkMajor = 0
if (-not [int]::TryParse(($ndkRevision -split '\.')[0], [ref]$ndkMajor) -or $ndkMajor -lt 27) {
  throw "Folio requires Android NDK r27 or newer for 16 KB page-size support; found '$ndkRevision' at $ndk"
}

$targetInfo = @{
  aarch64 = @{ Abi = 'arm64-v8a'; Api = '24' }
  armv7   = @{ Abi = 'armeabi-v7a'; Api = '24' }
  i686    = @{ Abi = 'x86'; Api = '24' }
  x86_64  = @{ Abi = 'x86_64'; Api = '24' }
}
$Targets = @($Targets | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
foreach ($target in $Targets) {
  if (-not $targetInfo.ContainsKey($target)) { throw "Unsupported Android target: $target" }
}

$git = (Get-Command git -ErrorAction Stop).Source
$buildRoot = Join-Path $repoRoot '.android-build\espeak-ng'
$defaultSourceRoot = Join-Path $buildRoot 'source'
$sourceRoot = if ($env:FOLIO_ESPEAK_SOURCE) { Get-FullPath $env:FOLIO_ESPEAK_SOURCE } else { $defaultSourceRoot }
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot '.git'))) {
  if ($env:FOLIO_ESPEAK_SOURCE) {
    throw "FOLIO_ESPEAK_SOURCE must be an official git checkout pinned to eSpeak NG $EspeakVersion ($EspeakRevision): $sourceRoot"
  }
  if (Test-Path -LiteralPath $sourceRoot) {
    Remove-SafeDirectory $sourceRoot $buildRoot
  }
  New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
  Invoke-Checked 'eSpeak NG repository initialization' { & $git -C $sourceRoot init --quiet }
  Invoke-Checked 'eSpeak NG origin configuration' { & $git -C $sourceRoot remote add origin $EspeakRepository }
}

$origin = (& $git -C $sourceRoot remote get-url origin 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $origin -notmatch '^(https://github\.com/espeak-ng/espeak-ng(?:\.git)?|git@github\.com:espeak-ng/espeak-ng\.git)$') {
  throw "eSpeak NG source origin is not the official repository: '$origin'"
}

$sourceStatus = @(& $git -C $sourceRoot status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw "Could not verify eSpeak NG source status: $sourceRoot" }
if ($sourceStatus.Count -gt 0) {
  if ($Force -and -not $env:FOLIO_ESPEAK_SOURCE) {
    Remove-SafeDirectory $sourceRoot $buildRoot
    New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
    Invoke-Checked 'eSpeak NG repository initialization' { & $git -C $sourceRoot init --quiet }
    Invoke-Checked 'eSpeak NG origin configuration' { & $git -C $sourceRoot remote add origin $EspeakRepository }
  } else {
    throw "eSpeak NG source has local changes. Use a clean $EspeakRevision checkout or rerun with -Force for the generated default cache."
  }
}

$head = (& $git -C $sourceRoot rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $EspeakRevision) {
  Invoke-Checked "fetching pinned eSpeak NG $EspeakVersion" { & $git -C $sourceRoot fetch --depth 1 origin $EspeakRevision }
  Invoke-Checked "checking out pinned eSpeak NG $EspeakVersion" { & $git -C $sourceRoot checkout --detach --force $EspeakRevision }
}
$verifiedHead = (& $git -C $sourceRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $verifiedHead -ne $EspeakRevision) {
  throw "eSpeak NG checkout verification failed: expected $EspeakRevision, got '$verifiedHead'"
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'CMakeLists.txt') -PathType Leaf)) {
  throw "Pinned eSpeak NG source is incomplete: $sourceRoot"
}

$dataRoot = if ($env:FOLIO_ESPEAK_DATA) { Get-FullPath $env:FOLIO_ESPEAK_DATA } else {
  Join-Path $repoRoot 'backend\.venv\Lib\site-packages\espeakng_loader\espeak-ng-data'
}
foreach ($requiredData in @('phondata', 'phonindex', 'phontab')) {
  $requiredPath = Join-Path $dataRoot $requiredData
  if (-not (Test-NonEmptyFile $requiredPath)) {
    throw "Compiled eSpeak NG data '$requiredData' was not found at $dataRoot. Set FOLIO_ESPEAK_DATA or install the desktop backend dependencies first."
  }
}
$dataFingerprint = Get-TreeFingerprint $dataRoot
if ($dataFingerprint -ne $EspeakDataFingerprint) {
  throw "eSpeak NG data is not the pinned $EspeakDataProvider payload. Expected $EspeakDataFingerprint, got $dataFingerprint at $dataRoot"
}

$pluginRoot = Join-Path $repoRoot 'src-tauri\plugins\android\src\main'
$jniRoot = Join-Path $pluginRoot 'jniLibs'
$assetRoot = Join-Path $pluginRoot 'assets\espeak-ng-data'
$noticeRoot = Join-Path $pluginRoot 'assets\notices'
$cppRoot = Join-Path $pluginRoot 'cpp'
$markerRoot = Join-Path $buildRoot 'markers'
$assetMarker = Join-Path $markerRoot 'assets.json'
$env:Path = "$cmakeBin;$env:Path"
New-Item -ItemType Directory -Force -Path $markerRoot | Out-Null

# Package the exact license set from the verified source revision. COPYING is
# eSpeak NG's GPL-3.0-or-later text; the other files cover bundled source/data
# components in the same upstream release.
New-Item -ItemType Directory -Force -Path $noticeRoot | Out-Null
$licenseFiles = @{
  'COPYING' = 'ESPEAK_NG_GPL-3.0.txt'
  'COPYING.APACHE' = 'ESPEAK_NG_APACHE-2.0.txt'
  'COPYING.BSD2' = 'ESPEAK_NG_BSD-2-Clause.txt'
  'COPYING.UCD' = 'ESPEAK_NG_UNICODE-DFS-2015.txt'
}
foreach ($sourceName in $licenseFiles.Keys) {
  $sourceLicense = Join-Path $sourceRoot $sourceName
  $destinationLicense = Join-Path $noticeRoot $licenseFiles[$sourceName]
  if (-not (Test-NonEmptyFile $sourceLicense)) { throw "Pinned eSpeak NG license file is missing: $sourceLicense" }
  Copy-Item -LiteralPath $sourceLicense -Destination $destinationLicense -Force
  if (-not (Test-NonEmptyFile $destinationLicense)) { throw "Packaged eSpeak NG license file is missing: $destinationLicense" }
  if ((Get-FileSha256 $sourceLicense) -ne (Get-FileSha256 $destinationLicense)) {
    throw "Packaged eSpeak NG license verification failed: $destinationLicense"
  }
}

$assetCurrent = $false
if (-not $Force -and (Test-Path -LiteralPath $assetMarker -PathType Leaf) -and (Test-NonEmptyFile (Join-Path $assetRoot 'phondata'))) {
  try {
    $assetState = Get-Content -LiteralPath $assetMarker -Raw | ConvertFrom-Json
    $assetCurrent = $assetState.dataFingerprint -eq $dataFingerprint -and $assetState.dataProvider -eq $EspeakDataProvider
  } catch {
    $assetCurrent = $false
  }
}
if (-not $assetCurrent) {
  $stagingRoot = Join-Path $buildRoot ("assets-staging-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
  try {
    Copy-Item -Path (Join-Path $dataRoot '*') -Destination $stagingRoot -Recurse -Force
    foreach ($requiredData in @('phondata', 'phonindex', 'phontab')) {
      if (-not (Test-NonEmptyFile (Join-Path $stagingRoot $requiredData))) {
        throw "The staged eSpeak NG assets are incomplete: $requiredData"
      }
    }
    if (Test-Path -LiteralPath $assetRoot) {
      Remove-SafeDirectory $assetRoot (Join-Path $pluginRoot 'assets')
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $assetRoot) | Out-Null
    Move-Item -LiteralPath $stagingRoot -Destination $assetRoot
    @{
      schema = 1
      sourceVersion = $EspeakVersion
      sourceRevision = $EspeakRevision
      dataProvider = $EspeakDataProvider
      dataFingerprint = $dataFingerprint
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $assetMarker -Encoding UTF8
  } finally {
    if (Test-Path -LiteralPath $stagingRoot) { Remove-SafeDirectory $stagingRoot $buildRoot }
  }
}

$cmakeFingerprint = Get-FileSha256 (Join-Path $cppRoot 'CMakeLists.txt')
$bridgeFingerprint = Get-FileSha256 (Join-Path $cppRoot 'folio_espeak.c')
$readelf = Join-Path $ndk 'toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-readelf.exe'
if (-not (Test-Path -LiteralPath $readelf -PathType Leaf)) { throw "llvm-readelf is missing: $readelf" }

foreach ($target in $Targets) {
  $info = $targetInfo[$target]
  $outputDir = Join-Path $buildRoot "bridge-$target"
  $library = Join-Path $outputDir 'libfolio_espeak.so'
  $destinationDir = Join-Path $jniRoot $info.Abi
  $destination = Join-Path $destinationDir 'libfolio_espeak.so'
  $marker = Join-Path $markerRoot "$target.json"
  $fingerprint = "$EspeakRevision|$ndkRevision|$target|$cmakeFingerprint|$bridgeFingerprint"

  $cached = $false
  if (-not $Force -and (Test-NonEmptyFile $destination) -and (Test-Path -LiteralPath $marker -PathType Leaf)) {
    try {
      $state = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
      $destinationHash = Get-FileSha256 $destination
      $cached = $state.fingerprint -eq $fingerprint -and $state.libraryHash -eq $destinationHash
    } catch {
      $cached = $false
    }
  }

  if (-not $cached) {
    if (Test-Path -LiteralPath $outputDir) { Remove-SafeDirectory $outputDir $buildRoot }
    & $cmake -S $cppRoot -B $outputDir -G Ninja `
      "-DCMAKE_MAKE_PROGRAM=$ninja" `
      "-DCMAKE_TOOLCHAIN_FILE=$ndk\build\cmake\android.toolchain.cmake" `
      "-DCMAKE_BUILD_TYPE=Release" `
      "-DANDROID_ABI=$($info.Abi)" `
      "-DANDROID_PLATFORM=android-$($info.Api)" `
      "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON" `
      "-DESPEAK_SOURCE_DIR=$sourceRoot"
    if ($LASTEXITCODE -ne 0) { throw "eSpeak NG CMake configure failed for $target" }
    & $cmake --build $outputDir --target folio_espeak --parallel 4
    if ($LASTEXITCODE -ne 0 -or -not (Test-NonEmptyFile $library)) { throw "eSpeak NG bridge build failed for $target" }

    New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
    if (Test-Path -LiteralPath $destination) {
      $existing = Get-Item -LiteralPath $destination -Force
      if ($existing.PSIsContainer) { throw "JNI destination is unexpectedly a directory: $destination" }
      Remove-Item -LiteralPath $destination -Force
    }
    Copy-Item -LiteralPath $library -Destination $destination -Force
    if (-not (Test-NonEmptyFile $destination)) { throw "Copied eSpeak NG bridge is missing, empty, or a link: $destination" }
    $sourceHash = Get-FileSha256 $library
    $destinationHash = Get-FileSha256 $destination
    if ($sourceHash -ne $destinationHash) { throw "eSpeak NG bridge copy verification failed for $target" }
    @{
      schema = 1
      fingerprint = $fingerprint
      libraryHash = $destinationHash
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $marker -Encoding UTF8
    Write-Host "Built pinned eSpeak NG $EspeakVersion bridge: $destination"
  } else {
    Write-Host "Verified cached eSpeak NG $EspeakVersion bridge: $destination"
  }

  $loadLines = & $readelf -lW $destination | Select-String '^\s*LOAD\s'
  if ($LASTEXITCODE -ne 0 -or -not $loadLines) { throw "Could not inspect ELF program headers: $destination" }
  foreach ($line in $loadLines) {
    $alignmentText = (($line.Line.Trim() -split '\s+')[-1]).ToLowerInvariant()
    $alignment = [Convert]::ToInt64($alignmentText.Substring(2), 16)
    if ($alignment -lt 16384) {
      throw "eSpeak NG bridge is not 16 KB ELF-aligned ($alignmentText): $destination"
    }
  }
}

Write-Host "Pinned eSpeak NG source verified: $EspeakVersion ($EspeakRevision)"
Write-Host "Pinned eSpeak NG data verified: $EspeakDataProvider ($dataFingerprint)"
