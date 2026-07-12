import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.normpath(os.path.join(_HERE, ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

import model_manager


class ModelManagerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.old_state_dir = model_manager.INSTALL_STATE_DIR
        model_manager.INSTALL_STATE_DIR = Path(self.tmp)

    def tearDown(self):
        model_manager.INSTALL_STATE_DIR = self.old_state_dir
        shutil.rmtree(self.tmp)

    def test_unchanged_state_does_not_rewrite_install_metadata(self):
        state = model_manager.default_state("engine", "Engine", 100)
        state = model_manager.set_state(state, "ready", ready=True, downloaded_bytes=100, total_bytes=100)
        path = model_manager.state_path("engine")
        before_mtime = path.stat().st_mtime_ns
        before_text = path.read_text(encoding="utf-8")
        before_updated = state["updated_at"]

        state = model_manager.set_state(state, "ready", ready=True, downloaded_bytes=100, total_bytes=100)
        state = model_manager.update_progress(state, 100, 100)

        self.assertEqual(path.stat().st_mtime_ns, before_mtime)
        self.assertEqual(path.read_text(encoding="utf-8"), before_text)
        self.assertEqual(state["updated_at"], before_updated)

    def test_state_write_is_atomic_and_leaves_no_temp_file(self):
        state = model_manager.default_state("engine", "Engine", 100)
        model_manager.save_state(state)

        self.assertTrue(model_manager.state_path("engine").is_file())
        self.assertEqual(list(Path(self.tmp).glob("*.tmp.*")), [])


if __name__ == "__main__":
    unittest.main()
