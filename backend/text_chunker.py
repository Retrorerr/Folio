"""Paragraph- and block-aware chunker for the Kokoro TTS pipeline.

Sentences from the splitter (pdf_service / reflow_service) are too short on
their own — Kokoro sounds stop-start when fed isolated sentences. This module
merges adjacent sentences into "natural narration" chunks while respecting
paragraph, heading, list, and dialogue boundaries.

The chunker is deterministic and pure: same input always produces the same
output. It does NOT touch sentence-level splitting — that stays in the
existing splitters which already handle abbreviations, decimals, and
initials. The chunker only decides how to group already-split sentences.
"""

from __future__ import annotations

import math
import re
from typing import Iterable

# Bumping this invalidates the audio cache by changing _cache_key in
# tts_service. Old WAVs become orphaned (different hash prefix) and new
# chunks regenerate from scratch.
CHUNKER_VERSION = "v2.1-2026-04"

# Token estimation. Kokoro's internal phoneme tokenizer isn't directly
# importable here, so we approximate with char-count: ~4 chars per token for
# typical English prose. This matches the user's reported sentence median
# (sentences ~80 chars / 4 = ~20 tokens).
_CHARS_PER_TOKEN = 4.0

# Chunk-size targets (in approximate Kokoro tokens).
MIN_NATURAL_TOKENS = 10    # below this is "tiny"; only kept when intentional
TARGET_MIN_TOKENS = 80     # prefer chunks at least this big for prose
TARGET_MAX_TOKENS = 180    # prefer to stop adding sentences past this
SOFT_OVER_BUDGET = 220     # treat as "full" when next sentence would breach
HARD_MAX_TOKENS = 280      # never cross by merging; a single long sentence
                           # may exceed this and is emitted alone


def estimate_tokens(text: str) -> int:
    """Approximate Kokoro phoneme tokens. Char-based for determinism."""
    if not text:
        return 0
    return max(1, math.ceil(len(text) / _CHARS_PER_TOKEN))


# ----- dialogue detection -----

_OPEN_QUOTES = ('"', "“", "'", "‘")
_CLOSE_QUOTES = ('"', "”", "'", "’")


def _looks_like_dialogue(text: str) -> bool:
    """Return True if a sentence is likely a quoted speech line.

    Heuristic: starts with an opening quote OR is a single short line that
    contains balanced quotes (e.g. 'He said: "No."').
    """
    if not text:
        return False
    s = text.lstrip()
    if not s:
        return False
    if s[0] in _OPEN_QUOTES:
        return True
    # Whole sentence wrapped in quotes somewhere — count quotes.
    quote_chars = sum(1 for c in s if c in _OPEN_QUOTES + _CLOSE_QUOTES)
    if quote_chars >= 2 and len(s) < 200:
        # Looks like a short utterance with attribution.
        return True
    return False


# ----- core chunker -----

class _Pending:
    """Mutable accumulator for the current chunk being built."""

    __slots__ = ("texts", "source_sentences", "kind")

    def __init__(self) -> None:
        self.texts: list[str] = []
        self.source_sentences: list[int] = []
        self.kind: str | None = None  # "prose" | "dialogue" | "heading" | "list"

    def empty(self) -> bool:
        return not self.texts

    def add(self, text: str, source_idx: int, kind: str) -> None:
        self.texts.append(text)
        self.source_sentences.append(source_idx)
        if self.kind is None:
            self.kind = kind

    def total_text(self) -> str:
        return " ".join(t for t in self.texts if t).strip()

    def total_tokens(self) -> int:
        # Sum of per-sentence token estimates is close enough to the
        # joined-string estimate; using the joined-string estimate keeps
        # the heuristic monotonic with respect to merging.
        return estimate_tokens(self.total_text())


def _emit(chunks: list[dict], pending: _Pending) -> None:
    if pending.empty():
        return
    text = pending.total_text()
    if not text:
        pending.texts = []
        pending.source_sentences = []
        pending.kind = None
        return
    tokens = estimate_tokens(text)
    chunks.append({
        "text": text,
        "kind": pending.kind or "prose",
        "source_sentences": list(pending.source_sentences),
        "tokens": tokens,
        "over_hard_max": tokens > HARD_MAX_TOKENS,
    })
    pending.texts = []
    pending.source_sentences = []
    pending.kind = None


def _flush(chunks: list[dict], pending: _Pending) -> None:
    _emit(chunks, pending)


def chunk_blocks(blocks: Iterable[dict]) -> list[dict]:
    """Block-aware chunking for EPUB-style structured text.

    Input: iterable of block dicts. Recognized shapes:
      - {"type": "heading", "level": int, "text": str}
      - {"type": "paragraph", "sentences": [{"text": str, "idx": int?}, ...]}
      - {"type": "list", "items": [str | {"text": str}, ...]}  (optional kind)
      - {"type": "dinkus"}  (visual scene break, no audio)

    Output: list of chunk dicts (see _emit).

    Source sentence ids are tracked per-block when provided; otherwise we
    assign monotonic ids starting at 0 across the whole input so callers can
    still recover the merge map.
    """
    chunks: list[dict] = []
    pending = _Pending()

    # Two passes. First, materialize the block list so we can peek at the
    # following block when deciding paragraph carry-over.
    block_list = list(blocks)

    # Assign a stable source-sentence id stream for blocks that didn't carry
    # explicit indices (e.g. PDF input).
    next_auto_idx = 0

    def _next_idx(explicit) -> int:
        nonlocal next_auto_idx
        if isinstance(explicit, int):
            return explicit
        idx = next_auto_idx
        next_auto_idx += 1
        return idx

    def _para_total_tokens(b: dict) -> int:
        text = " ".join(s.get("text", "") for s in b.get("sentences", [])).strip()
        return estimate_tokens(text)

    def _block_breaks_carry(b: dict) -> bool:
        return b.get("type") in ("heading", "list", "dinkus")

    for block_i, block in enumerate(block_list):
        btype = block.get("type")

        if btype == "heading":
            _flush(chunks, pending)
            text = (block.get("text") or "").strip()
            if not text:
                continue
            pending.add(text, _next_idx(block.get("idx")), "heading")
            _flush(chunks, pending)
            continue

        if btype == "dinkus":
            _flush(chunks, pending)
            continue

        if btype == "list":
            _flush(chunks, pending)
            items = block.get("items", []) or []
            list_pending = _Pending()
            for item in items:
                if isinstance(item, dict):
                    item_text = (item.get("text") or "").strip()
                    item_idx = _next_idx(item.get("idx"))
                else:
                    item_text = str(item).strip()
                    item_idx = _next_idx(None)
                if not item_text:
                    continue
                # Try to merge tiny consecutive list items so a list of
                # one-word bullets doesn't become N tiny audio files.
                projected = list_pending.total_tokens() + estimate_tokens(item_text)
                if (
                    not list_pending.empty()
                    and list_pending.total_tokens() < MIN_NATURAL_TOKENS
                    and projected <= TARGET_MAX_TOKENS
                ):
                    list_pending.add(item_text, item_idx, "list")
                    continue
                _emit(chunks, list_pending)
                list_pending.add(item_text, item_idx, "list")
                # Flush each substantial item immediately so list reading
                # has natural per-item breaks.
                if list_pending.total_tokens() >= MIN_NATURAL_TOKENS:
                    _emit(chunks, list_pending)
            _emit(chunks, list_pending)
            continue

        if btype != "paragraph":
            # Unknown block type — flush and skip.
            _flush(chunks, pending)
            continue

        sentences = block.get("sentences") or []
        if not sentences:
            continue

        # Respect block boundaries: any time we move from one paragraph to
        # the next, the only way pending carries over is if it's small AND
        # the previous block was also a prose paragraph that we chose to
        # leave open. We detect that here.
        prev_block = block_list[block_i - 1] if block_i > 0 else None
        prev_was_prose = prev_block is not None and prev_block.get("type") == "paragraph"
        if not pending.empty() and not prev_was_prose:
            _flush(chunks, pending)
        if (
            not pending.empty()
            and prev_was_prose
            and (pending.kind == "dialogue" or _para_total_tokens(block) > TARGET_MIN_TOKENS)
        ):
            # Don't drag a dialogue tail into prose, and don't extend across
            # boundary if the new paragraph is already substantial on its own.
            _flush(chunks, pending)

        for sent in sentences:
            text = (sent.get("text") or "").strip()
            if not text:
                continue
            sent_idx = _next_idx(sent.get("idx"))
            kind = "dialogue" if _looks_like_dialogue(text) else "prose"

            # Dialogue / prose mode flip → flush.
            if not pending.empty() and pending.kind in ("dialogue", "prose") and pending.kind != kind:
                _flush(chunks, pending)

            sent_tokens = estimate_tokens(text)

            # Hard cap: never grow past HARD_MAX_TOKENS by merging.
            if not pending.empty() and pending.total_tokens() + sent_tokens > HARD_MAX_TOKENS:
                _flush(chunks, pending)

            # Dialogue: each line stands alone unless extremely tiny (a
            # single "yes." or "no." with another tiny dialogue line right
            # after — in that case we still keep them separate to preserve
            # the back-and-forth feel). Keep dialogue lines as single-line
            # chunks.
            if kind == "dialogue":
                if not pending.empty():
                    _flush(chunks, pending)
                pending.add(text, sent_idx, kind)
                _flush(chunks, pending)
                continue

            # Prose accumulation.
            pending.add(text, sent_idx, kind)
            # Soft flush: at a sentence boundary, if we're past the soft
            # budget already, close the chunk so we don't drift past
            # TARGET_MAX cleanly.
            projected = pending.total_tokens()
            if projected >= TARGET_MIN_TOKENS:
                # If adding the next would clearly overshoot, close now.
                # We approximate "next sentence" as the average remaining
                # sentence size for the paragraph; if total already past
                # SOFT_OVER_BUDGET, flush.
                if projected >= SOFT_OVER_BUDGET:
                    _flush(chunks, pending)
                elif projected >= TARGET_MAX_TOKENS:
                    _flush(chunks, pending)

        # End-of-paragraph behavior.
        if pending.empty():
            continue
        next_block = block_list[block_i + 1] if block_i + 1 < len(block_list) else None
        # Carry over only if pending is below MIN_NATURAL and the next
        # block is another short prose paragraph (continuation case).
        carry_ok = (
            pending.total_tokens() < MIN_NATURAL_TOKENS
            and pending.kind == "prose"
            and next_block is not None
            and next_block.get("type") == "paragraph"
            and not _block_breaks_carry(next_block)
            and _para_total_tokens(next_block) < TARGET_MIN_TOKENS
        )
        if not carry_ok:
            _flush(chunks, pending)

    _flush(chunks, pending)
    return chunks


def chunk_paragraph_sentences(paragraphs: Iterable[Iterable[str]]) -> list[dict]:
    """PDF-flavored entry point.

    Input: iterable of paragraphs, each an iterable of sentence strings.
    Output: chunks (same shape as chunk_blocks).

    Each input sentence is implicitly numbered in iteration order so the
    caller can stitch back word-box arrays from the original SentenceInfo
    list using `chunk["source_sentences"]`.
    """
    blocks: list[dict] = []
    next_idx = 0
    for para in paragraphs:
        sentences = []
        for s in para:
            text = (s or "").strip()
            if not text:
                continue
            sentences.append({"text": text, "idx": next_idx})
            next_idx += 1
        if sentences:
            blocks.append({"type": "paragraph", "sentences": sentences})
    return chunk_blocks(blocks)
