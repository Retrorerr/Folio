"""Benchmark and debug Folio's Kokoro model choices.

Example:
  python backend/tts_benchmark.py --compare --output-dir backend/tts_debug_wavs_compare
"""

from __future__ import annotations

import argparse
import csv
import glob
import hashlib
import os
import re
import sys
import time
from pathlib import Path

import numpy as np

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
import soundfile as sf
from kokoro_onnx import Kokoro

sys.path.insert(0, str(Path(__file__).resolve().parent))

import tts_service  # noqa: E402
from paths import MODELS_DIR  # noqa: E402


DEFAULT_PARAGRAPH = (
    "Good narration should leave room for the sentence to breathe, especially "
    "when the thought turns or the rhythm changes."
)


def lang_for_voice(voice: str) -> str:
    return tts_service.lang_for_voice(voice)


def input_tokens(text: str) -> int:
    return len(re.findall(r"\S+", text))


def stats(samples: np.ndarray, sample_rate: int) -> dict[str, float]:
    audio = np.asarray(samples, dtype=np.float32)
    if audio.size == 0:
        return {"duration_s": 0.0, "peak": 0.0, "rms": 0.0}
    return {
        "duration_s": round(float(audio.shape[0] / sample_rate), 4),
        "peak": round(float(np.max(np.abs(audio))), 6),
        "rms": round(float(np.sqrt(np.mean(np.square(audio)))), 6),
    }


def cache_key(text: str, voice: str, speed: float, model_path: Path, provider: str) -> str:
    identity = tts_service.model_file_identity(str(model_path))
    clean = re.sub(r"\s+", " ", text).strip()
    raw = "|".join(
        [
            tts_service.CHUNKER_VERSION,
            clean,
            voice,
            lang_for_voice(voice),
            str(tts_service.validate_speed(speed)),
            identity["filename"],
            str(identity["size_bytes"]),
            identity["sha256_partial"],
            provider,
        ]
    )
    return hashlib.md5(raw.encode()).hexdigest()


def make_session(model_path: Path, provider: str) -> Kokoro:
    if provider == "CUDAExecutionProvider":
        providers = [
            (
                "CUDAExecutionProvider",
                {
                    "gpu_mem_limit": 2 * 1024 * 1024 * 1024,
                    "arena_extend_strategy": "kSameAsRequested",
                },
            )
        ]
    else:
        providers = ["CPUExecutionProvider"]
    session = ort.InferenceSession(str(model_path), providers=providers)
    actual = session.get_providers()
    if not actual or actual[0] != provider:
        raise RuntimeError(f"Requested ONNX provider {provider} fell back to {actual}")
    voices_path = Path(MODELS_DIR) / tts_service.VOICES_FILENAME
    return Kokoro.from_session(session, str(voices_path))


def smoke(kokoro: Kokoro, voice: str, speed: float) -> None:
    samples, sample_rate = kokoro.create(
        "Ready.",
        voice=voice,
        speed=speed,
        lang=lang_for_voice(voice),
    )
    if sample_rate <= 0 or len(samples) == 0:
        raise RuntimeError("Smoke inference produced no audio")


def build_scenarios(voice: str, speed: float) -> list[dict]:
    scenarios: list[dict] = []
    quality_model = Path(MODELS_DIR) / tts_service.QUALITY_MODEL_FILENAME
    int8_model = Path(MODELS_DIR) / tts_service.INT8_FALLBACK_MODEL_FILENAME
    available = set(ort.get_available_providers())

    if quality_model.exists():
        if "CUDAExecutionProvider" in available:
            try:
                kokoro = make_session(quality_model, "CUDAExecutionProvider")
                smoke(kokoro, voice, speed)
                scenarios.append({
                    "name": "quality-cuda",
                    "model_path": quality_model,
                    "provider": "CUDAExecutionProvider",
                    "kokoro": kokoro,
                })
            except Exception as exc:
                print(f"SKIP quality-cuda: {exc}", file=sys.stderr)
        try:
            kokoro = make_session(quality_model, "CPUExecutionProvider")
            smoke(kokoro, voice, speed)
            scenarios.append({
                "name": "quality-cpu",
                "model_path": quality_model,
                "provider": "CPUExecutionProvider",
                "kokoro": kokoro,
            })
        except Exception as exc:
            print(f"SKIP quality-cpu: {exc}", file=sys.stderr)
    else:
        print(f"SKIP quality model: missing {quality_model}", file=sys.stderr)

    if int8_model.exists():
        try:
            kokoro = make_session(int8_model, "CPUExecutionProvider")
            smoke(kokoro, voice, speed)
            scenarios.append({
                "name": "int8-emergency-cpu",
                "model_path": int8_model,
                "provider": "CPUExecutionProvider",
                "kokoro": kokoro,
            })
        except Exception as exc:
            print(f"SKIP int8-emergency-cpu: {exc}", file=sys.stderr)

    return scenarios


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare Folio Kokoro quality and fallback models.")
    parser.add_argument("--compare", action="store_true", help="Run the standard quality-vs-int8 comparison.")
    parser.add_argument("--voice", default=tts_service.DEFAULT_VOICE)
    parser.add_argument("--speed", default=str(tts_service.DEFAULT_SPEED))
    parser.add_argument("--text", default=DEFAULT_PARAGRAPH)
    parser.add_argument("--output-dir", default=str(Path(__file__).parent / "tts_debug_wavs_compare"))
    parser.add_argument("--csv", default=str(Path(__file__).parent / "tts_benchmark_compare.csv"))
    args = parser.parse_args()

    voice = tts_service.normalize_voice(args.voice)
    speed = tts_service.validate_speed(args.speed)
    text = re.sub(r"\s+", " ", args.text).strip()
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Available providers: {ort.get_available_providers()}")
    print(f"Voice: {voice}")
    print(f"Speed: {speed}")
    print(f"Text: {text}")

    scenarios = build_scenarios(voice, speed)
    if not scenarios:
        print("No benchmark scenarios could run.", file=sys.stderr)
        return 1

    fieldnames = [
        "scenario",
        "model_path",
        "model_filename",
        "model_size_bytes",
        "model_sha256_partial",
        "provider",
        "voice",
        "language_code",
        "speed",
        "sample_rate",
        "input_chars",
        "input_tokens",
        "audio_duration_s",
        "generation_time_s",
        "real_time_factor",
        "peak",
        "rms",
        "cache_key",
        "output_wav_path",
    ]

    with open(args.csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for scenario in scenarios:
            model_path = scenario["model_path"]
            provider = scenario["provider"]
            kokoro = scenario["kokoro"]
            identity = tts_service.model_file_identity(str(model_path))
            key = cache_key(text, voice, speed, model_path, provider)
            wav_path = out_dir / f"{scenario['name']}_{voice}_{speed}_{key[:8]}.wav"

            start = time.perf_counter()
            samples, sample_rate = kokoro.create(
                text,
                voice=voice,
                speed=speed,
                lang=lang_for_voice(voice),
            )
            elapsed = time.perf_counter() - start
            sf.write(wav_path, samples, sample_rate)

            audio_stats = stats(samples, sample_rate)
            duration = audio_stats["duration_s"]
            row = {
                "scenario": scenario["name"],
                "model_path": str(model_path),
                "model_filename": identity["filename"],
                "model_size_bytes": identity["size_bytes"],
                "model_sha256_partial": identity["sha256_partial"],
                "provider": provider,
                "voice": voice,
                "language_code": lang_for_voice(voice),
                "speed": speed,
                "sample_rate": sample_rate,
                "input_chars": len(text),
                "input_tokens": input_tokens(text),
                "audio_duration_s": duration,
                "generation_time_s": round(elapsed, 4),
                "real_time_factor": round(elapsed / duration, 4) if duration else "",
                "peak": audio_stats["peak"],
                "rms": audio_stats["rms"],
                "cache_key": key,
                "output_wav_path": str(wav_path),
            }
            writer.writerow(row)
            f.flush()
            print(row)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
