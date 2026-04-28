import glob
import hashlib
import math
import os
import re
import sys
import threading

import numpy as np
import soundfile as sf

# Add NVIDIA CUDA DLL directories to PATH before importing onnxruntime.
_site_packages = os.path.join(
    os.path.expanduser("~"),
    "AppData",
    "Roaming",
    "Python",
    f"Python{sys.version_info.major}{sys.version_info.minor}",
    "site-packages",
)
for _nvidia_bin in glob.glob(os.path.join(_site_packages, "nvidia", "*", "bin")):
    if _nvidia_bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = _nvidia_bin + os.pathsep + os.environ.get("PATH", "")

import onnxruntime as ort
from kokoro_onnx import Kokoro

from paths import AUDIO_CACHE_DIR, MODELS_DIR

try:
    from text_chunker import CHUNKER_VERSION
except Exception:
    CHUNKER_VERSION = "tts-v1"

SAMPLE_RATE = 24000
CACHE_DIR = str(AUDIO_CACHE_DIR)
DEFAULT_VOICE = "af_heart"
DEFAULT_SPEED = 0.95
MIN_SPEED = 0.75
MAX_SPEED = 1.35
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

_kokoro: Kokoro | None = None
_gpu_enabled: bool = False
_model_loading: bool = False
_selected_provider: str | None = None
_selected_model_path: str | None = None
_selected_model_identity: dict | None = None
_gpu_smoke_passed: bool | None = None
_gpu_smoke_error: str | None = None
_cpu_fallback_used: bool = False
_cpu_smoke_passed: bool | None = None
_int8_fallback_used: bool = False
_setup_error: str | None = None
_last_load_error: str | None = None
_model_lock = threading.Lock()
_generation_slots = threading.BoundedSemaphore(1)
_inflight_lock = threading.Lock()
_inflight: dict[str, threading.Event] = {}
_inflight_errors: dict[str, Exception] = {}
_cache_lock = threading.Lock()
_identity_cache: dict[tuple[str, int, int], dict] = {}


def is_model_loaded() -> bool:
    return _kokoro is not None


def is_model_loading() -> bool:
    return _model_loading


def validate_speed(speed: float | str | None) -> float:
    if speed is None:
        speed = DEFAULT_SPEED
    try:
        value = float(speed)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid speed: {speed!r}")
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
            f"Run: {SETUP_COMMAND}"
        )
    alias = quality_model_alias_path()
    if _valid_file(alias):
        return (
            f"Found {QUALITY_MODEL_SOURCE_ALIAS}, but Folio expects "
            f"{QUALITY_MODEL_FILENAME}. Run: {SETUP_COMMAND}"
        )
    return (
        f"Full-quality Kokoro model missing: {path}. "
        f"Run: {SETUP_COMMAND}"
    )


def _select_quality_model() -> str | None:
    path = quality_model_path()
    return path if _valid_file(path) else None


def _select_int8_fallback_model() -> str | None:
    path = int8_fallback_model_path()
    return path if _valid_file(path) else None


def _make_session(model_path: str, provider: str):
    if provider == "CUDAExecutionProvider":
        mem_limit_mb = int(os.environ.get("KOKORO_CUDA_MEM_LIMIT_MB", "4096"))
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
    samples, sample_rate = kokoro.create(
        text,
        voice=DEFAULT_VOICE,
        speed=DEFAULT_SPEED,
        lang=lang_for_voice(DEFAULT_VOICE),
    )
    if sample_rate <= 0 or len(samples) == 0:
        raise RuntimeError("Kokoro smoke inference produced no audio")
    return len(samples), sample_rate


def _load_with_provider(model_path: str, provider: str) -> Kokoro:
    session = _make_session(model_path, provider)
    return Kokoro.from_session(session, voices_path())


def _set_selected_runtime(
    kokoro: Kokoro,
    model_path: str,
    provider: str,
    *,
    gpu_enabled: bool,
    int8_fallback: bool,
) -> Kokoro:
    global _kokoro, _gpu_enabled, _selected_provider, _selected_model_path
    global _selected_model_identity, _int8_fallback_used

    _kokoro = kokoro
    _gpu_enabled = gpu_enabled
    _selected_provider = provider
    _selected_model_path = model_path
    _selected_model_identity = model_file_identity(model_path)
    _int8_fallback_used = int8_fallback
    return kokoro


def _log_selected_runtime() -> None:
    print(f"Kokoro TTS selected model file: {os.path.basename(_selected_model_path) if _selected_model_path else None}")
    print(f"Kokoro TTS selected provider: {_selected_provider}")
    print(f"Kokoro TTS GPU smoke test passed: {_gpu_smoke_passed}")
    if _gpu_smoke_error:
        print(f"Kokoro TTS GPU smoke test failure: {_gpu_smoke_error}")
    print(f"Kokoro TTS CPU fallback happened: {_cpu_fallback_used}")
    print(f"Kokoro TTS CPU smoke test passed: {_cpu_smoke_passed}")
    print(f"Kokoro TTS int8 emergency fallback used: {_int8_fallback_used}")


def log_runtime_environment() -> None:
    providers = ort.get_available_providers()
    setup_error = _quality_setup_error()
    print(f"Kokoro ONNX available providers: {providers}")
    print(f"Kokoro provider request: {_requested_provider()}")
    print(f"Kokoro expected quality model: {quality_model_path()}")
    print(f"Kokoro voices file: {voices_path()}")
    if setup_error:
        print(f"Kokoro setup warning: {setup_error}")


def get_runtime_info() -> dict:
    setup_error = _setup_error or _quality_setup_error()
    identity = _selected_model_identity
    if identity is None and _selected_model_path and os.path.exists(_selected_model_path):
        identity = model_file_identity(_selected_model_path)
    return {
        "available_providers": ort.get_available_providers(),
        "requested_provider": _requested_provider(),
        "selected_provider": _selected_provider,
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
    }


def get_kokoro() -> Kokoro:
    global _model_loading, _setup_error, _gpu_smoke_passed, _gpu_smoke_error
    global _cpu_fallback_used, _cpu_smoke_passed, _last_load_error

    if _kokoro is not None:
        return _kokoro

    with _model_lock:
        if _kokoro is not None:
            return _kokoro
        return _load_kokoro_locked()


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
        if not _valid_file(voices_path()):
            raise FileNotFoundError(f"Voices not found: {voices_path()}. Run: {SETUP_COMMAND}")

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
                    gpu_kokoro = _load_with_provider(quality_model, "CUDAExecutionProvider")
                    _smoke_inference(gpu_kokoro)
                    _gpu_smoke_passed = True
                    _cpu_smoke_passed = None
                    _set_selected_runtime(
                        gpu_kokoro,
                        quality_model,
                        "CUDAExecutionProvider",
                        gpu_enabled=True,
                        int8_fallback=False,
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

    model_path = _select_quality_model()
    if not model_path:
        raise reason

    print(f"Kokoro CUDA generation failed; switching runtime to CPU: {reason}")
    _kokoro = None
    _gpu_enabled = False
    _selected_provider = None
    _selected_model_path = None
    _selected_model_identity = None
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
    if _kokoro is None:
        return False
    try:
        _kokoro = None
        _gpu_enabled = False
        _selected_provider = None
        _selected_model_path = None
        _selected_model_identity = None
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
    if _kokoro is not None:
        available = set(_kokoro.get_voices())
        return [voice for voice in KOKORO_VOICES if voice in available]
    path = voices_path()
    if not os.path.exists(path):
        return KOKORO_VOICES
    with np.load(path) as f:
        available = set(f.files)
    return [voice for voice in KOKORO_VOICES if voice in available]


def normalize_voice(voice: str | None) -> str:
    return voice if voice in KOKORO_VOICES else DEFAULT_VOICE


def lang_for_voice(voice: str) -> str:
    return "en-gb" if voice.startswith(("bf_", "bm_")) else "en-us"


def _cache_runtime_identity() -> tuple[str, int, str, str]:
    if _selected_model_path is None or _selected_provider is None:
        get_kokoro()
    if _selected_model_path is None or _selected_provider is None:
        raise RuntimeError("Kokoro runtime identity is unavailable")
    identity = _selected_model_identity or model_file_identity(_selected_model_path)
    return (
        identity["filename"],
        int(identity["size_bytes"]),
        identity["sha256_partial"],
        _selected_provider,
    )


def _cache_key(text: str, voice: str, speed: float) -> str:
    text = re.sub(r"\s+", " ", (text or "")).strip()
    voice = normalize_voice(voice)
    speed = validate_speed(speed)
    lang = lang_for_voice(voice)
    filename, size_bytes, sha256_partial, provider = _cache_runtime_identity()
    raw = "|".join(
        [
            CHUNKER_VERSION,
            text,
            voice,
            lang,
            str(speed),
            filename,
            str(size_bytes),
            sha256_partial,
            provider,
        ]
    )
    return hashlib.md5(raw.encode()).hexdigest()


def generate_sentence_audio(
    text: str,
    voice: str = "af_heart",
    speed: float = DEFAULT_SPEED,
    book_id: str = "",
) -> tuple[str, float]:
    """Generate audio for a sentence. Returns (filename, duration_ms).
    Caches to disk so repeated reads are instant."""
    os.makedirs(CACHE_DIR, exist_ok=True)

    voice = normalize_voice(voice)
    speed = validate_speed(speed)
    kokoro = get_kokoro()

    def cached_path() -> tuple[str, str]:
        cache_key = _cache_key(text, voice, speed)
        name = f"{book_id}_{cache_key}.wav"
        return name, os.path.join(CACHE_DIR, name)

    filename, filepath = cached_path()
    inflight_path = filepath

    if os.path.exists(filepath):
        info = sf.info(filepath)
        duration_ms = info.frames / info.samplerate * 1000
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
        if os.path.exists(filepath):
            info = sf.info(filepath)
            duration_ms = info.frames / info.samplerate * 1000
            return filename, duration_ms
        err = _inflight_errors.pop(filepath, RuntimeError("Audio generation failed"))
        raise err

    try:
        with _generation_slots:
            if os.path.exists(filepath):
                info = sf.info(filepath)
                duration_ms = info.frames / info.samplerate * 1000
                result = (filename, duration_ms)
            else:
                try:
                    samples, sr = kokoro.create(text, voice=voice, speed=speed, lang=lang_for_voice(voice))
                except Exception as exc:
                    if _selected_provider != "CUDAExecutionProvider":
                        raise
                    with _model_lock:
                        kokoro = _switch_to_cpu_runtime(exc)
                    if os.path.exists(filepath):
                        info = sf.info(filepath)
                        duration_ms = info.frames / info.samplerate * 1000
                        result = (filename, duration_ms)
                        return result
                    samples, sr = kokoro.create(text, voice=voice, speed=speed, lang=lang_for_voice(voice))
                if sr != SAMPLE_RATE:
                    print(f"Kokoro TTS sample rate differs from expected {SAMPLE_RATE}: {sr}")
                sf.write(filepath, samples, sr)
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
    files = [f for f in os.listdir(CACHE_DIR) if f.endswith(".wav")]
    total = sum(os.path.getsize(os.path.join(CACHE_DIR, f)) for f in files)
    return {"files": len(files), "size_mb": round(total / 1024 / 1024, 1)}


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
