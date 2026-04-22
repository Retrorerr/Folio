import os
import sys
import hashlib
import glob
import threading
import soundfile as sf
import numpy as np

# Add NVIDIA CUDA DLL directories to PATH before importing onnxruntime
_site_packages = os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "Python",
                              f"Python{sys.version_info.major}{sys.version_info.minor}", "site-packages")
for _nvidia_bin in glob.glob(os.path.join(_site_packages, "nvidia", "*", "bin")):
    if _nvidia_bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = _nvidia_bin + os.pathsep + os.environ.get("PATH", "")

import onnxruntime as ort
from kokoro_onnx import Kokoro

SAMPLE_RATE = 24000
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio_cache")

_kokoro: Kokoro | None = None
_gpu_enabled: bool = False
_model_loading: bool = False
_generation_slots = threading.BoundedSemaphore(6)
_inflight_lock = threading.Lock()
_inflight: dict[str, threading.Event] = {}
_inflight_errors: dict[str, Exception] = {}
_cache_lock = threading.Lock()


def is_model_loaded() -> bool:
    return _kokoro is not None


def is_model_loading() -> bool:
    return _model_loading


def get_kokoro() -> Kokoro:
    global _kokoro, _gpu_enabled, _model_loading
    if _kokoro is None:
        _model_loading = True
        try:
            voices_path = os.path.join(MODELS_DIR, "voices-v1.0.bin")
            if not os.path.exists(voices_path):
                raise FileNotFoundError(f"Voices not found: {voices_path}")

            # Try GPU first (CUDA or DirectML), fall back to CPU
            providers = ort.get_available_providers()
            gpu_model = os.path.join(MODELS_DIR, "kokoro-v1.0.fp16-gpu.onnx")
            cpu_model = os.path.join(MODELS_DIR, "kokoro-v1.0.int8.onnx")

            # Try CUDA first
            if "CUDAExecutionProvider" in providers and os.path.exists(gpu_model):
                try:
                    # Cap the CUDA EP arena so ORT doesn't grab all free VRAM for a ~300MB model.
                    cuda_provider = ("CUDAExecutionProvider", {
                        "gpu_mem_limit": 2 * 1024 * 1024 * 1024,  # 2 GB
                        "arena_extend_strategy": "kSameAsRequested",
                    })
                    sess = ort.InferenceSession(gpu_model, providers=[cuda_provider])
                    _kokoro = Kokoro.from_session(sess, voices_path)
                    _gpu_enabled = True
                    print("Kokoro TTS loaded with CUDA GPU acceleration")
                    return _kokoro
                except Exception as e:
                    print(f"CUDA init failed: {e}")

            # Try DirectML (works with any GPU on Windows, no CUDA toolkit needed)
            if "DmlExecutionProvider" in providers:
                for dml_model_path in [gpu_model, cpu_model]:
                    if not os.path.exists(dml_model_path):
                        continue
                    try:
                        sess = ort.InferenceSession(dml_model_path, providers=["DmlExecutionProvider"])
                        kokoro_test = Kokoro.from_session(sess, voices_path)
                        kokoro_test.create("test", voice="af_heart", speed=1.0)
                        _kokoro = kokoro_test
                        _gpu_enabled = True
                        model_name = os.path.basename(dml_model_path)
                        print(f"Kokoro TTS loaded with DirectML GPU ({model_name})")
                        return _kokoro
                    except Exception as e:
                        print(f"DirectML failed with {os.path.basename(dml_model_path)}: {e}")

            # CPU fallback
            if not os.path.exists(cpu_model):
                raise FileNotFoundError(f"Model not found: {cpu_model}")
            _kokoro = Kokoro(cpu_model, voices_path)
            _gpu_enabled = False
            print("Kokoro TTS loaded on CPU")
        finally:
            _model_loading = False
    return _kokoro


def is_gpu_enabled() -> bool:
    return _gpu_enabled


def get_available_voices() -> list[str]:
    kokoro = get_kokoro()
    return kokoro.get_voices()


def _cache_key(text: str, voice: str, speed: float) -> str:
    h = hashlib.md5(f"{text}|{voice}|{speed}".encode()).hexdigest()
    return h


def generate_sentence_audio(
    text: str,
    voice: str = "af_heart",
    speed: float = 1.0,
    book_id: str = "",
) -> tuple[str, float]:
    """Generate audio for a sentence. Returns (filename, duration_ms).
    Caches to disk so repeated reads are instant."""
    os.makedirs(CACHE_DIR, exist_ok=True)

    cache_key = _cache_key(text, voice, speed)
    filename = f"{book_id}_{cache_key}.wav"
    filepath = os.path.join(CACHE_DIR, filename)

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
                kokoro = get_kokoro()
                samples, sr = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
                sf.write(filepath, samples, sr)
                duration_ms = len(samples) / sr * 1000
                result = (filename, duration_ms)
            return result
    except Exception as e:
        _inflight_errors[filepath] = e
        raise
    finally:
        with _inflight_lock:
            done_event = _inflight.pop(filepath, None)
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
