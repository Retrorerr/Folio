param(
  [string[]]$Targets = @(),
  [string[]]$Artifacts = @(),
  [string]$CorrespondingSource,
  [switch]$SkipShared,
  [switch]$RequireRelease
)

$ErrorActionPreference = 'Stop'

function Require-Command([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "Required command is missing: $Name" }
  return $command.Source
}

function Test-RegularNonEmptyFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  return $item.Length -gt 0 -and -not (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-Elf16K([string]$Path, [string]$ReadElf) {
  $headers = & $ReadElf -lW $Path 2>&1
  if ($LASTEXITCODE -ne 0) { throw "llvm-readelf failed for $Path`n$($headers -join "`n")" }
  $loadLines = @($headers | Select-String '^\s*LOAD\s')
  if ($loadLines.Count -eq 0) { throw "No ELF LOAD segments were found in $Path" }
  foreach ($line in $loadLines) {
    $alignmentText = (($line.Line.Trim() -split '\s+')[-1]).ToLowerInvariant()
    if ($alignmentText -notmatch '^0x[0-9a-f]+$') { throw "Could not parse ELF alignment '$alignmentText' in $Path" }
    $alignment = [Convert]::ToInt64($alignmentText.Substring(2), 16)
    if ($alignment -lt 16384) { throw "ELF LOAD alignment is $alignmentText, not 0x4000 or greater: $Path" }
  }
}

function Get-ZipEntrySha256($Entry) {
  $stream = $Entry.Open()
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
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

function Get-CanonicalTextSha256([string]$Text) {
  $normalized = $Text.Replace("`r`n", "`n").Replace("`r", "`n")
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($normalized)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-FileCanonicalTextSha256([string]$Path) {
  $encoding = [Text.UTF8Encoding]::new($false, $true)
  return (Get-CanonicalTextSha256 ([IO.File]::ReadAllText($Path, $encoding)))
}

function Get-ZipEntryCanonicalTextSha256($Entry) {
  $stream = $Entry.Open()
  $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $true)
  try {
    return (Get-CanonicalTextSha256 ($reader.ReadToEnd()))
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

function Get-GzipExpandedSha256([string]$Path) {
  $file = [IO.File]::OpenRead($Path)
  $gzip = [IO.Compression.GZipStream]::new($file, [IO.Compression.CompressionMode]::Decompress)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($gzip))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $gzip.Dispose()
    $file.Dispose()
  }
}

function Get-ExpectedArtifactAbis([string]$Path, [hashtable]$TargetInfo, [string[]]$SelectedTargets) {
  $leaf = [IO.Path]::GetFileName($Path)
  if ($Path -match '[\\/]universal(?:Release|Debug)?[\\/]' -or $leaf -match '(?i)-universal-(?:debug|release)\.(?:apk|aab)$') {
    if ($SelectedTargets.Count -gt 0) { return @($SelectedTargets | ForEach-Object { $TargetInfo[$_].Abi }) }
    return @('arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64')
  }
  if ($Path -match '[\\/]arm64(?:Release|Debug)?[\\/]' -or $leaf -match '(?i)-arm64-v8a-(?:debug|release)\.(?:apk|aab)$') { return @('arm64-v8a') }
  if ($Path -match '[\\/]x86_64(?:Release|Debug)?[\\/]' -or $leaf -match '(?i)-x86_64-(?:debug|release)\.(?:apk|aab)$') { return @('x86_64') }
  if ($Path -match '[\\/]x86(?:Release|Debug)?[\\/]' -or $leaf -match '(?i)-x86-(?:debug|release)\.(?:apk|aab)$') { return @('x86') }
  if ($Path -match '[\\/]arm(?:Release|Debug)?[\\/]' -or $leaf -match '(?i)-armeabi-v7a-(?:debug|release)\.(?:apk|aab)$') { return @('armeabi-v7a') }
  throw "Could not infer expected ABI set from artifact path: $Path"
}

if (-not $SkipShared) {
  Write-Host 'Checking the shared frontend and desktop Rust boundary...'
  & npm --prefix frontend run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'Frontend typecheck failed' }
  & npm --prefix frontend run lint
  if ($LASTEXITCODE -ne 0) { throw 'Frontend lint failed' }
  & npm --prefix frontend run build
  if ($LASTEXITCODE -ne 0) { throw 'Frontend production build failed' }
  & cargo check --manifest-path src-tauri/Cargo.toml
  if ($LASTEXITCODE -ne 0) { throw 'Desktop Rust check failed' }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $env:JAVA_HOME) {
  $studioJbr = 'C:\Program Files\Android\Android Studio\jbr'
  if (Test-Path (Join-Path $studioJbr 'bin\java.exe') -PathType Leaf) { $env:JAVA_HOME = $studioJbr }
}
if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
  $defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
  if (Test-Path (Join-Path $defaultSdk 'platform-tools\adb.exe') -PathType Leaf) { $env:ANDROID_SDK_ROOT = $defaultSdk }
}
if (-not $env:NDK_HOME -and ($env:ANDROID_HOME -or $env:ANDROID_SDK_ROOT)) {
  $sdkRoot = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $env:ANDROID_HOME }
  $latestNdk = Get-ChildItem (Join-Path $sdkRoot 'ndk') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if ($latestNdk) { $env:NDK_HOME = $latestNdk.FullName }
}

$missing = @()
if (-not $env:JAVA_HOME) { $missing += 'JAVA_HOME' }
if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) { $missing += 'ANDROID_HOME or ANDROID_SDK_ROOT' }
if (-not $env:NDK_HOME) { $missing += 'NDK_HOME' }
if ($missing.Count -gt 0) {
  Write-Warning ("Android toolchain is not configured in this shell: " + ($missing -join ', '))
  Write-Warning 'See docs/android.md for the setup commands. Shared validation passed.'
  exit 2
}

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $env:ANDROID_HOME }
$ndk = $env:NDK_HOME
$ndkProperties = Join-Path $ndk 'source.properties'
$ndkRevision = if (Test-Path -LiteralPath $ndkProperties) {
  ((Get-Content -LiteralPath $ndkProperties | Select-String '^Pkg.Revision\s*=\s*(.+)$').Matches.Groups[1].Value).Trim()
} else { Split-Path $ndk -Leaf }
$ndkMajor = 0
if (-not [int]::TryParse(($ndkRevision -split '\.')[0], [ref]$ndkMajor) -or $ndkMajor -lt 27) {
  throw "Android NDK r27 or newer is required; found '$ndkRevision'"
}

$buildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory -ErrorAction Stop | Sort-Object Name -Descending | Select-Object -First 1
$zipalign = Join-Path $buildTools.FullName 'zipalign.exe'
$apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
$readelf = Join-Path $ndk 'toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-readelf.exe'
$jarsigner = Join-Path $env:JAVA_HOME 'bin\jarsigner.exe'
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
foreach ($tool in @($zipalign, $apksigner, $readelf, $jarsigner, $keytool)) {
  if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Required Android verification tool is missing: $tool" }
}

$targetInfo = @{
  aarch64 = @{ Rust = 'aarch64-linux-android'; Abi = 'arm64-v8a' }
  armv7   = @{ Rust = 'armv7-linux-androideabi'; Abi = 'armeabi-v7a' }
  i686    = @{ Rust = 'i686-linux-android'; Abi = 'x86' }
  x86_64  = @{ Rust = 'x86_64-linux-android'; Abi = 'x86_64' }
}
$Targets = @($Targets | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
foreach ($target in $Targets) {
  if (-not $targetInfo.ContainsKey($target)) { throw "Unsupported Android target: $target" }
}

$rustup = Require-Command 'rustup'
$installedTargets = @(& $rustup target list --installed)
if ($LASTEXITCODE -ne 0) { throw 'Could not query installed Rust targets' }
foreach ($target in $Targets) {
  if ($installedTargets -notcontains $targetInfo[$target].Rust) {
    throw "Rust Android target is not installed: $($targetInfo[$target].Rust)"
  }

  $rustLibrary = Join-Path $repoRoot "src-tauri\gen\android\app\src\main\jniLibs\$($targetInfo[$target].Abi)\libfolio.so"
  $espeakLibrary = Join-Path $repoRoot "src-tauri\plugins\android\src\main\jniLibs\$($targetInfo[$target].Abi)\libfolio_espeak.so"
  foreach ($library in @($rustLibrary, $espeakLibrary)) {
    if (-not (Test-RegularNonEmptyFile $library)) { throw "Required staged JNI library is absent, empty, or a link: $library" }
    Assert-Elf16K $library $readelf
  }
}

$androidConfig = Get-Content -LiteralPath (Join-Path $repoRoot 'src-tauri\tauri.android.conf.json') -Raw | ConvertFrom-Json
if ($androidConfig.bundle.resources.Count -ne 0) { throw 'Android Tauri config must set bundle.resources to an empty array' }
$generatedResources = Join-Path $repoRoot 'src-tauri\gen\android\app\src\main\assets\resources'
if (Test-Path -LiteralPath $generatedResources) { throw "Generated Android assets still contain desktop resources: $generatedResources" }
foreach ($asset in @(
  'src-tauri\plugins\android\src\main\assets\espeak-ng-data\phondata',
  'src-tauri\plugins\android\src\main\assets\espeak-ng-data\phonindex',
  'src-tauri\plugins\android\src\main\assets\espeak-ng-data\phontab',
  'src-tauri\plugins\android\src\main\assets\ESPEAK_NG_NOTICE.txt',
  'src-tauri\plugins\android\src\main\assets\notices\ESPEAK_NG_GPL-3.0.txt',
  'src-tauri\plugins\android\src\main\assets\notices\ESPEAK_NG_APACHE-2.0.txt',
  'src-tauri\plugins\android\src\main\assets\notices\ESPEAK_NG_BSD-2-Clause.txt',
  'src-tauri\plugins\android\src\main\assets\notices\ESPEAK_NG_UNICODE-DFS-2015.txt',
  'src-tauri\plugins\android\src\main\assets\misaki-en\LICENSE',
  'src-tauri\plugins\android\src\main\assets\misaki-en\NOTICE',
  'src-tauri\plugins\android\src\main\assets\misaki-en\SOURCE.json',
  'src-tauri\plugins\android\src\main\assets\misaki-en\us.lex.gz',
  'src-tauri\plugins\android\src\main\assets\misaki-en\gb.lex.gz'
)) {
  $assetPath = Join-Path $repoRoot $asset
  if (-not (Test-RegularNonEmptyFile $assetPath)) { throw "Required Android asset is missing or empty: $assetPath" }
}
$pinnedAssetHashes = @{
  'notices/ESPEAK_NG_GPL-3.0.txt' = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
  'notices/ESPEAK_NG_APACHE-2.0.txt' = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
  'notices/ESPEAK_NG_BSD-2-Clause.txt' = 'a8b0c1c7d7af6c0415c068be8cf373799d1a42b0707b79dc4ccfcaf593cd902d'
  'notices/ESPEAK_NG_UNICODE-DFS-2015.txt' = 'be029c50df83105a810e391778b6edcb522d6cb4b4e142332aca54437a499bf7'
  'misaki-en/LICENSE' = 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'
  'misaki-en/NOTICE' = '4019b637c2229fbeda72c956c69c685862313093b5964892d2ffd713b1ff3092'
  'misaki-en/SOURCE.json' = '7bcf29e3a84d721af1762bf5453e84f29f14ae00a6b0ea89d5a94d4458cd067c'
  'misaki-en/us.lex.gz' = '0e59e4085aff821089bd015ed436d07f69716ea914a02960a7511ecec48a67d8'
  'misaki-en/gb.lex.gz' = '760714acdb23f5eb2a09e4313c4f9c7d688ea4e2a7af3d266a54f8024743ea8b'
}
$pinnedTextAssets = @(
  'notices/ESPEAK_NG_GPL-3.0.txt',
  'notices/ESPEAK_NG_APACHE-2.0.txt',
  'notices/ESPEAK_NG_BSD-2-Clause.txt',
  'notices/ESPEAK_NG_UNICODE-DFS-2015.txt',
  'misaki-en/LICENSE',
  'misaki-en/NOTICE',
  'misaki-en/SOURCE.json'
)
foreach ($relativeLicense in $pinnedAssetHashes.Keys) {
  $sourceLicense = Join-Path $repoRoot ("src-tauri\plugins\android\src\main\assets\" + $relativeLicense.Replace('/', '\'))
  $actualHash = if ($pinnedTextAssets -contains $relativeLicense) {
    Get-FileCanonicalTextSha256 $sourceLicense
  } else {
    Get-FileSha256 $sourceLicense
  }
  if ($actualHash -ne $pinnedAssetHashes[$relativeLicense]) { throw "Pinned asset hash mismatch: $sourceLicense" }
}
$expandedMisakiHashes = @{}
foreach ($dialect in @('us', 'gb')) {
  $relativeSource = "misaki-en/$dialect.lex.gz"
  $sourceLexicon = Join-Path $repoRoot ("src-tauri\plugins\android\src\main\assets\" + $relativeSource.Replace('/', '\'))
  $expandedMisakiHashes[$relativeSource] = Get-GzipExpandedSha256 $sourceLexicon
}
$misakiSourcePath = Join-Path $repoRoot 'src-tauri\plugins\android\src\main\assets\misaki-en\SOURCE.json'
$misakiSource = Get-Content -LiteralPath $misakiSourcePath -Raw | ConvertFrom-Json
if ($misakiSource.upstream -ne 'https://github.com/hexgrad/misaki' -or
    $misakiSource.upstreamRevision -ne 'fba1236595f2d2bf21d414ba6e57d25256afada3' -or
    $misakiSource.upstreamVersion -ne '0.9.4' -or
    $misakiSource.license -ne 'Apache-2.0') {
  throw "Misaki provenance is not the pinned official 0.9.4 source: $misakiSourcePath"
}

if ($Artifacts.Count -eq 0) {
  $deliveryRoot = Join-Path $repoRoot 'dist\android'
  if (Test-Path -LiteralPath $deliveryRoot) {
    $Artifacts = @(
      Get-ChildItem -LiteralPath $deliveryRoot -Recurse -File |
        Where-Object { $_.Extension -in @('.apk', '.aab') } |
        Select-Object -ExpandProperty FullName
    )
  }
}
$Artifacts = @($Artifacts | ForEach-Object { (Resolve-Path -LiteralPath $_).Path } | Sort-Object -Unique)

if ($RequireRelease) {
  if ($Artifacts.Count -eq 0) { throw 'Release artifact verification was requested, but no APK/AAB files were supplied' }
  $requiredReleaseKinds = @(
    @{ Flavor = 'arm64'; Extension = '.apk' },
    @{ Flavor = 'arm64'; Extension = '.aab' },
    @{ Flavor = 'universal'; Extension = '.apk' },
    @{ Flavor = 'universal'; Extension = '.aab' }
  )
  foreach ($required in $requiredReleaseKinds) {
    $match = @($Artifacts | Where-Object {
      $leaf = [IO.Path]::GetFileName($_)
      $flavorMatch = if ($required.Flavor -eq 'arm64') {
        $_ -match '[\\/]arm64(?:Release)?[\\/]' -or $leaf -match '(?i)-arm64-v8a-release\.(?:apk|aab)$'
      } else {
        $_ -match '[\\/]universal(?:Release)?[\\/]' -or $leaf -match '(?i)-universal-release\.(?:apk|aab)$'
      }
      $flavorMatch -and [IO.Path]::GetExtension($_) -eq $required.Extension
    })
    if ($match.Count -eq 0) { throw "Required signed release artifact is missing: $($required.Flavor)$($required.Extension)" }
  }
  if (-not $CorrespondingSource) { throw 'Release verification requires the deterministic eSpeak NG Corresponding Source archive' }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("folio-android-check-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
  if ($CorrespondingSource) {
    $sourceBundlePath = (Resolve-Path -LiteralPath $CorrespondingSource).Path
    $sourceBundleItem = Get-Item -LiteralPath $sourceBundlePath
    if ($sourceBundleItem.Extension -ne '.zip' -or $sourceBundleItem.Length -le 0) { throw "Corresponding Source archive is missing or empty: $sourceBundlePath" }
    $sourceArchive = [IO.Compression.ZipFile]::OpenRead($sourceBundlePath)
    try {
      $sourceEntries = @($sourceArchive.Entries)
      if ($sourceEntries.Count -lt 2500) { throw "Corresponding Source archive is incomplete: $sourceBundlePath" }
      $sourcePaths = [string[]]@($sourceEntries | ForEach-Object { $_.FullName })
      if (@($sourcePaths | Sort-Object -Unique).Count -ne $sourcePaths.Count) { throw "Corresponding Source archive contains duplicate entry names: $sourceBundlePath" }
      $sortedSourcePaths = [string[]]$sourcePaths.Clone()
      [Array]::Sort($sortedSourcePaths, [StringComparer]::Ordinal)
      for ($index = 0; $index -lt $sourcePaths.Length; $index++) {
        if ($sourcePaths[$index] -ne $sortedSourcePaths[$index]) { throw "Corresponding Source entries are not in deterministic ordinal order: $sourceBundlePath" }
      }
      if (@($sourceEntries | Where-Object { $_.FullName -match '(^|/)\.git/' }).Count -gt 0) {
        throw "Corresponding Source archive contains git metadata: $sourceBundlePath"
      }
      foreach ($entry in $sourceEntries) {
        if ($entry.LastWriteTime.UtcDateTime -ne [DateTime]::new(1980, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)) {
          throw "Corresponding Source entry timestamp is not deterministic: $($entry.FullName)"
        }
      }

      $provenanceEntry = $sourceEntries | Where-Object { $_.FullName.EndsWith('/SOURCE-BUNDLE.json', [StringComparison]::Ordinal) } | Select-Object -First 1
      if (-not $provenanceEntry -or $provenanceEntry.Length -le 0) { throw "Corresponding Source provenance is missing: $sourceBundlePath" }
      $provenanceStream = $provenanceEntry.Open()
      $reader = [IO.StreamReader]::new($provenanceStream, [Text.UTF8Encoding]::new($false), $true)
      try { $sourceProvenance = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose(); $provenanceStream.Dispose() }
      if ($sourceProvenance.upstream.repository -ne 'https://github.com/espeak-ng/espeak-ng.git' -or
          $sourceProvenance.upstream.version -ne '1.52.0' -or
          $sourceProvenance.upstream.revision -ne '4870adfa25b1a32b4361592f1be8a40337c58d6c' -or
          $sourceProvenance.compiledData.provider -ne 'espeakng-loader 0.2.4' -or
          $sourceProvenance.compiledData.treeSha256 -ne '226190a2a2435b64f214f62c18961268e2b4a1dea13cabcc1e82be70bdf081b7' -or
          $sourceProvenance.build.ndkRevision -ne $ndkRevision -or
          [int]$sourceProvenance.build.elfPageSize -ne 16384) {
        throw "Corresponding Source provenance does not match the pinned Android build: $sourceBundlePath"
      }
      $sourceRootPrefix = $provenanceEntry.FullName.Substring(0, $provenanceEntry.FullName.Length - 'SOURCE-BUNDLE.json'.Length)
      $upstreamSourceEntries = @($sourceEntries | Where-Object { $_.FullName.StartsWith("${sourceRootPrefix}upstream/espeak-ng/", [StringComparison]::Ordinal) })
      if ($upstreamSourceEntries.Count -ne 2579) { throw "Corresponding Source archive has $($upstreamSourceEntries.Count) upstream files; expected 2579" }
      $requiredSourceEntries = @{
        "${sourceRootPrefix}upstream/espeak-ng/COPYING" = (Join-Path $repoRoot '.android-build\espeak-ng\source\COPYING')
        "${sourceRootPrefix}upstream/espeak-ng/CMakeLists.txt" = (Join-Path $repoRoot '.android-build\espeak-ng\source\CMakeLists.txt')
        "${sourceRootPrefix}upstream/espeak-ng/src/libespeak-ng/speech.c" = (Join-Path $repoRoot '.android-build\espeak-ng\source\src\libespeak-ng\speech.c')
        "${sourceRootPrefix}folio/src-tauri/plugins/android/src/main/cpp/CMakeLists.txt" = (Join-Path $repoRoot 'src-tauri\plugins\android\src\main\cpp\CMakeLists.txt')
        "${sourceRootPrefix}folio/src-tauri/plugins/android/src/main/cpp/folio_espeak.c" = (Join-Path $repoRoot 'src-tauri\plugins\android\src\main\cpp\folio_espeak.c')
        "${sourceRootPrefix}folio/scripts/build-espeak-android.ps1" = (Join-Path $repoRoot 'scripts\build-espeak-android.ps1')
        "${sourceRootPrefix}folio/scripts/New-AndroidCorrespondingSource.ps1" = (Join-Path $repoRoot 'scripts\New-AndroidCorrespondingSource.ps1')
      }
      foreach ($entryName in $requiredSourceEntries.Keys) {
        $entry = $sourceEntries | Where-Object FullName -eq $entryName | Select-Object -First 1
        if (-not $entry -or $entry.Length -le 0) { throw "Required Corresponding Source file is absent or empty: $entryName" }
        $entryHash = Get-ZipEntrySha256 $entry
        $sourceHash = Get-FileSha256 $requiredSourceEntries[$entryName]
        if ($entryHash -ne $sourceHash) { throw "Corresponding Source file hash mismatch: $entryName" }
      }
    } finally {
      $sourceArchive.Dispose()
    }
    Write-Host "Verified $($sourceBundleItem.Name): deterministic=yes, upstream-files=2579, provenance=pinned"
  }

  $releaseSignerDigests = New-Object System.Collections.Generic.List[string]
  foreach ($artifactPath in $Artifacts) {
    $artifact = Get-Item -LiteralPath $artifactPath
    if ($artifact.Length -le 0) { throw "Android artifact is empty: $artifactPath" }
    $extension = $artifact.Extension.ToLowerInvariant()
    if ($extension -ne '.apk' -and $extension -ne '.aab') { throw "Unsupported Android artifact type: $artifactPath" }
    $isRelease = $artifactPath -match '(?i)release'
    if ($RequireRelease -and -not $isRelease) { throw "Debug artifact was supplied to release verification: $artifactPath" }

    $expectedAbis = @(Get-ExpectedArtifactAbis $artifactPath $targetInfo $Targets)
    $archive = [IO.Compression.ZipFile]::OpenRead($artifactPath)
    try {
      $entries = @($archive.Entries)
      $windowsEntries = @($entries | Where-Object {
        $_.FullName -match '^(?:base/)?assets/resources/' -or
        $_.FullName -match '(?i)\.(?:exe|dll|msi|pdb|bat|cmd|ps1|ico)$'
      })
      if ($windowsEntries.Count -gt 0) {
        throw "Android artifact contains Windows-only resources: $artifactPath`n$($windowsEntries.FullName -join "`n")"
      }

      $prefix = if ($extension -eq '.aab') { 'base/' } else { '' }
      foreach ($assetName in @('phondata', 'phonindex', 'phontab')) {
        $entryName = "${prefix}assets/espeak-ng-data/$assetName"
        $entry = $entries | Where-Object FullName -eq $entryName | Select-Object -First 1
        if (-not $entry -or $entry.Length -le 0) { throw "Required eSpeak NG asset is absent or empty in $artifactPath`: $entryName" }
      }
      $noticeName = "${prefix}assets/ESPEAK_NG_NOTICE.txt"
      $noticeEntry = $entries | Where-Object FullName -eq $noticeName | Select-Object -First 1
      if (-not $noticeEntry -or $noticeEntry.Length -le 0) { throw "eSpeak NG notice is absent or empty in $artifactPath" }
      foreach ($noticeAsset in @(
        'notices/ESPEAK_NG_GPL-3.0.txt',
        'notices/ESPEAK_NG_APACHE-2.0.txt',
        'notices/ESPEAK_NG_BSD-2-Clause.txt',
        'notices/ESPEAK_NG_UNICODE-DFS-2015.txt',
        'misaki-en/LICENSE',
        'misaki-en/NOTICE',
        'misaki-en/SOURCE.json'
      )) {
        $noticeAssetName = "${prefix}assets/$noticeAsset"
        $requiredNoticeEntry = $entries | Where-Object FullName -eq $noticeAssetName | Select-Object -First 1
        if (-not $requiredNoticeEntry -or $requiredNoticeEntry.Length -le 0) {
          throw "Required license/provenance asset is absent or empty in $artifactPath`: $noticeAssetName"
        }
        if ($pinnedAssetHashes.ContainsKey($noticeAsset)) {
          $packagedHash = if ($pinnedTextAssets -contains $noticeAsset) {
            Get-ZipEntryCanonicalTextSha256 $requiredNoticeEntry
          } else {
            Get-ZipEntrySha256 $requiredNoticeEntry
          }
          if ($packagedHash -ne $pinnedAssetHashes[$noticeAsset]) {
            throw "Pinned license/provenance asset hash mismatch in $artifactPath`: $noticeAssetName"
          }
        }
      }
      # AAPT may transparently expand a *.gz asset and remove its suffix. Accept
      # exactly one representation, then verify either the pinned gzip bytes or
      # the bytes obtained by expanding that pinned source asset.
      foreach ($dialect in @('us', 'gb')) {
        $relativeSource = "misaki-en/$dialect.lex.gz"
        $gzipName = "${prefix}assets/$relativeSource"
        $expandedName = "${prefix}assets/misaki-en/$dialect.lex"
        $lexiconEntries = @($entries | Where-Object { $_.FullName -eq $gzipName -or $_.FullName -eq $expandedName })
        if ($lexiconEntries.Count -ne 1 -or $lexiconEntries[0].Length -le 0) {
          throw "Expected exactly one non-empty packaged Misaki $dialect lexicon in $artifactPath ($gzipName or $expandedName)"
        }
        $lexiconEntry = $lexiconEntries[0]
        $expectedHash = if ($lexiconEntry.FullName -eq $gzipName) {
          $pinnedAssetHashes[$relativeSource]
        } else {
          $expandedMisakiHashes[$relativeSource]
        }
        $packagedHash = Get-ZipEntrySha256 $lexiconEntry
        if ($packagedHash -ne $expectedHash) {
          throw "Pinned Misaki lexicon hash mismatch in $artifactPath`: $($lexiconEntry.FullName)"
        }
      }

      foreach ($abi in $expectedAbis) {
        $nativePrefix = "${prefix}lib/$abi/"
        $nativeEntries = @($entries | Where-Object { $_.FullName.StartsWith($nativePrefix, [StringComparison]::Ordinal) -and $_.FullName.EndsWith('.so', [StringComparison]::Ordinal) })
        foreach ($requiredLibrary in @('libfolio.so', 'libfolio_espeak.so', 'libonnxruntime.so', 'libonnxruntime4j_jni.so')) {
          $entryName = "$nativePrefix$requiredLibrary"
          $entry = $nativeEntries | Where-Object FullName -eq $entryName | Select-Object -First 1
          if (-not $entry -or $entry.Length -le 0) { throw "Required $abi library is absent or empty in $artifactPath`: $requiredLibrary" }
        }
        foreach ($entry in $nativeEntries) {
          if ($entry.Length -le 0) { throw "Native library is empty in $artifactPath`: $($entry.FullName)" }
          $safeName = ($entry.FullName -replace '[^A-Za-z0-9_.-]', '_')
          $extracted = Join-Path $tempRoot $safeName
          $input = $entry.Open()
          $output = [IO.File]::Open($extracted, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
          try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
          Assert-Elf16K $extracted $readelf
        }
      }
    } finally {
      $archive.Dispose()
    }

    if ($extension -eq '.apk') {
      $alignmentOutput = & $zipalign -c -P 16 4 $artifactPath 2>&1
      if ($LASTEXITCODE -ne 0) { throw "APK is not 16 KB archive-aligned: $artifactPath`n$($alignmentOutput -join "`n")" }
      $signingOutput = & $apksigner verify --verbose --print-certs $artifactPath 2>&1
      if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed: $artifactPath`n$($signingOutput -join "`n")" }
      if ($isRelease -and ($signingOutput -join "`n") -match '(?i)Android Debug') {
        throw "Release APK is signed with the Android debug certificate: $artifactPath"
      }
      if ($isRelease) {
        $signerMatch = [regex]::Match(($signingOutput -join "`n"), '(?i)certificate SHA-256 digest:\s*([0-9a-f]{64})')
        if (-not $signerMatch.Success) { throw "Could not parse release APK certificate fingerprint: $artifactPath" }
        $releaseSignerDigests.Add($signerMatch.Groups[1].Value.ToLowerInvariant())
      }
    } else {
      $archive = [IO.Compression.ZipFile]::OpenRead($artifactPath)
      try {
        $signatureBlocks = @($archive.Entries | Where-Object { $_.FullName -match '^META-INF/[^/]+\.(?:RSA|DSA|EC)$' })
        $signatureFiles = @($archive.Entries | Where-Object { $_.FullName -match '^META-INF/[^/]+\.SF$' })
        if ($signatureBlocks.Count -eq 0 -or $signatureFiles.Count -eq 0) { throw "AAB has no JAR signature block: $artifactPath" }
      } finally {
        $archive.Dispose()
      }
      $jarOutput = & $jarsigner -verify $artifactPath 2>&1
      if ($LASTEXITCODE -ne 0 -or ($jarOutput -join "`n") -notmatch '(?i)jar verified') {
        throw "AAB signature verification failed: $artifactPath`n$($jarOutput -join "`n")"
      }
      $certificateOutput = & $keytool -printcert -jarfile $artifactPath 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Could not read AAB signing certificate: $artifactPath" }
      if ($isRelease -and ($certificateOutput -join "`n") -match '(?i)Android Debug') {
        throw "Release AAB is signed with the Android debug certificate: $artifactPath"
      }
      if ($isRelease) {
        $signerMatch = [regex]::Match(($certificateOutput -join "`n"), '(?im)^\s*SHA256:\s*([0-9a-f:]{95})\s*$')
        if (-not $signerMatch.Success) { throw "Could not parse release AAB certificate fingerprint: $artifactPath" }
        $releaseSignerDigests.Add($signerMatch.Groups[1].Value.Replace(':', '').ToLowerInvariant())
      }
    }
    Write-Host "Verified $($artifact.Name): ABIs=$($expectedAbis -join ','), 16KB=yes, signed=yes, desktop-resources=none"
  }
  if ($RequireRelease) {
    $uniqueSigners = @($releaseSignerDigests | Sort-Object -Unique)
    if ($uniqueSigners.Count -ne 1) { throw "Release APK/AAB artifacts do not share one signing identity: $($uniqueSigners -join ', ')" }
    Write-Host "Release signing identity consistent across $($releaseSignerDigests.Count) artifacts: $($uniqueSigners[0])"
  }
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    $fullTemp = [IO.Path]::GetFullPath($tempRoot)
    $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($fullTemp.StartsWith($systemTemp + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $fullTemp -Recurse -Force
    }
  }
}

Write-Host "Android environment verified (NDK $ndkRevision)."
if ($Artifacts.Count -eq 0) {
  Write-Host 'No delivery artifacts were supplied; toolchain, staged libraries, config, and source assets were checked.'
}
