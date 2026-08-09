from __future__ import annotations

import gc
import hashlib
import math
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

from lazy_import import LazyModule

np = LazyModule("numpy")
sf = LazyModule("soundfile")

from model_manager import (
    ModelInstallRequired,
    load_state,
    set_state,
    update_progress,
    user_install_info,
)
from paths import AUDIO_CACHE_DIR, MODELS_DIR
from tts_defaults import (
    DEFAULT_SUPERTONIC_VOICE,
    DEFAULT_TTS_SPEED,
    SUPERTONIC_ENGINE_ID,
)

try:
    from text_chunker import CHUNKER_VERSION, HARD_MAX_TOKENS
except Exception:
    HARD_MAX_TOKENS = 280
    CHUNKER_VERSION = "tts-v1"

ENGINE_ID = SUPERTONIC_ENGINE_ID
ENGINE_LABEL = "Supertonic 3"
SDK_MODEL = "supertonic-3"
HF_REPO_ID = "Supertone/supertonic-3"
MODEL_REVISION = "724fb5abbf5502583fb520898d45929e62f02c0b"
DEFAULT_VOICE = DEFAULT_SUPERTONIC_VOICE
DEFAULT_LANGUAGE = "en"
DEFAULT_QUALITY_STEPS = 8
DEFAULT_SPEED = DEFAULT_TTS_SPEED
MIN_SPEED = 0.7
MAX_SPEED = 2.0
SAMPLE_RATE = 44100
SILENCE_DURATION = 0.0
MAX_CHUNK_LENGTH = max(1200, int(HARD_MAX_TOKENS) * 4)
CACHE_FORMAT_VERSION = "supertonic3-v1"
CACHE_DIR = str(AUDIO_CACHE_DIR)
EXPECTED_INSTALL_BYTES = 403_513_201

SUPERTONIC_VOICES = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"]
REQUIRED_MODEL_FILES = [
    "onnx/duration_predictor.onnx",
    "onnx/text_encoder.onnx",
    "onnx/vector_estimator.onnx",
    "onnx/vocoder.onnx",
    "onnx/tts.json",
    "onnx/unicode_indexer.json",
    *[f"voice_styles/{voice}.json" for voice in SUPERTONIC_VOICES],
]

os.makedirs(CACHE_DIR, exist_ok=True)

_tts: Any | None = None
_model_loading = False
_download_active = False
_download_bytes = 0
_download_total_bytes = 0
_download_label: str | None = None
_download_error: str | None = None
_last_load_error: str | None = None
_selected_provider: str | None = None
_selected_model_path: str | None = None
_selected_model_identity: dict | None = None
_voice_styles: dict[str, Any] = {}
_model_lock = threading.Lock()
_install_lock = threading.Lock()
_install_cancel = threading.Event()
_install_thread: threading.Thread | None = None
_generation_slots = threading.BoundedSemaphore(1)
_inflight_lock = threading.Lock()
_inflight: dict[str, threading.Event] = {}
_inflight_errors: dict[str, Exception] = {}
_cache_lock = threading.Lock()
_identity_cache: dict[tuple[str, int, int], dict] = {}
_installed_bytes_cache: tuple[str, float, int] | None = None
_INSTALLED_BYTES_CACHE_TTL = 15.0
_install_state = load_state(ENGINE_ID, ENGINE_LABEL, EXPECTED_INSTALL_BYTES)


def model_dir() -> str:
    return str(Path(MODELS_DIR) / SDK_MODEL)


def _required_path(relative: str) -> str:
    return str(Path(model_dir()) / relative)


def _valid_file(path: str) -> bool:
    try:
        return os.path.isfile(path) and os.path.getsize(path) > 0
    except OSError:
        return False


def _asset_size(path: str) -> int:
    try:
        if os.path.isfile(path):
            return os.path.getsize(path)
        if os.path.isdir(path):
            total = 0
            for root, _dirs, files in os.walk(path):
                for name in files:
                    try:
                        total += os.path.getsize(os.path.join(root, name))
                    except OSError:
                        pass
            return total
    except OSError:
        pass
    return 0


def _assets_ready() -> bool:
    return all(_valid_file(_required_path(relative)) for relative in REQUIRED_MODEL_FILES)


def _asset_manifest() -> list[dict]:
    base = model_dir()
    return [
        {
            "filename": relative.replace("\\", "/"),
            "path": _required_path(relative),
            "present": _valid_file(_required_path(relative)),
        }
        for relative in REQUIRED_MODEL_FILES
    ] + [
        {
            "filename": "LICENSE",
            "path": str(Path(base) / "LICENSE"),
            "present": _valid_file(str(Path(base) / "LICENSE")),
        }
    ]


def _installed_bytes() -> int:
    global _installed_bytes_cache
    path = model_dir()
    now = time.monotonic()
    cached = _installed_bytes_cache
    if (
        not _download_active
        and cached is not None
        and cached[0] == path
        and now - cached[1] < _INSTALLED_BYTES_CACHE_TTL
    ):
        return cached[2]
    installed = _asset_size(path)
    _installed_bytes_cache = (path, now, installed)
    return installed


def _sync_install_state() -> dict:
    global _install_state
    installed = _installed_bytes()
    if _assets_ready():
        _install_state = set_state(
            _install_state,
            "ready",
            ready=True,
            error=None,
            downloaded_bytes=installed,
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
    elif _install_state.get("state") == "ready":
        _install_state = set_state(
            _install_state,
            "not_installed",
            ready=False,
            error=None,
            downloaded_bytes=installed,
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
    else:
        _install_state = update_progress(_install_state, installed, EXPECTED_INSTALL_BYTES)
    return _install_state


def get_install_info() -> dict:
    state = user_install_info(_sync_install_state())
    state.update(
        {
            "installed": _assets_ready(),
            "manifest": _asset_manifest(),
            "download_active": _download_active,
            "download_label": _download_label or "Supertonic 3 model assets",
            "download_error": _download_error or state.get("error"),
            "model_dir": model_dir(),
            "repo_id": HF_REPO_ID,
            "revision": MODEL_REVISION,
            "license": "OpenRAIL-M",
        }
    )
    if _download_active:
        total = _download_total_bytes or state["total_bytes"]
        downloaded = _download_bytes
        state["state"] = "downloading"
        state["downloaded_bytes"] = downloaded
        state["total_bytes"] = total
        state["progress"] = max(0.0, min(1.0, downloaded / total)) if total else 0.0
    return state


def _load_sdk_tts():
    from supertonic import TTS

    return TTS


def _download_model_assets() -> None:
    global _download_active, _download_bytes, _download_total_bytes, _download_label, _download_error

    _download_active = True
    _download_bytes = _installed_bytes()
    _download_total_bytes = EXPECTED_INSTALL_BYTES
    _download_label = "Supertonic 3 model assets"
    _download_error = None
    try:
        if _install_cancel.is_set():
            raise RuntimeError("Download cancellation requested.")
        from supertonic.loader import download_model

        download_model(model_dir(), SDK_MODEL)
        if _install_cancel.is_set():
            raise RuntimeError("Download cancellation requested.")
        if not _assets_ready():
            raise RuntimeError(f"Supertonic 3 assets are incomplete in {model_dir()}")
        _download_bytes = _installed_bytes()
        update_progress(_install_state, _download_bytes, EXPECTED_INSTALL_BYTES)
    except Exception as exc:
        _download_error = str(exc)
        raise
    finally:
        _download_active = False


def require_ready_for_generation() -> None:
    info = get_install_info()
    if not info["ready"] and not _assets_ready():
        if info["state"] == "failed":
            message = info.get("error") or "Supertonic 3 install failed. Retry the download."
        elif info["state"] in {"download_queued", "downloading", "verifying"}:
            message = "Supertonic 3 is still being installed."
        else:
            message = (
                "Supertonic 3 model assets are not installed yet. "
                "Download them from the model prompt before generating audio."
            )
        raise ModelInstallRequired(ENGINE_ID, str(info["state"]), message)


def _install_worker() -> None:
    global _install_state, _install_thread, _download_error, _last_load_error
    try:
        _install_state = set_state(
            _install_state,
            "downloading",
            ready=False,
            error=None,
            downloaded_bytes=_installed_bytes(),
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
        _download_error = None
        _last_load_error = None
        _download_model_assets()
        if _install_cancel.is_set():
            raise RuntimeError("Download cancellation requested.")
        _install_state = set_state(
            _install_state,
            "verifying",
            ready=False,
            error=None,
            downloaded_bytes=_installed_bytes(),
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
        if not _assets_ready():
            raise RuntimeError("Supertonic 3 install finished but required assets are still missing.")
        _install_state = set_state(
            _install_state,
            "ready",
            ready=True,
            error=None,
            downloaded_bytes=_installed_bytes(),
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
    except Exception as exc:
        _download_error = str(exc)
        _last_load_error = str(exc)
        _install_state = set_state(
            _install_state,
            "failed",
            ready=False,
            error=str(exc),
            downloaded_bytes=_installed_bytes(),
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
    finally:
        with _install_lock:
            _install_thread = None


def start_install() -> dict:
    global _install_thread, _install_state
    with _install_lock:
        if _assets_ready():
            _sync_install_state()
            return get_install_info()
        if _install_thread and _install_thread.is_alive():
            return get_install_info()
        _install_cancel.clear()
        _install_state = set_state(
            _install_state,
            "download_queued",
            ready=False,
            error=None,
            downloaded_bytes=_installed_bytes(),
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
        _install_thread = threading.Thread(target=_install_worker, name="supertonic-install", daemon=True)
        _install_thread.start()
    return get_install_info()


def cancel_install() -> dict:
    global _install_state
    _install_cancel.set()
    if _download_active or (_install_thread and _install_thread.is_alive()):
        _install_state = set_state(
            _install_state,
            "failed",
            ready=False,
            error="Download cancellation requested. Supertonic may finish the current file before stopping.",
            downloaded_bytes=_installed_bytes(),
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
    return get_install_info()


def retry_install() -> dict:
    global _install_state
    _install_cancel.clear()
    _install_state = set_state(
        _install_state,
        "not_installed",
        ready=False,
        error=None,
        downloaded_bytes=_installed_bytes(),
        total_bytes=EXPECTED_INSTALL_BYTES,
    )
    return start_install()


def is_model_loaded() -> bool:
    return _tts is not None


def is_model_loading() -> bool:
    return _model_loading


def is_download_active() -> bool:
    return _download_active


def is_gpu_enabled() -> bool:
    return False


def validate_speed(speed: float | str | None) -> float:
    if speed is None:
        speed = DEFAULT_SPEED
    try:
        value = float(speed)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid speed: {speed!r}") from exc
    if not math.isfinite(value) or value < MIN_SPEED or value > MAX_SPEED:
        raise ValueError(f"Speed must be between {MIN_SPEED} and {MAX_SPEED}")
    return round(value, 3)


def normalize_voice(voice: str | None) -> str:
    return voice if voice in SUPERTONIC_VOICES else DEFAULT_VOICE


def get_available_voices() -> list[str]:
    return list(SUPERTONIC_VOICES)


def _partial_sha256(path: str, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        first = f.read(chunk_size)
        digest.update(first)
        if size > chunk_size:
            f.seek(max(size - chunk_size, 0))
            digest.update(f.read(chunk_size))
    return digest.hexdigest()[:16]


def _model_identity() -> dict:
    marker = _required_path("onnx/vector_estimator.onnx")
    if _valid_file(marker):
        return model_file_identity(marker)
    return {
        "filename": "supertonic-3",
        "size_bytes": 0,
        "sha256_partial": "missing",
    }


def model_file_identity(path: str) -> dict:
    stat = os.stat(path)
    cache_key = (os.path.abspath(path), stat.st_size, stat.st_mtime_ns)
    with _cache_lock:
        cached = _identity_cache.get(cache_key)
    if cached is not None:
        return dict(cached)
    identity = {
        "filename": os.path.basename(path),
        "size_bytes": stat.st_size,
        "sha256_partial": _partial_sha256(path),
    }
    with _cache_lock:
        _identity_cache[cache_key] = identity
    return dict(identity)


def _set_selected_runtime(model: Any) -> None:
    global _selected_model_path, _selected_model_identity, _selected_provider
    _selected_model_path = model_dir()
    _selected_model_identity = _model_identity()
    _selected_provider = "CPUExecutionProvider"
    try:
        runtime = getattr(model, "_tts", None) or getattr(model, "model", None) or model
        providers: list[str] = []
        for attr in ("dp_ort", "text_enc_ort", "vector_est_ort", "vocoder_ort"):
            session = getattr(runtime, attr, None)
            if session is not None and hasattr(session, "get_providers"):
                providers.extend(session.get_providers())
        if providers:
            _selected_provider = providers[0]
    except Exception:
        pass


def get_model():
    global _tts, _model_loading, _last_load_error
    if _tts is not None:
        return _tts
    with _model_lock:
        if _tts is not None:
            return _tts
        require_ready_for_generation()
        _model_loading = True
        _last_load_error = None
        try:
            TTS = _load_sdk_tts()
            model = TTS(model=SDK_MODEL, model_dir=model_dir(), auto_download=False)
            _tts = model
            _set_selected_runtime(model)
            print(
                "Supertonic 3 loaded "
                f"model_dir={model_dir()} provider={_selected_provider} sample_rate={SAMPLE_RATE}"
            )
            return _tts
        except Exception as exc:
            _last_load_error = str(exc)
            raise
        finally:
            _model_loading = False


def _voice_style(voice: str):
    voice = normalize_voice(voice)
    style = _voice_styles.get(voice)
    if style is not None:
        return style
    with _model_lock:
        style = _voice_styles.get(voice)
        if style is not None:
            return style
        model = get_model()
        style = model.get_voice_style(voice_name=voice)
        _voice_styles[voice] = style
        return style


def unload_model() -> bool:
    global _tts, _selected_provider, _selected_model_path, _selected_model_identity
    if _tts is None:
        return False
    try:
        _tts = None
        _voice_styles.clear()
        _selected_provider = None
        _selected_model_path = None
        _selected_model_identity = None
        gc.collect()
        print("Supertonic 3 TTS unloaded")
        return True
    except Exception:
        return False


def _cache_runtime_identity() -> tuple[str, int, str]:
    identity = _selected_model_identity or _model_identity()
    return (
        identity["filename"],
        int(identity["size_bytes"]),
        identity["sha256_partial"],
    )


def _cache_key(text: str, voice: str, speed: float) -> str:
    text = re.sub(r"\s+", " ", (text or "")).strip()
    voice = normalize_voice(voice)
    speed = validate_speed(speed)
    filename, size_bytes, sha256_partial = _cache_runtime_identity()
    raw = "|".join(
        [
            CACHE_FORMAT_VERSION,
            ENGINE_ID,
            SDK_MODEL,
            MODEL_REVISION,
            CHUNKER_VERSION,
            text,
            voice,
            DEFAULT_LANGUAGE,
            str(speed),
            str(DEFAULT_QUALITY_STEPS),
            str(MAX_CHUNK_LENGTH),
            str(SILENCE_DURATION),
            filename,
            str(size_bytes),
            sha256_partial,
        ]
    )
    return hashlib.md5(raw.encode()).hexdigest()


def audio_cache_path(book_id: str, text: str, voice: str, speed: float) -> str:
    cache_key = _cache_key(text, voice, speed)
    name = f"{book_id}_{ENGINE_ID}_{cache_key}.wav"
    return os.path.join(CACHE_DIR, name)


def _cached_duration_ms(filepath: str) -> float | None:
    if not os.path.exists(filepath):
        return None
    try:
        info = sf.info(filepath)
        if info.frames <= 0 or info.samplerate <= 0:
            raise RuntimeError("Cached audio has no samples")
        return info.frames / info.samplerate * 1000
    except Exception:
        try:
            os.remove(filepath)
        except OSError:
            pass
        return None


def _write_wav_atomic(filepath: str, samples: np.ndarray, sample_rate: int) -> None:
    tmp = f"{filepath}.tmp.{os.getpid()}.{threading.get_ident()}"
    try:
        sf.write(tmp, samples, sample_rate, format="WAV")
        os.replace(tmp, filepath)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def generate_sentence_audio(
    text: str,
    voice: str = DEFAULT_VOICE,
    speed: float = DEFAULT_SPEED,
    book_id: str = "",
) -> tuple[str, float]:
    voice = normalize_voice(voice)
    speed = validate_speed(speed)

    def cached_path() -> tuple[str, str]:
        path = audio_cache_path(book_id, text, voice, speed)
        return os.path.basename(path), path

    filename, filepath = cached_path()
    inflight_path = filepath

    duration_ms = _cached_duration_ms(filepath)
    if duration_ms is not None:
        return filename, duration_ms

    should_generate = False
    with _inflight_lock:
        event = _inflight.get(filepath)
        if event is None:
            event = threading.Event()
            _inflight[filepath] = event
            should_generate = True

    if not should_generate:
        event.wait()
        duration_ms = _cached_duration_ms(filepath)
        if duration_ms is not None:
            return filename, duration_ms
        err = _inflight_errors.pop(inflight_path, RuntimeError("Audio generation failed"))
        raise err

    try:
        with _generation_slots:
            duration_ms = _cached_duration_ms(filepath)
            if duration_ms is not None:
                return filename, duration_ms
            model = get_model()
            style = _voice_style(voice)
            wav, duration = model.synthesize(
                text=text,
                voice_style=style,
                lang=DEFAULT_LANGUAGE,
                total_steps=DEFAULT_QUALITY_STEPS,
                speed=speed,
                max_chunk_length=MAX_CHUNK_LENGTH,
                silence_duration=SILENCE_DURATION,
                verbose=False,
            )
            samples = np.asarray(wav, dtype=np.float32).squeeze()
            if samples.ndim != 1:
                samples = samples.reshape(-1)
            sample_rate = int(getattr(model, "sample_rate", SAMPLE_RATE) or SAMPLE_RATE)
            _write_wav_atomic(filepath, samples, sample_rate)
            if isinstance(duration, (int, float, np.number)) and float(duration) > 0:
                duration_ms = float(duration) * 1000.0
            else:
                duration_ms = len(samples) / sample_rate * 1000.0
            return filename, duration_ms
    except Exception as exc:
        _inflight_errors[inflight_path] = exc
        raise
    finally:
        with _inflight_lock:
            done_event = _inflight.pop(inflight_path, None)
        if done_event is not None:
            done_event.set()


def get_runtime_info() -> dict:
    install = get_install_info()
    return {
        "model": SDK_MODEL,
        "repo_id": HF_REPO_ID,
        "revision": MODEL_REVISION,
        "model_dir": model_dir(),
        "model_loaded": is_model_loaded(),
        "model_loading": is_model_loading(),
        "download_active": _download_active,
        "download_bytes": _download_bytes,
        "download_total_bytes": _download_total_bytes,
        "download_label": _download_label,
        "download_error": _download_error,
        "install_state": install["state"],
        "install_ready": install["ready"],
        "installed": install["installed"],
        "install_error": install.get("error"),
        "selected_provider": _selected_provider,
        "selected_model_path": _selected_model_path,
        "selected_model_identity": _selected_model_identity or (_model_identity() if _assets_ready() else None),
        "last_load_error": _last_load_error,
        "sample_rate": SAMPLE_RATE,
        "default_voice": DEFAULT_VOICE,
        "default_language": DEFAULT_LANGUAGE,
        "default_speed": DEFAULT_SPEED,
        "speed_min": MIN_SPEED,
        "speed_max": MAX_SPEED,
        "quality_steps": DEFAULT_QUALITY_STEPS,
        "max_chunk_length": MAX_CHUNK_LENGTH,
        "silence_duration": SILENCE_DURATION,
        "voices": get_available_voices(),
        "license": "OpenRAIL-M",
    }


def log_runtime_environment() -> None:
    print(f"Supertonic 3 model dir: {model_dir()}")
    print(f"Supertonic 3 assets ready: {_assets_ready()}")
    print(f"Supertonic 3 voice styles present: {_valid_file(_required_path('voice_styles/M1.json'))}")
    print(f"Supertonic 3 revision: {MODEL_REVISION}")
