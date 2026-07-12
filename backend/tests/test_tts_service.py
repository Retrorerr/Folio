import sys
import tempfile
import types
import unittest
import os
from pathlib import Path
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.normpath(os.path.join(_HERE, ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)


try:
    import kokoro_onnx  # noqa: F401
    import numpy  # noqa: F401
    import onnxruntime  # noqa: F401
    import soundfile  # noqa: F401
except (ImportError, ModuleNotFoundError):
    class ImportKokoro:
        @staticmethod
        def from_session(_session, _voices_path):
            raise AssertionError("test should patch Kokoro.from_session")

    sys.modules["numpy"] = types.SimpleNamespace(
        load=lambda _path: (_ for _ in ()).throw(AssertionError("np.load should not be used")),
        float32=float,
    )
    sys.modules["soundfile"] = types.SimpleNamespace(
        info=lambda _path: types.SimpleNamespace(frames=0, samplerate=24000),
        write=lambda *_args, **_kwargs: None,
    )
    sys.modules["onnxruntime"] = types.SimpleNamespace(
        get_available_providers=lambda: ["CPUExecutionProvider"],
        InferenceSession=lambda *_args, **_kwargs: None,
    )
    sys.modules["kokoro_onnx"] = types.SimpleNamespace(Kokoro=ImportKokoro)

import tts_service


class FakeSession:
    def __init__(self, provider: str):
        self.provider = provider

    def get_providers(self):
        return [self.provider]


class FakeKokoro:
    failing_providers: set[str] = set()
    create_calls: list[tuple[tuple, dict]] = []

    def __init__(self, provider: str):
        self.provider = provider

    def create(self, *args, **kwargs):
        type(self).create_calls.append((args, kwargs))
        if self.provider in self.failing_providers:
            raise RuntimeError(f"{self.provider} smoke failed")
        return [0.0] * 240, 24000

    def get_voices(self):
        return list(tts_service.KOKORO_VOICES)


def write_asset(path: Path, content=b"asset") -> Path:
    path.write_bytes(content)
    return path


class TTSServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.models_dir = Path(self.tmp.name)
        self.cache_dir = self.models_dir / "audio-cache"
        self.cache_dir.mkdir()
        self.patches = [
            mock.patch.object(tts_service, "MODELS_DIR", self.models_dir),
            mock.patch.object(tts_service, "CACHE_DIR", str(self.cache_dir)),
            mock.patch.object(tts_service, "WARMUP_TEXT", "Ready."),
            mock.patch.dict("os.environ", {tts_service.PROVIDER_ENV: ""}, clear=False),
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
        tts_service._kokoro = None
        tts_service._gpu_enabled = False
        tts_service._model_loading = False
        tts_service._download_active = False
        tts_service._download_bytes = 0
        tts_service._download_total_bytes = 0
        tts_service._download_label = None
        tts_service._download_error = None
        tts_service._selected_provider = None
        tts_service._selected_model_path = None
        tts_service._selected_model_identity = None
        tts_service._gpu_smoke_passed = None
        tts_service._gpu_smoke_error = None
        tts_service._cpu_fallback_used = False
        tts_service._cpu_smoke_passed = None
        tts_service._int8_fallback_used = False
        tts_service._setup_error = None
        tts_service._last_load_error = None
        tts_service._identity_cache.clear()
        FakeKokoro.failing_providers = set()
        FakeKokoro.create_calls = []

    def install_fake_runtime(self, providers, failing_providers=()):
        FakeKokoro.failing_providers = set(failing_providers)

        def fake_inference_session(_model_path, providers):
            requested = providers[0][0] if isinstance(providers[0], tuple) else providers[0]
            return FakeSession(requested)

        self.patches.extend(
            [
                mock.patch.object(tts_service.ort, "get_available_providers", lambda: list(providers)),
                mock.patch.object(tts_service.ort, "InferenceSession", fake_inference_session),
                mock.patch.object(
                    tts_service.Kokoro,
                    "from_session",
                    staticmethod(lambda session, _voices_path: FakeKokoro(session.get_providers()[0])),
                ),
            ]
        )
        self.patches[-3].start()
        self.patches[-2].start()
        self.patches[-1].start()

    def test_quality_model_is_selected_when_present(self):
        self.install_fake_runtime(["CPUExecutionProvider"])
        write_asset(self.models_dir / tts_service.QUALITY_MODEL_FILENAME, b"quality-model")
        write_asset(self.models_dir / tts_service.VOICES_FILENAME, b"voices")

        tts_service.get_kokoro()
        info = tts_service.get_runtime_info()

        self.assertEqual(info["selected_model"], tts_service.QUALITY_MODEL_FILENAME)
        self.assertEqual(info["selected_provider"], "CPUExecutionProvider")
        self.assertIs(info["model_loaded"], True)
        self.assertIs(info["model_loading"], False)
        self.assertIs(info["cpu_smoke_passed"], True)
        self.assertIs(info["int8_fallback_used"], False)

    def test_kokoro_receives_misaki_phonemes_with_explicit_phoneme_contract(self):
        self.install_fake_runtime(["CPUExecutionProvider"])
        write_asset(self.models_dir / tts_service.QUALITY_MODEL_FILENAME, b"quality-model")
        write_asset(self.models_dir / tts_service.VOICES_FILENAME, b"voices")

        tts_service.get_kokoro()

        args, kwargs = FakeKokoro.create_calls[-1]
        expected = tts_service._english_g2p.phonemize("Ready.", british=False).phonemes
        self.assertEqual(args[0], expected)
        self.assertNotEqual(args[0], "Ready.")
        self.assertIs(kwargs["is_phonemes"], True)
        info = tts_service.get_runtime_info()
        self.assertEqual(info["phonemizer"], tts_service.MISAKI_G2P_STRATEGY)
        self.assertEqual(info["g2p_revision"], tts_service.MISAKI_G2P_REVISION)
        self.assertEqual(info["g2p_fallback_count"], 0)

    def test_missing_quality_model_reports_setup_and_uses_int8_fallback(self):
        self.install_fake_runtime(["CPUExecutionProvider"])
        write_asset(self.models_dir / tts_service.INT8_FALLBACK_MODEL_FILENAME, b"int8-model")
        write_asset(self.models_dir / tts_service.VOICES_FILENAME, b"voices")

        with mock.patch.object(tts_service, "ensure_model_assets", return_value=None):
            tts_service.get_kokoro()
        info = tts_service.get_runtime_info()

        self.assertEqual(info["selected_model"], tts_service.INT8_FALLBACK_MODEL_FILENAME)
        self.assertEqual(info["selected_provider"], "CPUExecutionProvider")
        self.assertIs(info["int8_fallback_used"], True)
        self.assertIn("download it automatically", info["setup_error"])

    def test_missing_quality_model_downloads_assets_before_loading(self):
        self.install_fake_runtime(["CPUExecutionProvider"])

        def fake_download(destination, _sources, *, label):
            content = b"voices" if "voices" in label else b"quality-model"
            write_asset(Path(destination), content)

        with mock.patch.object(tts_service, "_download_asset", side_effect=fake_download) as download:
            tts_service.get_kokoro()

        info = tts_service.get_runtime_info()
        self.assertEqual(download.call_count, 2)
        self.assertEqual(info["selected_model"], tts_service.QUALITY_MODEL_FILENAME)
        self.assertTrue(info["quality_model_present"])
        self.assertTrue(info["voices_present"])

    def test_cuda_smoke_failure_falls_back_to_cpu(self):
        self.install_fake_runtime(
            ["CUDAExecutionProvider", "CPUExecutionProvider"],
            failing_providers={"CUDAExecutionProvider"},
        )
        write_asset(self.models_dir / tts_service.QUALITY_MODEL_FILENAME, b"quality-model")
        write_asset(self.models_dir / tts_service.VOICES_FILENAME, b"voices")

        with mock.patch.object(tts_service, "_cleanup_failed_cuda_attempt", return_value=None):
            tts_service.get_kokoro()
        info = tts_service.get_runtime_info()

        self.assertIs(info["gpu_smoke_passed"], False)
        self.assertIn("smoke failed", info["gpu_smoke_error"])
        self.assertIs(info["cpu_fallback_used"], True)
        self.assertEqual(info["selected_provider"], "CPUExecutionProvider")
        self.assertEqual(info["selected_model"], tts_service.QUALITY_MODEL_FILENAME)
        self.assertIs(info["int8_fallback_used"], False)

    def test_cache_key_changes_with_model_identity_provider_and_chunker(self):
        model = write_asset(self.models_dir / tts_service.QUALITY_MODEL_FILENAME, b"quality-model")

        tts_service._selected_model_path = str(model)
        tts_service._selected_model_identity = None
        tts_service._selected_provider = "CPUExecutionProvider"
        key_cpu = tts_service._cache_key("Same text.", "af_heart", 0.95)

        tts_service._selected_provider = "CUDAExecutionProvider"
        key_cuda = tts_service._cache_key("Same text.", "af_heart", 0.95)

        write_asset(model, b"quality-model-with-different-size")
        tts_service._selected_provider = "CPUExecutionProvider"
        tts_service._selected_model_identity = None
        key_model_changed = tts_service._cache_key("Same text.", "af_heart", 0.95)

        with mock.patch.object(tts_service, "CHUNKER_VERSION", "different-existing-version"):
            key_chunker_changed = tts_service._cache_key("Same text.", "af_heart", 0.95)
        with mock.patch.object(tts_service, "MISAKI_G2P_REVISION", "different-g2p-revision"):
            key_g2p_changed = tts_service._cache_key("Same text.", "af_heart", 0.95)

        self.assertNotEqual(key_cpu, key_cuda)
        self.assertNotEqual(key_cpu, key_model_changed)
        self.assertNotEqual(key_model_changed, key_chunker_changed)
        self.assertNotEqual(key_model_changed, key_g2p_changed)

    def test_cache_key_does_not_load_model_when_runtime_unselected(self):
        write_asset(self.models_dir / tts_service.QUALITY_MODEL_FILENAME, b"quality-model")

        with mock.patch.object(tts_service, "get_kokoro", side_effect=AssertionError("should not load")):
            key = tts_service._cache_key("Cached text.", "af_heart", 0.95)

        self.assertTrue(key)
        self.assertIsNone(tts_service._selected_provider)

    def test_cached_audio_hit_does_not_load_model(self):
        write_asset(self.models_dir / tts_service.QUALITY_MODEL_FILENAME, b"quality-model")
        cached = Path(tts_service.audio_cache_path("book", "Cached text.", "af_heart", 0.95))
        tts_service.sf.write(str(cached), [0.0] * 240, 24000)

        with mock.patch.object(tts_service, "get_kokoro", side_effect=AssertionError("should not load")):
            with mock.patch.object(tts_service, "_cached_duration_ms", return_value=10.0):
                filename, duration_ms = tts_service.generate_sentence_audio(
                    "Cached text.",
                    voice="af_heart",
                    speed=0.95,
                    book_id="book",
                )

        self.assertEqual(filename, cached.name)
        self.assertGreater(duration_ms, 0)
        self.assertIsNone(tts_service._selected_provider)

    def test_int8_is_not_used_when_quality_model_works(self):
        self.install_fake_runtime(["CPUExecutionProvider"])
        write_asset(self.models_dir / tts_service.QUALITY_MODEL_FILENAME, b"quality-model")
        write_asset(self.models_dir / tts_service.INT8_FALLBACK_MODEL_FILENAME, b"int8-model")
        write_asset(self.models_dir / tts_service.VOICES_FILENAME, b"voices")

        tts_service.get_kokoro()
        info = tts_service.get_runtime_info()

        self.assertEqual(info["selected_model"], tts_service.QUALITY_MODEL_FILENAME)
        self.assertIs(info["int8_fallback_used"], False)

    def test_cache_size_ignores_files_removed_during_scan(self):
        wav = self.cache_dir / "cached.wav"
        write_asset(wav, b"audio")

        def flaky_getsize(path):
            if os.path.basename(path) == wav.name:
                raise FileNotFoundError(path)
            return os.path.getsize(path)

        with mock.patch.object(tts_service.os.path, "getsize", side_effect=flaky_getsize):
            info = tts_service.get_cache_size()

        self.assertEqual(info, {"files": 0, "size_mb": 0})


if __name__ == "__main__":
    unittest.main()
