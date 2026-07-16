[CmdletBinding()]
param(
  [string]$AndroidRoot
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $AndroidRoot) { $AndroidRoot = Join-Path $repoRoot 'src-tauri\gen\android' }
$AndroidRoot = [IO.Path]::GetFullPath($AndroidRoot)
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'src-tauri\gen\android'))
if ($AndroidRoot -ne $expectedRoot) {
  throw "Refusing to write Android branding outside the generated project: $AndroidRoot"
}

$mainRoot = Join-Path $AndroidRoot 'app\src\main'
$resRoot = Join-Path $mainRoot 'res'
$manifestPath = Join-Path $mainRoot 'AndroidManifest.xml'
if (-not (Test-Path -LiteralPath $resRoot -PathType Container) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "The generated Android project is incomplete. Run 'npm run android:init' first."
}

$goldLogo = Join-Path $repoRoot 'src-tauri\android\branding\folio-launcher-icon.png'
$monochromeLogo = Join-Path $repoRoot 'src-tauri\android\branding\folio-launcher-monochrome.png'
$appLogo = Join-Path $repoRoot 'frontend\public\folio-icon-gold-splash.png'
$appMonochromeLogo = Join-Path $repoRoot 'frontend\public\folio-monochrome-icon.png'
$mainActivitySource = Join-Path $repoRoot 'src-tauri\android\MainActivity.kt'
foreach ($source in @($goldLogo, $monochromeLogo, $appLogo, $appMonochromeLogo, $mainActivitySource)) {
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Folio branding source is missing: $source" }
}

Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath([Drawing.RectangleF]$Bounds, [float]$Radius) {
  $path = [Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = [Math]::Max(1, $Radius * 2)
  $path.AddArc($Bounds.Left, $Bounds.Top, $diameter, $diameter, 180, 90)
  $path.AddArc($Bounds.Right - $diameter, $Bounds.Top, $diameter, $diameter, 270, 90)
  $path.AddArc($Bounds.Right - $diameter, $Bounds.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Bounds.Left, $Bounds.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Write-BrandedPng(
  [string]$SourcePath,
  [string]$DestinationPath,
  [int]$Size,
  [double]$LogoScale,
  [ValidateSet('transparent', 'rounded', 'round')][string]$Background = 'transparent'
) {
  $directory = Split-Path -Parent $DestinationPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $source = [Drawing.Image]::FromFile($SourcePath)
  $bitmap = [Drawing.Bitmap]::new($Size, $Size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([Drawing.Color]::Transparent)
    $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceOver
    $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality

    if ($Background -ne 'transparent') {
      $brush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 5, 4, 3))
      try {
        if ($Background -eq 'round') {
          $graphics.FillEllipse($brush, 0, 0, $Size, $Size)
        } else {
          $bounds = [Drawing.RectangleF]::new(0, 0, $Size, $Size)
          $path = New-RoundedRectanglePath $bounds ([float]($Size * 0.22))
          try { $graphics.FillPath($brush, $path) } finally { $path.Dispose() }
        }
      } finally {
        $brush.Dispose()
      }
    }

    $logoSize = [Math]::Max(1, [int][Math]::Round($Size * $LogoScale))
    $offset = [int][Math]::Round(($Size - $logoSize) / 2)
    $destination = [Drawing.Rectangle]::new($offset, $offset, $logoSize, $logoSize)
    $graphics.DrawImage($source, $destination, 0, 0, $source.Width, $source.Height, [Drawing.GraphicsUnit]::Pixel)
    $bitmap.Save($DestinationPath, [Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
    $source.Dispose()
  }
}

function Write-Utf8File([string]$Path, [string]$Content) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  Set-Content -LiteralPath $Path -Value $Content -Encoding utf8
}

$densitySizes = [ordered]@{
  mdpi = @{ Legacy = 48; Adaptive = 108 }
  hdpi = @{ Legacy = 72; Adaptive = 162 }
  xhdpi = @{ Legacy = 96; Adaptive = 216 }
  xxhdpi = @{ Legacy = 144; Adaptive = 324 }
  xxxhdpi = @{ Legacy = 192; Adaptive = 432 }
}

foreach ($density in $densitySizes.Keys) {
  $sizes = $densitySizes[$density]
  $directory = Join-Path $resRoot "mipmap-$density"
  Write-BrandedPng $goldLogo (Join-Path $directory 'ic_launcher.png') $sizes.Legacy 0.72 rounded
  Write-BrandedPng $goldLogo (Join-Path $directory 'ic_launcher_round.png') $sizes.Legacy 0.72 round
  Write-BrandedPng $goldLogo (Join-Path $directory 'ic_launcher_foreground.png') $sizes.Adaptive 0.68 transparent
  Write-BrandedPng $monochromeLogo (Join-Path $directory 'ic_launcher_monochrome.png') $sizes.Adaptive 0.68 transparent
  # Android places this bitmap inside its own splash icon mask. A restrained
  # source scale keeps the native mark optically aligned with the 58dp WebView
  # lockup instead of visibly shrinking during hand-off.
  Write-BrandedPng $appLogo (Join-Path $directory 'ic_splash_logo.png') $sizes.Adaptive 0.38 transparent
  Write-BrandedPng $appMonochromeLogo (Join-Path $directory 'ic_splash_logo_monochrome.png') $sizes.Adaptive 0.38 transparent
}

$bootDrawableRoot = Join-Path $resRoot 'drawable-nodpi'
New-Item -ItemType Directory -Force -Path $bootDrawableRoot | Out-Null
Copy-Item -LiteralPath $appLogo -Destination (Join-Path $bootDrawableRoot 'folio_boot_logo.png') -Force
Copy-Item -LiteralPath $appMonochromeLogo -Destination (Join-Path $bootDrawableRoot 'folio_boot_logo_monochrome.png') -Force

$adaptiveIcon = @'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
'@
$themedAdaptiveIcon = @'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
'@
foreach ($name in @('ic_launcher.xml', 'ic_launcher_round.xml')) {
  Write-Utf8File (Join-Path $resRoot "mipmap-anydpi-v26\$name") $adaptiveIcon
  Write-Utf8File (Join-Path $resRoot "mipmap-anydpi-v33\$name") $themedAdaptiveIcon
}

Write-Utf8File (Join-Path $resRoot 'drawable\ic_launcher_background.xml') @'
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:fillColor="#050403" android:pathData="M0,0h108v108h-108z" />
</vector>
'@

$obsoleteForeground = Join-Path $resRoot 'drawable\ic_launcher_foreground.xml'
if (Test-Path -LiteralPath $obsoleteForeground -PathType Leaf) {
  Remove-Item -LiteralPath $obsoleteForeground -Force
}

Write-Utf8File (Join-Path $resRoot 'values\colors.xml') @'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="purple_200">#FFBB86FC</color>
    <color name="purple_500">#FF6200EE</color>
    <color name="purple_700">#FF3700B3</color>
    <color name="teal_200">#FF03DAC5</color>
    <color name="teal_700">#FF018786</color>
    <color name="black">#FF000000</color>
    <color name="white">#FFFFFFFF</color>
    <color name="folio_boot_brand">#FF050403</color>
    <color name="folio_boot_sepia">#FFF3E7CF</color>
</resources>
'@

$theme = @'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.folio" parent="Theme.SplashScreen">
        <item name="windowSplashScreenBackground">@color/folio_boot_brand</item>
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_splash_logo</item>
        <item name="windowSplashScreenAnimationDuration">0</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="postSplashScreenTheme">@style/Theme.Folio.Main</item>
    </style>
    <style name="Theme.Folio.Main" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="android:windowActionModeOverlay">true</item>
        <item name="android:windowNoTitle">true</item>
        <item name="android:windowBackground">@color/folio_boot_brand</item>
        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>
        <item name="android:windowLightStatusBar">true</item>
    </style>
</resources>
'@
$themeV27 = @'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.folio" parent="Theme.SplashScreen">
        <item name="windowSplashScreenBackground">@color/folio_boot_brand</item>
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_splash_logo</item>
        <item name="windowSplashScreenAnimationDuration">0</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:windowLightNavigationBar">false</item>
        <item name="postSplashScreenTheme">@style/Theme.Folio.Main</item>
    </style>
    <style name="Theme.Folio.Main" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="android:windowActionModeOverlay">true</item>
        <item name="android:windowNoTitle">true</item>
        <item name="android:windowBackground">@color/folio_boot_brand</item>
        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>
        <item name="android:windowLightStatusBar">true</item>
        <item name="android:windowLightNavigationBar">true</item>
    </style>
</resources>
'@
Write-Utf8File (Join-Path $resRoot 'values\themes.xml') $theme
# The system splash is a deliberate brand surface, not a guessed reader theme.
# Keep both qualifiers identical so device night mode cannot recolor it.
Write-Utf8File (Join-Path $resRoot 'values-night\themes.xml') $theme
Write-Utf8File (Join-Path $resRoot 'values-v27\themes.xml') $themeV27
Write-Utf8File (Join-Path $resRoot 'values-night-v27\themes.xml') $themeV27

$manifest = Get-Content -LiteralPath $manifestPath -Raw
$manifest = [regex]::Replace(
  $manifest,
  '\s*<!--\s*AndroidTV support\s*-->\s*<uses-feature\s+android:name="android\.software\.leanback"\s+android:required="false"\s*/>',
  ''
)
if ($manifest -notmatch 'android:roundIcon=') {
  $replacement = '$1' + "`r`n        android:roundIcon=`"@mipmap/ic_launcher_round`"`r`n        "
  $manifest = [regex]::Replace($manifest, '(android:icon="@mipmap/ic_launcher"\s*)', $replacement, 1)
  Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding utf8
}

$obsoleteLaunchers = '(?s)\s*<activity\s+[^>]*android:name="\.FolioLaunch(?:LightFamily|DarkFamily|Sepia|Light|Dark|Folio|Blackleaf)Activity".*?</activity>'
$manifest = [regex]::Replace($manifest, $obsoleteLaunchers, '')
$launcherFilterPattern = '(?s)\s*<intent-filter>\s*<action android:name="android\.intent\.action\.MAIN"\s*/>\s*<category android:name="android\.intent\.category\.LAUNCHER"\s*/>.*?</intent-filter>'
$manifest = [regex]::Replace($manifest, $launcherFilterPattern, '')
$mainActivityOpeningPattern = '(?s)<activity\s+[^>]*android:name="\.MainActivity"[^>]*>'
$manifest = [regex]::Replace(
  $manifest,
  $mainActivityOpeningPattern,
  {
    param($match)
    $openingTag = [regex]::Replace($match.Value, '\s+android:theme="[^"]*"', '')
    [regex]::Replace($openingTag, '(android:name="\.MainActivity")', '$1' + "`r`n            android:theme=`"@style/Theme.folio`"", 1)
  },
  1
)
$launcherFilter = @'

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
'@
$mainActivityPattern = '(?s)(<activity\s+[^>]*android:name="\.MainActivity"[^>]*>)(.*?)(</activity>)'
$manifest = [regex]::Replace(
  $manifest,
  $mainActivityPattern,
  { param($match) $match.Groups[1].Value + $match.Groups[2].Value.TrimEnd() + $launcherFilter + "`r`n        " + $match.Groups[3].Value },
  1
)
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding utf8

$activityDestinationRoot = Join-Path $mainRoot 'java\com\folio\reader'
New-Item -ItemType Directory -Force -Path $activityDestinationRoot | Out-Null
Copy-Item -LiteralPath $mainActivitySource -Destination (Join-Path $activityDestinationRoot 'MainActivity.kt') -Force
$obsoleteLauncherDestination = Join-Path $activityDestinationRoot 'FolioLaunchActivity.kt'
if (Test-Path -LiteralPath $obsoleteLauncherDestination -PathType Leaf) {
  Remove-Item -LiteralPath $obsoleteLauncherDestination -Force
}

$appGradlePath = Join-Path $AndroidRoot 'app\build.gradle.kts'
$appGradle = Get-Content -LiteralPath $appGradlePath -Raw
if ($appGradle -notmatch 'androidx\.core:core-splashscreen:') {
  $gradleReplacement = '$1' + "`r`n    implementation(`"androidx.core:core-splashscreen:1.0.1`")"
  $appGradle = [regex]::Replace($appGradle, '(dependencies\s*\{)', $gradleReplacement, 1)
  Set-Content -LiteralPath $appGradlePath -Value $appGradle -Encoding utf8
}

Write-Host 'Android Folio launcher, themed, round, and splash branding synchronized.' -ForegroundColor DarkGray
