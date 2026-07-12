param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$AppVersion,

  [Parameter(Mandatory = $true)]
  [string]$NdkRevision
)

$ErrorActionPreference = 'Stop'

$EspeakVersion = '1.52.0'
$EspeakRevision = '4870adfa25b1a32b4361592f1be8a40337c58d6c'
$EspeakRepository = 'https://github.com/espeak-ng/espeak-ng.git'
$EspeakDataProvider = 'espeakng-loader 0.2.4'
$EspeakDataFingerprint = '226190a2a2435b64f214f62c18961268e2b4a1dea13cabcc1e82be70bdf081b7'

function New-SourceRecord([string]$ArchivePath, [string]$SourcePath, [string]$Mode = '100644') {
  if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) { throw "Corresponding source input is missing: $SourcePath" }
  return [pscustomobject]@{
    ArchivePath = $ArchivePath.Replace('\', '/')
    SourcePath = (Resolve-Path -LiteralPath $SourcePath).Path
    Bytes = $null
    Mode = $Mode
  }
}

function Get-ExternalAttributes([string]$Mode) {
  switch ($Mode) {
    '100755' { return [int](0x81ED -shl 16) }
    '120000' { return [int](0xA1FF -shl 16) }
    default { return [int](0x81A4 -shl 16) }
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = Join-Path $repoRoot '.android-build\espeak-ng\source'
$git = (Get-Command git -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot '.git'))) { throw "Pinned eSpeak NG source checkout is missing: $sourceRoot" }
$head = (& $git -C $sourceRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $EspeakRevision) { throw "eSpeak NG source revision is not pinned: expected $EspeakRevision, got '$head'" }
$status = @(& $git -C $sourceRoot status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $status.Count -gt 0) { throw "eSpeak NG source checkout is not clean: $sourceRoot" }

$archiveRoot = "Folio-$AppVersion-espeak-corresponding-source"
$records = New-Object System.Collections.Generic.List[object]
$tracked = @(& $git -C $sourceRoot ls-files -s)
if ($LASTEXITCODE -ne 0 -or $tracked.Count -lt 2000) { throw "Pinned eSpeak NG tracked-source list is incomplete: $sourceRoot" }
foreach ($line in $tracked) {
  if ($line -notmatch '^(\d{6})\s+[0-9a-f]{40}\s+\d+\t(.+)$') { throw "Could not parse eSpeak NG tracked source record: $line" }
  $mode = $Matches[1]
  $relative = $Matches[2]
  $sourceFile = Join-Path $sourceRoot $relative.Replace('/', '\')
  $records.Add((New-SourceRecord "$archiveRoot/upstream/espeak-ng/$relative" $sourceFile $mode))
}

$folioFiles = @(
  'docs/android.md',
  'scripts/build-android.ps1',
  'scripts/build-espeak-android.ps1',
  'scripts/check-android.ps1',
  'scripts/New-AndroidCorrespondingSource.ps1',
  'src-tauri/plugins/android/src/main/assets/ESPEAK_NG_NOTICE.txt',
  'src-tauri/plugins/android/src/main/cpp/CMakeLists.txt',
  'src-tauri/plugins/android/src/main/cpp/folio_espeak.c',
  'src-tauri/plugins/android/src/main/java/EspeakPhonemizer.kt'
)
foreach ($relative in $folioFiles) {
  $records.Add((New-SourceRecord "$archiveRoot/folio/$relative" (Join-Path $repoRoot $relative.Replace('/', '\'))))
}

$provenance = [ordered]@{
  schemaVersion = 1
  component = 'eSpeak NG Android JNI bridge'
  appVersion = $AppVersion
  upstream = [ordered]@{
    repository = $EspeakRepository
    version = $EspeakVersion
    revision = $EspeakRevision
  }
  compiledData = [ordered]@{
    provider = $EspeakDataProvider
    treeSha256 = $EspeakDataFingerprint
  }
  build = [ordered]@{
    ndkRevision = $NdkRevision
    androidMinApi = 24
    elfPageSize = 16384
    linkerFlags = @('-Wl,-z,max-page-size=16384', '-Wl,-z,common-page-size=16384')
    entrypoint = 'folio/scripts/build-espeak-android.ps1'
  }
  layout = [ordered]@{
    upstreamSource = 'upstream/espeak-ng/'
    folioGlueAndBuild = 'folio/'
  }
}
$provenanceBytes = [Text.UTF8Encoding]::new($false).GetBytes(($provenance | ConvertTo-Json -Depth 6 -Compress))
$records.Add([pscustomobject]@{
  ArchivePath = "$archiveRoot/SOURCE-BUNDLE.json"
  SourcePath = $null
  Bytes = $provenanceBytes
  Mode = '100644'
})

$recordsByPath = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
foreach ($record in $records) { $recordsByPath.Add($record.ArchivePath, $record) }
$sortKeys = [string[]]@($recordsByPath.Keys | ForEach-Object { $_ })
[Array]::Sort($sortKeys, [StringComparer]::Ordinal)
$recordArray = [object[]]@($sortKeys | ForEach-Object { $recordsByPath[$_] })

$output = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $output
if (-not (Test-Path -LiteralPath $outputDirectory)) { New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null }
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fixedTimestamp = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
$stream = [IO.File]::Open($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($record in $recordArray) {
      $entry = $archive.CreateEntry($record.ArchivePath, [IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = $fixedTimestamp
      $entry.ExternalAttributes = Get-ExternalAttributes $record.Mode
      $entryStream = $entry.Open()
      try {
        if ($null -ne $record.Bytes) {
          $entryStream.Write($record.Bytes, 0, $record.Bytes.Length)
        } else {
          $input = [IO.File]::OpenRead($record.SourcePath)
          try { $input.CopyTo($entryStream, 1MB) } finally { $input.Dispose() }
        }
      } finally {
        $entryStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  $stream.Dispose()
}

$bundle = Get-Item -LiteralPath $output
if ($bundle.Length -le 0) { throw "Corresponding source archive is empty: $output" }
Write-Host "Created deterministic eSpeak NG Corresponding Source: $output"
Write-Host "Tracked upstream files: $($tracked.Count)"
Write-Host "SHA-256: $((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash)"
