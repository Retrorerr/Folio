"""Tests for text_chunker and the cache-key invalidation it gates.

Run from the backend dir:
    python -m pytest tests/test_chunker.py -v

These tests cover only the chunker and the cache-key wiring. They don't
load Kokoro / ONNX / FastAPI, so they're cheap and CI-friendly.
"""

from __future__ import annotations

import os
import sys

# Make backend modules importable regardless of where pytest is invoked.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.normpath(os.path.join(_HERE, ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

# Import the EPUB reflow splitter to test the full path (split + chunk) the
# way the production pipeline runs.
import reflow_service
import text_chunker
from text_chunker import (
    CHUNKER_VERSION,
    HARD_MAX_TOKENS,
    MIN_NATURAL_TOKENS,
    chunk_blocks,
    chunk_paragraph_sentences,
    estimate_tokens,
)


def _para(*sentences: str) -> dict:
    return {"type": "paragraph", "sentences": [{"text": s} for s in sentences]}


# ---------- Splitter (abbreviation / decimal / time safety) ----------

def test_epub_splitter_handles_abbreviations():
    text = "Dr. Smith met Mr. Jones at the U.S. embassy. Prof. Lee was there too."
    sents = reflow_service._split_sentences(text)
    assert len(sents) == 2
    assert sents[0].startswith("Dr. Smith")
    assert sents[0].endswith("embassy.")


def test_splitter_handles_decimals_and_percentages():
    text = "The rate dropped to 12.5% by April. It rose to 13.7% in May."
    sents = reflow_service._split_sentences(text)
    assert len(sents) == 2
    assert "12.5%" in sents[0]


def test_splitter_handles_eg_ie():
    text = "Some words split, e.g., we tested it. It worked."
    sents = reflow_service._split_sentences(text)
    # "e.g." should NOT terminate the first sentence; the split happens at
    # "tested it." → 2 sentences total.
    assert len(sents) == 2


def test_splitter_handles_initials():
    # "J.K. Rowling" should not split at the initials.
    sents = reflow_service._split_sentences("She read J.K. Rowling at home.")
    assert len(sents) == 1


def test_splitter_keeps_initial_plus_name_together():
    # "J. Maynard Smith" — single-letter initial followed by a real name
    # word. Should NOT split between "J." and "Maynard". This is the
    # citation-list pattern, e.g. "G. C. Williams, J. Maynard Smith".
    text = (
        "Their originators are acknowledged in the appropriate places in "
        "the text; the dominant figures are G. C. Williams, J. Maynard "
        "Smith, W. D. Hamilton, and R. L. Trivers."
    )
    epub_sents = reflow_service._split_sentences(text)
    assert len(epub_sents) == 1, epub_sents


# ---------- Chunker: prose merging ----------

def test_short_sentences_merge_into_natural_chunk():
    # 8 short sentences in one paragraph (~10 words each) ≈ 80 words ≈ 320 chars.
    sents = [
        "The fox was quick and brown today.",
        "It jumped right over the lazy dog.",
        "The dog opened one eye and then yawned.",
        "Nothing about the day seemed unusual yet.",
        "Above them a small cloud drifted east.",
        "The hill behind the barn shimmered green.",
        "A breeze rolled across the dry grass.",
        "Far off a bell rang out twice.",
    ]
    chunks = chunk_blocks([_para(*sents)])
    assert len(chunks) >= 1
    # We expect 1-2 chunks, each in target range.
    for c in chunks:
        assert c["tokens"] <= HARD_MAX_TOKENS
        assert c["text"]
    # At least one chunk should be substantial (≥ MIN_NATURAL).
    assert any(c["tokens"] >= MIN_NATURAL_TOKENS for c in chunks)


def test_long_paragraph_is_split_below_hard_max():
    # 30 sentences x ~70 chars each = ~2100 chars / 4 ≈ 525 tokens.
    body = ["This is a moderately long sentence that has some substance."] * 30
    chunks = chunk_blocks([_para(*body)])
    assert len(chunks) >= 2  # must split
    for c in chunks:
        # Merging never crosses HARD_MAX_TOKENS.
        # (A pathological single sentence over HARD_MAX could; not the case here.)
        assert c["tokens"] <= HARD_MAX_TOKENS, c


def test_no_chunk_over_400_tokens_in_normal_prose():
    # 100 normal sentences. The chunker must keep every chunk well under 400.
    body = ["The cat sat on the mat and stared back at the dog."] * 100
    chunks = chunk_blocks([_para(*body)])
    assert all(c["tokens"] <= 400 for c in chunks)


# ---------- Chunker: paragraph & block boundaries ----------

def test_paragraph_boundary_not_crossed_when_both_substantial():
    p1 = ["A " * 50] * 4   # ~50 words each, 200 words total
    p2 = ["B " * 50] * 4
    chunks = chunk_blocks([_para(*p1), _para(*p2)])
    # Each paragraph should produce its own chunk(s); none should mix.
    for c in chunks:
        starts_a = c["text"].lstrip().startswith("A")
        starts_b = c["text"].lstrip().startswith("B")
        assert starts_a ^ starts_b, c["text"][:80]


def test_heading_isolated_from_following_prose():
    blocks = [
        {"type": "heading", "level": 1, "text": "Chapter Three"},
        _para("This is the body paragraph.", "It has two sentences."),
    ]
    chunks = chunk_blocks(blocks)
    # The first chunk should be exactly the heading, with kind="heading".
    assert chunks[0]["text"] == "Chapter Three"
    assert chunks[0]["kind"] == "heading"
    # The next chunk(s) should not contain the heading text.
    for c in chunks[1:]:
        assert "Chapter Three" not in c["text"]


def test_dinkus_breaks_chunk_accumulation():
    blocks = [
        _para("Before the break."),
        {"type": "dinkus"},
        _para("After the break."),
    ]
    chunks = chunk_blocks(blocks)
    # Two chunks; dinkus emits no audio.
    assert len(chunks) == 2
    assert "Before" in chunks[0]["text"] and "After" not in chunks[0]["text"]


# ---------- Chunker: dialogue ----------

def test_dialogue_lines_are_not_blindly_merged():
    blocks = [
        _para("“No,” he said."),
        _para("“Why not?” she asked."),
        _para("“I just don’t want to,” he replied."),
    ]
    chunks = chunk_blocks(blocks)
    # Each dialogue paragraph stands alone.
    assert len(chunks) == 3
    for c in chunks:
        assert c["kind"] == "dialogue"


def test_short_dialogue_line_preserved():
    blocks = [_para('"No."')]
    chunks = chunk_blocks(blocks)
    assert len(chunks) == 1
    assert chunks[0]["text"] == '"No."'


def test_dialogue_does_not_merge_with_surrounding_prose():
    blocks = [
        _para("He looked up from the page."),
        _para('"No," he said quietly.'),
        _para("Then he kept reading."),
    ]
    chunks = chunk_blocks(blocks)
    # Dialogue stays in its own chunk; prose can chunk separately.
    dialogue_chunks = [c for c in chunks if c["kind"] == "dialogue"]
    assert len(dialogue_chunks) == 1
    assert '"No,"' in dialogue_chunks[0]["text"]


# ---------- Chunker: lists ----------

def test_list_items_become_separate_chunks():
    blocks = [{
        "type": "list",
        "items": [
            "First item with several words and a clause.",
            "Second item also of substantial length.",
            "Third item rounding things off nicely.",
        ],
    }]
    chunks = chunk_blocks(blocks)
    assert len(chunks) == 3
    for c in chunks:
        assert c["kind"] == "list"


def test_tiny_list_items_merge():
    blocks = [{"type": "list", "items": ["A.", "B.", "C.", "D."]}]
    chunks = chunk_blocks(blocks)
    # 4 one-letter items shouldn't become 4 chunks.
    assert len(chunks) <= 2


# ---------- Whitespace & emptiness ----------

def test_no_empty_chunks_emitted():
    blocks = [_para("", "  ", "Real content here.", "")]
    chunks = chunk_blocks(blocks)
    assert all(c["text"].strip() for c in chunks)


def test_empty_input_returns_empty_list():
    assert chunk_blocks([]) == []


# ---------- Determinism ----------

def test_chunker_is_deterministic():
    blocks = [_para("One.", "Two.", "Three.", "Four.", "Five.")]
    a = chunk_blocks(blocks)
    b = chunk_blocks(blocks)
    assert a == b


# ---------- Source-sentence map ----------

def test_source_sentences_recoverable():
    blocks = [_para("Alpha.", "Bravo.", "Charlie.")]
    chunks = chunk_blocks(blocks)
    # All raw sentence ids 0,1,2 should appear across chunks at least once,
    # in increasing order, with no duplicates.
    seen: list[int] = []
    for c in chunks:
        seen.extend(c["source_sentences"])
    assert seen == [0, 1, 2]


def test_chunk_paragraph_sentences_preserves_text():
    paragraphs = [
        ["The first sentence.", "The second sentence.", "The third sentence."],
        ["Another paragraph here.", "With one more sentence."],
    ]
    chunks = chunk_paragraph_sentences(paragraphs)
    joined = " ".join(c["text"] for c in chunks)
    for sent in [s for p in paragraphs for s in p]:
        assert sent in joined


# ---------- Hard maximum + over-budget flag ----------

def test_single_overlong_sentence_gets_flagged():
    long_sentence = "x " * (HARD_MAX_TOKENS * 6)  # well over the cap
    chunks = chunk_blocks([_para(long_sentence)])
    assert len(chunks) == 1
    assert chunks[0]["over_hard_max"] is True


def test_merged_chunks_never_cross_hard_max():
    sents = ["One short sentence here." for _ in range(50)]
    chunks = chunk_blocks([_para(*sents)])
    for c in chunks:
        # Single-sentence chunks could be over hard max only if the lone
        # source sentence already exceeds it; ours don't.
        assert c["tokens"] <= HARD_MAX_TOKENS


# ---------- Cache invalidation ----------

def test_cache_key_changes_with_chunker_version(monkeypatch):
    import tts_service
    text, voice, speed = "Hello world.", "af_heart", 1.0
    original = tts_service._cache_key(text, voice, speed)
    monkeypatch.setattr(text_chunker, "CHUNKER_VERSION", "v-test-other")
    # Re-import-time constant capture means we have to also patch tts_service's
    # imported name.
    monkeypatch.setattr(tts_service, "CHUNKER_VERSION", "v-test-other")
    other = tts_service._cache_key(text, voice, speed)
    assert original != other


def test_cache_key_includes_current_chunker_version():
    import tts_service
    text, voice, speed = "Hello world.", "af_heart", 1.0
    h_now = tts_service._cache_key(text, voice, speed)
    # If CHUNKER_VERSION ever changed without updating tests, this catches it.
    assert tts_service.CHUNKER_VERSION == CHUNKER_VERSION
    assert h_now  # non-empty


# ---------- Typographic cleanup pass-through (EPUB) ----------

def test_typographic_cleanup_preserved_into_chunks():
    raw = "She said -- so what? spo- ken plainly."
    cleaned = reflow_service._typographic(raw)
    assert "—" in cleaned       # em-dash inserted
    assert "spoken" in cleaned  # hyphenation rejoin (lowercase pair)
    sents = reflow_service._split_sentences(cleaned)
    chunks = chunk_blocks([{"type": "paragraph", "sentences": [{"text": s} for s in sents]}])
    joined = " ".join(c["text"] for c in chunks)
    assert "—" in joined
    assert "spoken" in joined


# ---------- Token estimation ----------

def test_token_estimate_monotonic():
    short = "Hi."
    long_ = "Hi. " * 100
    assert estimate_tokens(short) < estimate_tokens(long_)


def test_token_estimate_zero_on_empty():
    assert estimate_tokens("") == 0
