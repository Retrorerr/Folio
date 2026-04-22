"""Orpheus TTS service - generates speech via LM Studio API + SNAC decoder."""

import os
import hashlib
import json
import wave
import requests
import numpy as np
import threading
import asyncio

CACHE_DIR = os.path.join(os.path.dirname(__file__), "audio_cache")
SAMPLE_RATE = 24000

# Orpheus config
AVAILABLE_VOICES = ["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"]
DEFAULT_VOICE = os.environ.get("ORPHEUS_DEFAULT_VOICE", "tara")

# Sampling params for LM Studio. LM Studio's UI sampling settings are silently
# ignored over the API — only values in the request body take effect. Orpheus
# emits SNAC audio-codec tokens (not text), so text-LLM sampling defaults break
# audio quality. These values come from the Orpheus-FastAPI maintainer's
# testing: temperature 0.6 / top_p 0.9 produce intelligible speech, and
# repetition_penalty 1.1 is the ONLY value known to produce stable output —
# changing it causes stutters, loops, or silence, so it is hardcoded.
ORPHEUS_TEMPERATURE = float(os.environ.get("ORPHEUS_TEMPERATURE", "0.6"))
ORPHEUS_TOP_P = float(os.environ.get("ORPHEUS_TOP_P", "0.9"))
ORPHEUS_MAX_TOKENS = int(os.environ.get("ORPHEUS_MAX_TOKENS", "2000"))
ORPHEUS_REPETITION_PENALTY = 1.1

# LM Studio connection
_api_url = "http://127.0.0.1:1234/v1/completions"
_headers = {"Content-Type": "application/json"}

# SNAC model (lazy loaded)
_snac_model = None
_snac_device = None
_model_loaded = False
_model_loading = False
_generation_slots = threading.BoundedSemaphore(6)
_inflight_lock = threading.Lock()
_inflight: dict[str, threading.Event] = {}
_inflight_errors: dict[str, Exception] = {}


def _get_snac():
    """Lazy-load the SNAC decoder model."""
    global _snac_model, _snac_device, _model_loaded, _model_loading
    if _snac_model is not None:
        return _snac_model, _snac_device

    _model_loading = True
    try:
        import torch
        from snac import SNAC

        _snac_device = "cuda" if torch.cuda.is_available() else "cpu"
        _snac_model = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").eval().to(_snac_device)
        _model_loaded = True
        print(f"SNAC decoder loaded on {_snac_device}")
    finally:
        _model_loading = False

    return _snac_model, _snac_device


def is_model_loaded():
    return _model_loaded


def is_model_loading():
    return _model_loading


def get_available_voices():
    return AVAILABLE_VOICES


def set_api_url(url):
    global _api_url
    _api_url = url


def _convert_to_audio(multiframe):
    """Convert token frames to audio bytes via SNAC decoder."""
    import torch

    model, device = _get_snac()
    if len(multiframe) < 7:
        return None

    codes_0, codes_1, codes_2 = [], [], []
    num_frames = len(multiframe) // 7

    for j in range(num_frames):
        i = 7 * j
        codes_0.append(multiframe[i])
        codes_1.append(multiframe[i + 1])
        codes_1.append(multiframe[i + 4])
        codes_2.append(multiframe[i + 2])
        codes_2.append(multiframe[i + 3])
        codes_2.append(multiframe[i + 5])
        codes_2.append(multiframe[i + 6])

    codes = [
        torch.tensor([codes_0], device=device, dtype=torch.int32),
        torch.tensor([codes_1], device=device, dtype=torch.int32),
        torch.tensor([codes_2], device=device, dtype=torch.int32),
    ]

    # Validate token range
    for c in codes:
        if torch.any(c < 0) or torch.any(c > 4096):
            return None

    with torch.inference_mode():
        audio_hat = model.decode(codes)

    audio_slice = audio_hat[:, :, 2048:4096]
    audio_np = audio_slice.detach().cpu().numpy()
    audio_int16 = (audio_np * 32767).astype(np.int16)
    return audio_int16.tobytes()


def _turn_token_into_id(token_string, index):
    """Parse custom token string into numeric ID."""
    token_string = token_string.strip()
    last_start = token_string.rfind("<custom_token_")
    if last_start == -1:
        return None
    last_token = token_string[last_start:]
    if last_token.startswith("<custom_token_") and last_token.endswith(">"):
        try:
            number = int(last_token[14:-1])
            return number - 10 - ((index % 7) * 4096)
        except ValueError:
            return None
    return None


def _sanitize_text(text):
    """Remove control tokens and special markup that could corrupt Orpheus prompts."""
    import re
    text = re.sub(r'<\|[^|]*\|>', '', text)  # strip <|...|> tokens
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def _generate_tokens(text, voice):
    """Stream tokens from LM Studio API."""
    text = _sanitize_text(text)
    # Orpheus-3b expects this exact wrapper around the "{voice}: {text}" body.
    # The special tokens are part of the trained prompt format — omitting them
    # or using a chat template mangles generation. Hardcoded on purpose.
    prompt = (
        f"<custom_token_3><|begin_of_text|>{voice}: {text}<|eot_id|>"
        f"<custom_token_4><custom_token_5><custom_token_1>"
    )

    payload = {
        "model": "orpheus-3b-0.1-ft",
        "prompt": prompt,
        "stop": ["<|eot_id|>"],
        "stream": True,
        "temperature": ORPHEUS_TEMPERATURE,
        "top_p": ORPHEUS_TOP_P,
        "repetition_penalty": ORPHEUS_REPETITION_PENALTY,
        "max_tokens": ORPHEUS_MAX_TOKENS,
    }

    resp = requests.post(_api_url, headers=_headers, json=payload, stream=True, timeout=60)
    resp.raise_for_status()

    for line in resp.iter_lines():
        if not line:
            continue
        line = line.decode("utf-8")
        if line.startswith("data: "):
            data_str = line[6:]
            if data_str.strip() == "[DONE]":
                break
            try:
                data = json.loads(data_str)
                if "choices" in data and data["choices"]:
                    token_text = data["choices"][0].get("text", "")
                    if token_text:
                        yield token_text
            except json.JSONDecodeError:
                continue


def _decode_tokens_to_wav(token_gen, output_path, text=""):
    """Collect tokens, decode via SNAC, write WAV file."""
    audio_segments = []
    raw_token_count = 0
    valid_token_count = 0
    decode_attempts = 0
    decode_failures = 0

    async def _async_gen():
        for token in token_gen:
            yield token

    async def _process():
        nonlocal raw_token_count, valid_token_count, decode_attempts, decode_failures
        buffer = []
        count = 0
        async for token_text in _async_gen():
            raw_token_count += 1
            token_id = _turn_token_into_id(token_text, count)
            if token_id is not None and token_id > 0:
                buffer.append(token_id)
                count += 1
                valid_token_count += 1
                if count % 7 == 0 and count > 27:
                    decode_attempts += 1
                    audio = _convert_to_audio(buffer[-28:])
                    if audio is not None:
                        audio_segments.append(audio)
                    else:
                        decode_failures += 1

    asyncio.run(_process())

    expected_words = len(text.split()) if text else "?"
    print(
        f"[orpheus] text={repr(text[:60])}{'...' if len(text) > 60 else ''} | "
        f"words={expected_words} | raw_tokens={raw_token_count} | "
        f"valid={valid_token_count} | decodes={decode_attempts} | "
        f"failures={decode_failures} | segments={len(audio_segments)}"
    )

    if not audio_segments:
        return None

    with wave.open(output_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        for seg in audio_segments:
            wf.writeframes(seg)

    total_samples = sum(len(s) // 2 for s in audio_segments)
    duration_ms = (total_samples / SAMPLE_RATE) * 1000
    print(f"[orpheus] -> {duration_ms:.0f}ms audio for {expected_words} words")
    return duration_ms


def _cache_key(text, voice, speed):
    # speed is not used by Orpheus generation, but keep in signature for API compat
    raw = f"{text}|{voice}|orpheus"
    return hashlib.md5(raw.encode()).hexdigest()


def generate_sentence_audio(text, voice, speed, book_id):
    """Generate audio for a sentence. Returns (filename, duration_ms) or raises."""
    os.makedirs(CACHE_DIR, exist_ok=True)

    if voice not in AVAILABLE_VOICES:
        voice = DEFAULT_VOICE

    key = _cache_key(text, voice, speed)
    filename = f"{book_id}_{key}.wav"
    filepath = os.path.join(CACHE_DIR, filename)

    # Check cache
    if os.path.exists(filepath):
        import soundfile as sf
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
            import soundfile as sf
            info = sf.info(filepath)
            duration_ms = info.frames / info.samplerate * 1000
            return filename, duration_ms
        err = _inflight_errors.pop(filepath, RuntimeError("Orpheus TTS generation failed"))
        raise err

    try:
        with _generation_slots:
            if os.path.exists(filepath):
                import soundfile as sf
                info = sf.info(filepath)
                duration_ms = info.frames / info.samplerate * 1000
                return filename, duration_ms

            # Ensure SNAC is loaded and serialize generation so LM Studio/SNAC don't get flooded.
            _get_snac()
            token_gen = _generate_tokens(text, voice)
            duration_ms = _decode_tokens_to_wav(token_gen, filepath, text=text)

            if duration_ms is None:
                raise RuntimeError("Orpheus TTS generation failed - no audio produced")

            return filename, duration_ms
    except Exception as e:
        _inflight_errors[filepath] = e
        raise
    finally:
        with _inflight_lock:
            done_event = _inflight.pop(filepath, None)
        if done_event is not None:
            done_event.set()
