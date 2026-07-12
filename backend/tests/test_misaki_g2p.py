from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from misaki_g2p import MisakiEnglishG2P, REVISION


class MisakiEnglishG2PParityTests(unittest.TestCase):
    def test_lightweight_runtime_matches_pinned_official_misaki_fixtures(self):
        document = json.loads((Path(__file__).parent / "fixtures" / "misaki_en_parity.json").read_text(encoding="utf-8"))
        self.assertEqual(document["oracleRevision"], REVISION)

        current_raw: dict[str, str] = {}
        fallback_calls: list[tuple[str, str]] = []

        def fallback(word: str, language: str) -> str:
            fallback_calls.append((word, language))
            if word not in current_raw:
                raise AssertionError(f"Unexpected eSpeak fallback for {word}")
            return current_raw[word]

        runtime = MisakiEnglishG2P(fallback=fallback)
        for fixture in document["fixtures"]:
            with self.subTest(dialect=fixture["dialect"], case=fixture["id"]):
                current_raw = fixture["fallbackRaw"]
                fallback_calls.clear()
                result = runtime.phonemize(fixture["text"], british=fixture["dialect"] == "gb")

                self.assertEqual(result.phonemes, fixture["phonemes"])
                self.assertEqual(list(result.telemetry.fallback_words), fixture["fallbackWords"])
                self.assertEqual([word for word, _ in fallback_calls], fixture["fallbackWords"])
                expected_language = "en-gb" if fixture["dialect"] == "gb" else "en-us"
                self.assertTrue(all(language == expected_language for _, language in fallback_calls))
                if fixture["id"] == "ood":
                    self.assertEqual(fixture["fallbackWords"], ["zxqvblorfquangles"])
                    self.assertNotEqual(result.phonemes, fixture["wholeSentenceEspeak"])
                else:
                    self.assertEqual(fallback_calls, [])


if __name__ == "__main__":
    unittest.main()
