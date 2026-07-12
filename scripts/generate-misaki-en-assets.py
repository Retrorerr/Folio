"""Build Folio's compact, deterministic Misaki English runtime lexicons.

The source checkout is deliberately external to the shipped application. This
script mechanically converts the four Apache-2.0 Misaki dictionaries into a
line-indexable gzip format shared by Android and the frozen desktop backend.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import subprocess
from pathlib import Path


EXPECTED_REVISION = "fba1236595f2d2bf21d414ba6e57d25256afada3"
FORMAT_VERSION = 1


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\t", "\\t").replace("\r", "\\r").replace("\n", "\\n")


def _load_dialect(data_dir: Path, dialect: str) -> dict[str, tuple[int, str | dict[str, str | None]]]:
    result: dict[str, tuple[int, str | dict[str, str | None]]] = {}
    for tier, rating in (("silver", 3), ("gold", 4)):
        path = data_dir / f"{dialect}_{tier}.json"
        values = json.loads(path.read_text(encoding="utf-8"))
        for word, pronunciation in values.items():
            result[word] = (rating, pronunciation)
    return result


def _encode_lexicon(dialect: str, records: dict[str, tuple[int, str | dict[str, str | None]]]) -> bytes:
    lines = [f"FOLIO-MISAKI-LEXICON\t{FORMAT_VERSION}\t{EXPECTED_REVISION}\t{dialect}\t{len(records)}"]
    for word in sorted(records, key=lambda value: value.encode("utf-8")):
        rating, pronunciation = records[word]
        fields = [_escape(word), str(rating)]
        if isinstance(pronunciation, str):
            fields.extend(("S", _escape(pronunciation)))
        else:
            fields.append("M")
            for tag in sorted(pronunciation, key=lambda value: (value != "DEFAULT", value)):
                value = pronunciation[tag]
                fields.append(f"{_escape(tag)}={_escape(value) if value is not None else '~'}")
        lines.append("\t".join(fields))
    raw = ("\n".join(lines) + "\n").encode("utf-8")
    return gzip.compress(raw, compresslevel=9, mtime=0)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_tree(destination: Path, payloads: dict[str, bytes], license_bytes: bytes, notice: bytes, source: bytes) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    expected = {"us.lex.gz", "gb.lex.gz", "LICENSE", "NOTICE", "SOURCE.json"}
    for child in destination.iterdir():
        if child.is_file() and child.name not in expected:
            child.unlink()
    for name, payload in payloads.items():
        (destination / name).write_bytes(payload)
    (destination / "LICENSE").write_bytes(license_bytes)
    (destination / "NOTICE").write_bytes(notice)
    (destination / "SOURCE.json").write_bytes(source)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(".android-build/misaki-source"))
    parser.add_argument("--allow-unpinned", action="store_true")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    source = args.source.resolve()
    revision = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True, encoding="utf-8"
    ).strip()
    if revision != EXPECTED_REVISION and not args.allow_unpinned:
        raise SystemExit(f"Misaki checkout is {revision}; expected {EXPECTED_REVISION}")

    data_dir = source / "misaki" / "data"
    records = {dialect: _load_dialect(data_dir, dialect) for dialect in ("us", "gb")}
    payloads = {f"{dialect}.lex.gz": _encode_lexicon(dialect, values) for dialect, values in records.items()}
    metadata = {
        "format": "folio-misaki-lexicon",
        "formatVersion": FORMAT_VERSION,
        "upstream": "https://github.com/hexgrad/misaki",
        "upstreamVersion": "0.9.4",
        "upstreamRevision": revision,
        "license": "Apache-2.0",
        "generator": "scripts/generate-misaki-en-assets.py",
        "outputs": {
            name: {
                "bytes": len(payload),
                "sha256": _sha256(payload),
                "entries": len(records[name[:2]]),
            }
            for name, payload in sorted(payloads.items())
        },
    }
    source_json = (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode("utf-8")
    notice = (
        "Folio includes mechanically compacted English pronunciation dictionaries from Misaki 0.9.4.\n"
        f"Source: https://github.com/hexgrad/misaki at revision {revision}.\n"
        "The generated us.lex.gz and gb.lex.gz files are modified data representations.\n"
        "Misaki and these derived dictionary assets are distributed under Apache License 2.0; see LICENSE.\n"
    ).encode("utf-8")
    license_bytes = (source / "LICENSE").read_bytes()

    android = root / "src-tauri" / "plugins" / "android" / "src" / "main" / "assets" / "misaki-en"
    backend = root / "backend" / "misaki_data"
    _write_tree(android, payloads, license_bytes, notice, source_json)
    _write_tree(backend, payloads, license_bytes, notice, source_json)

    for name, info in metadata["outputs"].items():
        print(f"{name}: {info['entries']} entries, {info['bytes']} bytes, sha256={info['sha256']}")


if __name__ == "__main__":
    main()
