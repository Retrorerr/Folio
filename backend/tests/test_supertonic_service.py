import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import soundfile as sf

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.normpath(os.path.join(_HERE, ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

import supertonic_service


class FakeSupertonicModel:
    sample_rate = 44100

    def __init__(self):
        self.style_calls = []
        self.synth_calls = []

    def get_voice_style(self, voice_name):
        self.style_calls.append(voice_name)
        return {"voice": voice_name}

    def synthesize(self, **kwargs):
        self.synth_calls.append(kwargs)
        return np.zeros((1, 4410), dtype=np.float32), 0.1


class SupertonicServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.models_dir = Path(self.tmp.name) / "models"
        self.cache_dir = Path(self.tmp.name) / "audio-cache"
        self.models_dir.mkdir()
        self.cache_dir.mkdir()
        self.patches = [
            mock.patch.object(supertonic_service, "MODELS_DIR", self.models_dir),
            mock.patch.object(supertonic_service, "CACHE_DIR", str(self.cache_dir)),
        ]
        for patch in self.patches:
            patch.start()
        self.addCleanup(self.cleanup_patches)
        self.reset_runtime()

    def cleanup_patches(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def reset_runtime(self):
        supertonic_service._tts = None
        supertonic_service._model_loading = False
        supertonic_service._download_active = False
        supertonic_service._download_bytes = 0
        supertonic_service._download_total_bytes = 0
        supertonic_service._download_label = None
        supertonic_service._download_error = None
        supertonic_service._last_load_error = None
        supertonic_service._selected_provider = None
        supertonic_service._selected_model_path = None
        supertonic_service._selected_model_identity = None
        supertonic_service._voice_styles.clear()
        supertonic_service._inflight.clear()
        supertonic_service._inflight_errors.clear()
        supertonic_service._identity_cache.clear()
        supertonic_service._installed_bytes_cache = None

    def test_default_voice_and_voice_enumeration(self):
        self.assertEqual(supertonic_service.DEFAULT_VOICE, "M1")
        self.assertEqual(
            supertonic_service.get_available_voices(),
            ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"],
        )

    def test_invalid_voice_falls_back_to_default(self):
        self.assertEqual(supertonic_service.normalize_voice("not-real"), "M1")
        self.assertEqual(supertonic_service.normalize_voice(None), "M1")
        self.assertEqual(supertonic_service.normalize_voice("F5"), "F5")

    def test_speed_validation_uses_supertonic_range(self):
        self.assertEqual(supertonic_service.validate_speed(None), 1.0)
        self.assertEqual(supertonic_service.validate_speed("1.2344"), 1.234)
        with self.assertRaisesRegex(ValueError, "between 0.7 and 2.0"):
            supertonic_service.validate_speed(2.5)

    def test_cache_key_separates_voice_speed_language_quality_and_engine(self):
        key_m1 = supertonic_service._cache_key("Same text.", "M1", 1.0)
        key_f1 = supertonic_service._cache_key("Same text.", "F1", 1.0)
        key_speed = supertonic_service._cache_key("Same text.", "M1", 1.2)
        with mock.patch.object(supertonic_service, "DEFAULT_QUALITY_STEPS", 12):
            key_quality = supertonic_service._cache_key("Same text.", "M1", 1.0)
        with mock.patch.object(supertonic_service, "DEFAULT_LANGUAGE", "es"):
            key_language = supertonic_service._cache_key("Same text.", "M1", 1.0)

        self.assertNotEqual(key_m1, key_f1)
        self.assertNotEqual(key_m1, key_speed)
        self.assertNotEqual(key_m1, key_quality)
        self.assertNotEqual(key_m1, key_language)
        self.assertIn("supertonic", os.path.basename(supertonic_service.audio_cache_path("book", "Same text.", "M1", 1.0)))

    def test_model_identity_is_cached_by_file_stat(self):
        marker = Path(supertonic_service._required_path("onnx/vector_estimator.onnx"))
        marker.parent.mkdir(parents=True)
        marker.write_bytes(b"model")

        with mock.patch.object(supertonic_service, "_partial_sha256", wraps=supertonic_service._partial_sha256) as sha:
            first = supertonic_service._model_identity()
            second = supertonic_service._model_identity()
            marker.write_bytes(b"model-updated")
            third = supertonic_service._model_identity()

        self.assertEqual(sha.call_count, 2)
        self.assertEqual(first, second)
        self.assertEqual(first["filename"], "vector_estimator.onnx")
        self.assertNotEqual(first["size_bytes"], third["size_bytes"])

    def test_lazy_singleton_initializes_once(self):
        created = []

        class FakeTTS:
            def __init__(self, **kwargs):
                created.append(kwargs)

        with mock.patch.object(supertonic_service, "require_ready_for_generation", return_value=None):
            with mock.patch.object(supertonic_service, "_load_sdk_tts", return_value=FakeTTS):
                first = supertonic_service.get_model()
                second = supertonic_service.get_model()

        self.assertIs(first, second)
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["model"], "supertonic-3")
        self.assertEqual(created[0]["model_dir"], supertonic_service.model_dir())
        self.assertIs(created[0]["auto_download"], False)

    def test_synthesis_returns_valid_wav_and_caches_voice_styles(self):
        fake = FakeSupertonicModel()
        with mock.patch.object(supertonic_service, "get_model", return_value=fake):
            filename, duration_ms = supertonic_service.generate_sentence_audio(
                "A short sentence.",
                voice="F2",
                speed=1.0,
                book_id="book",
            )

        filepath = self.cache_dir / filename
        info = sf.info(filepath)

        self.assertEqual(info.samplerate, 44100)
        self.assertEqual(info.frames, 4410)
        self.assertGreater(duration_ms, 0)
        self.assertEqual(fake.style_calls, ["F2"])
        self.assertEqual(fake.synth_calls[0]["voice_style"], {"voice": "F2"})
        self.assertEqual(fake.synth_calls[0]["lang"], "en")
        self.assertEqual(fake.synth_calls[0]["total_steps"], 8)
        self.assertEqual(fake.synth_calls[0]["max_chunk_length"], supertonic_service.MAX_CHUNK_LENGTH)
        self.assertEqual(fake.synth_calls[0]["silence_duration"], 0.0)

        with mock.patch.object(fake, "synthesize", side_effect=AssertionError("should hit cache")):
            cached_filename, cached_duration_ms = supertonic_service.generate_sentence_audio(
                "A short sentence.",
                voice="F2",
                speed=1.0,
                book_id="book",
            )

        self.assertEqual(cached_filename, filename)
        self.assertGreater(cached_duration_ms, 0)

    def test_assets_resolve_under_folio_models_dir(self):
        self.assertEqual(Path(supertonic_service.model_dir()), self.models_dir / "supertonic-3")
        self.assertTrue(supertonic_service._required_path("onnx/vocoder.onnx").endswith("supertonic-3\\onnx\\vocoder.onnx"))


if __name__ == "__main__":
    unittest.main()
