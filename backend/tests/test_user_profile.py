import os
import sys
import unittest
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.normpath(os.path.join(_HERE, ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

import user_profile


class UserProfileTests(unittest.TestCase):
    def tearDown(self):
        user_profile.system_reader_name.cache_clear()

    def test_normalize_reader_name_collapses_whitespace_and_limits_length(self):
        self.assertEqual(user_profile.normalize_reader_name("  Maris   Obazee  "), "Maris Obazee")
        self.assertEqual(user_profile.normalize_reader_name("Maris Obazee", first_name_only=True), "Maris")
        self.assertEqual(len(user_profile.normalize_reader_name("x" * 100)), 40)

    def test_system_reader_name_prefers_local_display_name(self):
        user_profile.system_reader_name.cache_clear()
        with mock.patch.object(user_profile, "_windows_display_name", return_value="Maris Obazee"), \
             mock.patch.object(user_profile, "_posix_display_name", return_value=""):
            self.assertEqual(user_profile.system_reader_name(), "Maris")

    def test_system_reader_name_has_username_fallback(self):
        user_profile.system_reader_name.cache_clear()
        with mock.patch.object(user_profile, "_windows_display_name", return_value=""), \
             mock.patch.object(user_profile, "_posix_display_name", return_value=""), \
             mock.patch.object(user_profile.getpass, "getuser", return_value="reader"):
            self.assertEqual(user_profile.system_reader_name(), "Reader")


if __name__ == "__main__":
    unittest.main()
