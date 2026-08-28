from __future__ import annotations

import gc
import glob
import hashlib
import math
import os
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

from lazy_import import LazyAttribute, LazyModule

np = LazyModule("numpy")
sf = LazyModule("soundfile")

# Add NVIDIA CUDA DLL directories to PATH before importing onnxruntime.
_site_packages = os.path.join(
    os.path.expanduser("~"),
    "AppData",
    "Roaming",
    "Python",
    f"Python{sys.version_info.major}{sys.version_info.minor}",
    "site-packages",
)
_site_package_candidates = [
    os.path.join(sys.prefix, "Lib", "site-packages"),
    _site_packages,
]
_dll_dir_handles = []


def _add_runtime_path(path: str) -> None:
    if not os.path.isdir(path):
        return
    path = os.path.abspath(path)
    current = os.environ.get("PATH", "")
    if path.lower() not in {p.lower() for p in current.split(os.pathsep) if p}:
        os.environ["PATH"] = path + os.pathsep + current
    if hasattr(os, "add_dll_directory"):
        try:
            _dll_dir_handles.append(os.add_dll_directory(path))
        except OSError:
            pass


for _candidate in _site_package_candidates:
    for _nvidia_bin in glob.glob(os.path.join(_candidate, "nvidia", "*", "bin")):
        _add_runtime_path(_nvidia_bin)
    _add_runtime_path(os.path.join(_candidate, "torch", "lib"))

ort = LazyModule("onnxruntime")
Kokoro = LazyAttribute("kokoro_onnx", "Kokoro")

from misaki_g2p import REVISION as MISAKI_G2P_REVISION
from misaki_g2p import STRATEGY as MISAKI_G2P_STRATEGY
from misaki_g2p import MisakiEnglishG2P
from model_manager import (
    ModelInstallRequired,
    load_state,
    set_state,
    update_progress,
    user_install_info,
)
from paths import AUDIO_CACHE_DIR, MODELS_DIR
from tts_defaults import DEFAULT_KOKORO_VOICE, DEFAULT_TTS_SPEED, KOKORO_ENGINE_ID

try:
    from text_chunker import CHUNKER_VERSION
except Exception:
    CHUNKER_VERSION = "tts-v1"

SAMPLE_RATE = 24000
CACHE_DIR = str(AUDIO_CACHE_DIR)
os.makedirs(CACHE_DIR, exist_ok=True)
DEFAULT_VOICE = DEFAULT_KOKORO_VOICE
DEFAULT_SPEED = DEFAULT_TTS_SPEED
MIN_SPEED = 0.75
MAX_SPEED = 1.35
CACHE_FORMAT_VERSION = "kokoro-v3"
KOKORO_VOICES = [
    "af_heart",
    "af_bella",
    "af_nicole",
    "bf_emma",
    "af_sarah",
    "af_aoede",
]
PREPROCESSING_VERSION = CHUNKER_VERSION
PROVIDER_ENV = "KOKORO_ONNX_PROVIDER"
SETUP_COMMAND = "python backend/setup_kokoro_models.py"
QUALITY_MODEL_FILENAME = "kokoro-v1.0.onnx"
QUALITY_MODEL_SOURCE_ALIAS = "model.onnx"
INT8_FALLBACK_MODEL_FILENAME = "kokoro-v1.0.int8.onnx"
VOICES_FILENAME = "voices-v1.0.bin"
WARMUP_TEXT = os.environ.get("KOKORO_WARMUP_TEXT", "Ready.")
MODEL_SOURCES = [
    (
        "GitHub kokoro-onnx release",
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    ),
    (
        "Hugging Face onnx-community/Kokoro-82M-v1.0-ONNX",
        "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx?download=true",
    ),
]
VOICE_SOURCES = [
    (
        "GitHub kokoro-onnx release",
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
    ),
]
ENGINE_ID = KOKORO_ENGINE_ID
ENGINE_LABEL = "Kokoro"
EXPECTED_MODEL_BYTES = 325_532_387
EXPECTED_VOICES_BYTES = 28_214_398
EXPECTED_INSTALL_BYTES = EXPECTED_MODEL_BYTES + EXPECTED_VOICES_BYTES

_kokoro: Kokoro | None = None
_gpu_enabled: bool = False
_model_loading: bool = False
_download_active: bool = False
_download_bytes: int = 0
_download_total_bytes: int = 0
_download_label: str | None = None
_download_error: str | None = None
_selected_provider: str | None = None
_selected_model_path: str | None = None
_selected_model_identity: dict | None = None
_selected_cuda_mem_limit_mb: int | None = None
_gpu_smoke_passed: bool | None = None
_gpu_smoke_error: str | None = None
_cpu_fallback_used: bool = False
_cpu_smoke_passed: bool | None = None
_int8_fallback_used: bool = False
_setup_error: str | None = None
_last_load_error: str | None = None
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
_installed_bytes_cache: tuple[float, int] | None = None
_available_voices_cache: tuple[str, int, int, list[str]] | None = None
_INSTALL_METADATA_CACHE_TTL = 15.0
_install_state = load_state(ENGINE_ID, ENGINE_LABEL, EXPECTED_INSTALL_BYTES)
_english_g2p = MisakiEnglishG2P()


def _install_kokoro_espeak_compat() -> None:
    """Bridge kokoro-onnx 0.4.x to newer phonemizer wrappers on Windows."""
    try:
        from phonemizer.backend.espeak import wrapper as espeak_wrapper
    except Exception:
        return

    if hasattr(espeak_wrapper.EspeakWrapper, "set_data_path"):
        return

    def set_data_path(cls, data_path):
        cls._folio_espeak_data_path = str(data_path) if data_path else None

    original_init = espeak_wrapper.EspeakAPI.__init__

    if getattr(original_init, "_folio_data_path_patch", False):
        espeak_wrapper.EspeakWrapper.set_data_path = classmethod(set_data_path)
        return

    def init_with_data_path(self, library):
        import atexit
        import ctypes
        import pathlib
        import shutil
        import tempfile
        import weakref

        self._library = None
        try:
            espeak = ctypes.cdll.LoadLibrary(str(library))
            library_path = self._shared_library_path(espeak)
            del espeak
        except OSError as error:
            raise RuntimeError(f"failed to load espeak library: {error!s}") from None

        # Keep the native eSpeak copy under Folio's app-data root so a crash
        # cannot leave an unowned runtime directory in the user's global temp.
        runtime_temp_dir = MODELS_DIR.parent / "temp"
        runtime_temp_dir.mkdir(parents=True, exist_ok=True)
        self._tempdir = tempfile.mkdtemp(prefix="espeak-", dir=str(runtime_temp_dir))
        if sys.platform == "win32":
            atexit.register(self._delete_win32)
        else:
            weakref.finalize(self, self._delete, self._library, self._tempdir)

        espeak_copy = pathlib.Path(self._tempdir) / library_path.name
        shutil.copy(library_path, espeak_copy, follow_symlinks=False)

        self._library = ctypes.cdll.LoadLibrary(str(espeak_copy))
        data_path = getattr(espeak_wrapper.EspeakWrapper, "_folio_espeak_data_path", None)
        data_arg = os.fsencode(data_path) if data_path else None
        try:
            if self._library.espeak_Initialize(0x02, 0, data_arg, 0) <= 0:
                raise RuntimeError("failed to initialize espeak shared library")
        except AttributeError:
            raise RuntimeError("failed to load espeak library") from None

        self._library_path = library_path

    init_with_data_path._folio_data_path_patch = True
    espeak_wrapper.EspeakWrapper.set_data_path = classmethod(set_data_path)
    espeak_wrapper.EspeakAPI.__init__ = init_with_data_path


_install_kokoro_espeak_compat()


def is_model_loaded() -> bool:
    return _kokoro is not None


def is_model_loading() -> bool:
    return _model_loading


def is_download_active() -> bool:
    return _download_active


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


def _models_dir() -> str:
    return str(MODELS_DIR)


def quality_model_path() -> str:
    return os.path.join(_models_dir(), QUALITY_MODEL_FILENAME)


def quality_model_alias_path() -> str:
    return os.path.join(_models_dir(), QUALITY_MODEL_SOURCE_ALIAS)


def int8_fallback_model_path() -> str:
    return os.path.join(_models_dir(), INT8_FALLBACK_MODEL_FILENAME)


def voices_path() -> str:
    return os.path.join(_models_dir(), VOICES_FILENAME)


def _is_lfs_pointer(path: str) -> bool:
    try:
        if os.path.getsize(path) > 1024:
            return False
        with open(path, "rb") as f:
            head = f.read(256)
        return head.startswith(b"version https://git-lfs.github.com/spec/")
    except OSError:
        return False


def _valid_file(path: str) -> bool:
    return os.path.exists(path) and not _is_lfs_pointer(path)


def _asset_size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _download_asset(
    destination: str,
    sources: list[tuple[str, str]],
    *,
    label: str,
    cancel_event: threading.Event | None = None,
) -> None:
    global _download_active, _download_bytes, _download_total_bytes, _download_label, _download_error

    os.makedirs(os.path.dirname(destination), exist_ok=True)
    last_error: Exception | None = None
    for source_name, url in sources:
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{os.path.basename(destination)}.",
            suffix=".tmp",
            dir=os.path.dirname(destination),
        )
        os.close(fd)
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Folio-Kokoro/1.0"})
            _download_active = True
            _download_bytes = 0
            _download_total_bytes = 0
            _download_label = f"{label} from {source_name}"
            _download_error = None
            print(f"Kokoro first-run download starting: {_download_label}")
            with urllib.request.urlopen(request, timeout=60) as response:
                total_header = response.headers.get("Content-Length")
                _download_total_bytes = int(total_header) if total_header and total_header.isdigit() else 0
                with open(tmp_name, "wb") as f:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if cancel_event and cancel_event.is_set():
                            raise RuntimeError("Download cancelled")
                        if not chunk:
                            break
                        f.write(chunk)
                        _download_bytes += len(chunk)
            if _is_lfs_pointer(tmp_name):
                raise RuntimeError(f"Downloaded Git LFS pointer instead of model asset from {url}")
            os.replace(tmp_name, destination)
            _download_bytes = _asset_size(destination)
            if _download_total_bytes <= 0:
                _download_total_bytes = _download_bytes
            print(f"Kokoro first-run download saved: {destination}")
            return
        except (OSError, RuntimeError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            last_error = exc
            _download_error = str(exc)
            print(f"Kokoro first-run download failed from {source_name}: {exc}")
        finally:
            try:
                if os.path.exists(tmp_name):
                    os.remove(tmp_name)
            except OSError:
                pass
            _download_active = False

    raise RuntimeError(f"Could not download {label}: {last_error}")


def _normalize_manual_model_alias() -> None:
    alias = quality_model_alias_path()
    target = quality_model_path()
    if _valid_file(alias) and not _valid_file(target):
        print(f"Kokoro found {QUALITY_MODEL_SOURCE_ALIAS}; moving it to {QUALITY_MODEL_FILENAME}")
        os.replace(alias, target)


def ensure_model_assets() -> None:
    """Download Kokoro assets on first use into the writable runtime models dir."""
    _normalize_manual_model_alias()
    model_path = quality_model_path()
    voices = voices_path()
    if not _valid_file(model_path):
        _download_asset(model_path, MODEL_SOURCES, label="Kokoro v1.0 model")
    if not _valid_file(voices):
        _download_asset(voices, VOICE_SOURCES, label="Kokoro voices")


def _asset_manifest() -> list[dict]:
    return [
        {
            "filename": QUALITY_MODEL_FILENAME,
            "path": quality_model_path(),
            "size_bytes": EXPECTED_MODEL_BYTES,
        },
        {
            "filename": VOICES_FILENAME,
            "path": voices_path(),
            "size_bytes": EXPECTED_VOICES_BYTES,
        },
    ]


def _installed_bytes() -> int:
    global _installed_bytes_cache
    now = time.monotonic()
    if (
        not _download_active
        and _installed_bytes_cache is not None
        and now - _installed_bytes_cache[0] < _INSTALL_METADATA_CACHE_TTL
    ):
        return _installed_bytes_cache[1]
    installed = sum(_asset_size(item["path"]) for item in _asset_manifest())
    _installed_bytes_cache = (now, installed)
    return installed


def _assets_ready() -> bool:
    _normalize_manual_model_alias()
    return _valid_file(voices_path()) and (
        _valid_file(quality_model_path()) or _valid_file(int8_fallback_model_path())
    )


def _quality_assets_ready() -> bool:
    _normalize_manual_model_alias()
    return _valid_file(quality_model_path()) and _valid_file(voices_path())


def _sync_install_state() -> dict:
    global _install_state
    if _assets_ready():
        _install_state = set_state(
            _install_state,
            "ready",
            ready=True,
            error=None,
            downloaded_bytes=_installed_bytes(),
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
    elif _install_state.get("state") == "ready":
        _install_state = set_state(
            _install_state,
            "not_installed",
            ready=False,
            error=None,
            downloaded_bytes=_installed_bytes(),
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
    else:
        _install_state = update_progress(_install_state, _installed_bytes(), EXPECTED_INSTALL_BYTES)
    return _install_state


def get_install_info() -> dict:
    state = user_install_info(_sync_install_state())
    state.update(
        {
            "installed": _assets_ready(),
            "manifest": _asset_manifest(),
            "download_active": _download_active,
            "download_label": _download_label or "Kokoro model assets",
            "download_error": _download_error or state.get("error"),
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


def require_ready_for_generation() -> None:
    info = get_install_info()
    if not info["ready"] and not _assets_ready():
        if info["state"] == "failed":
            message = info.get("error") or "Kokoro install failed. Retry the download."
        elif info["state"] in {"download_queued", "downloading", "verifying"}:
            message = "Kokoro is still being installed."
        else:
            message = "Kokoro is not installed yet."
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
        _download_asset(
            quality_model_path(),
            MODEL_SOURCES,
            label="Kokoro v1.0 model",
            cancel_event=_install_cancel,
        )
        update_progress(_install_state, _installed_bytes(), EXPECTED_INSTALL_BYTES)
        _download_asset(
            voices_path(),
            VOICE_SOURCES,
            label="Kokoro voices",
            cancel_event=_install_cancel,
        )
        _install_state = set_state(
            _install_state,
            "verifying",
            ready=False,
            error=None,
            downloaded_bytes=_installed_bytes(),
            total_bytes=EXPECTED_INSTALL_BYTES,
        )
        if not _quality_assets_ready():
            raise RuntimeError("Kokoro install finished but required assets are still missing.")
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
        _install_thread = threading.Thread(target=_install_worker, name="kokoro-install", daemon=True)
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
            error="Download cancelled.",
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


def _requested_provider() -> str:
    requested = os.environ.get(PROVIDER_ENV, "auto").strip().lower()
    if requested in {"", "auto"}:
        return "auto"
    if requested in {"cuda", "gpu", "cudaexecutionprovider"}:
        return "cuda"
    if requested in {"cpu", "cpuexecutionprovider"}:
        return "cpu"
    print(f"Unknown Kokoro provider request {requested!r}; using auto")
    return "auto"


def _partial_sha256(path: str, chunk_size: int = 1024 * 1024) -> str:
    size = os.path.getsize(path)
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        first = f.read(chunk_size)
        digest.update(first)
        if size > chunk_size:
            f.seek(max(size - chunk_size, 0))
            digest.update(f.read(chunk_size))
    return digest.hexdigest()[:16]


def model_file_identity(path: str) -> dict:
    stat = os.stat(path)
    cache_key = (os.path.abspath(path), stat.st_size, stat.st_mtime_ns)
    cached = _identity_cache.get(cache_key)
    if cached is not None:
        return dict(cached)
    identity = {
        "filename": os.path.basename(path),
        "size_bytes": stat.st_size,
        "sha256_partial": _partial_sha256(path),
    }
    _identity_cache[cache_key] = identity
    return dict(identity)


def _quality_setup_error() -> str | None:
    path = quality_model_path()
    if _valid_file(path):
        return None
    if os.path.exists(path) and _is_lfs_pointer(path):
        return (
            f"Full-quality Kokoro model is still a Git LFS pointer: {path}. "
            "Folio will try to download it automatically on first use."
        )
    alias = quality_model_alias_path()
    if _valid_file(alias):
        return (
            f"Found {QUALITY_MODEL_SOURCE_ALIAS}, but Folio expects "
            f"{QUALITY_MODEL_FILENAME}. Folio will rename it automatically on first use."
        )
    return (
        f"Full-quality Kokoro model missing: {path}. "
        "Folio will download it automatically on first use."
    )


def _select_quality_model() -> str | None:
    path = quality_model_path()
    return path if _valid_file(path) else None


def _select_int8_fallback_model() -> str | None:
    path = int8_fallback_model_path()
    return path if _valid_file(path) else None


def _cache_provider_candidate() -> str:
    requested_provider = _requested_provider()
    if requested_provider == "cpu":
        return "CPUExecutionProvider"

    try:
        providers = set(ort.get_available_providers())
    except Exception:
        providers = set()

    if requested_provider in {"auto", "cuda"} and "CUDAExecutionProvider" in providers:
        return "CUDAExecutionProvider"
    return "CPUExecutionProvider"


def _cache_model_candidate() -> str | None:
    return _select_quality_model() or _select_int8_fallback_model()


def _cuda_mem_limit_candidates() -> list[int]:
    raw = os.environ.get("KOKORO_CUDA_MEM_LIMIT_MB", "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError:
            print(f"Invalid KOKORO_CUDA_MEM_LIMIT_MB={raw!r}; using adaptive CUDA limits")
        else:
            return [value]

    # Try the smallest practical arenas first and grow only if smoke inference
    # proves the model needs more. This avoids the old always-1536MB cap forcing
    # CPU fallback while still not reserving a giant CUDA arena by default.
    return [2048, 2560, 3072, 3584, 4096]


def _cleanup_failed_cuda_attempt() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _make_session(model_path: str, provider: str, cuda_mem_limit_mb: int | None = None):
    if provider == "CUDAExecutionProvider":
        mem_limit_mb = cuda_mem_limit_mb or _cuda_mem_limit_candidates()[0]
        providers = [
            (
                "CUDAExecutionProvider",
                {
                    "gpu_mem_limit": mem_limit_mb * 1024 * 1024,
                    "arena_extend_strategy": "kSameAsRequested",
                },
            )
        ]
    else:
        providers = ["CPUExecutionProvider"]
    session = ort.InferenceSession(model_path, providers=providers)
    actual = session.get_providers()
    if not actual or actual[0] != provider:
        raise RuntimeError(f"Requested ONNX provider {provider} fell back to {actual}")
    return session


def _smoke_inference(kokoro: Kokoro) -> tuple[int, int]:
    text = (WARMUP_TEXT or "Ready.").strip() or "Ready."
    samples, sample_rate = _create_with_misaki(
        kokoro,
        text,
        voice=DEFAULT_VOICE,
        speed=DEFAULT_SPEED,
    )
    if sample_rate <= 0 or len(samples) == 0:
        raise RuntimeError("Kokoro smoke inference produced no audio")
    return len(samples), sample_rate


def _create_with_misaki(kokoro: Kokoro, text: str, *, voice: str, speed: float):
    """Synthesize precomputed Misaki phonemes; never let kokoro-onnx re-G2P English."""
    language = lang_for_voice(voice)
    g2p = _english_g2p.phonemize(text, british=language == "en-gb")
    return kokoro.create(
        g2p.phonemes,
        voice=voice,
        speed=speed,
        lang=language,
        is_phonemes=True,
    )


def _load_with_provider(model_path: str, provider: str, cuda_mem_limit_mb: int | None = None) -> Kokoro:
    session = _make_session(model_path, provider, cuda_mem_limit_mb)
    return Kokoro.from_session(session, voices_path())


def _load_cuda_with_adaptive_limit(model_path: str) -> tuple[Kokoro, int]:
    errors = []
    for mem_limit_mb in _cuda_mem_limit_candidates():
        try:
            print(f"Kokoro CUDA smoke attempt with gpu_mem_limit={mem_limit_mb}MB")
            kokoro = _load_with_provider(model_path, "CUDAExecutionProvider", mem_limit_mb)
            _smoke_inference(kokoro)
            return kokoro, mem_limit_mb
        except Exception as exc:
            errors.append(f"{mem_limit_mb}MB: {exc}")
            print(f"Kokoro CUDA smoke failed at gpu_mem_limit={mem_limit_mb}MB: {exc}")
            try:
                kokoro = None
            except Exception:
                pass
            _cleanup_failed_cuda_attempt()
    raise RuntimeError("CUDA smoke failed for all memory limits: " + " | ".join(errors))


def _set_selected_runtime(
    kokoro: Kokoro,
    model_path: str,
    provider: str,
    *,
    gpu_enabled: bool,
    int8_fallback: bool,
    cuda_mem_limit_mb: int | None = None,
) -> Kokoro:
    global _kokoro, _gpu_enabled, _selected_provider, _selected_model_path
    global _selected_model_identity, _int8_fallback_used, _selected_cuda_mem_limit_mb

    _kokoro = kokoro
    _gpu_enabled = gpu_enabled
    _selected_provider = provider
    _selected_model_path = model_path
    _selected_model_identity = model_file_identity(model_path)
    _int8_fallback_used = int8_fallback
    _selected_cuda_mem_limit_mb = cuda_mem_limit_mb if provider == "CUDAExecutionProvider" else None
    return kokoro


def _log_selected_runtime() -> None:
    print(f"Kokoro TTS selected model file: {os.path.basename(_selected_model_path) if _selected_model_path else None}")
    print(f"Kokoro TTS selected provider: {_selected_provider}")
    if _selected_cuda_mem_limit_mb is not None:
        print(f"Kokoro TTS CUDA memory limit: {_selected_cuda_mem_limit_mb}MB")
    print(f"Kokoro TTS GPU smoke test passed: {_gpu_smoke_passed}")
    if _gpu_smoke_error:
        print(f"Kokoro TTS GPU smoke test failure: {_gpu_smoke_error}")
    print(f"Kokoro TTS CPU fallback happened: {_cpu_fallback_used}")
    print(f"Kokoro TTS CPU smoke test passed: {_cpu_smoke_passed}")
    print(f"Kokoro TTS int8 emergency fallback used: {_int8_fallback_used}")


def log_runtime_environment() -> None:
    setup_error = _quality_setup_error()
    print("Kokoro ONNX provider discovery deferred until narration starts")
    print(f"Kokoro provider request: {_requested_provider()}")
    print(f"Kokoro expected quality model: {quality_model_path()}")
    print(f"Kokoro voices file: {voices_path()}")
    if setup_error:
        print(f"Kokoro setup warning: {setup_error}")


def get_runtime_info() -> dict:
    install = get_install_info()
    setup_error = _setup_error or _quality_setup_error()
    identity = _selected_model_identity
    if identity is None and _selected_model_path and os.path.exists(_selected_model_path):
        identity = model_file_identity(_selected_model_path)
    g2p = _english_g2p.last_telemetry
    return {
        "model_loaded": is_model_loaded(),
        "model_loading": is_model_loading(),
        # Provider discovery imports ONNX Runtime and its native libraries.
        # Keep startup/status lightweight until narration actually needs it.
        "available_providers": ort.get_available_providers() if (_kokoro is not None or _model_loading) else [],
        "requested_provider": _requested_provider(),
        "selected_provider": _selected_provider,
        "selected_cuda_mem_limit_mb": _selected_cuda_mem_limit_mb,
        "selected_model": os.path.basename(_selected_model_path) if _selected_model_path else None,
        "selected_model_path": _selected_model_path,
        "selected_model_identity": identity,
        "quality_model": QUALITY_MODEL_FILENAME,
        "quality_model_path": quality_model_path(),
        "quality_model_present": _valid_file(quality_model_path()),
        "voices_path": voices_path(),
        "voices_present": _valid_file(voices_path()),
        "setup_command": SETUP_COMMAND,
        "setup_error": setup_error,
        "download_active": _download_active,
        "download_bytes": _download_bytes,
        "download_total_bytes": _download_total_bytes,
        "download_label": _download_label,
        "download_error": _download_error,
        "install_state": install["state"],
        "install_ready": install["ready"],
        "installed": install["installed"],
        "install_error": install.get("error"),
        "gpu_smoke_passed": _gpu_smoke_passed,
        "gpu_smoke_error": _gpu_smoke_error,
        "cpu_fallback_used": _cpu_fallback_used,
        "cpu_smoke_passed": _cpu_smoke_passed,
        "int8_fallback_used": _int8_fallback_used,
        "last_load_error": _last_load_error,
        "sample_rate": SAMPLE_RATE,
        "default_voice": DEFAULT_VOICE,
        "default_speed": DEFAULT_SPEED,
        "speed_min": MIN_SPEED,
        "speed_max": MAX_SPEED,
        "chunker_version": CHUNKER_VERSION,
        "phonemizer": MISAKI_G2P_STRATEGY,
        "g2p_revision": MISAKI_G2P_REVISION,
        "g2p_dialect": g2p.dialect,
        "g2p_fallback_count": g2p.fallback_count,
        "g2p_fallback_words": list(g2p.fallback_words),
    }


def get_kokoro() -> Kokoro:
    global _model_loading, _setup_error, _gpu_smoke_passed, _gpu_smoke_error
    global _cpu_fallback_used, _cpu_smoke_passed, _last_load_error

    if _kokoro is not None:
        return _kokoro

    with _model_lock:
        if _kokoro is not None:
            return _kokoro
        install = get_install_info()
        if not install.get("ready") and install.get("state") not in {"download_queued", "downloading", "verifying"}:
            ensure_model_assets()
        require_ready_for_generation()
        return _load_kokoro_locked()


def get_model() -> Kokoro:
    return get_kokoro()


def _load_kokoro_locked() -> Kokoro:
    global _model_loading, _setup_error, _gpu_smoke_passed, _gpu_smoke_error
    global _cpu_fallback_used, _cpu_smoke_passed, _last_load_error

    _model_loading = True
    _setup_error = _quality_setup_error()
    _gpu_smoke_passed = None
    _gpu_smoke_error = None
    _cpu_fallback_used = False
    _cpu_smoke_passed = None
    _last_load_error = None

    try:
        require_ready_for_generation()
        _setup_error = _quality_setup_error()
        if not _valid_file(voices_path()):
            raise ModelInstallRequired(ENGINE_ID, get_install_info()["state"], f"Voices not found: {voices_path()}")

        providers = ort.get_available_providers()
        requested_provider = _requested_provider()
        quality_model = _select_quality_model()
        quality_error: Exception | None = None

        print(f"Kokoro ONNX available providers: {providers}")
        if _setup_error:
            print(f"Kokoro setup warning: {_setup_error}")

        if quality_model:
            if requested_provider in {"auto", "cuda"} and "CUDAExecutionProvider" in providers:
                try:
                    gpu_kokoro, cuda_mem_limit_mb = _load_cuda_with_adaptive_limit(quality_model)
                    _gpu_smoke_passed = True
                    _cpu_smoke_passed = None
                    _set_selected_runtime(
                        gpu_kokoro,
                        quality_model,
                        "CUDAExecutionProvider",
                        gpu_enabled=True,
                        int8_fallback=False,
                        cuda_mem_limit_mb=cuda_mem_limit_mb,
                    )
                    _log_selected_runtime()
                    return _kokoro
                except Exception as exc:
                    _gpu_smoke_passed = False
                    _gpu_smoke_error = str(exc)
                    _cpu_fallback_used = True
                    print(f"Kokoro CUDA smoke failed; falling back to CPU: {exc}")

            try:
                cpu_kokoro = _load_with_provider(quality_model, "CPUExecutionProvider")
                _smoke_inference(cpu_kokoro)
                _cpu_smoke_passed = True
                _set_selected_runtime(
                    cpu_kokoro,
                    quality_model,
                    "CPUExecutionProvider",
                    gpu_enabled=False,
                    int8_fallback=False,
                )
                _log_selected_runtime()
                return _kokoro
            except Exception as exc:
                quality_error = exc
                _cpu_smoke_passed = False
                _last_load_error = str(exc)
                print(f"Kokoro quality model failed on CPU: {exc}")

        int8_model = _select_int8_fallback_model()
        if int8_model:
            try:
                if quality_model is None:
                    _setup_error = _setup_error or _quality_setup_error()
                _cpu_fallback_used = True
                int8_kokoro = _load_with_provider(int8_model, "CPUExecutionProvider")
                _smoke_inference(int8_kokoro)
                _cpu_smoke_passed = True
                _set_selected_runtime(
                    int8_kokoro,
                    int8_model,
                    "CPUExecutionProvider",
                    gpu_enabled=False,
                    int8_fallback=True,
                )
                _log_selected_runtime()
                return _kokoro
            except Exception as exc:
                _last_load_error = str(exc)
                print(f"Kokoro int8 emergency fallback failed: {exc}")

        if quality_error is not None:
            raise RuntimeError(
                f"Full-quality Kokoro model failed and int8 fallback is unavailable: {quality_error}"
            ) from quality_error
        raise FileNotFoundError(_setup_error or f"No Kokoro model found. Run: {SETUP_COMMAND}")
    finally:
        _model_loading = False


def _switch_to_cpu_runtime(reason: Exception) -> Kokoro:
    global _kokoro, _gpu_enabled, _selected_provider, _selected_model_path
    global _selected_model_identity, _cpu_fallback_used, _cpu_smoke_passed
    global _gpu_smoke_error, _last_load_error, _int8_fallback_used
    global _selected_cuda_mem_limit_mb

    model_path = _select_quality_model()
    if not model_path:
        raise reason

    print(f"Kokoro CUDA generation failed; switching runtime to CPU: {reason}")
    _kokoro = None
    _gpu_enabled = False
    _selected_provider = None
    _selected_model_path = None
    _selected_model_identity = None
    _selected_cuda_mem_limit_mb = None
    _cpu_fallback_used = True
    _gpu_smoke_error = str(reason)
    _last_load_error = str(reason)

    cpu_kokoro = _load_with_provider(model_path, "CPUExecutionProvider")
    _smoke_inference(cpu_kokoro)
    _cpu_smoke_passed = True
    _set_selected_runtime(
        cpu_kokoro,
        model_path,
        "CPUExecutionProvider",
        gpu_enabled=False,
        int8_fallback=False,
    )
    _log_selected_runtime()
    _int8_fallback_used = False
    return cpu_kokoro


def is_gpu_enabled() -> bool:
    return _gpu_enabled


def unload_model() -> bool:
    """Release the Kokoro ONNX session and free GPU VRAM. Returns True if unloaded."""
    global _kokoro, _gpu_enabled, _selected_provider, _selected_model_path
    global _selected_model_identity, _gpu_smoke_passed, _gpu_smoke_error
    global _cpu_fallback_used, _cpu_smoke_passed, _int8_fallback_used
    global _selected_cuda_mem_limit_mb
    if _kokoro is None:
        return False
    try:
        _kokoro = None
        _gpu_enabled = False
        _selected_provider = None
        _selected_model_path = None
        _selected_model_identity = None
        _selected_cuda_mem_limit_mb = None
        _gpu_smoke_passed = None
        _gpu_smoke_error = None
        _cpu_fallback_used = False
        _cpu_smoke_passed = None
        _int8_fallback_used = False
        import gc

        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        print("Kokoro TTS unloaded")
        return True
    except Exception:
        return False


def get_available_voices() -> list[str]:
    global _available_voices_cache
    if _kokoro is not None:
        available = set(_kokoro.get_voices())
        return [voice for voice in KOKORO_VOICES if voice in available]
    path = voices_path()
    if not os.path.exists(path):
        return KOKORO_VOICES
    try:
        stat = os.stat(path)
        cache_key = (path, stat.st_mtime_ns, stat.st_size)
        if _available_voices_cache and _available_voices_cache[:3] == cache_key:
            return list(_available_voices_cache[3])
    except OSError:
        cache_key = None
    with np.load(path) as f:
        available = set(f.files)
    voices = [voice for voice in KOKORO_VOICES if voice in available]
    if cache_key is not None:
        _available_voices_cache = (*cache_key, voices)
    return voices


def normalize_voice(voice: str | None) -> str:
    return voice if voice in KOKORO_VOICES else DEFAULT_VOICE


def lang_for_voice(voice: str) -> str:
    return "en-gb" if voice.startswith(("bf_", "bm_")) else "en-us"


def _cache_runtime_identity() -> tuple[str, int, str, str]:
    model_path = _selected_model_path or _cache_model_candidate()
    provider = _selected_provider or _cache_provider_candidate()
    if model_path and os.path.exists(model_path):
        identity = (
            _selected_model_identity
            if _selected_model_path == model_path and _selected_model_identity
            else model_file_identity(model_path)
        )
    else:
        identity = {
            "filename": os.path.basename(quality_model_path()),
            "size_bytes": 0,
            "sha256_partial": "missing",
        }
    return (
        identity["filename"],
        int(identity["size_bytes"]),
        identity["sha256_partial"],
        provider,
    )


def _cache_key(text: str, voice: str, speed: float) -> str:
    text = re.sub(r"\s+", " ", (text or "")).strip()
    voice = normalize_voice(voice)
    speed = validate_speed(speed)
    lang = lang_for_voice(voice)
    filename, size_bytes, sha256_partial, provider = _cache_runtime_identity()
    raw = "|".join(
        [
            CACHE_FORMAT_VERSION,
            ENGINE_ID,
            CHUNKER_VERSION,
            text,
            voice,
            lang,
            str(speed),
            filename,
            str(size_bytes),
            sha256_partial,
            provider,
            MISAKI_G2P_REVISION,
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


def _write_wav_atomic(filepath: str, samples, sample_rate: int) -> None:
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
    voice: str = "af_heart",
    speed: float = DEFAULT_SPEED,
    book_id: str = "",
) -> tuple[str, float]:
    """Generate audio for a sentence. Returns (filename, duration_ms).
    Caches to disk so repeated reads are instant."""
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
        filename, filepath = cached_path()
        duration_ms = _cached_duration_ms(filepath)
        if duration_ms is not None:
            return filename, duration_ms
        err = _inflight_errors.pop(inflight_path, RuntimeError("Audio generation failed"))
        raise err

    try:
        with _generation_slots:
            duration_ms = _cached_duration_ms(filepath)
            if duration_ms is not None:
                result = (filename, duration_ms)
            else:
                kokoro = get_kokoro()
                filename, filepath = cached_path()
                duration_ms = _cached_duration_ms(filepath)
                if duration_ms is not None:
                    return filename, duration_ms
                try:
                    samples, sr = _create_with_misaki(kokoro, text, voice=voice, speed=speed)
                except Exception as exc:
                    if _selected_provider != "CUDAExecutionProvider":
                        raise
                    with _model_lock:
                        kokoro = _switch_to_cpu_runtime(exc)
                    filename, filepath = cached_path()
                    duration_ms = _cached_duration_ms(filepath)
                    if duration_ms is not None:
                        result = (filename, duration_ms)
                        return result
                    samples, sr = _create_with_misaki(kokoro, text, voice=voice, speed=speed)
                if sr != SAMPLE_RATE:
                    print(f"Kokoro TTS sample rate differs from expected {SAMPLE_RATE}: {sr}")
                _write_wav_atomic(filepath, samples, sr)
                duration_ms = len(samples) / sr * 1000
                result = (filename, duration_ms)
            return result
    except Exception as e:
        _inflight_errors[inflight_path] = e
        raise
    finally:
        with _inflight_lock:
            done_event = _inflight.pop(inflight_path, None)
        if done_event is not None:
            done_event.set()


def get_cache_size() -> dict:
    """Return cache info."""
    if not os.path.exists(CACHE_DIR):
        return {"files": 0, "size_mb": 0}
    files = 0
    total = 0
    for name in os.listdir(CACHE_DIR):
        if not name.endswith(".wav"):
            continue
        try:
            total += os.path.getsize(os.path.join(CACHE_DIR, name))
            files += 1
        except OSError:
            continue
    return {"files": files, "size_mb": round(total / 1024 / 1024, 1)}


def clear_cache() -> dict:
    """Delete cached audio files that are not currently being generated."""
    if not os.path.exists(CACHE_DIR):
        return {"deleted": 0, "skipped": 0}

    with _inflight_lock:
        inflight_paths = set(_inflight.keys())

    deleted = 0
    skipped = 0
    with _cache_lock:
        for f in os.listdir(CACHE_DIR):
            if not f.endswith(".wav"):
                continue
            path = os.path.join(CACHE_DIR, f)
            if path in inflight_paths:
                skipped += 1
                continue
            try:
                os.remove(path)
                deleted += 1
            except OSError:
                skipped += 1

    return {"deleted": deleted, "skipped": skipped}
