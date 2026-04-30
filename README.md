# Folio

Folio is a Windows desktop reader for people who like to move between reading and listening without losing the thread.

It opens PDF and EPUB books, remembers where you left off, and uses local Kokoro text-to-speech so a book can become sentence-aware audio without sending the text away from your machine.

## What It Does

- Opens PDF and EPUB files from a polished desktop app.
- Keeps recent books, reading position, bookmarks, and settings.
- Generates local speech with Kokoro ONNX voices.
- Highlights and advances through sentences while audio plays.
- Supports EPUB reflow, PDF page views, full-text search, and chapter navigation.
- Bundles the backend, frontend, and model runtime into a Tauri installer.

## Install

Download the latest Windows installer from GitHub Releases and run it:

```text
Folio_<version>_x64-setup.exe
```

The installer includes the app, backend sidecar, and required model files. The first launch may take a moment while Windows finishes extracting the bundled resources.

Runtime data is stored in your user profile:

```text
%APPDATA%\com.folio.reader
```

That folder holds uploaded books, reading state, generated audio cache, and logs.

## For Developers

### Prerequisites

- Node.js 20+
- Python 3.11+
- Rust and Cargo
- Windows tooling required by Tauri

### Build The App

From the repo root:

```powershell
npm install
npm run tauri:build
```

The build script:

- builds the Python backend sidecar;
- builds the React frontend with the Tauri API base;
- packages the Windows installer with Tauri;
- includes bundled resources from `src-tauri/resources`.

The installer is written to:

```text
src-tauri\target\release\bundle\nsis\
```

## Local Development

Run the Tauri dev workflow:

```powershell
npm run tauri:dev
```

Or run the frontend/backend pieces manually when debugging:

```powershell
cd frontend
npm run dev
```

```powershell
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

## Release Checklist

1. Update the version in:
   - `package.json`
   - `package-lock.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`

2. Build:

```powershell
npm run tauri:build
```

3. Upload the installer from:

```text
src-tauri\target\release\bundle\nsis\Folio_<version>_x64-setup.exe
```

4. Tag the release with the same version, for example:

```text
v0.1.6
```

## Uploading A GitHub Release

Using the GitHub website:

1. Open the repository on GitHub.
2. Go to **Releases**.
3. Click **Draft a new release**.
4. Create or choose a tag such as `v0.1.6`.
5. Use a release title like `Folio 0.1.6`.
6. Attach the `.exe` installer from the Tauri bundle folder.
7. Publish the release.

Using GitHub CLI:

```powershell
gh release create v0.1.6 `
  "src-tauri\target\release\bundle\nsis\Folio_0.1.6_x64-setup.exe" `
  --title "Folio 0.1.6" `
  --notes "Windows desktop installer for Folio 0.1.6."
```

## Updating

Folio includes the Tauri updater plugin and a Settings button for checking updates. The app-side wiring is present, but automatic updates need a published signed updater manifest in the GitHub release channel before they can fully work.

Until that release manifest is published, update by installing the newer `.exe` from GitHub Releases.

## Repository Layout

```text
backend/       FastAPI app, book parsing, reflow, search, and TTS
frontend/      React reader UI
scripts/       Windows build and Tauri helper scripts
src-tauri/     Tauri desktop shell, app resources, icons, and sidecar wiring
```

## What Is Not Tracked

The repo intentionally avoids committing local-only or bulky runtime files:

- installed app output;
- generated installers;
- model binaries in `backend/models`;
- uploaded books;
- generated audio cache;
- backend test/debug artifacts;
- local updater signing keys.

Bundled release resources live under `src-tauri/resources` at build time.

## Logs

Installed app logs are written to:

```text
%APPDATA%\com.folio.reader\backend.log
```

That log records backend startup, bundled model discovery, book loading, TTS generation, and shutdown.

## License

Folio is released under the [MIT License](LICENSE).
