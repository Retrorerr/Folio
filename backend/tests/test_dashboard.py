import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.normpath(os.path.join(_HERE, ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

import main
from models import BookState, Bookmark, Position


class FakeRequest:
    def __init__(self, data):
        self.data = data

    async def json(self):
        return self.data


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.data_dir = os.path.join(self.tmp, "data")
        self.upload_dir = os.path.join(self.tmp, "uploads")
        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(self.upload_dir, exist_ok=True)
        self.old_data_dir = main.DATA_DIR
        self.old_upload_dir = main.UPLOAD_DIR
        self.old_cover = main._ensure_book_cover
        self.old_status = main._dashboard_status_summary
        main.DATA_DIR = self.data_dir
        main.UPLOAD_DIR = self.upload_dir
        main._ensure_book_cover = lambda filepath, book_id: (None, "test")
        main._dashboard_status_summary = lambda: {"reachable": True, "version": "test"}
        main.BOOKS.clear()
        main._recent_books_cache = None
        main._recent_books_cache_time = 0

    def tearDown(self):
        main.BOOKS.clear()
        main._recent_books_cache = None
        main._recent_books_cache_time = 0
        main.DATA_DIR = self.old_data_dir
        main.UPLOAD_DIR = self.old_upload_dir
        main._ensure_book_cover = self.old_cover
        main._dashboard_status_summary = self.old_status
        shutil.rmtree(self.tmp)

    def write_epub(self, name):
        path = os.path.join(self.upload_dir, name)
        Path(path).write_bytes(b"epub")
        return path

    def write_state(self, book_id, **overrides):
        filepath = overrides.pop("filepath", self.write_epub(f"{book_id}.epub"))
        state = BookState(
            id=book_id,
            filepath=filepath,
            title=overrides.pop("title", f"Book {book_id}"),
            author=overrides.pop("author", "Author"),
            page_count=overrides.pop("page_count", 10),
            toc=[],
            last_position=overrides.pop("last_position", Position(page=0, sentence_idx=0)),
            **overrides,
        )
        Path(main._state_path(book_id)).write_text(state.model_dump_json(indent=2), encoding="utf-8")
        return state

    def test_dashboard_payload_handles_old_state_without_new_fields(self):
        filepath = self.write_epub("old.epub")
        old_state = {
            "id": "old",
            "filepath": filepath,
            "title": "Old Schema",
            "author": "Legacy Author",
            "page_count": 7,
            "toc": [],
            "format": "epub",
            "tts_engine": "kokoro",
            "voice": "af_heart",
            "speed": 0.95,
            "last_position": {"page": 0, "sentence_idx": 0},
            "bookmarks": [],
        }
        Path(main._state_path("old")).write_text(json.dumps(old_state), encoding="utf-8")

        payload = main._dashboard_payload()

        self.assertEqual(payload["counts"]["books"], 1)
        self.assertEqual(payload["books"][0]["title"], "Old Schema")
        self.assertEqual(payload["books"][0]["collections"], [])
        self.assertEqual(payload["books"][0]["genres"], [])
        self.assertIsNotNone(payload["continue_book"])

    def test_library_search_matches_title_author_genre_and_collection(self):
        self.write_state(
            "one",
            title="Space Atlas",
            author="Jane Reader",
            genres=["Science"],
            collections=["Research"],
        )
        self.write_state("two", title="Quiet Poems", author="Alex Lines")

        by_title = main.search_library(q="space")
        by_author = main.search_library(q="alex")
        by_genre = main.search_library(q="science")
        by_collection = main.search_library(q="research")

        self.assertEqual([book["id"] for book in by_title["books"]], ["one"])
        self.assertEqual([book["id"] for book in by_author["books"]], ["two"])
        self.assertEqual([book["id"] for book in by_genre["books"]], ["one"])
        self.assertEqual([book["id"] for book in by_collection["books"]], ["one"])

    def test_goal_persistence(self):
        result = asyncio.run(main.save_dashboard_goal(FakeRequest({"daily_goal_minutes": 45})))

        self.assertEqual(result["daily_goal_minutes"], 45)
        self.assertEqual(main._load_dashboard_store()["daily_goal_minutes"], 45)

    def test_note_creation_persists_dashboard_note(self):
        self.write_state("book", title="Notes Book")

        result = asyncio.run(main.create_dashboard_note(FakeRequest({
            "book_id": "book",
            "page": 2,
            "text": "Remember this passage.",
        })))

        self.assertTrue(result["ok"])
        store = main._load_dashboard_store()
        self.assertEqual(len(store["notes"]), 1)
        self.assertEqual(store["notes"][0]["book_id"], "book")
        self.assertEqual(store["notes"][0]["note"], "Remember this passage.")

    def test_visual_page_count_persists_in_metadata(self):
        self.write_state(
            "visual",
            title="Visual Pages",
            page_count=14,
            last_position=Position(page=5, sentence_idx=0, visual_page=99),
        )

        result = asyncio.run(main.update_book_metadata("visual", FakeRequest({"visual_page_count": 222})))

        self.assertTrue(result["ok"])
        self.assertEqual(result["book"]["visual_page_count"], 222)
        payload = main._dashboard_payload()
        self.assertEqual(payload["counts"]["pages_total"], 222)
        self.assertEqual(payload["counts"]["pages_read"], 99)
        self.assertAlmostEqual(payload["books"][0]["progress"], 98 / 222)

    def test_legacy_position_estimates_visual_pages_read_from_progress(self):
        self.write_state(
            "legacy-visual",
            page_count=10,
            visual_page_count=100,
            last_position=Position(page=4, sentence_idx=0),
        )

        payload = main._dashboard_payload()

        self.assertEqual(payload["counts"]["pages_read"], 41)

    def test_sentence_position_update_preserves_exact_visual_page(self):
        state = self.write_state(
            "position",
            page_count=10,
            visual_page_count=100,
            last_position=Position(page=4, sentence_idx=2, content_page=3, visual_page=41),
        )
        main.BOOKS["position"] = {
            "state": state,
            "filepath": state.filepath,
            "last_activity_ms": None,
        }

        with mock.patch.object(main, "_save_state_debounced", return_value=None):
            result = main.save_position("position", Position(page=4, sentence_idx=3))

        self.assertTrue(result["ok"])
        self.assertEqual(state.last_position.content_page, 3)
        self.assertEqual(state.last_position.visual_page, 41)

    def test_dashboard_bookmark_keeps_visual_page_label_context(self):
        self.write_state(
            "bookmarked",
            bookmarks=[Bookmark(page=4, sentence_idx=2, label="A passage", visual_page=41)],
        )

        payload = main._dashboard_payload()

        self.assertEqual(payload["highlights"][0]["visual_page"], 41)

    def test_recent_continue_and_recently_added_sorting(self):
        self.write_state(
            "newest",
            title="Newest Import",
            imported_at=5000,
            last_opened_at=2000,
            last_position=Position(page=0, sentence_idx=0),
        )
        self.write_state(
            "progress",
            title="In Progress",
            imported_at=1000,
            last_opened_at=3000,
            last_position=Position(page=3, sentence_idx=0),
        )

        payload = main._dashboard_payload()

        self.assertEqual(payload["recent_books"][0]["id"], "progress")
        self.assertEqual(payload["recently_added"][0]["id"], "newest")
        self.assertEqual(payload["continue_book"]["id"], "progress")

    def test_dashboard_ignores_malformed_event_duration(self):
        Path(main._dashboard_path()).write_text(
            json.dumps({
                "reading_events": [{
                    "date": datetime.now().date().isoformat(),
                    "elapsed_ms": {"invalid": True},
                }],
            }),
            encoding="utf-8",
        )

        payload = main._dashboard_payload()

        self.assertEqual(payload["reading_goal"]["today_ms"], 0)
        self.assertEqual(payload["weekly_stats"][-1]["reading_ms"], 0)

    def test_dashboard_sorts_notes_with_malformed_timestamp(self):
        self.write_state("book", title="Notes Book")
        Path(main._dashboard_path()).write_text(
            json.dumps({
                "notes": [{
                    "book_id": "book",
                    "text": "Still visible",
                    "created_at": {"invalid": True},
                }],
            }),
            encoding="utf-8",
        )

        payload = main._dashboard_payload()

        self.assertEqual(payload["highlights"][0]["text"], "Still visible")

    def test_dashboard_reuses_cached_library_snapshot(self):
        cover_calls = []
        main._ensure_book_cover = lambda filepath, book_id: (cover_calls.append(book_id) or (None, "test"))
        self.write_state("cached", title="Cached Book")

        first = main._dashboard_payload()
        second = main._dashboard_payload()

        self.assertEqual(first["counts"]["books"], 1)
        self.assertEqual(second["counts"]["books"], 1)
        self.assertEqual(cover_calls, ["cached"])

    def test_dashboard_exposes_a_local_reader_name(self):
        payload = main._dashboard_payload()
        self.assertTrue(payload["profile"]["reader_name"])


if __name__ == "__main__":
    unittest.main()
