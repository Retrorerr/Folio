"""Filesystem locations for source assets and runtime data.

Environment overrides make the backend easier to embed in Tauri: bundled files
can stay read-only while uploads, state, and generated audio live in app data.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent


def _path_from_env(name: str, fallback: Path) -> Path:
    return Path(os.environ.get(name, fallback)).expanduser().resolve()


DATA_DIR = _path_from_env("KOKORO_READER_DATA_DIR", BASE_DIR / "data")
UPLOAD_DIR = _path_from_env("KOKORO_READER_UPLOAD_DIR", BASE_DIR / "uploads")
AUDIO_CACHE_DIR = _path_from_env("KOKORO_READER_AUDIO_CACHE_DIR", BASE_DIR / "audio_cache")
MODELS_DIR = _path_from_env("KOKORO_READER_MODELS_DIR", BASE_DIR / "models")
FRONTEND_DIR = _path_from_env("KOKORO_READER_FRONTEND_DIR", PROJECT_DIR / "frontend" / "dist")
