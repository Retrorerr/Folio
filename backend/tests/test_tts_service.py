import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


try:
    import kokoro_onnx  # noqa: F401
    import numpy  # noqa: F401
    import onnxruntime  # noqa: F401
    import soundfile  # noqa: F401
except ModuleNotFoundError:
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

    def __init__(self, provider: str):
        self.provider = provider

    def create(self, *_args, **_kwargs):
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
        self.patches = [
            mock.patch.object(tts_service, "MODELS_DIR", self.models_dir),
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
        self.assertIs(info["cpu_smoke_passed"], True)
        self.assertIs(info["int8_fallback_used"], False)

    def test_missing_quality_model_reports_setup_and_uses_int8_fallback(self):
        self.install_fake_runtime(["CPUExecutionProvider"])
        write_asset(self.models_dir / tts_service.INT8_FALLBACK_MODEL_FILENAME, b"int8-model")
        write_asset(self.models_dir / tts_service.VOICES_FILENAME, b"voices")

        tts_service.get_kokoro()
        info = tts_service.get_runtime_info()

        self.assertEqual(info["selected_model"], tts_service.INT8_FALLBACK_MODEL_FILENAME)
        self.assertEqual(info["selected_provider"], "CPUExecutionProvider")
        self.assertIs(info["int8_fallback_used"], True)
        self.assertIn(tts_service.SETUP_COMMAND, info["setup_error"])

    def test_cuda_smoke_failure_falls_back_to_cpu(self):
        self.install_fake_runtime(
            ["CUDAExecutionProvider", "CPUExecutionProvider"],
            failing_providers={"CUDAExecutionProvider"},
        )
        write_asset(self.models_dir / tts_service.QUALITY_MODEL_FILENAME, b"quality-model")
        write_asset(self.models_dir / tts_service.VOICES_FILENAME, b"voices")

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

        self.assertNotEqual(key_cpu, key_cuda)
        self.assertNotEqual(key_cpu, key_model_changed)
        self.assertNotEqual(key_model_changed, key_chunker_changed)

    def test_int8_is_not_used_when_quality_model_works(self):
        self.install_fake_runtime(["CPUExecutionProvider"])
        write_asset(self.models_dir / tts_service.QUALITY_MODEL_FILENAME, b"quality-model")
        write_asset(self.models_dir / tts_service.INT8_FALLBACK_MODEL_FILENAME, b"int8-model")
        write_asset(self.models_dir / tts_service.VOICES_FILENAME, b"voices")

        tts_service.get_kokoro()
        info = tts_service.get_runtime_info()

        self.assertEqual(info["selected_model"], tts_service.QUALITY_MODEL_FILENAME)
        self.assertIs(info["int8_fallback_used"], False)


if __name__ == "__main__":
    unittest.main()
