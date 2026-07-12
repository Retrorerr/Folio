"""Generate reviewable parity fixtures from the pinned official Misaki code.

This is a development-only oracle. Folio's shipped runtimes do not include
spaCy, transformers, or torch; those imports are stubbed because Misaki's
explicit EspeakFallback path never constructs its neural fallback class.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import types
from pathlib import Path


EXPECTED_REVISION = "fba1236595f2d2bf21d414ba6e57d25256afada3"

CASES = [
    {"id": "pangram", "text": "The quick brown fox jumps over the lazy dog."},
    {"id": "contractions", "text": "I can't believe it's already seven thirty."},
    {"id": "number", "text": "In 2026, Folio reads 42 books."},
    {"id": "abbreviation", "text": "Dr. Smith moved to the U.S."},
    {"id": "currency", "text": "The total is $12.50."},
    {"id": "punctuation", "text": "Hello, she said—are you ready?"},
    {"id": "articles", "text": "The apple and the banana are on a table."},
    {"id": "used_to", "text": "I used to read every day."},
    {"id": "record", "text": "I record a record."},
    {"id": "wind", "text": "Wind the clock in the wind."},
    {"id": "refuse", "text": "Please refuse the refuse."},
    {"id": "read_tense", "text": "I read the book yesterday, and I read it every day."},
    {"id": "project", "text": "They project the project."},
    {"id": "dialect", "text": "The mobile schedule was near the garage."},
    {"id": "ood", "text": "Folio zxqvblorfquangles."},
]


def _install_import_stubs() -> None:
    transformers = types.ModuleType("transformers")
    transformers.BartForConditionalGeneration = object
    torch = types.ModuleType("torch")
    torch.device = lambda value: value
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)
    torch.no_grad = lambda: None
    torch.tensor = lambda *args, **kwargs: None
    sys.modules.setdefault("transformers", transformers)
    sys.modules.setdefault("torch", torch)


def _token_rating(token):
    rating = getattr(token, "rating", None)
    if rating is None and token._:
        rating = token._.rating
    return rating


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(".android-build/misaki-source"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source = args.source.resolve()
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True, encoding="utf-8"
    ).strip()
    if revision != EXPECTED_REVISION:
        raise SystemExit(f"Misaki checkout is {revision}; expected {EXPECTED_REVISION}")

    _install_import_stubs()
    sys.path.insert(0, str(source))
    from misaki import en, espeak

    fixtures = []
    for dialect in ("us", "gb"):
        fallback = espeak.EspeakFallback(british=dialect == "gb")
        oracle = en.G2P(
            trf=False,
            british=dialect == "gb",
            fallback=fallback,
            unk="",
        )
        for case in CASES:
            phonemes, tokens = oracle(case["text"])
            fallback_tokens = [
                token
                for token in tokens
                if _token_rating(token) is not None and _token_rating(token) <= 2
            ]
            whole_sentence_espeak, _ = fallback(types.SimpleNamespace(text=case["text"]))
            fixtures.append(
                {
                    **case,
                    "dialect": dialect,
                    "phonemes": phonemes,
                    "fallbackWords": [token.text for token in fallback_tokens],
                    "fallbackRaw": {
                        token.text: fallback.backend.phonemize([token.text])[0].strip() for token in fallback_tokens
                    },
                    "wholeSentenceEspeak": whole_sentence_espeak,
                    "tokens": [
                        {
                            "text": token.text,
                            "tag": token.tag,
                            "whitespace": token.whitespace,
                            "phonemes": token.phonemes,
                            "rating": _token_rating(token),
                        }
                        for token in tokens
                    ],
                }
            )

    document = {
        "oracle": "hexgrad/misaki",
        "oracleVersion": "0.9.4",
        "oracleRevision": revision,
        "englishFallback": "EspeakFallback",
        "fixtures": fixtures,
    }
    encoded = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    targets = [
        root / "backend" / "tests" / "fixtures" / "misaki_en_parity.json",
        root / "src-tauri" / "plugins" / "android" / "src" / "test" / "resources" / "misaki_en_parity.json",
    ]
    for target in targets:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(encoded, encoding="utf-8")
    print(f"wrote {len(fixtures)} oracle fixtures to {len(targets)} targets")


if __name__ == "__main__":
    main()
