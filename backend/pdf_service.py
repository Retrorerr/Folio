import asyncio
import hashlib
import os
import re
import threading
from collections import OrderedDict

import fitz  # PyMuPDF

from models import PageText, SentenceInfo, WordInfo

# OCR cache: page_key -> PageText (avoid re-running OCR on same page)
_ocr_cache: OrderedDict[str, PageText] = OrderedDict()
_page_text_cache: OrderedDict[str, PageText] = OrderedDict()
_cache_lock = threading.Lock()
_CACHE_LIMIT = 256


def _cache_get(cache: OrderedDict[str, PageText], key: str) -> PageText | None:
    with _cache_lock:
        value = cache.get(key)
        if value is not None:
            cache.move_to_end(key)
        return value


def _cache_set(cache: OrderedDict[str, PageText], key: str, value: PageText):
    with _cache_lock:
        cache[key] = value
        cache.move_to_end(key)
        while len(cache) > _CACHE_LIMIT:
            cache.popitem(last=False)

_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "v", "etc",
    "inc", "ltd", "corp", "vol", "ch", "fig", "no", "approx", "dept",
    "est", "govt", "gen", "gov", "sgt", "cpl", "pvt", "rev", "sen",
    "rep", "pres", "u.s", "u.k", "u.n", "e.g", "i.e", "al", "op", "ed",
    "pt", "ft", "mt", "ave", "blvd",
}


def get_book_id(filepath: str) -> str:
    # Normalize path separators so the same file always gets the same ID
    normalized = os.path.normpath(filepath).replace("\\", "/").lower()
    return hashlib.md5(normalized.encode()).hexdigest()[:12]


def open_pdf(filepath: str) -> fitz.Document:
    return fitz.open(filepath)


def get_metadata(doc: fitz.Document, filepath: str) -> dict:
    meta = doc.metadata or {}
    title = meta.get("title", "") or filepath.split("/")[-1].split("\\")[-1].replace(".pdf", "")
    author = meta.get("author", "") or "Unknown"
    toc_raw = doc.get_toc()
    toc = [{"title": entry[1], "page": entry[2] - 1} for entry in toc_raw]  # 0-indexed
    return {
        "id": get_book_id(filepath),
        "filepath": filepath,
        "title": title,
        "author": author,
        "page_count": len(doc),
        "toc": toc,
    }


def render_page(doc: fitz.Document, page_num: int, dpi: int = 150) -> tuple[bytes, int, int]:
    """Render a page to PNG bytes. Returns (png_bytes, width, height)."""
    page = doc[page_num]
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)
    png_bytes = pix.tobytes("png")
    return png_bytes, pix.width, pix.height


def _should_split_sentence(text: str, punct_idx: int) -> bool:
    punct = text[punct_idx]
    if punct not in ".!?":
        return False

    if punct == "." and punct_idx > 0 and punct_idx + 1 < len(text):
        if text[punct_idx - 1].isdigit() and text[punct_idx + 1].isdigit():
            return False

    prefix = text[: punct_idx + 1].rstrip()
    last_token = prefix.split()[-1] if prefix.split() else ""
    token_core = last_token.strip("\"'“”‘’()[]{}").rstrip(".!?").lower()
    if token_core in _ABBREVIATIONS:
        return False

    if re.search(r"(?:\b[A-Z]\.){2,}$", prefix):
        return False

    tail = text[punct_idx + 1 :]
    if not tail.strip():
        return True

    next_char_match = re.search(r"\S", tail)
    if not next_char_match:
        return True
    next_char = tail[next_char_match.start()]
    return next_char.isupper() or next_char in "\"'“”("


def _split_sentences(text: str) -> list[str]:
    """Split text into readable TTS chunks without breaking common abbreviations."""
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []

    sentences = []
    start = 0
    idx = 0
    while idx < len(text):
        if _should_split_sentence(text, idx):
            end = idx + 1
            while end < len(text) and text[end] in "\"'”’)]}":
                end += 1
            sentence = text[start:end].strip()
            if sentence:
                sentences.append(sentence)
            start = end
        idx += 1

    remainder = text[start:].strip()
    if remainder:
        sentences.append(remainder)

    if not sentences:
        return [text]

    merged = []
    idx = 0
    while idx < len(sentences):
        current = sentences[idx].strip()
        if not current:
            idx += 1
            continue

        current_words = len(current.split())
        looks_fragmentary = current_words <= 3 or len(current) < 24
        strong_terminal = current.endswith(("?", "!", '."', '!"', '?"'))

        if looks_fragmentary and not strong_terminal and idx + 1 < len(sentences):
            merged.append(f"{current} {sentences[idx + 1].strip()}".strip())
            idx += 2
            continue

        merged.append(current)
        idx += 1

    return merged or [text]


def _normalize_token(token: str) -> str:
    return token.strip("\"'“”‘’()[]{}").rstrip(",;:").lower()


def _ocr_page(page, dpi: int) -> tuple[list[list[dict]], int, int]:
    """Run Windows OCR on a page rendered as an image.
    Returns (word_groups, render_width, render_height)."""
    import winocr
    from PIL import Image

    pix = page.get_pixmap(dpi=dpi)
    img = Image.frombytes("RGB", (pix.width, pix.height), bytes(pix.samples))
    img = img.convert("RGBA")
    rgba_bytes = img.tobytes()

    result = asyncio.run(winocr.recognize_bytes(rgba_bytes, pix.width, pix.height))

    word_groups = []
    for line in result.lines:
        group = []
        for w in line.words:
            br = w.bounding_rect
            group.append({
                "text": w.text,
                "x": br.x,
                "y": br.y,
                "w": br.width,
                "h": br.height,
            })
        if group:
            word_groups.append(group)
    return word_groups, pix.width, pix.height


def _group_lines_into_paragraphs(lines: list[list[dict]], zoom: float) -> list[list[dict]]:
    """Group visual lines into paragraphs based on vertical gaps and horizontal alignment."""
    paragraphs = []
    current_paragraph = []
    previous_line = None
    for line_words in lines:
        if not line_words:
            continue
        # Ensure line_top/line_bottom exist (native sets them; compute for OCR words)
        for w in line_words:
            if "line_top" not in w:
                w["line_top"] = w["y"]
            if "line_bottom" not in w:
                w["line_bottom"] = w["y"] + w["h"]

        line_top = min(w["line_top"] for w in line_words)
        line_left = min(w["x"] for w in line_words)
        line_right = max(w["x"] + w["w"] for w in line_words)

        new_paragraph = False
        if previous_line is not None:
            prev_bottom = max(w["line_bottom"] for w in previous_line)
            prev_height = max(w["h"] for w in previous_line)
            prev_left = min(w["x"] for w in previous_line)
            prev_right = max(w["x"] + w["w"] for w in previous_line)
            gap = line_top - prev_bottom
            horizontal_overlap = min(prev_right, line_right) - max(prev_left, line_left)
            compatible_line = horizontal_overlap > 0 or abs(line_left - prev_left) < 40 * zoom

            if gap > max(prev_height * 1.6, 28 * zoom):
                new_paragraph = True
            elif gap > max(prev_height * 0.75, 12 * zoom) and not compatible_line:
                new_paragraph = True

        if new_paragraph and current_paragraph:
            paragraphs.append(current_paragraph)
            current_paragraph = []

        current_paragraph.extend(line_words)
        previous_line = line_words

    if current_paragraph:
        paragraphs.append(current_paragraph)

    return paragraphs


def _extract_native_paragraphs(page, zoom: float) -> list[list[dict]]:
    raw_words = page.get_text("words", sort=True)
    if not raw_words:
        return []

    lines = []
    current_line_key = None
    current_line_words = []
    for x0, y0, x1, y1, text, block_no, line_no, _word_no in raw_words:
        clean = (text or "").strip()
        if not clean:
            continue
        line_key = (block_no, line_no)
        word = {
            "text": clean,
            "x": x0 * zoom,
            "y": y0 * zoom,
            "w": (x1 - x0) * zoom,
            "h": (y1 - y0) * zoom,
            "block_no": block_no,
            "line_no": line_no,
            "line_top": y0 * zoom,
            "line_bottom": y1 * zoom,
        }
        if current_line_key != line_key:
            if current_line_words:
                lines.append(current_line_words)
            current_line_key = line_key
            current_line_words = [word]
        else:
            current_line_words.append(word)

    if current_line_words:
        lines.append(current_line_words)

    return _group_lines_into_paragraphs(lines, zoom)


def _fix_fused_words(word_list: list[dict]) -> list[dict]:
    """Split words fused by OCR/extraction, e.g. 'ofAmerican' -> 'of', 'American'."""
    result = []
    for word in word_list:
        text = word["text"]
        parts = re.split(r'(?<=[a-z])(?=[A-Z])', text)
        if len(parts) <= 1:
            result.append(word)
        else:
            # Split the bounding box proportionally
            total_len = len(text)
            x = word["x"]
            for part in parts:
                frac = len(part) / total_len
                result.append({
                    **word,
                    "text": part,
                    "x": x,
                    "w": word["w"] * frac,
                })
                x += word["w"] * frac
    return result


def _build_sentence_infos(paragraphs: list[list[dict]]) -> list[SentenceInfo]:
    sentences = []
    global_char_offset = 0

    for para_words in paragraphs:
        if not para_words:
            continue

        para_words = _fix_fused_words(para_words)
        para_text = " ".join(word["text"] for word in para_words)
        sentence_texts = _split_sentences(para_text)

        word_idx = 0
        for sentence_text in sentence_texts:
            sentence_tokens = sentence_text.split()
            if not sentence_tokens:
                continue

            sentence_words = []
            search_idx = word_idx
            sentence_start_offset = global_char_offset

            for token in sentence_tokens:
                normalized_token = _normalize_token(token)
                if not normalized_token:
                    sentence_start_offset += len(token) + 1
                    continue

                matched_idx = None
                for candidate_idx in range(search_idx, len(para_words)):
                    candidate_token = _normalize_token(para_words[candidate_idx]["text"])
                    if candidate_token == normalized_token:
                        matched_idx = candidate_idx
                        break

                if matched_idx is None:
                    sentence_start_offset += len(token) + 1
                    continue

                for skipped_idx in range(search_idx, matched_idx):
                    skipped = para_words[skipped_idx]["text"]
                    global_char_offset += len(skipped) + 1

                matched_word = para_words[matched_idx]
                sentence_words.append(WordInfo(
                    text=matched_word["text"],
                    x=matched_word["x"],
                    y=matched_word["y"],
                    w=matched_word["w"],
                    h=matched_word["h"],
                    char_offset=global_char_offset,
                    char_length=max(len(_normalize_token(matched_word["text"])), 1),
                ))
                global_char_offset += len(matched_word["text"]) + 1
                search_idx = matched_idx + 1

            word_idx = max(word_idx, search_idx)

            if sentence_words:
                sentences.append(SentenceInfo(text=sentence_text, words=sentence_words))
            else:
                global_char_offset = max(global_char_offset, sentence_start_offset + len(sentence_text) + 1)

        while word_idx < len(para_words):
            global_char_offset += len(para_words[word_idx]["text"]) + 1
            word_idx += 1

    return sentences


def _merge_sentence_infos(sentences: list[SentenceInfo]) -> list[SentenceInfo]:
    if not sentences:
        return []

    merged = []
    chunk_texts: list[str] = []
    chunk_words: list[WordInfo] = []

    def flush_chunk():
        if chunk_words:
            merged.append(SentenceInfo(
                text=" ".join(part for part in chunk_texts if part).strip(),
                words=[*chunk_words],
            ))

    for sentence in sentences:
        text = sentence.text.strip()
        if not text:
            continue

        candidate_words = len(chunk_words) + len(sentence.words)
        candidate_chars = sum(len(part) for part in chunk_texts) + len(text)
        terminal = text.endswith((".", "?", "!", '."', '!"', '?"'))

        if chunk_words and (candidate_words >= 25 or candidate_chars >= 180):
            flush_chunk()
            chunk_texts = []
            chunk_words = []

        chunk_texts.append(text)
        chunk_words.extend(sentence.words)

        enough_context = len(chunk_words) >= 12 or candidate_chars >= 80
        if terminal and enough_context:
            flush_chunk()
            chunk_texts = []
            chunk_words = []

    flush_chunk()

    return merged


def extract_page_text(doc: fitz.Document, page_num: int, dpi: int = 150) -> PageText:
    """Extract text with word-level bounding boxes, grouped into sentences."""
    cache_key = f"{id(doc)}_{page_num}_{dpi}"
    cached = _cache_get(_page_text_cache, cache_key)
    if cached is not None:
        return cached

    page = doc[page_num]
    zoom = dpi / 72.0

    paragraphs = _extract_native_paragraphs(page, zoom)
    ocr_render_size = None

    if not paragraphs:
        cached = _cache_get(_ocr_cache, cache_key)
        if cached is not None:
            return cached
        try:
            word_groups, ocr_w, ocr_h = _ocr_page(page, dpi)
            ocr_render_size = (ocr_w, ocr_h)
            # OCR returns one group per visual line; group into paragraphs so
            # sentences spanning multiple lines stay together before splitting.
            paragraphs = _group_lines_into_paragraphs(word_groups, zoom=dpi / 72.0)
            if not paragraphs:
                page_rect = page.rect
                return PageText(
                    page_number=page_num,
                    sentences=[],
                    render_width=page_rect.width * zoom,
                    render_height=page_rect.height * zoom,
                )
        except Exception as e:
            print(f"OCR failed for page {page_num}: {e}")
            page_rect = page.rect
            return PageText(
                page_number=page_num,
                sentences=[],
                render_width=page_rect.width * zoom,
                render_height=page_rect.height * zoom,
            )

    sentences = _merge_sentence_infos(_build_sentence_infos(paragraphs))

    page_rect = page.rect
    if ocr_render_size:
        render_width, render_height = ocr_render_size
    else:
        render_width = page_rect.width * zoom
        render_height = page_rect.height * zoom

    result = PageText(
        page_number=page_num,
        sentences=sentences,
        render_width=render_width,
        render_height=render_height,
    )
    _cache_set(_page_text_cache, cache_key, result)
    if ocr_render_size:
        _cache_set(_ocr_cache, cache_key, result)
    return result
