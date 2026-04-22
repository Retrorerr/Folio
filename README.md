# Folio

Folio is a desktop-first PDF and EPUB reader with built-in text-to-speech, synchronized playback, and a library experience designed for long-form reading.

![Folio hero](frontend/src/assets/hero.png)

## Overview

Most reading tools treat listening as an afterthought. Folio is built around a different idea: reading and listening should feel like the same activity. The app keeps text, navigation, and playback aligned so a book can move naturally between silent reading and spoken playback.

- Drop in a PDF or EPUB and start reading immediately
- Turn books into followable, sentence-aware audio playback
- Keep your place with bookmarks, persistent progress, and recent-book history
- Search across the full text of the current book
- Switch between a faithful PDF view and reflowed EPUB reading
- Choose reading voices, playback speed, theme, motion, and highlight style
- Use local model-backed playback with GPU acceleration when available

## At A Glance

| Area | What Folio does |
| --- | --- |
| Formats | Reads PDF and EPUB files |
| Playback | Supports local TTS playback with synchronized sentence progress |
| Navigation | Includes chapters, bookmarks, recent books, and full-text search |
| Experience | Offers theme controls, motion settings, reader highlighting, and desktop-style launch flow |
| Runtime | Uses a React frontend, FastAPI backend, and local model assets via Git LFS |

## Highlights

- **Two reading modes**: paged PDF reading and chapter-based EPUB reflow
- **Integrated TTS playback**: on-device Kokoro voices and Orpheus playback support
- **Reader-following audio**: playback advances through sentences and can keep the view synced
- **Preloaded chapter audio**: prepares a chapter before playback for smoother listening
- **Search and navigation**: full-book search, bookmarks, chapter navigation, and recent titles
- **Desktop-friendly launcher**: starts the local server and opens the app in a standalone browser window
- **Persistent library state**: remembers theme, voice, progress, and recent books between sessions

## Stack

- Frontend: React 19, Vite
- Backend: FastAPI, Uvicorn
- PDF processing: PyMuPDF
- EPUB parsing: EbookLib, Beautiful Soup, lxml
- TTS: `kokoro-onnx`, ONNX Runtime, optional Orpheus flow
- Packaging style: local desktop workflow via `launcher.pyw`

## Demo-Friendly Feature Set

- **Library home** with recent books and resume state
- **Reading progress memory** across sessions
- **Sentence-aware playback** with voice and speed controls
- **Search panel** for navigating directly to passages
- **Bookmarks panel** for saving return points
- **Theme and motion settings** for different reading preferences

## Repository Layout

```text
.
|-- backend/        FastAPI server, parsing, search, and TTS services
|-- frontend/       React UI, reader views, settings, and library experience
|-- launcher.pyw    Windows launcher for the standalone desktop-style experience
|-- README.md
|-- CONTRIBUTING.md
|-- LICENSE
```

## Getting Started

### Prerequisites

- Python 3.11+ recommended
- Node.js 20+ recommended
- Git LFS

### 1. Clone the repository

```powershell
git clone https://github.com/Retrorerr/Folio.git
cd Folio
git lfs pull
```

### 2. Install backend dependencies

```powershell
python -m pip install -r backend/requirements.txt
```

### 3. Install frontend dependencies

```powershell
cd frontend
npm install
cd ..
```

### 4. Build the frontend

```powershell
cd frontend
npm run build
cd ..
```

### 5. Launch Folio

For the desktop-style flow on Windows:

```powershell
python launcher.pyw
```

For backend development directly:

```powershell
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

If you run the backend directly, start the frontend dev server in a second terminal:

```powershell
cd frontend
npm run dev
```

## Development Notes

- The backend serves the production frontend build from `frontend/dist`
- Runtime book data, uploads, generated audio, and local state are intentionally excluded from git
- Large model binaries in `backend/models` are tracked with Git LFS

## Notes On Models

Folio stores the large local speech models with Git LFS. After cloning, always run:

```powershell
git lfs pull
```

Without that step, the model files in `backend/models` will only exist as LFS pointers and playback will not work correctly.

## Current Scope

Folio currently focuses on:

- Local reading of PDF and EPUB files
- On-device or locally served speech generation
- Persistent reading state and navigation
- A refined solo-reader workflow on Windows

## Roadmap

- Better onboarding and first-run setup checks
- Easier model management and download flow
- Packaging for simpler installation
- Richer library metadata and cover handling
- Export and sharing options for notes/bookmarks

## Positioning

Folio is currently best suited for local-first personal reading on Windows, especially for users who want a cleaner bridge between visual reading and spoken playback than traditional ebook tools usually offer.

## Contributing

Contributions, fixes, and polish are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and expectations.

## License

This project is released under the [MIT License](LICENSE).
