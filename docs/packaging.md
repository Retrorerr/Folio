# Packaging Folio

Folio can ship as a Tauri desktop app with a bundled Python backend sidecar.
The installer gives users one app to install and the first launch writes only
runtime data to the user's app-data folder.

## Architecture

- Tauri owns the native window and installer.
- Vite builds the React frontend into static files.
- PyInstaller builds `backend/desktop_entry.py` into `folio-backend.exe`.
- Tauri launches that backend on `127.0.0.1:8000`.
- Runtime state, uploads, generated audio, and voice model assets live under
  the OS app-data directory instead of inside the read-only app bundle.
- Supertonic 3 and Kokoro model assets are deliberately provisioned into the
  app-data `models` directory through Folio's model install flow.

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

The first-use model install flow creates:

- `%APPDATA%\com.folio.reader\models\supertonic-3`
- `%APPDATA%\com.folio.reader\models\kokoro-v1.0.onnx`
- `%APPDATA%\com.folio.reader\models\voices-v1.0.bin`
- optionally `%APPDATA%\com.folio.reader\models\kokoro-v1.0.int8.onnx` as a fallback

Supertonic 3 assets come from `Supertone/supertonic-3` at Folio's pinned SDK
revision and are stored under Folio's model directory, not the user's global
Supertonic cache. The model is licensed under OpenRAIL-M.

On first launch, Tauri creates:

```text
%APPDATA%\com.folio.reader\data
%APPDATA%\com.folio.reader\uploads
%APPDATA%\com.folio.reader\audio-cache
%APPDATA%\com.folio.reader\models
%APPDATA%\com.folio.reader\temp
```

The Windows uninstallers remove the complete Folio install directory and the
complete `%APPDATA%\com.folio.reader` and `%LOCALAPPDATA%\com.folio.reader`
trees. The NSIS hook applies this cleanup unconditionally for a real uninstall;
the `/UPDATE` path is excluded so updates retain the app and its data.

Users should not need to install Python, Node, Rust, or copy model files manually.
