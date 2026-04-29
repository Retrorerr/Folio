# Packaging Folio

Folio can ship as a Tauri desktop app with a bundled Python backend sidecar.
The installer gives users one app to install and the first launch writes only
runtime data to the user's app-data folder.

## Architecture

- Tauri owns the native window and installer.
- Vite builds the React frontend into static files.
- PyInstaller builds `backend/desktop_entry.py` into `folio-backend.exe`.
- Tauri launches that backend on `127.0.0.1:8000`.
- Runtime state, uploads, and generated audio live under the OS app-data
  directory instead of inside the read-only app bundle.
- Kokoro model files are copied into Tauri resources and read from there.

## Windows Build

Install these once:

```powershell
# Rust/Cargo from https://rustup.rs
# Node.js with npm available on PATH
python -m pip install pyinstaller
npm install
npm --prefix frontend install
```

Then build the installer:

```powershell
npm run tauri:build
```

The build creates NSIS and MSI installers under:

```text
src-tauri/target/release/bundle/
```

## Development

```powershell
npm run tauri:dev
```

The dev command starts the FastAPI backend and Vite frontend, then opens Folio
inside the Tauri window.

## First-Use Experience

The installer should include:

- `folio-backend.exe`
- `kokoro-v1.0.onnx`
- `voices-v1.0.bin`
- optionally `kokoro-v1.0.int8.onnx` as a fallback

On first launch, Tauri creates:

```text
%APPDATA%\com.folio.reader\data
%APPDATA%\com.folio.reader\uploads
%APPDATA%\com.folio.reader\audio-cache
```

Users should not need to install Python, Node, Rust, or model files separately.
