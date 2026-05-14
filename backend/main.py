import json
import os
import re
import signal
import logging
import shutil
import subprocess
import threading
import time
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

try:
    import orjson  # noqa: F401
    from fastapi.responses import ORJSONResponse as _DefaultResponse
except ImportError:
    _DefaultResponse = None

import reflow_service
import cover_service
import chatterbox_service
import tts_service
import psutil
from models import BookState, Position, Bookmark, PageText, SentenceInfo
from paths import AUDIO_CACHE_DIR, DATA_DIR, FRONTEND_DIR, MODELS_DIR, UPLOAD_DIR
from tts_queue import TTSQueue

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = str(DATA_DIR)
FRONTEND_DIR = str(FRONTEND_DIR)
UPLOAD_DIR = str(UPLOAD_DIR)
AUDIO_CACHE_DIR = str(AUDIO_CACHE_DIR)
MODELS_DIR = str(MODELS_DIR)
logger = logging.getLogger(__name__)

BOOKS: dict[str, dict] = {}
TTS_MANAGER = TTSQueue(worker_count=3)
SEARCH_INDEXES: dict[str, dict] = {}
DEFAULT_TTS_ENGINE = "kokoro"
_active_tts_engine: str | None = None
_tts_engine_runtime_lock = threading.RLock()
_original_kokoro_provider_env = os.environ.get(tts_service.PROVIDER_ENV)
_kokoro_provider_pinned_for_inactive_engine = False

_recent_books_cache: list[dict] | None = None
_recent_books_cache_time: float = 0.0
_RECENT_CACHE_TTL = 2.0

_save_debounce_timers: dict[str, threading.Timer] = {}
_save_debounce_lock = threading.Lock()

_page_text_epub_cache: dict[str, dict] = {}
_PAGE_TEXT_EPUB_CACHE_LIMIT = 128
_hardware_cache: dict | None = None
_hardware_cache_time: float = 0.0
_HARDWARE_CACHE_TTL = 3.0


def _cover_url(book_id: str) -> str:
    return f"/api/book/{book_id}/cover"


def _ensure_book_cover(filepath: str, book_id: str):
    result = cover_service.ensure_cover_thumbnail(filepath, book_id, DATA_DIR)
    if result is None:
        return None, "default-fallback"
    source = result.source
    return _cover_url(book_id), source


def _system_metrics() -> dict:
    vm = psutil.virtual_memory()
    gpu = _gpu_metrics()
    return {
        "ram": {
            "used_bytes": int(vm.used),
            "total_bytes": int(vm.total),
            "percent": float(vm.percent),
        },
        "gpu": gpu,
    }


def _gpu_metrics() -> dict | None:
    global _hardware_cache, _hardware_cache_time
    now = time.monotonic()
    if _hardware_cache_time and now - _hardware_cache_time < _HARDWARE_CACHE_TTL:
        return _hardware_cache

    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        _hardware_cache = None
        _hardware_cache_time = now
        return None

    try:
        proc = subprocess.run(
            [
                nvidia_smi,
                "--query-gpu=name,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=1.5,
            check=True,
        )
        line = proc.stdout.strip().splitlines()[0]
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 3:
            raise ValueError(f"Unexpected nvidia-smi output: {line!r}")
        _hardware_cache = {
            "name": parts[0],
            "vram_used_mb": int(float(parts[1])),
            "vram_total_mb": int(float(parts[2])),
        }
    except Exception as exc:
        logger.info("GPU metrics unavailable via nvidia-smi: %s", exc)
        _hardware_cache = None
    _hardware_cache_time = now
    return _hardware_cache


def _normalize_tts_engine(engine: str | None) -> str:
    value = (engine or DEFAULT_TTS_ENGINE).strip().lower()
    if value in {
        "chatterbox",
        "chatterbox-turbo",
        "chatterbox_turbo",
        "vibevoice",  # legacy alias — migrates persisted state to Chatterbox
        "vibe-voice",
        "vibe_voice",
    }:
        return chatterbox_service.ENGINE_ID
    return DEFAULT_TTS_ENGINE


def _normalize_voice_for_engine(engine: str, voice: str | None) -> str:
    engine = _normalize_tts_engine(engine)
    if engine == chatterbox_service.ENGINE_ID:
        return chatterbox_service.normalize_voice(voice)
    return tts_service.normalize_voice(voice)


def _set_kokoro_provider_for_active_engine(engine: str) -> None:
    """Avoid incidental Kokoro CUDA loads, but restore CUDA when Kokoro is active."""
    global _kokoro_provider_pinned_for_inactive_engine
    engine = _normalize_tts_engine(engine)
    if engine == chatterbox_service.ENGINE_ID:
        if _original_kokoro_provider_env is None:
            os.environ[tts_service.PROVIDER_ENV] = "cpu"
            _kokoro_provider_pinned_for_inactive_engine = True
        return

    if _kokoro_provider_pinned_for_inactive_engine:
        if _original_kokoro_provider_env is None:
            os.environ.pop(tts_service.PROVIDER_ENV, None)
        else:
            os.environ[tts_service.PROVIDER_ENV] = _original_kokoro_provider_env
        _kokoro_provider_pinned_for_inactive_engine = False


def _activate_tts_engine(engine: str) -> None:
    """Keep only the selected local TTS engine resident on the GPU."""
    global _active_tts_engine
    engine = _normalize_tts_engine(engine)
    with _tts_engine_runtime_lock:
        # Always evict the inactive engine — even when the active flag matches —
        # so a stray load (e.g. a cache-key computation that called get_kokoro
        # under the hood) doesn't leave a multi-GB arena resident forever.
        if engine == chatterbox_service.ENGINE_ID:
            if tts_service.is_model_loaded():
                tts_service.unload_model()
        else:
            if chatterbox_service.is_model_loaded():
                chatterbox_service.unload_model()
        _set_kokoro_provider_for_active_engine(engine)
        if _active_tts_engine == engine:
            return
        _active_tts_engine = engine
        try:
            _save_global_settings({"tts_engine": engine})
        except Exception:
            logger.exception("Failed to persist tts_engine=%s", engine)
        _preload_engine_in_background(engine)


def _preload_engine_in_background(engine: str) -> None:
    """Kick off a daemon thread that loads the engine's model into memory.
    Safe to call repeatedly — both engines guard against duplicate loads."""
    engine = _normalize_tts_engine(engine)

    def _run():
        try:
            with _tts_engine_runtime_lock:
                if engine == chatterbox_service.ENGINE_ID:
                    if not chatterbox_service.is_model_loaded() and not chatterbox_service.is_model_loading():
                        chatterbox_service.get_model()
                    if _active_tts_engine != chatterbox_service.ENGINE_ID and chatterbox_service.is_model_loaded():
                        chatterbox_service.unload_model()
                else:
                    if not tts_service.is_model_loaded() and not tts_service.is_model_loading():
                        tts_service.get_kokoro()
                    if _active_tts_engine != DEFAULT_TTS_ENGINE and tts_service.is_model_loaded():
                        tts_service.unload_model()
        except Exception:
            logger.exception("Background TTS preload failed for engine=%s", engine)

    threading.Thread(target=_run, name=f"tts-preload-{engine}", daemon=True).start()


def _state_path(book_id: str) -> str:
    return os.path.join(DATA_DIR, f"{book_id}.json")


def _read_text_lenient(path) -> str:
    """Read a JSON state file robustly. Files written before the utf-8 fix
    (existing on-disk state) used Windows' cp1252 default, which breaks utf-8
    strict decoding when title/filepath contains a smart quote or em-dash. New
    writes always use utf-8 (see _atomic_write_text); the cp1252 fallback is
    backwards-compat only — a one-shot save will rewrite the file as utf-8."""
    # Sniff the first few bytes for a BOM and pick the matching codec. Without
    # this, an editor that saves UTF-16 (Notepad's "Unicode" / "Unicode big
    # endian") would fail utf-8 decode and then fall through to cp1252, which
    # silently produces garbage instead of raising.
    try:
        with open(path, "rb") as f:
            head = f.read(4)
    except OSError:
        head = b""
    if head.startswith(b"\xff\xfe\x00\x00"):
        with open(path, encoding="utf-32") as f:
            return f.read()
    if head.startswith(b"\x00\x00\xfe\xff"):
        with open(path, encoding="utf-32") as f:
            return f.read()
    if head.startswith(b"\xff\xfe") or head.startswith(b"\xfe\xff"):
        with open(path, encoding="utf-16") as f:
            return f.read()
    try:
        # utf-8-sig transparently strips a UTF-8 BOM if present (some editors
        # add one when manually saving JSON), and behaves like utf-8 otherwise.
        with open(path, encoding="utf-8-sig") as f:
            return f.read()
    except UnicodeDecodeError:
        with open(path, encoding="cp1252") as f:
            return f.read()


def _atomic_write_text(path: str, text: str):
    """Write text to `path` via a temp file in the same directory + os.replace,
    so a crash mid-write can't leave a half-written / corrupt file."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp_path = f"{path}.tmp.{os.getpid()}.{threading.get_ident()}.{time.time_ns()}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        for attempt in range(5):
            try:
                os.replace(tmp_path, path)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass


_settings_lock = threading.Lock()


def _save_state(book_id: str):
    if book_id in BOOKS:
        state = BOOKS[book_id]["state"]
        _atomic_write_text(_state_path(book_id), state.model_dump_json(indent=2))
    _invalidate_recent_cache()


def _save_state_debounced(book_id: str, delay: float = 0.5):
    def save_and_forget():
        try:
            _save_state(book_id)
        finally:
            with _save_debounce_lock:
                current = _save_debounce_timers.get(book_id)
                if current is threading.current_thread():
                    _save_debounce_timers.pop(book_id, None)

    with _save_debounce_lock:
        existing = _save_debounce_timers.pop(book_id, None)
        if existing:
            existing.cancel()
        timer = threading.Timer(delay, save_and_forget)
        timer.daemon = True
        _save_debounce_timers[book_id] = timer
        timer.start()


def _flush_debounced_saves():
    with _save_debounce_lock:
        for book_id, timer in list(_save_debounce_timers.items()):
            timer.cancel()
            _save_state(book_id)
        _save_debounce_timers.clear()


def _load_state(book_id: str) -> BookState | None:
    path = _state_path(book_id)
    if os.path.exists(path):
        return BookState.model_validate_json(_read_text_lenient(path))
    return None


def _settings_path() -> str:
    return os.path.join(DATA_DIR, "settings.json")


def _load_global_settings() -> dict:
    path = _settings_path()
    if os.path.exists(path):
        try:
            return json.loads(_read_text_lenient(path))
        except Exception:
            logger.exception("Failed to load global settings from %s", path)
    return {}


def _save_global_settings(updates: dict):
    # Serialize concurrent settings writes; load-modify-save would otherwise
    # drop updates if two requests race.
    with _settings_lock:
        existing = _load_global_settings()
        existing.update(updates)
        _atomic_write_text(_settings_path(), json.dumps(existing, indent=2))


def _resolve_filepath(filepath: str) -> str:
    """Return filepath if it exists, otherwise try basename in current uploads dir.
    Handles the case where the project folder was moved and saved states still
    reference the old absolute path."""
    if os.path.exists(filepath):
        return filepath
    candidate = os.path.join(UPLOAD_DIR, os.path.basename(filepath))
    if os.path.exists(candidate):
        return candidate
    return filepath


def _invalidate_recent_cache():
    global _recent_books_cache, _recent_books_cache_time
    _recent_books_cache = None
    _recent_books_cache_time = 0.0


def _load_recent_books() -> list[dict]:
    global _recent_books_cache, _recent_books_cache_time
    now = time.monotonic()
    if _recent_books_cache is not None and now - _recent_books_cache_time < _RECENT_CACHE_TTL:
        return _recent_books_cache

    os.makedirs(DATA_DIR, exist_ok=True)
    recent = []
    for f in sorted(Path(DATA_DIR).glob("*.json"), key=os.path.getmtime, reverse=True):
        # Skip settings.json (global UI settings), reflow caches, and any
        # half-written *.tmp.* shards from atomic writes.
        if f.name == "settings.json" or f.name.endswith(".reflow.json") or ".tmp." in f.name:
            continue
        try:
            # _read_text_lenient: utf-8 first (new writes), cp1252 fallback for
            # legacy state files written before the encoding fix. Without this,
            # smart quotes / em-dashes in EPUB titles crash the recent list,
            # which is polled every ~2s. The next _save_state rewrites as utf-8.
            text = _read_text_lenient(f)
            if not text.strip():
                # Empty/corrupt state file — prune it
                try:
                    f.unlink()
                except Exception:
                    logger.exception("Failed to delete empty state file %s", f)
                continue
            state = BookState.model_validate_json(text)
            resolved = _resolve_filepath(state.filepath)
            if os.path.splitext(resolved)[1].lower() != ".epub":
                continue
            cover_url, cover_source = (None, "default-fallback")
            if os.path.exists(resolved):
                cover_url, cover_source = _ensure_book_cover(resolved, state.id)
            recent.append({
                "id": state.id,
                "title": state.title,
                "author": state.author,
                "filepath": resolved,
                "page_count": state.page_count,
                "format": "epub",
                "cover_url": cover_url,
                "cover_source": cover_source,
                "last_position": state.last_position.model_dump(),
                "exists": os.path.exists(resolved),
            })
        except Exception:
            logger.exception("Failed to load recent book state from %s", f)
    _recent_books_cache = recent
    _recent_books_cache_time = time.monotonic()
    return recent


def _close_book_entry(book_id: str):
    entry = BOOKS.pop(book_id, None)
    if not entry:
        return
    keys_to_remove = [k for k in _page_text_epub_cache if k.startswith(f"{book_id}:")]
    for k in keys_to_remove:
        del _page_text_epub_cache[k]


def _invalidate_search_index(book_id: str):
    SEARCH_INDEXES.pop(book_id, None)


def _normalize_search_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").casefold()).strip()


def _search_snippet(text: str, query: str, max_len: int = 180) -> str:
    text = re.sub(r"\s+", " ", (text or "").strip())
    if len(text) <= max_len:
        return text

    normalized_text = text.casefold()
    normalized_query = (query or "").casefold()
    idx = normalized_text.find(normalized_query) if normalized_query else -1
    if idx < 0:
        return text[: max_len - 1].rstrip() + "…"

    half = max_len // 2
    start = max(0, idx - half)
    end = min(len(text), idx + len(query) + half)
    snippet = text[start:end].strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet


def _build_search_index(book_id: str) -> dict:
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")

    entry = BOOKS[book_id]
    state = entry["state"]
    rows: list[dict] = []

    reflow = reflow_service.get_or_build_reflow(entry["filepath"], DATA_DIR)
    for chapter_idx, chapter in enumerate(reflow.get("chapters", [])):
        sentence_idx = 0
        chapter_title = chapter.get("title") or f"Chapter {chapter_idx + 1}"
        for block in chapter.get("blocks", []):
            if block.get("type") != "paragraph":
                continue
            for sentence in block.get("sentences", []):
                text = re.sub(r"\s+", " ", sentence.get("text", "")).strip()
                if not text:
                    continue
                rows.append({
                    "page": chapter_idx,
                    "sentence_idx": sentence_idx,
                    "global_sentence_idx": sentence.get("idx"),
                    "location_label": chapter_title,
                    "text": text,
                    "normalized_text": _normalize_search_text(text),
                })
                sentence_idx += 1

    index = {
        "book_id": book_id,
        "filepath": entry["filepath"],
        "format": state.format,
        "rows": rows,
    }
    SEARCH_INDEXES[book_id] = index
    return index


def _get_search_index(book_id: str) -> dict:
    entry = BOOKS.get(book_id)
    if entry is None:
        raise HTTPException(404, "Book not loaded")

    cached = SEARCH_INDEXES.get(book_id)
    if cached and cached.get("filepath") == entry["filepath"] and cached.get("format") == entry["state"].format:
        return cached
    return _build_search_index(book_id)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("FastAPI lifespan starting")
    logger.info("Backend base dir: %s", BASE_DIR)
    logger.info("Runtime data dir: %s", DATA_DIR)
    logger.info("Upload dir: %s", UPLOAD_DIR)
    logger.info("Audio cache dir: %s", AUDIO_CACHE_DIR)
    logger.info("Models dir: %s", MODELS_DIR)
    logger.info("Frontend dir: %s", FRONTEND_DIR)
    logger.info("Expected quality model exists: %s", os.path.exists(os.path.join(MODELS_DIR, tts_service.QUALITY_MODEL_FILENAME)))
    logger.info("Expected voices file exists: %s", os.path.exists(os.path.join(MODELS_DIR, tts_service.VOICES_FILENAME)))
    logger.info("Expected frontend index exists: %s", os.path.exists(os.path.join(FRONTEND_DIR, "index.html")))
    tts_service.log_runtime_environment()
    chatterbox_service.log_runtime_environment()

    # Start loading whichever engine the user last selected, in the background
    # so the API binds quickly. Switching engines later unloads the previous
    # model (one resident at a time).
    #
    # Chatterbox is safe to eagerly preload now that we have the memory-pressure
    # guard (chatterbox_service._check_memory_available) and the sticky failure
    # flag (chatterbox_service._load_failed_permanently) — a low-RAM machine
    # gets a clean error surfaced in the Pill instead of an OOM crash, and a
    # broken load can't cascade-retry into a memory blow-up.
    saved_engine = _normalize_tts_engine(_load_global_settings().get("tts_engine"))
    global _active_tts_engine
    _active_tts_engine = saved_engine
    # If the saved engine isn't Kokoro, prevent incidental Kokoro CUDA init
    # from grabbing VRAM for an arena that nothing will use. When Kokoro later
    # becomes active, restore the user's provider setting so it can use CUDA.
    _set_kokoro_provider_for_active_engine(saved_engine)
    if saved_engine != "kokoro" and _kokoro_provider_pinned_for_inactive_engine:
        logger.info("Saved engine is %s; pinning %s=cpu so incidental Kokoro "
                    "sessions won't reserve CUDA VRAM.", saved_engine, tts_service.PROVIDER_ENV)
    logger.info("Auto-loading TTS engine at startup: %s", saved_engine)
    _preload_engine_in_background(saved_engine)

    yield
    logger.info("FastAPI lifespan shutting down; open books=%s", list(BOOKS.keys()))
    _flush_debounced_saves()
    for book_id in list(BOOKS):
        try:
            _save_state(book_id)
        except Exception:
            logger.exception("Failed to save state for book %s during shutdown", book_id)
        _close_book_entry(book_id)


_app_kwargs = {"title": "Kokoro Audiobook Reader", "lifespan": lifespan}
if _DefaultResponse is not None:
    _app_kwargs["default_response_class"] = _DefaultResponse
app = FastAPI(**_app_kwargs)
# Local-only desktop app — restrict CORS to the dev/preview origin and the
# bundled frontend. Allowing "*" lets any visited webpage in the user's browser
# hit our local API and read arbitrary files via /api/book/open?filepath=…
_DEV_ORIGINS = [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:8000",
    "http://localhost:8000",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("KOKORO_CORS_ORIGINS", ",".join(_DEV_ORIGINS)).split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)


_QUIET_PATHS = frozenset({"/api/status", "/api/recent", "/api/settings"})


@app.middleware("http")
async def log_requests(request: Request, call_next):
    path = request.url.path
    quiet = path in _QUIET_PATHS or path.startswith("/api/audio/")
    started = time.perf_counter()
    if not quiet:
        logger.info("HTTP request start method=%s path=%s query=%s", request.method, path, request.url.query)
    try:
        response = await call_next(request)
    except Exception:
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.exception("HTTP request failed method=%s path=%s elapsed_ms=%.1f", request.method, path, elapsed_ms)
        raise
    elapsed_ms = (time.perf_counter() - started) * 1000
    if not quiet or response.status_code >= 400:
        logger.info(
            "HTTP request end method=%s path=%s status=%s elapsed_ms=%.1f",
            request.method,
            path,
            response.status_code,
            elapsed_ms,
        )
    return response


# === API Routes ===

@app.get("/api/status")
def get_status():
    kokoro_loaded = tts_service.is_model_loaded()
    chatterbox_loaded = chatterbox_service.is_model_loaded()
    kokoro_loading = tts_service.is_model_loading()
    chatterbox_loading = chatterbox_service.is_model_loading()
    active_engine = _active_tts_engine or (chatterbox_service.ENGINE_ID if chatterbox_loaded else DEFAULT_TTS_ENGINE)
    active_voices = (
        len(chatterbox_service.get_available_voices())
        if active_engine == chatterbox_service.ENGINE_ID
        else (len(tts_service.get_available_voices()) if kokoro_loaded else 0)
    )
    return {
        "gpu": tts_service.is_gpu_enabled() or chatterbox_service.is_gpu_enabled(),
        "voices": active_voices,
        "model_loaded": kokoro_loaded or chatterbox_loaded,
        "model_loading": kokoro_loading or chatterbox_loading,
        "active_tts_engine": active_engine,
        "tts_runtime": tts_service.get_runtime_info(),
        "tts_engines": {
            "kokoro": tts_service.get_runtime_info(),
            chatterbox_service.ENGINE_ID: chatterbox_service.get_runtime_info(),
        },
        "system": _system_metrics(),
    }


@app.post("/api/shutdown")
def shutdown():
    """Shutdown the server (called by the launcher when the browser closes)."""
    _flush_debounced_saves()
    for book_id in list(BOOKS):
        try:
            _save_state(book_id)
        except Exception:
            logger.exception("Failed to save state for book %s during shutdown", book_id)
        _close_book_entry(book_id)
    os.kill(os.getpid(), signal.SIGTERM)
    return {"ok": True}


@app.get("/api/settings")
def get_global_settings():
    return _load_global_settings()


@app.post("/api/settings")
async def save_global_settings(request: Request):
    data = await request.json()
    _save_global_settings(data)
    return {"ok": True}


@app.get("/api/recent")
def get_recent_books():
    return _load_recent_books()


@app.post("/api/book/open")
def open_book(filepath: str = Query(...)):
    logger.info("Opening book from filepath=%s", filepath)
    resolved = _resolve_filepath(filepath)
    if not os.path.exists(resolved):
        logger.warning("Book file not found filepath=%s resolved=%s", filepath, resolved)
        raise HTTPException(404, f"File not found: {filepath}")
    ext = os.path.splitext(resolved)[1].lower()
    logger.info("Resolved book path=%s ext=%s size_bytes=%s", resolved, ext, os.path.getsize(resolved))
    if ext != ".epub":
        raise HTTPException(400, "Folio now supports EPUB files only.")

    logger.info("Opening EPUB path=%s", resolved)
    meta = reflow_service.get_metadata(resolved)
    # Build reflow now so page_count reflects real (post-frontmatter-filter) chapters.
    reflow = reflow_service.get_or_build_reflow(resolved, DATA_DIR)
    meta["page_count"] = max(1, len(reflow.get("chapters", [])))
    book_id = meta["id"]
    saved = _load_state(book_id)
    state = saved if saved else BookState(**meta)
    state.page_count = meta["page_count"]
    if state.filepath != resolved:
        state.filepath = resolved
    state.format = "epub"
    state.cover_url, state.cover_source = _ensure_book_cover(resolved, book_id)
    _close_book_entry(book_id)
    _invalidate_search_index(book_id)
    BOOKS[book_id] = {"state": state, "filepath": resolved}
    _save_state(book_id)
    logger.info("Opened EPUB book_id=%s title=%s chapters=%s", book_id, state.title, state.page_count)
    return state.model_dump()


@app.delete("/api/book/{book_id}")
def delete_book(book_id: str, delete_file: bool = Query(False)):
    """Remove a book from history. If delete_file=true and the EPUB lives under
    our uploads/ dir, delete the EPUB too (but not files from arbitrary user
    locations)."""
    state_path = _state_path(book_id)
    filepath = None
    if os.path.exists(state_path):
        try:
            state = BookState.model_validate_json(_read_text_lenient(state_path))
            filepath = state.filepath
        except Exception:
            logger.exception("Failed to parse state file for book %s", book_id)
        try:
            os.remove(state_path)
        except Exception:
            logger.exception("Failed to remove state file for book %s", book_id)
    if delete_file and filepath:
        resolved = _resolve_filepath(filepath)
        uploads_dir = os.path.realpath(UPLOAD_DIR)
        abs_fp = os.path.realpath(resolved)
        # realpath + commonpath defends against symlinks/junctions; the older
        # `startswith(uploads_dir + os.sep)` check could be bypassed with a
        # filename that starts with the same prefix (e.g. `uploads-evil/...`).
        try:
            inside_uploads = os.path.commonpath([uploads_dir, abs_fp]) == uploads_dir
        except ValueError:
            inside_uploads = False
        if inside_uploads and os.path.isfile(abs_fp):
            # Only delete if no other book state still references this file
            still_used = False
            for f in Path(DATA_DIR).glob("*.json"):
                if f.name == "settings.json" or f.name.endswith(".reflow.json") or ".tmp." in f.name:
                    continue
                try:
                    other = BookState.model_validate_json(_read_text_lenient(f))
                    if os.path.realpath(_resolve_filepath(other.filepath)) == abs_fp:
                        still_used = True
                        break
                except Exception:
                    logger.exception("Failed to inspect state file %s while deleting %s", f, abs_fp)
            if not still_used:
                try:
                    os.remove(abs_fp)
                except Exception:
                    logger.exception("Failed to remove uploaded file %s", abs_fp)
    _close_book_entry(book_id)
    _invalidate_search_index(book_id)
    return {"ok": True}


@app.post("/api/book/open-upload")
async def open_book_upload(file: UploadFile = File(...)):
    upload_dir = UPLOAD_DIR
    os.makedirs(upload_dir, exist_ok=True)
    safe_name = os.path.basename(file.filename) if file.filename else "upload.epub"
    if os.path.splitext(safe_name)[1].lower() != ".epub":
        raise HTTPException(400, "Choose an EPUB file.")
    filepath = os.path.join(upload_dir, safe_name)
    logger.info("Receiving upload filename=%s content_type=%s target=%s", file.filename, file.content_type, filepath)
    content = await file.read()
    logger.info("Upload read complete filename=%s bytes=%s", file.filename, len(content))
    with open(filepath, "wb") as f:
        f.write(content)
    logger.info("Upload saved target=%s size_bytes=%s", filepath, os.path.getsize(filepath))
    return open_book(filepath)


@app.get("/api/book/{book_id}/reflow")
def get_reflow(book_id: str):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    entry = BOOKS[book_id]
    return reflow_service.get_or_build_reflow(entry["filepath"], DATA_DIR)


@app.get("/api/book/{book_id}/cover")
def get_book_cover(book_id: str):
    covers_dir = os.path.realpath(os.path.join(DATA_DIR, "covers"))
    filepath = os.path.realpath(os.path.join(covers_dir, f"{book_id}.jpg"))
    if os.path.commonpath([covers_dir, filepath]) != covers_dir:
        raise HTTPException(400, "Invalid cover path")
    if not os.path.isfile(filepath):
        raise HTTPException(404, "Cover not found")
    return FileResponse(
        filepath,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


@app.get("/api/book/{book_id}/page/{page_num}/text")
def get_page_text(book_id: str, page_num: int):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    entry = BOOKS[book_id]
    cache_key = f"{book_id}:{page_num}"
    cached = _page_text_epub_cache.get(cache_key)
    if cached is not None:
        return cached

    reflow = reflow_service.get_or_build_reflow(entry["filepath"], DATA_DIR)
    chapters = reflow.get("chapters", [])
    if page_num < 0 or page_num >= len(chapters):
        raise HTTPException(400, "Invalid chapter index")
    chapter = chapters[page_num]

    sentences = []
    for block in chapter.get("blocks", []):
        if block.get("type") != "paragraph":
            continue
        for sent in block.get("sentences", []):
            text = sent.get("text", "").strip()
            if text:
                sentences.append(SentenceInfo(text=text, words=[]))
    result = PageText(
        page_number=page_num,
        sentences=sentences,
        render_width=0,
        render_height=0,
    ).model_dump()

    _page_text_epub_cache[cache_key] = result
    if len(_page_text_epub_cache) > _PAGE_TEXT_EPUB_CACHE_LIMIT:
        oldest = next(iter(_page_text_epub_cache))
        del _page_text_epub_cache[oldest]
    return result


@app.get("/api/book/{book_id}/search")
def search_book(
    book_id: str,
    q: str = Query(..., min_length=1),
    limit: int = Query(40, ge=1, le=200),
):
    query = _normalize_search_text(q)
    if not query:
        return {"query": q, "total": 0, "results": []}

    tokens = [token for token in query.split(" ") if token]
    first_token = tokens[0] if tokens else ""
    index = _get_search_index(book_id)
    rows = index["rows"]
    matches: list[dict] = []

    for row in rows:
        haystack = row["normalized_text"]
        phrase_match = query in haystack
        if not phrase_match and not (tokens and all(token in haystack for token in tokens)):
            continue

        score = 100 if phrase_match else 0
        if haystack.startswith(query):
            score += 20
        score += max(0, 10 - row["page"])
        if first_token:
            score += haystack.count(first_token)

        matches.append({
            "page": row["page"],
            "sentence_idx": row["sentence_idx"],
            "global_sentence_idx": row["global_sentence_idx"],
            "location_label": row["location_label"],
            "text": row["text"],
            "snippet": _search_snippet(row["text"], q),
            "_score": score,
        })

    matches.sort(key=lambda item: (-item["_score"], item["page"], item["sentence_idx"]))
    total = len(matches)
    for item in matches[:limit]:
        del item["_score"]
    results = matches[:limit]
    return {
        "query": q,
        "format": index["format"],
        "total": total,
        "results": results,
    }


def _generate_audio(
    text,
    engine,
    voice,
    speed,
    book_id,
    chatterbox_device: str | None = None,
):
    engine = _normalize_tts_engine(engine)
    with _tts_engine_runtime_lock:
        _activate_tts_engine(engine)
        if engine == chatterbox_service.ENGINE_ID:
            return chatterbox_service.generate_sentence_audio(
                text,
                voice=voice,
                speed=speed,
                book_id=book_id,
                device=chatterbox_device,
            )
        return tts_service.generate_sentence_audio(text, voice=voice, speed=speed, book_id=book_id)


def _job_key(
    book_id: str,
    page: int,
    sentence: int,
    engine: str,
    voice: str,
    speed: float,
    chatterbox_device: str | None = None,
) -> str:
    speed = tts_service.validate_speed(speed)
    engine = _normalize_tts_engine(engine)
    voice = _normalize_voice_for_engine(engine, voice)
    if engine == chatterbox_service.ENGINE_ID:
        device = chatterbox_service.normalize_device(chatterbox_device)
        return f"{engine}|{book_id}|{page}|{sentence}|{voice}|{speed}|{device}"
    return f"kokoro|{book_id}|{page}|{sentence}|{voice}|{speed}"


def _audio_cache_path(
    book_id: str,
    text: str,
    engine: str,
    voice: str,
    speed: float,
    chatterbox_device: str | None = None,
) -> str:
    engine = _normalize_tts_engine(engine)
    if engine == chatterbox_service.ENGINE_ID:
        return chatterbox_service.audio_cache_path(
            book_id,
            text,
            voice,
            speed,
            device=chatterbox_device,
        )
    key = tts_service._cache_key(text, voice, speed)
    return os.path.join(tts_service.CACHE_DIR, f"{book_id}_{key}.wav")


def _get_sentence(book_id: str, page: int, sentence: int):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    cache_key = f"{book_id}:{page}"
    cached_data = _page_text_epub_cache.get(cache_key)
    if cached_data is not None:
        sentences = cached_data["sentences"]
    else:
        data = get_page_text(book_id, page)
        sentences = data["sentences"]
    if sentence < 0 or sentence >= len(sentences):
        raise HTTPException(400, "Invalid sentence index")
    sent_dict = sentences[sentence]
    sent = SentenceInfo(**sent_dict) if isinstance(sent_dict, dict) else sent_dict
    if not sent.text.strip():
        raise HTTPException(400, "Empty sentence")
    page_text = PageText(page_number=page, sentences=[SentenceInfo(**s) if isinstance(s, dict) else s for s in sentences], render_width=0, render_height=0)
    return page_text, sent


def _submit_tts_job(
    book_id: str,
    page: int,
    sentence: int,
    engine: str,
    voice: str,
    speed: float,
    priority: int,
    chatterbox_device: str | None = None,
):
    _page_text, sent = _get_sentence(book_id, page, sentence)
    job_key = _job_key(book_id, page, sentence, engine, voice, speed, chatterbox_device)
    job = TTS_MANAGER.submit(
        key=job_key,
        priority=priority,
        fn=lambda: _generate_audio(sent.text, engine, voice, speed, book_id, chatterbox_device),
    )
    return job, sent


def _iter_sentence_window(book_id: str, page: int, sentence: int, count: int, include_current: bool = False):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    entry = BOOKS[book_id]
    _sentence_count_cache: dict[int, int] = {}
    reflow = reflow_service.get_or_build_reflow(entry["filepath"], DATA_DIR)
    chapters = reflow.get("chapters", [])
    total_pages = len(chapters)
    def sentence_count(page_idx):
        cached = _sentence_count_cache.get(page_idx)
        if cached is not None:
            return cached
        if page_idx < 0 or page_idx >= len(chapters):
            return 0
        n = 0
        for b in chapters[page_idx].get("blocks", []):
            if b.get("type") == "paragraph":
                n += sum(1 for s in b.get("sentences", []) if s.get("text", "").strip())
        _sentence_count_cache[page_idx] = n
        return n

    refs = []
    page_num = page
    sentence_idx = sentence if include_current else sentence + 1
    while page_num < total_pages and len(refs) < count:
        if sentence_idx < 0:
            sentence_idx = 0
        n = sentence_count(page_num)
        while sentence_idx < n and len(refs) < count:
            refs.append((page_num, sentence_idx))
            sentence_idx += 1
        page_num += 1
        sentence_idx = 0
    return refs


@app.get("/api/tts/generate")
def generate_tts(
    book_id: str = Query(...),
    page: int = Query(...),
    sentence: int = Query(...),
    engine: str = Query(DEFAULT_TTS_ENGINE),
    voice: str = Query("af_heart"),
    speed: float = Query(tts_service.DEFAULT_SPEED, ge=tts_service.MIN_SPEED, le=tts_service.MAX_SPEED),
    chatterbox_device: str = Query(chatterbox_service.DEFAULT_DEVICE),
):
    normalized_engine = _normalize_tts_engine(engine)
    _activate_tts_engine(normalized_engine)
    job, _sent = _submit_tts_job(
        book_id,
        page,
        sentence,
        engine,
        voice,
        speed,
        priority=0,
        chatterbox_device=chatterbox_device,
    )
    try:
        filename, duration_ms = TTS_MANAGER.wait(job)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"filename": filename, "duration_ms": duration_ms}


@app.post("/api/tts/buffer")
def buffer_tts(
    book_id: str = Query(...),
    page: int = Query(...),
    sentence: int = Query(...),
    count: int = Query(2, ge=1, le=24),
    engine: str = Query(DEFAULT_TTS_ENGINE),
    voice: str = Query("af_heart"),
    speed: float = Query(tts_service.DEFAULT_SPEED, ge=tts_service.MIN_SPEED, le=tts_service.MAX_SPEED),
    chatterbox_device: str = Query(chatterbox_service.DEFAULT_DEVICE),
):
    """Queue the next N sentences after the current reader position.

    This is intentionally fire-and-forget: playback should never wait for the
    buffer endpoint, and the current sentence keeps priority 0 via /generate.
    """
    refs = _iter_sentence_window(book_id, page, sentence, count, include_current=False)
    queued: list[dict] = []
    skipped: list[dict] = []
    normalized_engine = _normalize_tts_engine(engine)

    if normalized_engine == chatterbox_service.ENGINE_ID:
        _activate_tts_engine(normalized_engine)

    # Pre-queue future chunks regardless of engine. Chatterbox serializes GPU
    # work via its own BoundedSemaphore(1), so pending jobs sit in the priority
    # queue and start the instant the foreground chunk finishes — keeping
    # playback continuous instead of stalling once per sentence.
    model_loaded = (
        normalized_engine != chatterbox_service.ENGINE_ID
        or chatterbox_service.is_model_loaded()
    )
    for offset, (page_num, sentence_idx) in enumerate(refs, start=1):
        job_key = _job_key(book_id, page_num, sentence_idx, normalized_engine, voice, speed, chatterbox_device)
        status = TTS_MANAGER.status(job_key)
        if status in {"pending", "running"}:
            skipped.append({"page": page_num, "sentence": sentence_idx, "reason": status})
            continue

        _page_text, sent = _get_sentence(book_id, page_num, sentence_idx)
        if model_loaded and os.path.exists(_audio_cache_path(book_id, sent.text, normalized_engine, voice, speed, chatterbox_device)):
            skipped.append({"page": page_num, "sentence": sentence_idx, "reason": "cached"})
            continue

        TTS_MANAGER.submit(
            key=job_key,
            priority=offset,
            fn=lambda text=sent.text: _generate_audio(
                text,
                normalized_engine,
                voice,
                speed,
                book_id,
                chatterbox_device,
            ),
        )
        queued.append({"page": page_num, "sentence": sentence_idx})

    return {"requested": len(refs), "queued": queued, "skipped": skipped}


def _chapter_sentence_refs(
    book_id: str,
    page: int,
    engine: str,
    voice: str,
    speed: float,
    chatterbox_device: str | None = None,
    include_cache_path: bool = True,
):
    """Return [(sentence_idx, text, expected_cache_filepath)] for every non-empty
    sentence on the EPUB chapter at `page`."""
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    cache_key = f"{book_id}:{page}"
    cached_data = _page_text_epub_cache.get(cache_key)
    if cached_data is not None:
        sentences = [s.get("text", "") for s in cached_data["sentences"]]
    else:
        data = get_page_text(book_id, page)
        sentences = [s.get("text", "") for s in data["sentences"]]

    refs = []
    for idx, text in enumerate(sentences):
        text = (text or "").strip()
        if not text:
            continue
        filepath = (
            _audio_cache_path(book_id, text, engine, voice, speed, chatterbox_device)
            if include_cache_path
            else None
        )
        refs.append((idx, text, filepath))
    return refs


@app.post("/api/book/{book_id}/preload-chapter")
def preload_chapter(
    book_id: str,
    page: int = Query(...),
    engine: str = Query(DEFAULT_TTS_ENGINE),
    voice: str = Query("af_heart"),
    speed: float = Query(tts_service.DEFAULT_SPEED, ge=tts_service.MIN_SPEED, le=tts_service.MAX_SPEED),
    chatterbox_device: str = Query(chatterbox_service.DEFAULT_DEVICE),
):
    """Queue every sentence in the chapter/page for TTS generation at top priority."""
    engine = _normalize_tts_engine(engine)
    if engine == chatterbox_service.ENGINE_ID:
        _activate_tts_engine(engine)
    refs = _chapter_sentence_refs(
        book_id,
        page,
        engine,
        voice,
        speed,
        chatterbox_device,
        include_cache_path=True,
    )
    queued = 0
    for offset, (sentence_idx, _text, _path) in enumerate(refs):
        if _path and os.path.exists(_path):
            continue
        _submit_tts_job(
            book_id,
            page,
            sentence_idx,
            engine,
            voice,
            speed,
            priority=offset if engine != chatterbox_service.ENGINE_ID else offset + 1,
            chatterbox_device=chatterbox_device,
        )
        queued += 1
    return {"total": len(refs), "queued": queued}


@app.get("/api/book/{book_id}/preload-chapter/status")
def preload_chapter_status(
    book_id: str,
    page: int = Query(...),
    engine: str = Query(DEFAULT_TTS_ENGINE),
    voice: str = Query("af_heart"),
    speed: float = Query(tts_service.DEFAULT_SPEED, ge=tts_service.MIN_SPEED, le=tts_service.MAX_SPEED),
    chatterbox_device: str = Query(chatterbox_service.DEFAULT_DEVICE),
):
    """Probe the audio cache for every sentence in the chapter. Cheap — no generation."""
    # Kokoro cache keys use a no-load runtime fingerprint, so this endpoint can
    # report cached chapters on cold start without pinning a model in memory.
    engine = _normalize_tts_engine(engine)
    refs = _chapter_sentence_refs(book_id, page, engine, voice, speed, chatterbox_device)
    ready = 0
    failed: list[int] = []
    active = 0
    for sentence_idx, _text, filepath in refs:
        if os.path.exists(filepath):
            ready += 1
            continue
        job_key = _job_key(book_id, page, sentence_idx, engine, voice, speed, chatterbox_device)
        status = TTS_MANAGER.status(job_key)
        if status == "error":
            failed.append(sentence_idx)
        elif status in {"pending", "running"}:
            active += 1
    total = len(refs)
    if total == 0 or ready >= total:
        state = "ready"
    elif failed and active == 0:
        state = "error"
    else:
        state = "preloading"
    return {"state": state, "ready": ready, "total": total, "failed": failed}


_AUDIO_FILENAME_RE = re.compile(r"^[A-Za-z0-9_\-]+\.wav$")


@app.get("/api/audio/{filename}")
def get_audio(filename: str):
    if not _AUDIO_FILENAME_RE.match(filename):
        raise HTTPException(400, "Invalid audio filename")
    cache_dir = os.path.realpath(tts_service.CACHE_DIR)
    filepath = os.path.realpath(os.path.join(cache_dir, filename))
    if os.path.commonpath([cache_dir, filepath]) != cache_dir:
        raise HTTPException(400, "Invalid audio filename")
    if not os.path.isfile(filepath):
        raise HTTPException(404, "Audio not found")
    return FileResponse(
        filepath,
        media_type="audio/wav",
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


@app.get("/api/tts/voices")
def get_voices(engine: str = Query(DEFAULT_TTS_ENGINE)):
    try:
        engine = _normalize_tts_engine(engine)
        if engine == chatterbox_service.ENGINE_ID:
            return chatterbox_service.get_available_voices()
        return tts_service.get_available_voices()
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/tts/options")
def get_tts_options():
    return {
        "engines": [
            {
                "id": "kokoro",
                "name": "Kokoro",
                "voices": tts_service.get_available_voices(),
                "default_voice": tts_service.DEFAULT_VOICE,
            },
            {
                "id": chatterbox_service.ENGINE_ID,
                "name": "Chatterbox Turbo",
                "voices": chatterbox_service.get_available_voices(),
                "default_voice": chatterbox_service.DEFAULT_VOICE,
            },
        ]
    }


@app.get("/api/tts/voice-preview")
def voice_preview():
    raise HTTPException(400, "Voice preview is not available for the current engine.")


@app.post("/api/book/{book_id}/position")
def save_position(book_id: str, position: Position):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    BOOKS[book_id]["state"].last_position = position
    _save_state_debounced(book_id)
    return {"ok": True}


@app.post("/api/book/{book_id}/bookmark")
def add_bookmark(book_id: str, bookmark: Bookmark):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    BOOKS[book_id]["state"].bookmarks.append(bookmark)
    _save_state(book_id)
    return {"ok": True}


@app.delete("/api/book/{book_id}/bookmark/{idx}")
def remove_bookmark(book_id: str, idx: int):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    bmarks = BOOKS[book_id]["state"].bookmarks
    if 0 <= idx < len(bmarks):
        bmarks.pop(idx)
        _save_state(book_id)
    return {"ok": True}


@app.post("/api/book/{book_id}/settings")
def update_settings(
    book_id: str,
    tts_engine: str = Query(None),
    voice: str = Query(None),
    speed: float = Query(None, ge=tts_service.MIN_SPEED, le=tts_service.MAX_SPEED),
):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    state = BOOKS[book_id]["state"]
    if tts_engine is not None:
        state.tts_engine = _normalize_tts_engine(tts_engine)
        _activate_tts_engine(state.tts_engine)
    if voice is not None:
        state.voice = _normalize_voice_for_engine(getattr(state, "tts_engine", DEFAULT_TTS_ENGINE), voice)
    if speed is not None:
        state.speed = speed
    _save_state(book_id)
    return {"ok": True}


@app.get("/api/cache/info")
def cache_info():
    return tts_service.get_cache_size()


@app.post("/api/cache/clear")
def cache_clear():
    result = tts_service.clear_cache()
    return {"ok": True, **result}


# === Serve frontend static files ===
# Mount static assets (JS, CSS)
if os.path.exists(os.path.join(FRONTEND_DIR, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIR, "assets")), name="assets")


# Catch-all: serve index.html for any non-API route (SPA routing)
@app.get("/{path:path}")
def serve_frontend(path: str = ""):
    if path.startswith("api/"):
        raise HTTPException(404, "API route not found")
    index = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index):
        return FileResponse(index)
    return HTMLResponse("<h1>Frontend not built. Run: cd frontend && npm run build</h1>", status_code=500)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000)
