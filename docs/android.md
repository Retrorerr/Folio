# Folio Android

Folio Android is a Tauri 2 app that reuses the React reader while replacing the desktop FastAPI boundary with local TypeScript/Kotlin implementations. The Windows desktop sidecar, updater, resources, and packaging path remain desktop-only.

## Runtime architecture

- EPUB and PDF files are chosen through Android's Storage Access Framework. Folio persists granted document/tree permissions where applicable, validates document metadata, and copies imported content into app-owned storage/IndexedDB so it remains available after process death. Provider/WebView reads are capped at 64 MiB for EPUB and 96 MiB for PDF; EPUB expanded content is capped at 192 MiB, and validated cover images are capped at 8 MiB.
- EPUB parsing uses local ZIP/XML/XHTML handling. PDF parsing and canvas rendering use the bundled PDF.js worker. Reading position, bookmarks, notes, settings, and the local library persist without a loopback server.
- `frontend/src/mobileApi.ts` implements the Android `/api/...` contract locally. Android startup requires the native Tauri bridge; it never falls through to Vite's desktop proxy or `127.0.0.1:8000`.
- `src-tauri/plugins/android` owns SAF access, bounded document/TTS work queues, model-pack installation, ONNX inference, and Media3 playback. The media session service owns audio focus, notification controls, noisy-output handling, and background playback.
- Kokoro uses the pinned official Misaki 0.9.4 English G2P/lexicon data (revision `fba1236595f2d2bf21d414ba6e57d25256afada3`) as its primary US/GB pronunciation path. The bundled eSpeak NG JNI bridge is used only as a per-token out-of-dictionary fallback and for languages that explicitly require it; it is not a universal English phonemizer. Parity tests cover punctuation, contractions, heteronyms, abbreviations, and number/currency forms against the desktop pronunciation contract.
- Kokoro and Supertonic are real local ONNX pipelines. If a model is absent, corrupt, incompatible, or cannot run, the request fails explicitly. Android does not silently substitute the platform `TextToSpeech` service or label fallback audio as the requested engine.

The installed application needs no network access for reading, synthesis, or playback.

## Toolchain setup

Install Android Studio plus SDK Platform 35/36, Platform-Tools, Build-Tools, Command-line Tools, CMake 3.22.1 or newer, and NDK r27 or newer. Folio supplies the explicit flexible-page-size linker flags required by Android's [16 KB page-size guidance](https://developer.android.com/guide/practices/page-sizes) for r27. NDK r28+ is also accepted.

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME = (Get-ChildItem "$env:ANDROID_HOME\ndk" | Sort-Object Name | Select-Object -Last 1).FullName
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm install
npm --prefix frontend install
npm run android:init
```

`src-tauri/gen/android` is generated and ignored. Do not hand-maintain it. `scripts/build-android.ps1` replaces Tauri's Windows symlink step with a verified regular-file copy, rejects zero-byte or stale native outputs, and removes any generated desktop `assets/resources` tree before packaging.

The eSpeak bridge build is reproducible: `scripts/build-espeak-android.ps1` accepts only the official `espeak-ng/espeak-ng` repository at release 1.52.0, commit `4870adfa25b1a32b4361592f1be8a40337c58d6c`, plus the exact compiled 1.52 data payload from `espeakng-loader` 0.2.4 (tree SHA-256 `226190a2a2435b64f214f62c18961268e2b4a1dea13cabcc1e82be70bdf081b7`). It fingerprints the C/CMake inputs, NDK revision, data tree, and copied `.so` before reusing cached output. `FOLIO_ESPEAK_SOURCE` may point to a clean checkout of that exact commit; `FOLIO_ESPEAK_DATA` may point to another copy of that exact compiled data tree.

eSpeak NG is GPL-3.0-or-later. The build packages its GPL text plus upstream Apache/BSD/UCD notices under `assets/notices`. The pinned Misaki-derived lexicons carry their verbatim Apache-2.0 license and machine-readable source/hash provenance under `assets/misaki-en`. Preserve all of those files and applicable source-offer obligations with redistributed builds.

## Debug builds

## Managed Android preview

Use the managed preview entrypoint for normal Android UI and runtime work:

```powershell
npm run android:preview
```

It targets the visible `Folio_API36_Tablet_x86_64` Pixel Tablet AVD, starts it if needed, waits for Android boot, and launches `tauri android dev` against that emulator. React/CSS edits are served by Vite and hot-reload in the running app. Rust/Tauri and Android plugin edits stay under Tauri's watcher and rebuild/restart the app automatically. The wrapper keeps the session alive, relaunches Folio if its process stops, and prints only focused Folio/Tauri/runtime logcat tags.

For a change that needs a real APK rebuild, use:

```powershell
npm run android:preview:native
```

This performs the incremental x86_64 debug build, installs the verified APK with `adb install -r`, force-stops Folio, relaunches `com.folio.reader/.MainActivity`, and keeps the emulator/logcat session alive. It intentionally does not run the complete lint, test, Cargo, Kotlin, and artifact-verification suite; run `npm run android:check` when the implementation is ready for final validation.

Debug APKs are signed automatically with the Android debug certificate. They are for emulator/device QA only and must not be published.

```powershell
# Fast emulator build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-android.ps1 -Debug -Targets x86_64

# Every supported ABI
npm run android:build:debug
```

Verified copies are written to `dist/android/debug`. The build fails unless every requested ABI contains fresh `libfolio.so` and `libfolio_espeak.so`, every shipped ELF LOAD segment is at least `0x4000` aligned, the APK passes `zipalign -c -P 16 4`, signatures verify, required eSpeak/ONNX assets exist, and no Windows binaries/resources are present.

## Release signing

Release builds never create or accept an unsigned APK/AAB. Credentials are read from the process environment by `scripts/android-release-signing.init.gradle`; no password is written to the repository, generated Gradle project, build manifest, or command line. Keep production keys according to Android's [app-signing guidance](https://developer.android.com/studio/publish/app-signing).

Required variables:

```text
FOLIO_ANDROID_KEYSTORE
FOLIO_ANDROID_KEYSTORE_PASSWORD
FOLIO_ANDROID_KEY_ALIAS
FOLIO_ANDROID_KEY_PASSWORD
```

`FOLIO_ANDROID_KEYSTORE_TYPE` is optional (`PKCS12` or `JKS`). The build stops before compilation and lists missing variable names if the configuration is incomplete.

For a local QA-only key, create the keystore outside the repository and let `keytool` prompt for its password:

```powershell
$qaSigningRoot = Join-Path $env:LOCALAPPDATA 'Folio\signing'
New-Item -ItemType Directory -Force -Path $qaSigningRoot | Out-Null
$qaKeystore = Join-Path $qaSigningRoot 'folio-local-qa.p12'
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
  -keystore $qaKeystore -storetype PKCS12 -alias folio-local-qa `
  -keyalg RSA -keysize 4096 -validity 3650 `
  -dname 'CN=Folio Local QA, OU=Development, O=Folio, C=GB'
```

Load the password without putting it in PowerShell history:

```powershell
$secret = Read-Host 'QA keystore password' -AsSecureString
$plainSecret = [Net.NetworkCredential]::new('', $secret).Password
$env:FOLIO_ANDROID_KEYSTORE = $qaKeystore
$env:FOLIO_ANDROID_KEYSTORE_PASSWORD = $plainSecret
$env:FOLIO_ANDROID_KEY_ALIAS = 'folio-local-qa'
$env:FOLIO_ANDROID_KEY_PASSWORD = $plainSecret
$env:FOLIO_ANDROID_KEYSTORE_TYPE = 'PKCS12'
npm run android:build
Remove-Item Env:FOLIO_ANDROID_KEYSTORE_PASSWORD, Env:FOLIO_ANDROID_KEY_PASSWORD
$plainSecret = $null
```

That key and its output are strictly local QA artifacts. Never upload them to Play Console or treat them as production release credentials. The known Folio local-QA certificate (`F0:E9:90:EA:AD:F2:12:AF:AF:1C:73:80:8C:A5:5D:52:AF:E6:C4:86:DF:20:D3:42:F5:FB:BA:B1:C3:76:42:9F`) is recorded in the build manifest as `folio-local-qa-only` with `productionPlayUploadKey: false`. Production publishing must use a separately protected Play upload key, supplied by the team's secret manager/CI with the same environment-variable contract.

The default release build compiles all four ABIs, emits a minified APK for each ABI, and emits signed arm64 plus universal APK/AAB deliverables. It also creates one deterministic `Folio-<version>-espeak-corresponding-source.zip` beside the binaries. That archive contains all 2,579 files from the exact pinned upstream eSpeak checkout, Folio's JNI wrapper/CMake/build scripts, and machine-readable NDK/data/linker provenance. It is not duplicated inside each APK. Verified binary and source-bundle SHA-256 values are recorded in `dist/android/release/build-manifest.json`.

## Validation

```powershell
npm run android:check
```

The default check runs frontend typecheck/lint/build plus desktop `cargo check`, validates NDK/rust targets and staged assets, and verifies any deliverables already in `dist/android`. `build-android.ps1` invokes the artifact-only check automatically after Gradle packaging.

Artifact verification covers:

- requested ABI completeness and non-empty Folio, eSpeak, and ONNX native libraries;
- 16 KB ELF program-header alignment for every packaged `.so`;
- 16 KB APK ZIP alignment;
- APK and AAB signatures, with rejection of a debug certificate on release output;
- required eSpeak data/license assets;
- deterministic pinned eSpeak Corresponding Source content and provenance for release output;
- absence of inherited Windows sidecars, DLLs, executables, scripts, symbols, and icons.

For API 35/36 device QA, install the appropriate APK with `adb install -r`, cold-launch it, clear logcat before each flow, and verify on a true 16 KB emulator image as well as a normal 4 KB image. The API 35/36 reader matrix should cover EPUB/PDF import, relaunch persistence, rotation, process death, both neural engines, media controls, lock/background playback, and output-route changes.

## Local model packs

Large neural weights are not embedded in the APK. On Android, open Settings > Narrator and tap `Download model` for Kokoro or Supertonic 3. Folio downloads the pinned assets over HTTPS, reports progress, verifies every exact size and SHA-256, probes the ONNX contracts, and publishes the result atomically. An interrupted or invalid download never replaces an installed model.

The ZIP workflow below remains an advanced/offline fallback for sideloaded model packs. It rejects any unexpected size or SHA-256 before writing the archive.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\New-AndroidModelPack.ps1 `
  -Engine kokoro `
  -SourceRoot "$env:APPDATA\com.folio.reader\models" `
  -OutputPath "$env:USERPROFILE\Downloads\folio-kokoro-model-pack.zip"

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\New-AndroidModelPack.ps1 `
  -Engine supertonic `
  -SourceRoot 'C:\path\to\pinned\supertonic-assets' `
  -OutputPath "$env:USERPROFILE\Downloads\folio-supertonic-model-pack.zip"
```

Choose `Import pack` from the Android model card to import the resulting ZIP. Installation validates the schema, exact file set, sizes, and hashes, probes the ONNX input/output contracts, and publishes the model directory transactionally. A partial or invalid pack never becomes the active engine.

## Desktop safety

`npm run android:init` only generates the mobile project. It does not replace `src-tauri/src/main.rs`, the Windows FastAPI sidecar resources, updater, or `npm run tauri:build`. Android's platform config explicitly sets `bundle.resources` to an empty array so Windows sidecar binaries cannot leak into APK/AAB output.
