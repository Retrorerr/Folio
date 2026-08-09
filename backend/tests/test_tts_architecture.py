import os
import sys
import unittest
from unittest import mock

from fastapi.testclient import TestClient

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.normpath(os.path.join(_HERE, ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

import main
import reflow_service
import supertonic_service
import tts_service
from models import BookState
from tts_defaults import DEFAULT_TTS_ENGINE, DEFAULT_TTS_SPEED
from tts_queue import TTSQueue


class TtsArchitectureTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {
            "host": "127.0.0.1:8000",
            "x-folio-api-token": main._API_TOKEN,
        }

    def test_supertonic_is_default_engine(self):
        self.assertEqual(DEFAULT_TTS_ENGINE, "supertonic")
        self.assertEqual(main.DEFAULT_TTS_ENGINE, "supertonic")
        self.assertEqual(BookState(id="b", filepath="x.epub", title="T", author="", page_count=1, toc=[]).tts_engine, "supertonic")

    def test_only_supertonic_and_kokoro_are_valid_engine_ids(self):
        self.assertEqual(main._normalize_tts_engine("supertonic"), "supertonic")
        self.assertEqual(main._normalize_tts_engine("kokoro"), "kokoro")
        self.assertEqual(main._normalize_tts_engine("unknown"), "supertonic")
        self.assertEqual(set(main.TTS_SERVICES), {"supertonic", "kokoro"})

    def test_generic_persisted_state_fallback_sets_default_voice(self):
        state = BookState(
            id="b",
            filepath="x.epub",
            title="T",
            author="",
            page_count=1,
            toc=[],
            tts_engine="old-engine",
            voice="old-voice",
            speed=DEFAULT_TTS_SPEED,
        )

        coerced = main._coerce_tts_state(state)

        self.assertEqual(coerced.tts_engine, "supertonic")
        self.assertEqual(coerced.voice, "M1")
        self.assertEqual(coerced.tts_voices, {"supertonic": "M1"})

    def test_existing_kokoro_selection_remains_valid(self):
        state = BookState(
            id="b",
            filepath="x.epub",
            title="T",
            author="",
            page_count=1,
            toc=[],
            tts_engine="kokoro",
            voice="af_bella",
            speed=1.0,
        )

        coerced = main._coerce_tts_state(state)

        self.assertEqual(coerced.tts_engine, "kokoro")
        self.assertEqual(coerced.voice, "af_bella")
        self.assertEqual(coerced.tts_voices["kokoro"], "af_bella")

    def test_invalid_voice_fallback_per_engine(self):
        self.assertEqual(main._normalize_voice_for_engine("supertonic", "af_heart"), "M1")
        self.assertEqual(main._normalize_voice_for_engine("kokoro", "M1"), "af_heart")
        self.assertEqual(main._normalize_voice_for_engine("supertonic", "F4"), "F4")
        self.assertEqual(main._normalize_voice_for_engine("kokoro", "af_nicole"), "af_nicole")

    def test_job_and_cache_keys_separate_engines_and_voices(self):
        supertonic_job = main._job_key("book", 1, 2, "supertonic", "M1", 1.0)
        kokoro_job = main._job_key("book", 1, 2, "kokoro", "af_heart", 1.0)
        supertonic_voice_job = main._job_key("book", 1, 2, "supertonic", "F1", 1.0)

        self.assertNotEqual(supertonic_job, kokoro_job)
        self.assertNotEqual(supertonic_job, supertonic_voice_job)
        self.assertTrue(supertonic_job.startswith("supertonic|"))
        self.assertTrue(kokoro_job.startswith("kokoro|"))

        self.assertIn("supertonic", supertonic_service.audio_cache_path("book", "Same text.", "M1", 1.0))
        self.assertIn("kokoro", tts_service.audio_cache_path("book", "Same text.", "af_heart", 1.0))
        self.assertNotEqual(
            supertonic_service.audio_cache_path("book", "Same text.", "M1", 1.0),
            tts_service.audio_cache_path("book", "Same text.", "af_heart", 1.0),
        )

    def test_tts_options_schema_is_two_engine_supertonic_first(self):
        response = self.client.get("/api/tts/options", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        engines = data["engines"]

        self.assertEqual([engine["id"] for engine in engines], ["supertonic", "kokoro"])
        self.assertEqual(engines[0]["name"], "Supertonic 3")
        self.assertEqual(engines[0]["default_voice"], "M1")
        self.assertEqual(engines[0]["voices"], ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"])

    def test_generate_endpoint_rejects_speed_outside_selected_engine_range(self):
        response = self.client.get(
            "/api/tts/generate?book_id=b&page=0&sentence=0&engine=kokoro&voice=af_heart&speed=1.8",
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 400)

    def test_book_settings_response_preserves_selected_engine(self):
        state = BookState(
            id="settings-book",
            filepath="x.epub",
            title="T",
            author="",
            page_count=1,
            toc=[],
            tts_engine="supertonic",
            voice="M1",
            speed=1.0,
        )
        main.BOOKS[state.id] = {"state": state, "filepath": state.filepath}

        try:
            with (
                mock.patch.object(main, "_activate_tts_engine"),
                mock.patch.object(main, "_save_state"),
            ):
                response = self.client.post(
                    f"/api/book/{state.id}/settings?tts_engine=kokoro&voice=af_bella&speed=1",
                    headers=self.headers,
                )
        finally:
            main.BOOKS.pop(state.id, None)

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["tts_engine"], "kokoro")
        self.assertEqual(data["voice"], "af_bella")
        self.assertEqual(data["tts_voices"]["kokoro"], "af_bella")

    def test_buffer_queue_uses_generic_engine_scope(self):
        keep = {main._job_key("book", 0, 0, "supertonic", "M1", 1.0)}
        queue = main.TTS_MANAGER
        with mock.patch.object(queue, "cancel_pending", return_value=2) as cancel_pending:
            cancelled = main._cancel_pending_tts_buffer(
                "book",
                "supertonic",
                "M1",
                1.0,
                keep_keys=keep,
            )

        predicate = cancel_pending.call_args.args[0]
        self.assertEqual(cancelled, 2)
        self.assertFalse(predicate(main._job_key("book", 0, 0, "supertonic", "M1", 1.0)))
        self.assertTrue(predicate(main._job_key("book", 0, 1, "supertonic", "M1", 1.0)))
        self.assertFalse(predicate(main._job_key("book", 0, 1, "kokoro", "af_heart", 1.0)))

    def test_queue_activity_reports_job_metadata(self):
        queue = TTSQueue(worker_count=0)
        queue.submit(
            "supertonic|book|3|10|M1|1.0",
            fn=lambda: ("audio.wav", 1000),
            priority=2,
            metadata={"engine": "supertonic", "page": 3, "sentence": 10, "text": "Queued text."},
        )

        activity = queue.activity()

        self.assertEqual(activity["active"]["metadata"]["engine"], "supertonic")
        self.assertEqual(activity["active"]["metadata"]["sentence"], 10)
        self.assertEqual(activity["pending"][0]["metadata"]["text"], "Queued text.")

    def test_background_audio_job_cannot_reactivate_inactive_engine(self):
        service = mock.Mock()
        service.normalize_voice.side_effect = lambda voice: voice
        service.validate_speed.side_effect = lambda speed: float(speed)
        previous_engine = main._active_tts_engine
        main._active_tts_engine = "supertonic"

        try:
            with (
                mock.patch.object(main, "_engine_service", return_value=service),
                self.assertRaisesRegex(RuntimeError, "supertonic is now the active TTS engine"),
            ):
                main._generate_audio(
                    "Text",
                    "kokoro",
                    "af_heart",
                    1.0,
                    "book",
                    allow_engine_switch=False,
                )
        finally:
            main._active_tts_engine = previous_engine

        service.generate_sentence_audio.assert_not_called()

    def test_cancel_tts_buffer_can_drop_current_key_on_engine_switch(self):
        with mock.patch.object(main.TTS_MANAGER, "cancel_pending", return_value=1) as cancel_pending:
            response = self.client.post(
                "/api/tts/buffer/cancel"
                "?book_id=book&page=0&sentence=0&engine=kokoro&voice=af_heart&speed=1&keep_current=false",
                headers=self.headers,
            )

        self.assertEqual(response.status_code, 200)
        predicate = cancel_pending.call_args.args[0]
        self.assertTrue(predicate(main._job_key("book", 0, 0, "kokoro", "af_heart", 1.0)))


class ReflowNarrationTests(unittest.TestCase):
    def test_toc_follows_rendered_chapter_boundaries(self):
        toc = reflow_service.reflow_toc({
            "chapters": [
                {"number": "I", "title": "Arrival", "blocks": []},
                {"number": None, "title": "Interlude", "blocks": []},
                {"number": "2", "title": "Chapter 2", "blocks": []},
            ],
        })

        self.assertEqual(toc, [
            {"title": "I - Arrival", "page": 0},
            {"title": "Interlude", "page": 1},
            {"title": "Chapter 2", "page": 2},
        ])

    def test_structure_and_body_follow_visual_order(self):
        chapter = {
            "number": "4",
            "title": "Storm Signals",
            "blocks": [
                {"type": "heading", "level": 2, "text": "What Changed"},
                {
                    "type": "paragraph",
                    "sentences": [
                        {"text": "The first body sentence.", "idx": 21, "kind": "prose"},
                        {"text": "The second body sentence.", "idx": 22, "kind": "prose"},
                    ],
                },
            ],
        }

        units = reflow_service.chapter_narration_units(chapter)

        self.assertEqual(
            [unit["text"] for unit in units],
            [
                "Chapter 4.",
                "Storm Signals.",
                "What Changed.",
                "The first body sentence.",
                "The second body sentence.",
            ],
        )
        self.assertEqual([unit["kind"] for unit in units[:3]], ["chapter-label", "chapter-title", "heading-2"])
        self.assertEqual(units[3]["global_sentence_idx"], 21)
        self.assertEqual(units[3]["legacy_sentence_idx"], 0)
        self.assertEqual(units[4]["legacy_sentence_idx"], 1)
        self.assertEqual(units[4]["pause_after_ms"], 500)

    def test_section_break_extends_previous_pause(self):
        chapter = {
            "title": "A Beginning",
            "blocks": [
                {"type": "paragraph", "sentences": [{"text": "Before the break.", "idx": 1}]},
                {"type": "dinkus"},
                {"type": "paragraph", "sentences": [{"text": "After the break.", "idx": 2}]},
            ],
        }

        units = reflow_service.chapter_narration_units(chapter)

        self.assertEqual(units[1]["text"], "Before the break.")
        self.assertEqual(units[1]["pause_after_ms"], 900)
        self.assertEqual(units[2]["text"], "After the break.")

    def test_legacy_body_index_maps_past_structural_units(self):
        chapter = {
            "number": "7",
            "title": "The Crossing",
            "blocks": [
                {"type": "heading", "level": 2, "text": "At the Shore"},
                {
                    "type": "paragraph",
                    "sentences": [
                        {"text": "First body sentence."},
                        {"text": "Second body sentence."},
                    ],
                },
            ],
        }

        self.assertEqual(reflow_service.migrate_legacy_sentence_index(chapter, 0), 3)
        self.assertEqual(reflow_service.migrate_legacy_sentence_index(chapter, 1), 4)
        self.assertEqual(reflow_service.migrate_legacy_sentence_index(chapter, 99), 4)


if __name__ == "__main__":
    unittest.main()
