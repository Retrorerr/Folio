"""EPUB → structured reflow JSON.

Produces a chapter-by-chapter document tree the frontend can render with
themed typography (running head, chapter eyebrow/display, drop cap, justified
Cormorant body) matching the Folio design reference.

No LLM, no OCR. Deterministic extraction + typographic regex cleanup.
"""
import hashlib
import json
import os
import re
import logging

from bs4 import BeautifulSoup
from ebooklib import epub, ITEM_DOCUMENT

import text_chunker

logger = logging.getLogger(__name__)
REFLOW_VERSION = f"reflow-v2.3-2026-05-12|chunker:{text_chunker.CHUNKER_VERSION}"


def get_book_id(filepath: str) -> str:
    normalized = os.path.normpath(filepath).replace("\\", "/").lower()
    return hashlib.md5(normalized.encode()).hexdigest()[:12]


# ----- typographic cleanup -----

_SMART_QUOTE_PAIRS = [
    (re.compile(r'(^|[\s(\[{—–-])"'), r'\1“'),
    (re.compile(r'"'), r'”'),
    (re.compile(r"(^|[\s(\[{—–-])'"), r"\1‘"),
    (re.compile(r"'"), r"’"),
]

def _typographic(text: str) -> str:
    if not text:
        return ""
    # Collapse runs of whitespace (EPUBs often preserve XML indentation)
    text = re.sub(r"\s+", " ", text).strip()
    # Hyphenation rejoin: "spo- ken" → "spoken" (only when both halves are lowercase letters)
    text = re.sub(r"([a-z])-\s+([a-z])", r"\1\2", text)
    # Ellipsis
    text = text.replace("...", "…")
    # Em-dash from " -- " or surrounding " - "
    text = re.sub(r"\s+--\s+", " — ", text)
    text = re.sub(r"\s+-\s+", " — ", text)
    # Smart quotes
    for pat, repl in _SMART_QUOTE_PAIRS:
        text = pat.sub(repl, text)
    return text


# ----- sentence splitting for the audio pipeline -----

_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "v", "etc",
    "inc", "ltd", "corp", "vol", "ch", "fig", "no", "approx", "dept",
    "est", "govt", "gen", "gov", "sgt", "cpl", "pvt", "rev", "sen",
    "rep", "pres", "u.s", "u.k", "u.n", "e.g", "i.e", "al", "op", "ed",
    "pt", "ft", "mt", "ave", "blvd",
}

def _split_sentences(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    sentences, start, i = [], 0, 0
    while i < len(text):
        ch = text[i]
        if ch in ".!?…":
            if ch == "." and 0 < i < len(text) - 1 and text[i-1].isdigit() and text[i+1].isdigit():
                i += 1
                continue
            prefix = text[:i+1].rstrip()
            toks = prefix.split()
            last = toks[-1].strip("\"'“”‘’()[]{}").rstrip(".!?").lower() if toks else ""
            if last in _ABBREVIATIONS:
                i += 1
                continue
            end = i + 1
            while end < len(text) and text[end] in "\"'”’)]}":
                end += 1
            tail = text[end:].lstrip()
            # Mid-acronym: prefix ends with a single capital + period and the
            # tail begins with another single capital + period (e.g. "U.S.",
            # "U.K.", "P.M."). Don't split here.
            if re.search(r"\b[A-Z]\.$", prefix) and re.match(r"[A-Z]\.", tail):
                i += 1
                continue
            # Initial + name: single capital + period followed by a capitalized
            # word (e.g. "J. Maynard Smith"). The 2-adjacent-initials rule
            # above only catches consecutive initials like "G. C." or "W. D.".
            if re.search(r"\b[A-Z]\.$", prefix) and re.match(r"[A-Z][a-z]", tail):
                i += 1
                continue
            if not tail or tail[0].isupper() or tail[0] in "\"'“‘(":
                sent = text[start:end].strip()
                if sent:
                    sentences.append(sent)
                start = end
                i = end
                continue
        i += 1
    rest = text[start:].strip()
    if rest:
        sentences.append(rest)
    return sentences or [text]


# ----- EPUB extraction -----

_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
_PARAGRAPH_TAGS = {"p"}
_LIST_TAGS = {"ol", "ul", "menu"}
_LIST_ITEM_TAGS = {"li"}
_BLOCKQUOTE_TAGS = {"blockquote"}
_CONTAINER_TAGS = {
    "body", "html", "main", "article", "section", "div", "chapter",
    "aside", "header", "footer",
}
_SEMANTIC_BLOCK_TAGS = (
    _HEADING_TAGS | _PARAGRAPH_TAGS | _LIST_TAGS | _LIST_ITEM_TAGS |
    _BLOCKQUOTE_TAGS | {"hr"}
)
_SECTION_BREAK_TEXT_RE = re.compile(
    r"^\s*(?:(?:\*\s*){3,}|(?:\.\s*){3,}|(?:[-_]\s*){3,}|(?:[\u2022\u00b7]\s*){3,})\s*$"
)


def _chapter_number_from_title(title: str) -> tuple[str | None, str]:
    """Try to split 'Chapter VII — The Races' into ('VII', 'The Races')."""
    if not title:
        return None, ""
    m = re.match(r"^\s*(?:chapter|ch\.?|part|book)\s+([ivxlcdm\d]+)\b[\s\.—–:\-]*(.*)$", title, re.I)
    if m:
        return m.group(1).upper(), m.group(2).strip() or title.strip()
    m = re.match(r"^\s*(\d{1,3})[.\s]\s*(.+?)\s*\.?\s*$", title)
    if m:
        return m.group(1), m.group(2).strip()
    return None, title.strip()


def _is_section_break_text(text: str) -> bool:
    return bool(text and _SECTION_BREAK_TEXT_RE.match(text))


def _append_dinkus_block(blocks: list[dict]) -> None:
    if blocks and blocks[-1].get("type") == "dinkus":
        return
    blocks.append({"type": "dinkus"})


def _append_paragraph_block(blocks: list[dict], text: str, role: str = "prose", tag: str = "p") -> None:
    if _is_section_break_text(text):
        _append_dinkus_block(blocks)
        return

    text = _typographic(text)
    if not text:
        return
    sentences = [{"text": s} for s in _split_sentences(text)]
    if sentences:
        block = {"type": "paragraph", "sentences": sentences}
        if role != "prose":
            block["role"] = role
        if tag != "p":
            block["tag"] = tag
        blocks.append(block)


def _extract_flat_blocks(soup: BeautifulSoup) -> list[dict]:
    """Walk the EPUB body and return semantic blocks.

    Real paragraph-like tags are the source of paragraph boundaries. Container
    tags such as div/section are traversed first and are only treated as a
    paragraph when the EPUB offers no nested paragraph/head/body structure.
    This avoids spacing/rendering by sentence-ish wrapper divs.
    """
    body = soup.body or soup
    blocks: list[dict] = []

    def visit(node, role: str = "prose") -> None:
        for el in getattr(node, "children", []):
            name = getattr(el, "name", None)
            if not name:
                text = str(el).strip()
                if text:
                    _append_paragraph_block(blocks, text, role=role, tag="#text")
                continue
            name = name.lower()
            if name in {"script", "style", "svg", "nav", "img", "image"}:
                continue
            if name == "hr":
                _append_dinkus_block(blocks)
                continue

            raw = el.get_text(" ", strip=True)
            if not raw:
                continue

            if name in _HEADING_TAGS:
                text = _typographic(raw)
                if text:
                    blocks.append({"type": "heading", "level": int(name[1]), "text": text})
                continue

            if name in _BLOCKQUOTE_TAGS:
                has_semantic_children = el.find(list(_SEMANTIC_BLOCK_TAGS), recursive=True) is not None
                if has_semantic_children:
                    visit(el, role="blockquote")
                else:
                    _append_paragraph_block(blocks, raw, role="blockquote", tag=name)
                continue

            if name in _LIST_TAGS:
                visit(el, role=role)
                continue

            if name in _LIST_ITEM_TAGS:
                _append_paragraph_block(blocks, raw, role="list-item", tag=name)
                continue

            if name in _PARAGRAPH_TAGS:
                _append_paragraph_block(blocks, raw, role=role, tag=name)
                continue

            if name in _CONTAINER_TAGS:
                has_semantic_children = el.find(list(_SEMANTIC_BLOCK_TAGS), recursive=True) is not None
                if has_semantic_children:
                    visit(el, role=role)
                else:
                    _append_paragraph_block(blocks, raw, role=role, tag=name)
                continue

            has_semantic_children = el.find(list(_SEMANTIC_BLOCK_TAGS), recursive=True) is not None
            if has_semantic_children:
                visit(el, role=role)
            else:
                _append_paragraph_block(blocks, raw, role=role, tag=name)

    visit(body)
    return blocks


_CHAPTER_MARKER_RE = re.compile(
    r"^\s*(?:(?:chapter|part|book|prologue|epilogue|introduction|preface|foreword|afterword)\b"
    r"|(?:\d{1,2})[.\s]\s*[A-Z])",
    re.I,
)


def _promote_chapter_markers(blocks: list[dict]) -> list[dict]:
    """Convert short paragraph blocks that look like chapter titles into
    level-1 heading blocks. Handles EPUBs that omit heading tags and rely
    purely on styled paragraphs for chapter starts."""
    out: list[dict] = []
    for i, b in enumerate(blocks):
        if b.get("type") != "paragraph":
            out.append(b)
            continue
        if b.get("role", "prose") != "prose":
            out.append(b)
            continue
        text = " ".join(s.get("text", "") for s in b.get("sentences", [])).strip()
        if 0 < len(text) <= 140 and _CHAPTER_MARKER_RE.match(text):
            # require the next paragraph block to be substantial — avoids
            # false positives on section numbering inside prose.
            has_body_after = False
            for nxt in blocks[i + 1 : i + 6]:
                if nxt.get("type") == "paragraph":
                    nxt_text = " ".join(s.get("text", "") for s in nxt.get("sentences", []))
                    if len(nxt_text) > 200:
                        has_body_after = True
                        break
            if has_body_after:
                out.append({"type": "heading", "level": 1, "text": text})
                continue
        out.append(b)
    return out


def _split_into_chapters(blocks: list[dict]) -> list[dict]:
    """Split a flat block list into chapters at the shallowest heading level
    present. Each chapter = {title, number, blocks} where the opening heading
    (if any) has been consumed into title/number and removed from blocks."""
    heading_levels = [b["level"] for b in blocks if b.get("type") == "heading"]
    if not heading_levels:
        return [{"title": None, "number": None, "blocks": blocks}]

    split_level = min(heading_levels)
    chapters: list[dict] = []
    current_title: str | None = None
    current_blocks: list[dict] = []

    def flush():
        if not current_blocks and not current_title:
            return
        number, clean = _chapter_number_from_title(current_title or "")
        chapters.append({
            "title": clean or current_title,
            "number": number,
            "blocks": list(current_blocks),
        })

    for b in blocks:
        if b.get("type") == "heading" and b.get("level") == split_level:
            flush()
            current_title = b.get("text") or None
            current_blocks = []
        else:
            current_blocks.append(b)
    flush()
    return chapters


_FRONTMATTER_PATTERNS = re.compile(
    r"\b(ebook\s*v?\d|isbn\b|all rights reserved|copyright\s*©|first published|"
    r"printed in|library of congress|penguin books|random house|"
    r"this edition|scanned by|converted to epub|retail epub|version\s*\d|"
    r"table of contents|contents)\b",
    re.I,
)

def _looks_like_frontmatter(blocks: list[dict], chapter_title: str | None) -> bool:
    body_text = " ".join(
        s.get("text", "")
        for b in blocks if b.get("type") == "paragraph"
        for s in b.get("sentences", [])
    ).strip()
    if not body_text:
        return True
    # Very short sections at the front are almost always title/copyright pages.
    if len(body_text) < 500:
        return True
    if _FRONTMATTER_PATTERNS.search(body_text):
        return True
    if chapter_title and _FRONTMATTER_PATTERNS.search(chapter_title):
        return True
    return False


def _chunk_chapter_blocks(blocks: list[dict], start_chunk_idx: int) -> tuple[list[dict], int]:
    """Run the paragraph-aware chunker on a chapter's blocks.

    Each `paragraph` block's `sentences` are replaced with chunk dicts
    (merged sentence groups). `heading` and `dinkus` blocks pass through.
    Only paragraph chunks consume a chunk index — headings are not narrated
    by the audio pipeline today, so they don't get an idx.
    """
    new_blocks: list[dict] = []
    chunk_idx = start_chunk_idx

    for block in blocks:
        btype = block.get("type")
        if btype == "paragraph":
            chunks = text_chunker.chunk_blocks([block])
            new_sentences: list[dict] = []
            role = block.get("role", "prose")
            tag = block.get("tag")
            for ch in chunks:
                kind = ch.get("kind", "prose")
                if role == "list-item" and kind == "prose":
                    kind = "list"
                elif role == "blockquote" and kind == "prose":
                    kind = "quote"
                new_sentences.append({
                    "text": ch["text"],
                    "idx": chunk_idx,
                    "source_sentences": list(ch.get("source_sentences", [])),
                    "kind": kind,
                })
                chunk_idx += 1
            if new_sentences:
                new_block = {"type": "paragraph", "sentences": new_sentences}
                if role != "prose":
                    new_block["role"] = role
                if tag:
                    new_block["tag"] = tag
                new_blocks.append(new_block)
        elif btype == "heading":
            new_blocks.append({
                "type": "heading",
                "level": block.get("level", 1),
                "text": block.get("text", ""),
            })
        elif btype == "dinkus":
            new_blocks.append({"type": "dinkus"})
        else:
            new_blocks.append(block)
    return new_blocks, chunk_idx


def build_reflow(filepath: str) -> dict:
    """Parse an EPUB and return the reflow document tree."""
    book = epub.read_epub(filepath, options={"ignore_ncx": False})

    meta_title = ""
    meta_author = ""
    try:
        t = book.get_metadata("DC", "title")
        if t:
            meta_title = t[0][0] or ""
    except Exception:
        logger.exception("Failed to read EPUB title metadata from %s", filepath)
    try:
        a = book.get_metadata("DC", "creator")
        if a:
            meta_author = a[0][0] or ""
    except Exception:
        logger.exception("Failed to read EPUB author metadata from %s", filepath)
    if not meta_title:
        meta_title = os.path.splitext(os.path.basename(filepath))[0]
    if not meta_author:
        meta_author = "Unknown"

    chapters: list[dict] = []
    raw_sent_idx = 0       # for source-sentence traceability
    global_chunk_idx = 0   # post-chunking; this is what audio + display use

    for item in book.get_items_of_type(ITEM_DOCUMENT):
        try:
            html = item.get_content().decode("utf-8", errors="replace")
        except Exception:
            logger.exception("Failed to decode EPUB spine item %s from %s", getattr(item, "file_name", "<unknown>"), filepath)
            continue
        soup = BeautifulSoup(html, "lxml")
        flat = _extract_flat_blocks(soup)
        if not flat:
            continue
        flat = _promote_chapter_markers(flat)

        sub_chapters = _split_into_chapters(flat)
        # If the first split has no title, it's continuation of the previous
        # chapter (content before the first heading in this spine doc).
        if sub_chapters and not sub_chapters[0].get("title") and chapters:
            for b in sub_chapters[0]["blocks"]:
                if b.get("type") == "paragraph":
                    for sent in b["sentences"]:
                        sent["idx"] = raw_sent_idx
                        raw_sent_idx += 1
            chunked, global_chunk_idx = _chunk_chapter_blocks(
                sub_chapters[0]["blocks"], global_chunk_idx
            )
            chapters[-1]["blocks"].extend(chunked)
            sub_chapters = sub_chapters[1:]

        for ch in sub_chapters:
            ch_blocks = ch["blocks"]
            has_body = any(b.get("type") == "paragraph" for b in ch_blocks)
            if not has_body:
                continue

            if not chapters and _looks_like_frontmatter(ch_blocks, ch.get("title")):
                continue

            for b in ch_blocks:
                if b.get("type") == "paragraph":
                    for sent in b["sentences"]:
                        sent["idx"] = raw_sent_idx
                        raw_sent_idx += 1

            chunked, global_chunk_idx = _chunk_chapter_blocks(ch_blocks, global_chunk_idx)

            chapters.append({
                "id": len(chapters),
                "title": ch.get("title") or f"Chapter {len(chapters) + 1}",
                "number": ch.get("number"),
                "blocks": chunked,
            })

    return {
        "format": "epub",
        "version": REFLOW_VERSION,
        "chunker_version": text_chunker.CHUNKER_VERSION,
        "metadata": {
            "title": _typographic(meta_title),
            "author": _typographic(meta_author),
            "running_head": _typographic(meta_title),
        },
        "chapters": chapters,
        "sentence_count": global_chunk_idx,
    }


def get_metadata(filepath: str) -> dict:
    """Cheap metadata fetch for book-open (no full reflow yet)."""
    book = epub.read_epub(filepath, options={"ignore_ncx": False})
    title = ""
    author = ""
    try:
        t = book.get_metadata("DC", "title")
        if t: title = t[0][0] or ""
    except Exception:
        logger.exception("Failed to read EPUB title metadata from %s", filepath)
    try:
        a = book.get_metadata("DC", "creator")
        if a: author = a[0][0] or ""
    except Exception:
        logger.exception("Failed to read EPUB author metadata from %s", filepath)
    if not title:
        title = os.path.splitext(os.path.basename(filepath))[0]
    if not author:
        author = "Unknown"

    # Chapter count via spine; TOC via book.toc
    chapter_count = sum(1 for _ in book.get_items_of_type(ITEM_DOCUMENT))

    toc: list[dict] = []
    def walk(entries, depth=0):
        for e in entries:
            if isinstance(e, tuple):
                link, children = e[0], e[1]
                toc.append({"title": getattr(link, "title", "") or "", "page": len(toc)})
                walk(children, depth + 1)
            else:
                toc.append({"title": getattr(e, "title", "") or "", "page": len(toc)})
    try:
        walk(book.toc)
    except Exception:
        logger.exception("Failed to walk EPUB TOC for %s", filepath)

    return {
        "id": get_book_id(filepath),
        "filepath": filepath,
        "title": _typographic(title),
        "author": _typographic(author),
        "page_count": max(1, chapter_count),
        "toc": toc,
        "format": "epub",
    }


# ----- disk cache -----

def cached_reflow_path(data_dir: str, book_id: str) -> str:
    return os.path.join(data_dir, f"{book_id}.reflow.json")


def get_or_build_reflow(filepath: str, data_dir: str) -> dict:
    book_id = get_book_id(filepath)
    path = cached_reflow_path(data_dir, book_id)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                cached = json.load(f)
            # Reuse only if the cache was written by the current reflow schema
            # and chunker. A missing or mismatched `version` means cached
            # blocks may have flattened paragraph boundaries or an outdated
            # audio chunking scheme.
            if cached.get("version") == REFLOW_VERSION:
                return cached
            logger.info(
                "Reflow cache version mismatch (%s != %s); rebuilding %s",
                cached.get("version"), REFLOW_VERSION, path,
            )
        except Exception:
            logger.exception("Failed to read cached reflow from %s; rebuilding", path)
    doc = build_reflow(filepath)
    os.makedirs(data_dir, exist_ok=True)
    # Write to a temp file in the same dir + atomic rename so a crash during
    # write can't leave a half-written JSON that future reads would silently
    # discard or treat as empty.
    tmp_path = f"{path}.tmp.{os.getpid()}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp_path, path)
    except Exception:
        logger.exception("Failed to write cached reflow to %s", path)
        try:
            os.remove(tmp_path)
        except OSError:
            pass
    return doc
