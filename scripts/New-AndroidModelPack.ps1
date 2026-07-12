param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('kokoro', 'supertonic')]
  [string]$Engine,

  [Parameter(Mandatory = $true)]
  [string]$SourceRoot,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$trusted = @{
  kokoro = @(
    @{ Path = 'kokoro-v1.0.onnx'; Size = 325532387L; Sha256 = '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5' }
    @{ Path = 'voices-v1.0.bin'; Size = 28214398L; Sha256 = 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d' }
  )
  supertonic = @(
    @{ Path = 'onnx/duration_predictor.onnx'; Size = 3700147L; Sha256 = 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db' }
    @{ Path = 'onnx/text_encoder.onnx'; Size = 36416150L; Sha256 = 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff' }
    @{ Path = 'onnx/vector_estimator.onnx'; Size = 256534781L; Sha256 = '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c' }
    @{ Path = 'onnx/vocoder.onnx'; Size = 101424195L; Sha256 = '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba' }
    @{ Path = 'onnx/tts.json'; Size = 8253L; Sha256 = '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09' }
    @{ Path = 'onnx/unicode_indexer.json'; Size = 277676L; Sha256 = '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f' }
    @{ Path = 'voice_styles/F1.json'; Size = 292046L; Sha256 = 'bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2' }
    @{ Path = 'voice_styles/F2.json'; Size = 292423L; Sha256 = '7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6' }
    @{ Path = 'voice_styles/F3.json'; Size = 290794L; Sha256 = '12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab' }
    @{ Path = 'voice_styles/F4.json'; Size = 291808L; Sha256 = 'c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b' }
    @{ Path = 'voice_styles/F5.json'; Size = 291479L; Sha256 = '45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d' }
    @{ Path = 'voice_styles/M1.json'; Size = 291748L; Sha256 = 'e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b' }
    @{ Path = 'voice_styles/M2.json'; Size = 292055L; Sha256 = 'b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50' }
    @{ Path = 'voice_styles/M3.json'; Size = 290198L; Sha256 = 'ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b' }
    @{ Path = 'voice_styles/M4.json'; Size = 291522L; Sha256 = 'ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303' }
    @{ Path = 'voice_styles/M5.json'; Size = 291469L; Sha256 = 'dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2' }
  )
}

$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$output = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $output
if (-not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$records = foreach ($asset in $trusted[$Engine]) {
  $relative = $asset.Path.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $file = Join-Path $source $relative
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "Missing trusted $Engine asset: $($asset.Path)"
  }
  $item = Get-Item -LiteralPath $file
  if ($item.Length -ne $asset.Size) {
    throw "Unexpected size for $($asset.Path): $($item.Length), expected $($asset.Size)"
  }
  $digest = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($digest -ne $asset.Sha256) {
    throw "SHA-256 mismatch for $($asset.Path): $digest"
  }
  [ordered]@{ path = $asset.Path; size = $asset.Size; sha256 = $digest; source = $file }
}

if (Test-Path -LiteralPath $output) {
  Remove-Item -LiteralPath $output -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipTimestamp = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
$stream = [System.IO.File]::Open($output, [System.IO.FileMode]::CreateNew)
try {
  $archive = [System.IO.Compression.ZipArchive]::new(
    $stream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
  )
  try {
    $manifest = [ordered]@{
      schemaVersion = 1
      engine = $Engine
      files = @($records | ForEach-Object {
        [ordered]@{ path = $_.path; size = $_.size; sha256 = $_.sha256 }
      })
    } | ConvertTo-Json -Depth 5
    $manifestEntry = $archive.CreateEntry('manifest.json', [System.IO.Compression.CompressionLevel]::Optimal)
    $manifestEntry.LastWriteTime = $zipTimestamp
    $writer = [System.IO.StreamWriter]::new($manifestEntry.Open(), [System.Text.UTF8Encoding]::new($false))
    try { $writer.Write($manifest) } finally { $writer.Dispose() }

    foreach ($record in $records) {
      $entry = $archive.CreateEntry($record.path, [System.IO.Compression.CompressionLevel]::NoCompression)
      $entry.LastWriteTime = $zipTimestamp
      $input = [System.IO.File]::OpenRead($record.source)
      $entryStream = $entry.Open()
      try { $input.CopyTo($entryStream, 1MB) } finally { $entryStream.Dispose(); $input.Dispose() }
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  $stream.Dispose()
}

$pack = Get-Item -LiteralPath $output
$packHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
Write-Host "Created $Engine model pack: $output"
Write-Host "Size: $($pack.Length) bytes"
Write-Host "SHA-256: $packHash"
