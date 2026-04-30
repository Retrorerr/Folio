import json
import os
import re
import signal
import logging
import threading
import time
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, HTMLResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

import pdf_service
import reflow_service
import tts_service
from models import BookState, Position, Bookmark
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
TTS_MANAGER = TTSQueue(worker_count=3)  # 3 parallel workers; priority still orders closest-to-reader first
SEARCH_INDEXES: dict[str, dict] = {}


def _state_path(book_id: str) -> str:
    return os.path.join(DATA_DIR, f"{book_id}.json")


def _read_text_lenient(path) -> str:
    """Read a JSON state file robustly. Files written before the utf-8 fix
    (existing on-disk state) used Windows' cp1252 default, which breaks utf-8
    strict decoding when title/filepath contains a smart quote or em-dash. New
    writes always use utf-8 (see _atomic_write_text); the cp1252 fallback is
    backwards-compat only — a one-shot save will rewrite the file as utf-8."""
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except UnicodeDecodeError:
        with open(path, encoding="cp1252") as f:
            return f.read()


def _atomic_write_text(path: str, text: str):
    """Write text to `path` via a temp file in the same directory + os.replace,
    so a crash mid-write can't leave a half-written / corrupt file."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp_path = f"{path}.tmp.{os.getpid()}"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass
    os.replace(tmp_path, path)


_settings_lock = threading.Lock()


def _save_state(book_id: str):
    if book_id in BOOKS:
        state = BOOKS[book_id]["state"]
        _atomic_write_text(_state_path(book_id), state.model_dump_json(indent=2))


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


def _load_recent_books() -> list[dict]:
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
            recent.append({
                "id": state.id,
                "title": state.title,
                "author": state.author,
                "filepath": resolved,
                "page_count": state.page_count,
                "last_position": state.last_position.model_dump(),
                "exists": os.path.exists(resolved),
            })
        except Exception:
            logger.exception("Failed to load recent book state from %s", f)
    return recent


def _close_book_entry(book_id: str):
    entry = BOOKS.pop(book_id, None)
    if not entry:
        return
    doc = entry.get("doc")
    if doc is not None:
        try:
            doc.close()
        except Exception:
            logger.exception("Failed to close PDF document for book %s", book_id)


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

    if state.format == "epub":
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
    else:
        doc = entry["doc"]
        if doc is None:
            raise HTTPException(400, "Book not loaded")
        for page_num in range(len(doc)):
            page_text = pdf_service.extract_page_text(doc, page_num)
            for sentence_idx, sentence in enumerate(page_text.sentences):
                text = re.sub(r"\s+", " ", sentence.text).strip()
                if not text:
                    continue
                rows.append({
                    "page": page_num,
                    "sentence_idx": sentence_idx,
                    "global_sentence_idx": None,
                    "location_label": f"Page {page_num + 1}",
                    "text": text,
                    "normalized_text": _normalize_search_text(text),
                })

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
    yield
    logger.info("FastAPI lifespan shutting down; open books=%s", list(BOOKS.keys()))
    # Always close the doc even if the state-save fails — otherwise a partial
    # disk error would leak a fitz.Document on shutdown.
    for book_id in list(BOOKS):
        try:
            _save_state(book_id)
        except Exception:
            logger.exception("Failed to save state for book %s during shutdown", book_id)
        _close_book_entry(book_id)


app = FastAPI(title="Kokoro Audiobook Reader", lifespan=lifespan)
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


@app.middleware("http")
async def log_requests(request: Request, call_next):
    started = time.perf_counter()
    logger.info("HTTP request start method=%s path=%s query=%s", request.method, request.url.path, request.url.query)
    try:
        response = await call_next(request)
    except Exception:
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.exception("HTTP request failed method=%s path=%s elapsed_ms=%.1f", request.method, request.url.path, elapsed_ms)
        raise
    elapsed_ms = (time.perf_counter() - started) * 1000
    logger.info(
        "HTTP request end method=%s path=%s status=%s elapsed_ms=%.1f",
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    return response


# === API Routes ===

@app.get("/api/status")
def get_status():
    return {
        "gpu": tts_service.is_gpu_enabled(),
        "voices": len(tts_service.get_available_voices()) if tts_service.is_model_loaded() else 0,
        "model_loaded": tts_service.is_model_loaded(),
        "model_loading": tts_service.is_model_loading(),
        "tts_runtime": tts_service.get_runtime_info(),
    }


@app.post("/api/shutdown")
def shutdown():
    """Shutdown the server (called by the launcher when the browser closes)."""
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
    if ext == ".epub":
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
        _close_book_entry(book_id)
        _invalidate_search_index(book_id)
        BOOKS[book_id] = {"doc": None, "state": state, "filepath": resolved}
        _save_state(book_id)
        logger.info("Opened EPUB book_id=%s title=%s chapters=%s", book_id, state.title, state.page_count)
        return state.model_dump()

    logger.info("Opening PDF path=%s", resolved)
    doc = pdf_service.open_pdf(resolved)
    try:
        meta = pdf_service.get_metadata(doc, resolved)
        book_id = meta["id"]
        saved = _load_state(book_id)
        state = saved if saved else BookState(**meta)
        if state.filepath != resolved:
            state.filepath = resolved
        _close_book_entry(book_id)
        _invalidate_search_index(book_id)
        BOOKS[book_id] = {"doc": doc, "state": state, "filepath": resolved}
    except Exception:
        # Don't leak the fitz Document if metadata extraction or registration fails.
        try:
            doc.close()
        except Exception:
            logger.exception("Failed to close PDF after open_book failure")
        raise
    _save_state(book_id)
    logger.info("Opened PDF book_id=%s title=%s pages=%s", book_id, state.title, state.page_count)
    return state.model_dump()


@app.delete("/api/book/{book_id}")
def delete_book(book_id: str, delete_file: bool = Query(False)):
    """Remove a book from history. If delete_file=true and the PDF lives under
    our uploads/ dir, delete the PDF too (but not files from arbitrary user
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
    safe_name = os.path.basename(file.filename) if file.filename else "upload.pdf"
    filepath = os.path.join(upload_dir, safe_name)
    logger.info("Receiving upload filename=%s content_type=%s target=%s", file.filename, file.content_type, filepath)
    content = await file.read()
    logger.info("Upload read complete filename=%s bytes=%s", file.filename, len(content))
    with open(filepath, "wb") as f:
        f.write(content)
    logger.info("Upload saved target=%s size_bytes=%s", filepath, os.path.getsize(filepath))
    return open_book(filepath)


@app.get("/api/book/{book_id}/page/{page_num}/image")
def get_page_image(book_id: str, page_num: int, dpi: int = 150):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    dpi = max(50, min(600, dpi))
    doc = BOOKS[book_id]["doc"]
    if doc is None:
        raise HTTPException(400, "This book has no page images (EPUB)")
    if page_num < 0 or page_num >= len(doc):
        raise HTTPException(400, "Invalid page number")
    png_bytes, w, h = pdf_service.render_page(doc, page_num, dpi)
    return Response(content=png_bytes, media_type="image/png",
                    headers={"X-Width": str(w), "X-Height": str(h)})


@app.get("/api/book/{book_id}/reflow")
def get_reflow(book_id: str):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    entry = BOOKS[book_id]
    if entry["state"].format != "epub":
        raise HTTPException(400, "Reflow only available for EPUB books")
    return reflow_service.get_or_build_reflow(entry["filepath"], DATA_DIR)


@app.get("/api/book/{book_id}/page/{page_num}/text")
def get_page_text(book_id: str, page_num: int, dpi: int = 150):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    dpi = max(50, min(600, dpi))
    entry = BOOKS[book_id]
    doc = entry["doc"]
    if doc is None:
        # EPUB: synthesize a PageText from the reflow chapter so the audio
        # pipeline can consume it without branching.
        reflow = reflow_service.get_or_build_reflow(entry["filepath"], DATA_DIR)
        chapters = reflow.get("chapters", [])
        if page_num < 0 or page_num >= len(chapters):
            raise HTTPException(400, "Invalid chapter index")
        chapter = chapters[page_num]
        from models import PageText, SentenceInfo
        sentences = []
        for block in chapter.get("blocks", []):
            if block.get("type") != "paragraph":
                continue
            for sent in block.get("sentences", []):
                text = sent.get("text", "").strip()
                if text:
                    sentences.append(SentenceInfo(text=text, words=[]))
        return PageText(
            page_number=page_num,
            sentences=sentences,
            render_width=0,
            render_height=0,
        ).model_dump()
    if page_num < 0 or page_num >= len(doc):
        raise HTTPException(400, "Invalid page number")
    page_text = pdf_service.extract_page_text(doc, page_num, dpi)
    return page_text.model_dump()


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
    index = _get_search_index(book_id)
    matches: list[dict] = []

    for row in index["rows"]:
        haystack = row["normalized_text"]
        phrase_match = query in haystack
        token_match = bool(tokens) and all(token in haystack for token in tokens)
        if not phrase_match and not token_match:
            continue

        score = 0
        if phrase_match:
            score += 100
        if haystack.startswith(query):
            score += 20
        score += max(0, 10 - row["page"])
        score += haystack.count(tokens[0]) if tokens else 0

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
    results = [{k: v for k, v in item.items() if k != "_score"} for item in matches[:limit]]
    return {
        "query": q,
        "format": index["format"],
        "total": total,
        "results": results,
    }


def _generate_audio(text, voice, speed, book_id):
    return tts_service.generate_sentence_audio(text, voice=voice, speed=speed, book_id=book_id)


def _job_key(book_id: str, page: int, sentence: int, voice: str, speed: float) -> str:
    speed = tts_service.validate_speed(speed)
    return f"kokoro|{book_id}|{page}|{sentence}|{tts_service.normalize_voice(voice)}|{speed}"


def _audio_cache_path(book_id: str, text: str, voice: str, speed: float) -> str:
    key = tts_service._cache_key(text, voice, speed)
    return os.path.join(tts_service.CACHE_DIR, f"{book_id}_{key}.wav")


def _get_sentence(book_id: str, page: int, sentence: int):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    entry = BOOKS[book_id]
    doc = entry["doc"]
    if doc is None:
        # EPUB: pull sentences from reflow
        data = get_page_text(book_id, page)
        sentences = data["sentences"]
        if sentence < 0 or sentence >= len(sentences):
            raise HTTPException(400, "Invalid sentence index")
        from models import SentenceInfo, PageText
        sent = SentenceInfo(**sentences[sentence])
        if not sent.text.strip():
            raise HTTPException(400, "Empty sentence")
        page_text = PageText(page_number=page, sentences=[SentenceInfo(**s) for s in sentences], render_width=0, render_height=0)
        return None, page_text, sent
    page_text = pdf_service.extract_page_text(doc, page)
    if sentence < 0 or sentence >= len(page_text.sentences):
        raise HTTPException(400, "Invalid sentence index")
    sent = page_text.sentences[sentence]
    if not sent.text.strip():
        raise HTTPException(400, "Empty sentence")
    return doc, page_text, sent


def _submit_tts_job(book_id: str, page: int, sentence: int, voice: str, speed: float, priority: int):
    _doc, _page_text, sent = _get_sentence(book_id, page, sentence)
    job_key = _job_key(book_id, page, sentence, voice, speed)
    job = TTS_MANAGER.submit(
        key=job_key,
        priority=priority,
        fn=lambda: _generate_audio(sent.text, voice, speed, book_id),
    )
    return job, sent


def _iter_sentence_window(book_id: str, page: int, sentence: int, count: int, include_current: bool = False):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    entry = BOOKS[book_id]
    doc = entry["doc"]
    if doc is None:
        # EPUB path — iterate chapters via reflow
        reflow = reflow_service.get_or_build_reflow(entry["filepath"], DATA_DIR)
        chapters = reflow.get("chapters", [])
        total_pages = len(chapters)
        def sentence_count(page_idx):
            if page_idx < 0 or page_idx >= len(chapters):
                return 0
            n = 0
            for b in chapters[page_idx].get("blocks", []):
                if b.get("type") == "paragraph":
                    n += sum(1 for s in b.get("sentences", []) if s.get("text", "").strip())
            return n
    else:
        total_pages = len(doc)
        def sentence_count(page_idx):
            return len(pdf_service.extract_page_text(doc, page_idx).sentences)

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
    voice: str = Query("af_heart"),
    speed: float = Query(tts_service.DEFAULT_SPEED, ge=tts_service.MIN_SPEED, le=tts_service.MAX_SPEED),
):
    job, _sent = _submit_tts_job(book_id, page, sentence, voice, speed, priority=0)
    filename, duration_ms = TTS_MANAGER.wait(job)
    return {"filename": filename, "duration_ms": duration_ms}


@app.post("/api/tts/buffer")
def buffer_tts(
    book_id: str = Query(...),
    page: int = Query(...),
    sentence: int = Query(...),
    count: int = Query(6, ge=1, le=24),
    voice: str = Query("af_heart"),
    speed: float = Query(tts_service.DEFAULT_SPEED, ge=tts_service.MIN_SPEED, le=tts_service.MAX_SPEED),
):
    """Queue the next N sentences after the current reader position.

    This is intentionally fire-and-forget: playback should never wait for the
    buffer endpoint, and the current sentence keeps priority 0 via /generate.
    """
    refs = _iter_sentence_window(book_id, page, sentence, count, include_current=False)
    queued: list[dict] = []
    skipped: list[dict] = []

    for offset, (page_num, sentence_idx) in enumerate(refs, start=1):
        job_key = _job_key(book_id, page_num, sentence_idx, voice, speed)
        status = TTS_MANAGER.status(job_key)
        if status in {"pending", "running"}:
            skipped.append({"page": page_num, "sentence": sentence_idx, "reason": status})
            continue

        _doc, _page_text, sent = _get_sentence(book_id, page_num, sentence_idx)
        if os.path.exists(_audio_cache_path(book_id, sent.text, voice, speed)):
            skipped.append({"page": page_num, "sentence": sentence_idx, "reason": "cached"})
            continue

        TTS_MANAGER.submit(
            key=job_key,
            priority=offset,
            fn=lambda text=sent.text: _generate_audio(text, voice, speed, book_id),
        )
        queued.append({"page": page_num, "sentence": sentence_idx})

    return {"requested": len(refs), "queued": queued, "skipped": skipped}


def _chapter_sentence_refs(book_id: str, page: int, voice: str, speed: float):
    """Return [(sentence_idx, text, expected_cache_filepath)] for every non-empty
    sentence on `page` (which is a chapter index for EPUB, a page index for PDF)."""
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    entry = BOOKS[book_id]
    if entry["doc"] is None:
        data = get_page_text(book_id, page)
        sentences = [s.get("text", "") for s in data["sentences"]]
    else:
        page_text = pdf_service.extract_page_text(entry["doc"], page)
        sentences = [s.text for s in page_text.sentences]

    refs = []
    for idx, text in enumerate(sentences):
        text = (text or "").strip()
        if not text:
            continue
        filepath = _audio_cache_path(book_id, text, voice, speed)
        refs.append((idx, text, filepath))
    return refs


@app.post("/api/book/{book_id}/preload-chapter")
def preload_chapter(
    book_id: str,
    page: int = Query(...),
    voice: str = Query("af_heart"),
    speed: float = Query(tts_service.DEFAULT_SPEED, ge=tts_service.MIN_SPEED, le=tts_service.MAX_SPEED),
):
    """Queue every sentence in the chapter/page for TTS generation at top priority."""
    refs = _chapter_sentence_refs(book_id, page, voice, speed)
    for offset, (sentence_idx, _text, _path) in enumerate(refs):
        _submit_tts_job(book_id, page, sentence_idx, voice, speed, priority=offset)
    return {"total": len(refs)}


@app.get("/api/book/{book_id}/preload-chapter/status")
def preload_chapter_status(
    book_id: str,
    page: int = Query(...),
    voice: str = Query("af_heart"),
    speed: float = Query(tts_service.DEFAULT_SPEED, ge=tts_service.MIN_SPEED, le=tts_service.MAX_SPEED),
):
    """Probe the audio cache for every sentence in the chapter. Cheap — no generation."""
    refs = _chapter_sentence_refs(book_id, page, voice, speed)
    ready = 0
    failed: list[int] = []
    active = 0
    for sentence_idx, _text, filepath in refs:
        if os.path.exists(filepath):
            ready += 1
            continue
        job_key = _job_key(book_id, page, sentence_idx, voice, speed)
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
    # Reject anything that isn't a plain wav filename so a request like
    # /api/audio/..%2F..%2F..%2Fetc%2Fpasswd can't escape the cache dir.
    if not _AUDIO_FILENAME_RE.match(filename):
        raise HTTPException(400, "Invalid audio filename")
    cache_dir = os.path.realpath(tts_service.CACHE_DIR)
    filepath = os.path.realpath(os.path.join(cache_dir, filename))
    if os.path.commonpath([cache_dir, filepath]) != cache_dir:
        raise HTTPException(400, "Invalid audio filename")
    if not os.path.isfile(filepath):
        raise HTTPException(404, "Audio not found")
    return FileResponse(filepath, media_type="audio/wav")


@app.get("/api/tts/voices")
def get_voices():
    try:
        return tts_service.get_available_voices()
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/book/{book_id}/position")
def save_position(book_id: str, position: Position):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    BOOKS[book_id]["state"].last_position = position
    _save_state(book_id)
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
    voice: str = Query(None),
    speed: float = Query(None, ge=tts_service.MIN_SPEED, le=tts_service.MAX_SPEED),
):
    if book_id not in BOOKS:
        raise HTTPException(404, "Book not loaded")
    state = BOOKS[book_id]["state"]
    if voice is not None:
        state.voice = voice
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
    index = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index):
        return FileResponse(index)
    return HTMLResponse("<h1>Frontend not built. Run: cd frontend && npm run build</h1>", status_code=500)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000)
