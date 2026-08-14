from __future__ import annotations

import json
import os
import sys
import warnings
import zipfile
from pathlib import Path

from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning
from ebooklib import epub

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.normpath(os.path.join(_HERE, ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

import reflow_service


def _write_epub_with_missing_ncx(epub_path: Path) -> None:
    chapter = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter One</title></head>
  <body>
    <h1>Chapter One</h1>
    <p>This chapter has enough prose to be treated as book content. It should import even without an NCX file. The navigation metadata is incomplete, but the reading order still comes from the spine. Folio should preserve the chapter text instead of treating the upload as a server error.</p>
    <p>A second paragraph makes the chapter look like a real body section. The regression is about a missing navigation file, not about accepting empty documents. The fallback should be narrow: keep the same package payload, remove only the dangling spine toc attribute in a temporary copy, and parse the resulting spine items normally.</p>
    <p>The rest of this paragraph is deliberate body text for the frontmatter filter. A small story chapter can begin quietly, with a traveler listening to old machinery and counting the lights across the station window. Nothing about that prose should depend on an NCX document existing, because many EPUB readers can still follow the manifest and spine.</p>
  </body>
</html>
"""
    opf = """<?xml version="1.0" encoding="utf-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Missing NCX</dc:title>
    <dc:creator>Folio Test</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">missing-ncx</dc:identifier>
  </metadata>
  <manifest>
    <item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
  </spine>
</package>
"""
    with zipfile.ZipFile(epub_path, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
""",
        )
        zf.writestr("OEBPS/content.opf", opf)
        zf.writestr("OEBPS/chapter.xhtml", chapter)


def _block_text(block: dict) -> str:
    return " ".join(sent.get("text", "") for sent in block.get("sentences", [])).strip()


def test_extract_flat_blocks_preserves_html_paragraph_boundaries():
    soup = BeautifulSoup(
        """
        <html><body>
          <h1>Chapter One</h1>
          <p>First paragraph. Still first paragraph.</p>
          <p>Second paragraph.</p>
          <p>   </p>
          <blockquote>
            <p>Quoted paragraph one.</p>
            <p>Quoted paragraph two.</p>
          </blockquote>
          <ul>
            <li>First list item.</li>
            <li>Second list item.</li>
          </ul>
          <hr />
          <p>After the section break.</p>
        </body></html>
        """,
        "lxml",
    )

    blocks = reflow_service._extract_flat_blocks(soup)
    block_texts = [_block_text(block) for block in blocks if block.get("type") == "paragraph"]
    roles = [block.get("role", "prose") for block in blocks if block.get("type") == "paragraph"]

    assert block_texts == [
        "First paragraph. Still first paragraph.",
        "Second paragraph.",
        "Quoted paragraph one.",
        "Quoted paragraph two.",
        "First list item.",
        "Second list item.",
        "After the section break.",
    ]
    assert roles == [
        "prose",
        "prose",
        "blockquote",
        "blockquote",
        "list-item",
        "list-item",
        "prose",
    ]
    assert any(block.get("type") == "dinkus" for block in blocks)


def test_epub_reflow_keeps_blocks_for_viewer_and_tts_mapping(tmp_path: Path):
    body_tail = (
        "This sentence makes the chapter body long enough to avoid front matter. "
        "It also gives the chunker multiple sentences to map. "
        "The paragraph should remain one visual block. "
    )
    chapter_html = f"""
        <h1>Chapter One</h1>
        <p>First paragraph starts here. {body_tail}</p>
        <p>Second paragraph starts here. {body_tail}</p>
        <blockquote>
          <p>Quoted paragraph one stays separate. {body_tail}</p>
          <p>Quoted paragraph two stays separate. {body_tail}</p>
        </blockquote>
        <ol>
          <li>First list item survives as its own block.</li>
          <li>Second list item survives as its own block.</li>
        </ol>
        <hr />
        <p>After the section break, prose continues in a fresh block. {body_tail}</p>
    """

    book = epub.EpubBook()
    book.set_identifier("paragraph-boundary-regression")
    book.set_title("Paragraph Boundary Regression")
    book.set_language("en")
    book.add_author("Folio Test")

    chapter = epub.EpubHtml(title="Chapter One", file_name="chapter.xhtml", lang="en")
    chapter.content = chapter_html
    book.add_item(chapter)
    book.toc = (epub.Link("chapter.xhtml", "Chapter One", "chapter-one"),)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav", chapter]

    epub_path = tmp_path / "paragraph-boundary-regression.epub"
    epub.write_epub(str(epub_path), book, {})

    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
        doc = reflow_service.build_reflow(str(epub_path))
    assert doc["version"] == reflow_service.REFLOW_VERSION
    assert len(doc["chapters"]) == 1

    blocks = doc["chapters"][0]["blocks"]
    paragraph_blocks = [block for block in blocks if block.get("type") == "paragraph"]
    roles = [block.get("role", "prose") for block in paragraph_blocks]
    texts = [_block_text(block) for block in paragraph_blocks]

    assert roles == [
        "prose",
        "prose",
        "blockquote",
        "blockquote",
        "list-item",
        "list-item",
        "prose",
    ]
    assert texts[0].startswith("First paragraph starts here.")
    assert texts[1].startswith("Second paragraph starts here.")
    assert "Second paragraph starts here." not in texts[0]
    assert any(block.get("type") == "dinkus" for block in blocks)

    chunk_indices = [
        sent["idx"]
        for block in paragraph_blocks
        for sent in block.get("sentences", [])
    ]
    assert chunk_indices == list(range(len(chunk_indices)))

    source_sentence_ids = [
        source_idx
        for block in paragraph_blocks
        for sent in block.get("sentences", [])
        for source_idx in sent.get("source_sentences", [])
    ]
    assert source_sentence_ids == sorted(source_sentence_ids)
    assert len(source_sentence_ids) == len(set(source_sentence_ids))

    list_kinds = [
        sent.get("kind")
        for block in paragraph_blocks
        if block.get("role") == "list-item"
        for sent in block.get("sentences", [])
    ]
    assert list_kinds == ["list", "list"]


def test_epub_with_missing_ncx_reference_still_imports(tmp_path: Path):
    epub_path = tmp_path / "missing-ncx.epub"
    _write_epub_with_missing_ncx(epub_path)

    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
        meta = reflow_service.get_metadata(str(epub_path))
        doc = reflow_service.build_reflow(str(epub_path))

    assert meta["title"] == "Missing NCX"
    assert meta["author"] == "Folio Test"
    assert meta["page_count"] == 1
    assert len(doc["chapters"]) == 1
    assert doc["chapters"][0]["title"] == "Chapter One"


def test_reflow_cache_rebuilds_when_source_file_changes(tmp_path: Path, monkeypatch):
    epub_path = tmp_path / "mutable.epub"
    data_dir = tmp_path / "data"
    calls: list[str] = []

    def fake_build_reflow(filepath: str) -> dict:
        calls.append(Path(filepath).read_text(encoding="utf-8"))
        return {
            "format": "epub",
            "version": reflow_service.REFLOW_VERSION,
            "chunker_version": reflow_service.text_chunker.CHUNKER_VERSION,
            "metadata": {"title": "Mutable", "author": "Folio"},
            "chapters": [{"id": 0, "title": calls[-1], "blocks": []}],
            "sentence_count": 0,
        }

    monkeypatch.setattr(reflow_service, "build_reflow", fake_build_reflow)

    epub_path.write_text("first", encoding="utf-8")
    first = reflow_service.get_or_build_reflow(str(epub_path), str(data_dir))
    second = reflow_service.get_or_build_reflow(str(epub_path), str(data_dir))

    epub_path.write_text("second version", encoding="utf-8")
    changed = reflow_service.get_or_build_reflow(str(epub_path), str(data_dir))

    assert len(calls) == 2
    assert first == second
    assert changed["chapters"][0]["title"] == "second version"


def test_normalize_epub_path():
    assert reflow_service._normalize_epub_path("OEBPS/text/ch01.xhtml#fragment?query=1") == "OEBPS/text/ch01.xhtml"
    assert reflow_service._normalize_epub_path("OEBPS%20Folder/ch%201.xhtml") == "OEBPS Folder/ch 1.xhtml"
    assert reflow_service._normalize_epub_path("a/b/../c.html") == "a/c.html"
    assert reflow_service._normalize_epub_path("\\a\\b\\c.html") == "a/b/c.html"
    assert reflow_service._normalize_epub_path("") == ""


def test_get_metadata_loads_from_cached_reflow(tmp_path: Path):
    epub_path = tmp_path / "test.epub"
    epub_path.write_text("fake epub", encoding="utf-8")
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    # Pre-populate cache
    book_id = reflow_service.get_book_id(str(epub_path))
    cache_path = reflow_service.cached_reflow_path(str(data_dir), book_id)
    
    source = reflow_service._source_fingerprint(str(epub_path))
    cache_data = {
        "format": "epub",
        "version": reflow_service.REFLOW_VERSION,
        "source": source,
        "metadata": {
            "title": "Cached Title",
            "author": "Cached Author",
        },
        "chapters": [
            {"title": "Cached Chapter 1", "blocks": []},
            {"title": "Cached Chapter 2", "blocks": []},
        ]
    }
    
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache_data, f)
        
    meta = reflow_service.get_metadata(str(epub_path), str(data_dir))
    assert meta["title"] == "Cached Title"
    assert meta["author"] == "Cached Author"
    assert meta["page_count"] == 2
    assert meta["toc"] == [
        {"title": "Cached Chapter 1", "page": 0},
        {"title": "Cached Chapter 2", "page": 1},
    ]


def test_toc_mapping_resolves_basename_collisions_and_fragments(tmp_path: Path):
    book = epub.EpubBook()
    book.set_identifier("toc-collision-test")
    book.set_title("TOC Collision Test")
    book.set_language("en")
    book.add_author("Folio Test")

    # Add duplicate basenames in different directories
    ch1 = epub.EpubHtml(title="Section 1 Chapter", file_name="section1/chapter.xhtml", lang="en")
    ch1.content = "<html><body><h1>Chapter</h1><p>Content of section 1. This paragraph is long enough.</p></body></html>"
    
    ch2 = epub.EpubHtml(title="Section 2 Chapter", file_name="section2/chapter.xhtml", lang="en")
    ch2.content = "<html><body><h1>Chapter</h1><p>Content of section 2. This paragraph is long enough.</p></body></html>"

    book.add_item(ch1)
    book.add_item(ch2)
    
    # TOC pointing to specific directories with fragments/relative paths
    book.toc = (
        epub.Link("section1/chapter.xhtml#intro", "Intro Section 1", "s1"),
        epub.Link("../section2/chapter.xhtml?foo=bar#main", "Main Section 2", "s2"),
    )
    
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav", ch1, ch2]
    
    epub_path = tmp_path / "collision.epub"
    epub.write_epub(str(epub_path), book, {})
    
    meta = reflow_service.get_metadata(str(epub_path))
    assert meta["toc"][0]["page"] == 0
    assert meta["toc"][1]["page"] == 1
