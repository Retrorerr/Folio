import tempfile
import unittest
import zipfile
from pathlib import Path

import cover_service


class CoverServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write_epub(self, name: str, members: dict[str, bytes]) -> Path:
        path = Path(self.tmp.name) / name
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for member_name, content in members.items():
                archive.writestr(member_name, content)
        return path

    def test_filename_fallback_has_the_full_cover_result_shape_without_an_opf(self):
        epub = self.write_epub("missing-opf.epub", {"images/cover.jpg": b"cover-bytes"})

        result = cover_service._extract_cover_bytes(str(epub))

        self.assertEqual(result, (b"cover-bytes", "zip-filename-fallback", "images/cover.jpg"))

    def test_filename_fallback_survives_a_malformed_opf(self):
        container = b"""<?xml version="1.0"?>
        <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles><rootfile full-path="content.opf" /></rootfiles>
        </container>"""
        epub = self.write_epub(
            "malformed-opf.epub",
            {
                "META-INF/container.xml": container,
                "content.opf": b"<package>",
                "cover.png": b"fallback-cover",
            },
        )

        result = cover_service._extract_cover_bytes(str(epub))

        self.assertEqual(result, (b"fallback-cover", "zip-filename-fallback", "cover.png"))

    def test_oversized_cover_member_is_rejected_before_reading(self):
        oversized = b"x" * (cover_service.MAX_COVER_MEMBER_BYTES + 1)
        epub = self.write_epub("oversized-cover.epub", {"cover.jpg": oversized})

        with zipfile.ZipFile(epub) as archive:
            self.assertIsNone(cover_service._safe_read(archive, "cover.jpg"))


if __name__ == "__main__":
    unittest.main()
