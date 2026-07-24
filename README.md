<div align="center">
  <img src="frontend/public/folio-icon.png" width="96" alt="Folio icon">
  <h1>Folio</h1>
  <p><strong>Read books. Listen locally. Never lose your place.</strong></p>
  <p>A local-first EPUB and PDF reader for Windows and Android.</p>
</div>

![Folio library](docs/screenshots/dashboard-library.png)

Folio brings reading and narration into one continuous experience. Pick a line, press play, and the spoken text stays connected to the page with a smooth line-following cursor. Your books, progress, models, and generated audio remain on your device.

## What Folio can do

- Import **EPUB and PDF** books individually or from a selected library folder.
- Organise a local library with covers, metadata search, recent books, progress, reading goals, and bookmarks.
- Read EPUBs in a paginated one- or two-page layout with chapter navigation, page turns, full-book search, and saved position.
- Read PDFs as rendered pages with an extractable text transcript for navigation and narration.
- Generate natural speech locally with **Supertonic 3** or **Kokoro**. Models are downloaded only when requested and work offline once installed.
- Start narration from a chosen line and use **Follow Along** to keep the cursor and visible page synced with playback.
- Control voice, speed, volume, sleep timer, playback buffer, and full-chapter preloading.
- Choose from Light, Sepia, Dark, Folio, and Blackleaf themes.

![Folio reader and narration controls](docs/screenshots/reader-expanded-pill.png)

## Platforms

### Windows

The full desktop app includes the library, reader, local narration backend, model management, folder scanning, audio-cache controls, and built-in update checks. Folio is packaged as a native Tauri installer.

Download the latest installer from [GitHub Releases](https://github.com/Retrorerr/Folio/releases).

### Android

Android uses the same reader interface with a native mobile runtime. It supports local EPUB/PDF storage, on-device Kokoro and Supertonic inference, phone and tablet layouts, background playback, lock-screen and notification controls, and playback restoration after the app is closed.

Android builds are currently intended for sideloading and are not published on the Play Store. See [docs/android.md](docs/android.md) for setup, building, and model-pack details.

## Local by design

Folio does not require a cloud service for reading, speech generation, or playback. After a narration model is installed, the core experience works offline.

## Development

Requirements: Windows, Node.js 20+, Python 3.11+, Rust, and the Tauri prerequisites.

```powershell
npm install
npm --prefix frontend install
npm run tauri:dev
```

Run the main checks:

```powershell
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run test
npm --prefix frontend run build
npm run backend:test -- --SkipInstall
```

Build Windows:

```powershell
npm run tauri:build
```

Build Android:

```powershell
npm run android:check
npm run android:build:debug
```

## Project structure

```text
backend/       Windows library, document, and narration services
frontend/      Shared React reader interface
src-tauri/     Windows shell and native Android runtime
scripts/       Development, validation, and packaging tools
docs/          Platform and packaging documentation
```

## License

[MIT](LICENSE)
