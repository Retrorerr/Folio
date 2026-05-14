"""Chatterbox Turbo ONNX backend for Folio's quality TTS engine.

This follows the public ResembleAI/chatterbox-turbo-ONNX model-card pipeline:
download the ONNX graphs, condition on one bundled default reference clip,
generate speech tokens with ONNXRuntime, then decode to a 24 kHz WAV.

The public facade intentionally mirrors the old second-engine service so
`main.py` can keep the existing queue, cache, and engine-switching flow.
"""

from __future__ import annotations

import gc
import glob
import hashlib
import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

# Add NVIDIA CUDA DLL directories to PATH before importing onnxruntime. The
# Kokoro service does this too; Chatterbox can be imported first, so it needs
# its own setup rather than relying on import order.
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

import onnxruntime as ort
import soundfile as sf

from paths import AUDIO_CACHE_DIR, MODELS_DIR

try:
    from text_chunker import CHUNKER_VERSION
except Exception:
    CHUNKER_VERSION = "tts-v1"

ENGINE_ID = "chatterbox-turbo"
HF_REPO_ID = os.environ.get("CHATTERBOX_HF_REPO", "ResembleAI/chatterbox-turbo-ONNX")
MODEL_ID = os.environ.get("CHATTERBOX_MODEL_ID", HF_REPO_ID)
DEFAULT_VOICE = "default"
DEFAULT_DEVICE = os.environ.get("CHATTERBOX_DEVICE", "auto")
DEFAULT_ONNX_DTYPE = os.environ.get("CHATTERBOX_ONNX_DTYPE", "fp16").strip().lower()
ALLOW_CPU = os.environ.get("CHATTERBOX_ALLOW_CPU", "1").strip().lower() in {"1", "true", "yes", "on"}
APPLY_WATERMARK = os.environ.get("CHATTERBOX_APPLY_WATERMARK", "0").strip().lower() in {"1", "true", "yes", "on"}

DEFAULT_SPEED = 0.95
MIN_SPEED = 0.75
MAX_SPEED = 1.35
SAMPLE_RATE = 24000

START_SPEECH_TOKEN = 6561
STOP_SPEECH_TOKEN = 6562
SILENCE_TOKEN = 4299
NUM_KV_HEADS = 16
HEAD_DIM = 64
DEFAULT_MAX_NEW_TOKENS = int(os.environ.get("CHATTERBOX_MAX_NEW_TOKENS", "1024"))
DEFAULT_REPETITION_PENALTY = float(os.environ.get("CHATTERBOX_REPETITION_PENALTY", "1.2"))
DEFAULT_MAX_SEGMENT_CHARS = int(os.environ.get("CHATTERBOX_MAX_SEGMENT_CHARS", "96"))
GENERATION_CONFIG_VERSION = "chatterbox-turbo-onnx-v1"

CACHE_DIR = str(AUDIO_CACHE_DIR)
REFERENCE_DIR = MODELS_DIR / "chatterbox"
DEFAULT_REFERENCE_PATH = str(REFERENCE_DIR / "default_reference.wav")

# Approximate fp16 repo size. Only used for first-run progress display; actual
# completion is determined by hf_hub_download returning successfully.
EXPECTED_DOWNLOAD_BYTES = int(os.environ.get("CHATTERBOX_EXPECTED_BYTES", str(2_400_000_000)))

_VALID_DTYPES = {"fp32", "fp16", "q8", "q4", "q4f16"}
_MODEL_PARTS = ("conditional_decoder", "speech_encoder", "embed_tokens", "language_model")


@dataclass(frozen=True)
class RuntimeConfig:
    requested_device: str
    selected_device: str
    selected_provider: str
    model_id: str
    onnx_dtype: str
    sample_rate: int
    providers: list[str]
    reference_path: str
    reference_hash: str
    fallback_reason: str | None = None


@dataclass
class ChatterboxOnnxRuntime:
    tokenizer: Any
    embed_tokens_session: ort.InferenceSession
    language_model_session: ort.InferenceSession
    cond_decoder_session: ort.InferenceSession
    prompt_token: np.ndarray
    speaker_embeddings: np.ndarray
    speaker_features: np.ndarray
    config: RuntimeConfig


_model: ChatterboxOnnxRuntime | None = None
_runtime_config: RuntimeConfig | None = None
_model_loading = False
_last_load_error: str | None = None
_last_fallback_reason: str | None = None
_last_generation_ms: float | None = None
_last_audio_ms: float | None = None
_last_rtf: float | None = None
_last_cache_hit: bool | None = None
_download_active = False
_download_bytes = 0
_download_total_bytes = EXPECTED_DOWNLOAD_BYTES
_load_failed_permanently = False

_model_lock = threading.Lock()
_generation_slots = threading.BoundedSemaphore(1)
_inflight_lock = threading.Lock()
_inflight: dict[str, threading.Event] = {}
_inflight_errors: dict[str, Exception] = {}
_INFLIGHT_ERRORS_MAX = 32
_GC_EVERY_N_GENERATIONS = 20
_generations_since_gc = 0


def is_model_loaded() -> bool:
    return _model is not None


def is_model_loading() -> bool:
    return _model_loading


def is_gpu_enabled() -> bool:
    return _runtime_config is not None and _runtime_config.selected_device == "cuda"


def mark_active() -> None:
    return None


def normalize_device(device: str | None) -> str:
    value = (device or DEFAULT_DEVICE).strip().lower()
    if value in {"", "auto"}:
        return "auto"
    if value in {"cuda", "gpu", "cudaexecutionprovider"}:
        return "cuda"
    if value in {"cpu", "cpuexecutionprovider"}:
        return "cpu"
    return "auto"


def normalize_voice(voice: str | None) -> str:
    return DEFAULT_VOICE


def get_available_voices() -> list[dict]:
    return [
        {
            "id": DEFAULT_VOICE,
            "name": "Default",
            "description": "Bundled default Chatterbox Turbo reference voice. Inline tags supported.",
        }
    ]


def validate_speed(speed: float | str | None) -> float:
    if speed is None:
        speed = DEFAULT_SPEED
    try:
        value = float(speed)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid speed: {speed!r}")
    if not np.isfinite(value) or value < MIN_SPEED or value > MAX_SPEED:
        raise ValueError(f"Speed must be between {MIN_SPEED} and {MAX_SPEED}")
    return round(value, 3)


def _normalize_onnx_dtype(dtype: str | None = None) -> str:
    value = (dtype or DEFAULT_ONNX_DTYPE or "fp16").strip().lower()
    if value not in _VALID_DTYPES:
        print(f"Unknown Chatterbox ONNX dtype {value!r}; using fp16")
        return "fp16"
    return value


def _filename_for_part(name: str, dtype: str) -> str:
    suffix = "" if dtype == "fp32" else "_quantized" if dtype == "q8" else f"_{dtype}"
    return f"{name}{suffix}.onnx"


def _hf_cache_dir() -> str:
    base = os.environ.get("HF_HOME") or os.environ.get("HUGGINGFACE_HUB_CACHE")
    if base:
        hub = base if base.rstrip("/\\").endswith("hub") else os.path.join(base, "hub")
    else:
        hub = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
    return os.path.join(hub, f"models--{HF_REPO_ID.replace('/', '--')}")


def _dir_size_bytes(path: str) -> int:
    if not os.path.isdir(path):
        return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def _start_download_watcher(stop_event: threading.Event) -> threading.Thread:
    def _run() -> None:
        global _download_bytes
        cache_dir = _hf_cache_dir()
        while not stop_event.is_set():
            _download_bytes = _dir_size_bytes(cache_dir)
            stop_event.wait(timeout=1.0)
        _download_bytes = _dir_size_bytes(cache_dir)

    thread = threading.Thread(target=_run, name="chatterbox-onnx-download-watcher", daemon=True)
    thread.start()
    return thread


def _required_cache_files_present(dtype: str) -> bool:
    cache_dir = _hf_cache_dir()
    blobs_dir = os.path.join(cache_dir, "blobs")
    if not os.path.isdir(cache_dir) or not os.path.isdir(blobs_dir):
        return False
    try:
        if any(entry.name.endswith(".incomplete") for entry in os.scandir(blobs_dir)):
            return False
    except OSError:
        return False
    # Cheap approximation. hf_hub_download remains the source of truth; this
    # only decides whether the progress watcher should show first-run download.
    expected_names = []
    for part in _MODEL_PARTS:
        filename = _filename_for_part(part, dtype)
        expected_names.extend([filename, f"{filename}_data"])
    for root, _dirs, files in os.walk(cache_dir):
        present = set(files)
        if all(name in present for name in expected_names):
            return True
    return False


def _reference_hash() -> str:
    path = DEFAULT_REFERENCE_PATH
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Chatterbox default reference voice is missing: {path}. "
            "Run the bundled setup or restore backend/models/chatterbox/default_reference.wav."
        )
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


def _load_reference_audio(path: str) -> np.ndarray:
    import librosa

    audio_values, _sr = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    audio_values = np.asarray(audio_values, dtype=np.float32).reshape(1, -1)
    if audio_values.size == 0:
        raise RuntimeError(f"Chatterbox reference voice is empty: {path}")
    return audio_values


def _resolve_provider(requested_device: str) -> tuple[str, str, str | None]:
    requested = normalize_device(requested_device)
    providers = ort.get_available_providers()
    if requested == "cuda":
        if "CUDAExecutionProvider" not in providers:
            raise RuntimeError(
                "Chatterbox Turbo CUDA requested, but ONNXRuntime does not expose CUDAExecutionProvider."
            )
        return "CUDAExecutionProvider", "cuda", None
    if requested == "cpu":
        return "CPUExecutionProvider", "cpu", None
    if "CUDAExecutionProvider" in providers:
        return "CUDAExecutionProvider", "cuda", None
    if ALLOW_CPU:
        return (
            "CPUExecutionProvider",
            "cpu",
            "CUDAExecutionProvider is unavailable; running Chatterbox Turbo on CPU.",
        )
    raise RuntimeError(
        "Chatterbox Turbo needs CUDA for the configured auto mode. "
        "Set CHATTERBOX_ALLOW_CPU=1 to allow CPU fallback."
    )


def _session_provider_config(provider: str) -> list[Any]:
    if provider == "CUDAExecutionProvider":
        mem_limit_mb = os.environ.get("CHATTERBOX_CUDA_MEM_LIMIT_MB")
        if not mem_limit_mb:
            return ["CUDAExecutionProvider", "CPUExecutionProvider"]
        return [
            (
                "CUDAExecutionProvider",
                {"gpu_mem_limit": int(mem_limit_mb) * 1024 * 1024},
            ),
            "CPUExecutionProvider",
        ]
    return ["CPUExecutionProvider"]


def _make_session(path: str, provider: str) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.enable_mem_pattern = False
    session = ort.InferenceSession(path, sess_options=options, providers=_session_provider_config(provider))
    actual = session.get_providers()
    if provider not in actual:
        raise RuntimeError(f"Requested ONNX provider {provider} fell back to {actual}")
    return session


def _download_model_part(name: str, dtype: str) -> str:
    from huggingface_hub import hf_hub_download

    filename = _filename_for_part(name, dtype)
    graph = hf_hub_download(HF_REPO_ID, subfolder="onnx", filename=filename)
    hf_hub_download(HF_REPO_ID, subfolder="onnx", filename=f"{filename}_data")
    return graph


def _load_runtime_sessions(paths: dict[str, str], provider: str, reference_audio: np.ndarray):
    speech_encoder_session = None
    embed_tokens_session = None
    language_model_session = None
    cond_decoder_session = None
    try:
        speech_encoder_session = _make_session(paths["speech_encoder"], provider)
        embed_tokens_session = _make_session(paths["embed_tokens"], provider)
        language_model_session = _make_session(paths["language_model"], provider)
        cond_decoder_session = _make_session(paths["conditional_decoder"], provider)

        cond_emb, prompt_token, speaker_embeddings, speaker_features = speech_encoder_session.run(
            None,
            {"audio_values": reference_audio},
        )
        return (
            embed_tokens_session,
            language_model_session,
            cond_decoder_session,
            cond_emb,
            prompt_token,
            speaker_embeddings,
            speaker_features,
        )
    except Exception:
        del embed_tokens_session
        del language_model_session
        del cond_decoder_session
        gc.collect()
        raise
    finally:
        del speech_encoder_session


def _load_runtime(device: str) -> tuple[ChatterboxOnnxRuntime, RuntimeConfig]:
    global _last_fallback_reason, _download_active, _download_bytes, _download_total_bytes

    dtype = _normalize_onnx_dtype()
    requested_device = normalize_device(device)
    provider, selected_device, fallback_reason = _resolve_provider(requested_device)
    _last_fallback_reason = fallback_reason

    ref_hash = _reference_hash()
    reference_audio = _load_reference_audio(DEFAULT_REFERENCE_PATH)

    needs_download = not _required_cache_files_present(dtype)
    stop_event = threading.Event()
    watcher: threading.Thread | None = None
    if needs_download:
        _download_active = True
        _download_bytes = _dir_size_bytes(_hf_cache_dir())
        _download_total_bytes = EXPECTED_DOWNLOAD_BYTES
        watcher = _start_download_watcher(stop_event)
        print(
            f"Chatterbox ONNX first-run download starting repo={HF_REPO_ID} "
            f"dtype={dtype} expected~{EXPECTED_DOWNLOAD_BYTES // (1024 ** 2)} MB"
        )

    try:
        paths = {part: _download_model_part(part, dtype) for part in _MODEL_PARTS}
    finally:
        stop_event.set()
        if watcher is not None:
            watcher.join(timeout=2.0)
        _download_active = False

    print(f"Chatterbox ONNX loading repo={HF_REPO_ID} dtype={dtype} provider={provider}")

    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(HF_REPO_ID)
    try:
        (
            embed_tokens_session,
            language_model_session,
            cond_decoder_session,
            cond_emb,
            prompt_token,
            speaker_embeddings,
            speaker_features,
        ) = _load_runtime_sessions(paths, provider, reference_audio)
    except Exception as exc:
        if requested_device != "auto" or provider != "CUDAExecutionProvider" or not ALLOW_CPU:
            raise
        _last_fallback_reason = f"{exc}; retrying Chatterbox Turbo on CPU."
        print(f"Chatterbox ONNX CUDA load failed; retrying on CPU: {exc}")
        provider = "CPUExecutionProvider"
        selected_device = "cpu"
        (
            embed_tokens_session,
            language_model_session,
            cond_decoder_session,
            cond_emb,
            prompt_token,
            speaker_embeddings,
            speaker_features,
        ) = _load_runtime_sessions(paths, provider, reference_audio)
    del reference_audio

    config = RuntimeConfig(
        requested_device=requested_device,
        selected_device=selected_device,
        selected_provider=provider,
        model_id=MODEL_ID,
        onnx_dtype=dtype,
        sample_rate=SAMPLE_RATE,
        providers=ort.get_available_providers(),
        reference_path=DEFAULT_REFERENCE_PATH,
        reference_hash=ref_hash,
        fallback_reason=_last_fallback_reason,
    )

    runtime = ChatterboxOnnxRuntime(
        tokenizer=tokenizer,
        embed_tokens_session=embed_tokens_session,
        language_model_session=language_model_session,
        cond_decoder_session=cond_decoder_session,
        prompt_token=np.asarray(prompt_token, dtype=np.int64),
        speaker_embeddings=np.asarray(speaker_embeddings, dtype=np.float32),
        speaker_features=np.asarray(speaker_features, dtype=np.float32),
        config=config,
    )
    # Store the conditioning embedding privately; it is fp16/fp32 depending on
    # the graph and is only needed during token generation.
    runtime.cond_emb = cond_emb  # type: ignore[attr-defined]

    print(
        f"Chatterbox ONNX loaded engine={ENGINE_ID} device={selected_device} "
        f"provider={provider} dtype={dtype} reference_hash={ref_hash} "
        f"fallback={_last_fallback_reason}"
    )
    return runtime, config


def get_model(device: str | None = None) -> ChatterboxOnnxRuntime:
    global _model, _runtime_config, _model_loading, _last_load_error, _load_failed_permanently

    device = normalize_device(device)
    if _load_failed_permanently:
        raise RuntimeError(
            f"Chatterbox Turbo unavailable (previous load failed): {_last_load_error or 'unknown error'}. "
            "Restart the backend after fixing the cause; retries are disabled to protect memory."
        )

    if _model is not None and _runtime_config is not None and _runtime_config.requested_device == device:
        return _model

    with _model_lock:
        if _load_failed_permanently:
            raise RuntimeError(
                f"Chatterbox Turbo unavailable (previous load failed): {_last_load_error or 'unknown error'}."
            )
        if _model is not None and _runtime_config is not None and _runtime_config.requested_device == device:
            return _model
        _model_loading = True
        _last_load_error = None
        try:
            _model, _runtime_config = _load_runtime(device)
            return _model
        except Exception as exc:
            _last_load_error = str(exc)
            _load_failed_permanently = True
            _model = None
            _runtime_config = None
            gc.collect()
            raise RuntimeError(f"Chatterbox Turbo unavailable: {exc}") from exc
        finally:
            _model_loading = False


def reset_load_failure() -> None:
    global _load_failed_permanently, _last_load_error
    _load_failed_permanently = False
    _last_load_error = None


def _text_hash(text: str) -> str:
    text = re.sub(r"\s+", " ", (text or "")).strip()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def _selected_device_for_cache(device: str | None) -> str:
    requested = normalize_device(device)
    if requested == "auto":
        return "auto"
    if requested == "cuda":
        return "CUDAExecutionProvider"
    if requested == "cpu":
        return "CPUExecutionProvider"
    return requested


def _cache_key(text: str, speed: float, device: str | None = None) -> str:
    text = re.sub(r"\s+", " ", (text or "")).strip()
    speed = validate_speed(speed)
    try:
        reference_hash = _reference_hash()
    except Exception:
        reference_hash = "missing"
    raw = "|".join(
        [
            f"engine={ENGINE_ID}",
            f"repo={HF_REPO_ID}",
            f"model={MODEL_ID}",
            f"onnx_dtype={_normalize_onnx_dtype()}",
            f"text_hash={_text_hash(text)}",
            f"speed={speed}",
            f"provider={_selected_device_for_cache(device)}",
            f"max_new_tokens={DEFAULT_MAX_NEW_TOKENS}",
            f"max_segment_chars={DEFAULT_MAX_SEGMENT_CHARS}",
            f"repetition_penalty={DEFAULT_REPETITION_PENALTY}",
            f"watermark={int(APPLY_WATERMARK)}",
            f"reference_hash={reference_hash}",
            f"generation_config={GENERATION_CONFIG_VERSION}",
            f"chunker_version={CHUNKER_VERSION}",
        ]
    )
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _cached_path(book_id: str, text: str, speed: float, device: str | None) -> tuple[str, str]:
    key = _cache_key(text, speed, device)
    name = f"{book_id}_{ENGINE_ID}_{key}.wav"
    return name, os.path.join(CACHE_DIR, name)


def audio_cache_path(book_id: str, text: str, voice: str, speed: float, device: str | None = None) -> str:
    _name, path = _cached_path(book_id, text, speed, device)
    return path


def _duration_ms(filepath: str) -> float:
    info = sf.info(filepath)
    return info.frames / info.samplerate * 1000


def _apply_speed(wav: np.ndarray, speed: float) -> np.ndarray:
    wav = np.asarray(wav, dtype=np.float32).reshape(-1)
    if len(wav) < 2 or abs(speed - 1.0) < 0.001:
        return wav
    target_len = max(1, int(round(len(wav) / speed)))
    source_positions = np.linspace(0, len(wav) - 1, num=len(wav), dtype=np.float32)
    target_positions = np.linspace(0, len(wav) - 1, num=target_len, dtype=np.float32)
    return np.interp(target_positions, source_positions, wav).astype(np.float32)


def _write_wav_atomic(filepath: str, wav: np.ndarray, sample_rate: int) -> None:
    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    tmp = f"{filepath}.tmp.{os.getpid()}.{threading.get_ident()}"
    try:
        sf.write(tmp, arr, sample_rate, format="WAV")
        os.replace(tmp, filepath)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


class RepetitionPenaltyLogitsProcessor:
    def __init__(self, penalty: float):
        if not isinstance(penalty, float) or not (penalty > 0):
            raise ValueError(f"`penalty` must be a strictly positive float, but is {penalty}")
        self.penalty = penalty

    def __call__(self, input_ids: np.ndarray, scores: np.ndarray) -> np.ndarray:
        score = np.take_along_axis(scores, input_ids, axis=1)
        score = np.where(score < 0, score * self.penalty, score / self.penalty)
        scores_processed = scores.copy()
        np.put_along_axis(scores_processed, input_ids, score, axis=1)
        return scores_processed


def _generate_wav(runtime: ChatterboxOnnxRuntime, text: str) -> np.ndarray:
    input_ids = runtime.tokenizer(text, return_tensors="np")["input_ids"].astype(np.int64)
    repetition_penalty_processor = RepetitionPenaltyLogitsProcessor(float(DEFAULT_REPETITION_PENALTY))
    generate_tokens = np.array([[START_SPEECH_TOKEN]], dtype=np.int64)
    past_key_values: dict[str, np.ndarray] | None = None
    attention_mask: np.ndarray | None = None
    position_ids: np.ndarray | None = None
    batch_size = 1

    cond_emb = getattr(runtime, "cond_emb")
    for i in range(DEFAULT_MAX_NEW_TOKENS):
        inputs_embeds = runtime.embed_tokens_session.run(None, {"input_ids": input_ids})[0]
        if i == 0:
            inputs_embeds = np.concatenate((cond_emb, inputs_embeds), axis=1)
            batch_size, seq_len, _dim = inputs_embeds.shape
            past_key_values = {
                inp.name: np.zeros(
                    [batch_size, NUM_KV_HEADS, 0, HEAD_DIM],
                    dtype=np.float16 if inp.type == "tensor(float16)" else np.float32,
                )
                for inp in runtime.language_model_session.get_inputs()
                if "past_key_values" in inp.name
            }
            attention_mask = np.ones((batch_size, seq_len), dtype=np.int64)
            position_ids = np.arange(seq_len, dtype=np.int64).reshape(1, -1).repeat(batch_size, axis=0)

        assert past_key_values is not None
        assert attention_mask is not None
        assert position_ids is not None
        logits, *present_key_values = runtime.language_model_session.run(
            None,
            dict(
                inputs_embeds=inputs_embeds,
                attention_mask=attention_mask,
                position_ids=position_ids,
                **past_key_values,
            ),
        )

        logits = logits[:, -1, :]
        next_token_logits = repetition_penalty_processor(generate_tokens, logits)
        input_ids = np.argmax(next_token_logits, axis=-1, keepdims=True).astype(np.int64)
        generate_tokens = np.concatenate((generate_tokens, input_ids), axis=-1)
        if (input_ids.flatten() == STOP_SPEECH_TOKEN).all():
            break

        attention_mask = np.concatenate([attention_mask, np.ones((batch_size, 1), dtype=np.int64)], axis=1)
        position_ids = position_ids[:, -1:] + 1
        for j, key in enumerate(past_key_values):
            past_key_values[key] = present_key_values[j]

    if (generate_tokens[:, -1:] == STOP_SPEECH_TOKEN).all():
        speech_tokens = generate_tokens[:, 1:-1]
    else:
        speech_tokens = generate_tokens[:, 1:]
    if speech_tokens.size == 0:
        raise RuntimeError("Chatterbox produced no speech tokens")
    silence_tokens = np.full((speech_tokens.shape[0], 3), SILENCE_TOKEN, dtype=np.int64)
    speech_tokens = np.concatenate([runtime.prompt_token, speech_tokens, silence_tokens], axis=1)

    wav = runtime.cond_decoder_session.run(
        None,
        dict(
            speech_tokens=speech_tokens,
            speaker_embeddings=runtime.speaker_embeddings,
            speaker_features=runtime.speaker_features,
        ),
    )[0].squeeze(axis=0)
    wav = np.asarray(wav, dtype=np.float32).reshape(-1)

    if APPLY_WATERMARK:
        import perth

        watermarker = perth.PerthImplicitWatermarker()
        wav = watermarker.apply_watermark(wav, sample_rate=SAMPLE_RATE)
        wav = np.asarray(wav, dtype=np.float32).reshape(-1)
    return wav


def _split_generation_text(text: str) -> list[str]:
    """Split only oversized inputs so CUDA attention stays inside 6 GB VRAM.

    The reader still sees one sentence and one cached WAV. This is not user
    visible sentence splitting; it is a generation-internal safety valve for
    unusually large OCR/EPUB chunks.
    """
    text = re.sub(r"\s+", " ", (text or "")).strip()
    max_chars = max(80, DEFAULT_MAX_SEGMENT_CHARS)
    if len(text) <= max_chars:
        return [text]

    pieces: list[str] = []
    current: list[str] = []
    current_len = 0
    for word in text.split(" "):
        extra = len(word) + (1 if current else 0)
        if current and current_len + extra > max_chars:
            pieces.append(" ".join(current).strip())
            current = [word]
            current_len = len(word)
        else:
            current.append(word)
            current_len += extra
    if current:
        pieces.append(" ".join(current).strip())
    return [piece for piece in pieces if piece]


def _maybe_periodic_gc() -> None:
    global _generations_since_gc
    _generations_since_gc += 1
    if _generations_since_gc >= _GC_EVERY_N_GENERATIONS:
        _generations_since_gc = 0
        gc.collect()


def _record_inflight_error(filepath: str, exc: Exception) -> None:
    with _inflight_lock:
        _inflight_errors[filepath] = exc
        while len(_inflight_errors) > _INFLIGHT_ERRORS_MAX:
            oldest = next(iter(_inflight_errors))
            _inflight_errors.pop(oldest, None)


def generate_sentence_audio(
    text: str,
    voice: str = DEFAULT_VOICE,
    speed: float = DEFAULT_SPEED,
    book_id: str = "",
    quality: str | None = None,
    device: str | None = None,
) -> tuple[str, float]:
    """Generate or fetch cached audio for one reader chunk."""
    global _last_generation_ms, _last_audio_ms, _last_rtf, _last_cache_hit

    os.makedirs(CACHE_DIR, exist_ok=True)
    text = re.sub(r"\s+", " ", (text or "")).strip()
    if not text:
        raise RuntimeError("Chatterbox received empty text")
    speed = validate_speed(speed)
    device = normalize_device(device)

    filename, filepath = _cached_path(book_id, text, speed, device)
    if os.path.exists(filepath):
        _last_cache_hit = True
        _last_audio_ms = _duration_ms(filepath)
        print(
            f"Chatterbox ONNX cache=hit audio_ms={_last_audio_ms:.0f} "
            f"text_chars={len(text)} path={filename}"
        )
        return filename, _last_audio_ms

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
            return filename, _duration_ms(filepath)
        with _inflight_lock:
            err = _inflight_errors.pop(filepath, RuntimeError("Chatterbox audio generation failed"))
        raise err

    try:
        with _generation_slots:
            if os.path.exists(filepath):
                _last_cache_hit = True
                return filename, _duration_ms(filepath)

            runtime = get_model(device)
            started = time.perf_counter()
            segments = _split_generation_text(text)
            if len(segments) == 1:
                wav = _generate_wav(runtime, segments[0])
            else:
                generated: list[np.ndarray] = []
                gap = np.zeros(int(SAMPLE_RATE * 0.08), dtype=np.float32)
                for idx, segment in enumerate(segments):
                    if idx:
                        generated.append(gap)
                    generated.append(_generate_wav(runtime, segment))
                wav = np.concatenate(generated).astype(np.float32, copy=False)
                del generated
            wav = _apply_speed(wav, speed)
            if len(wav) == 0:
                raise RuntimeError("Chatterbox produced empty audio")
            _write_wav_atomic(filepath, wav, SAMPLE_RATE)

            elapsed = time.perf_counter() - started
            duration_s = len(wav) / SAMPLE_RATE
            _last_generation_ms = elapsed * 1000
            _last_audio_ms = duration_s * 1000
            _last_rtf = elapsed / duration_s if duration_s > 0 else 0
            _last_cache_hit = False
            print(
                f"Chatterbox ONNX model={MODEL_ID} dtype={runtime.config.onnx_dtype} "
                f"provider={runtime.config.selected_provider} generation_ms={_last_generation_ms:.1f} "
                f"audio_ms={_last_audio_ms:.1f} rtf={_last_rtf:.3f} "
                f"cache=miss text_chars={len(text)} segments={len(segments)} path={filepath}"
            )
            del wav
            _maybe_periodic_gc()
            return filename, _last_audio_ms
    except Exception as exc:
        if _runtime_config is not None and _runtime_config.selected_device == "cuda":
            unload_model()
        _record_inflight_error(filepath, exc)
        raise
    finally:
        with _inflight_lock:
            done_event = _inflight.pop(filepath, None)
        if done_event is not None:
            done_event.set()


def unload_model() -> bool:
    global _model, _runtime_config, _load_failed_permanently, _last_load_error
    _load_failed_permanently = False
    _last_load_error = None
    if _model is None:
        return False
    _model = None
    _runtime_config = None
    gc.collect()
    print("Chatterbox ONNX unloaded")
    return True


def get_runtime_info() -> dict:
    config = _runtime_config
    return {
        "engine": ENGINE_ID,
        "model_loaded": is_model_loaded(),
        "model_loading": is_model_loading(),
        "available": True,
        "model_id": MODEL_ID,
        "hf_repo_id": HF_REPO_ID,
        "onnx_dtype": config.onnx_dtype if config else _normalize_onnx_dtype(),
        "providers": ort.get_available_providers(),
        "selected_provider": config.selected_provider if config else None,
        "selected_device": config.selected_device if config else None,
        "requested_device": config.requested_device if config else normalize_device(DEFAULT_DEVICE),
        "default_device": DEFAULT_DEVICE,
        "default_voice": DEFAULT_VOICE,
        "voices": get_available_voices(),
        "generation_ms": _last_generation_ms,
        "audio_ms": _last_audio_ms,
        "rtf": _last_rtf,
        "last_cache_hit": _last_cache_hit,
        "fallback_reason": config.fallback_reason if config else _last_fallback_reason,
        "last_load_error": _last_load_error,
        "sample_rate": config.sample_rate if config else SAMPLE_RATE,
        "chunker_version": CHUNKER_VERSION,
        "download_active": _download_active,
        "download_bytes": _download_bytes,
        "download_total_bytes": _download_total_bytes,
        "reference_path": config.reference_path if config else DEFAULT_REFERENCE_PATH,
        "reference_hash": config.reference_hash if config else None,
        "max_new_tokens": DEFAULT_MAX_NEW_TOKENS,
        "max_segment_chars": DEFAULT_MAX_SEGMENT_CHARS,
        "repetition_penalty": DEFAULT_REPETITION_PENALTY,
        "watermark": APPLY_WATERMARK,
    }


def log_runtime_environment() -> None:
    print(f"Chatterbox ONNX engine available lazily: {ENGINE_ID}")
    print(f"Chatterbox ONNX repo: {HF_REPO_ID}")
    print(f"Chatterbox ONNX dtype: {_normalize_onnx_dtype()}")
    print(f"Chatterbox ONNX providers: {ort.get_available_providers()}")
    print(f"Chatterbox default device: {DEFAULT_DEVICE} (CUDA preferred; ALLOW_CPU={ALLOW_CPU})")
    print(f"Chatterbox default reference: {DEFAULT_REFERENCE_PATH}")
