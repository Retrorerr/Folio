import asyncio
import io
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import main
from fastapi import HTTPException, UploadFile


def epub_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", "<container />")
    return buffer.getvalue()


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.upload_dir = Path(self.tmp.name) / "uploads"
        self.upload_dir.mkdir()
        self.upload_dir_patch = mock.patch.object(main, "UPLOAD_DIR", str(self.upload_dir))
        self.upload_dir_patch.start()
        self.addCleanup(self.upload_dir_patch.stop)

    @staticmethod
    def upload(content: bytes, filename: str = "book.epub") -> UploadFile:
        return UploadFile(file=io.BytesIO(content), filename=filename)

    def test_upload_is_bounded_before_any_file_is_written(self):
        with (
            mock.patch.object(main, "_MAX_UPLOAD_BYTES", 8),
            self.assertRaises(HTTPException) as raised,
        ):
            asyncio.run(main.open_book_upload(self.upload(b"123456789")))

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(os.listdir(self.upload_dir), [])

    def test_non_zip_epub_is_rejected_before_any_file_is_written(self):
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(main.open_book_upload(self.upload(b"not-an-epub")))

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(os.listdir(self.upload_dir), [])

    def test_epub_with_unsafe_archive_path_is_rejected(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("META-INF/container.xml", "<container />")
            archive.writestr("../outside.xhtml", "unsafe")

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(main.open_book_upload(self.upload(buffer.getvalue())))

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(os.listdir(self.upload_dir), [])

    def test_epub_expansion_is_bounded_before_writing(self):
        content = epub_bytes()
        with (
            mock.patch.object(main, "_MAX_EPUB_EXPANDED_BYTES", 4),
            self.assertRaises(HTTPException) as raised,
        ):
            asyncio.run(main.open_book_upload(self.upload(content)))

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(os.listdir(self.upload_dir), [])

    def test_valid_epub_is_saved_and_opened_from_its_content_addressed_path(self):
        content = epub_bytes()
        with mock.patch.object(main, "open_book", return_value={"ok": True}) as open_book:
            result = asyncio.run(main.open_book_upload(self.upload(content, "A: Book?.epub")))

        self.assertEqual(result, {"ok": True})
        saved_files = list(self.upload_dir.iterdir())
        self.assertEqual(len(saved_files), 1)
        self.assertEqual(saved_files[0].read_bytes(), content)
        self.assertNotIn(":", saved_files[0].name)
        self.assertNotIn("?", saved_files[0].name)
        open_book.assert_called_once_with(str(saved_files[0]))


if __name__ == "__main__":
    unittest.main()
