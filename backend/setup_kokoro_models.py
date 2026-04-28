"""Download Folio's Kokoro v1.0 model assets.

The app never downloads models during startup. Run this script explicitly when
the full-quality model or voices file is missing.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from paths import MODELS_DIR

QUALITY_MODEL_FILENAME = "kokoro-v1.0.onnx"
MODEL_ALIAS_FILENAME = "model.onnx"
VOICES_FILENAME = "voices-v1.0.bin"

MODEL_SOURCES = [
    (
        "GitHub kokoro-onnx release",
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    ),
    (
        "Hugging Face onnx-community/Kokoro-82M-v1.0-ONNX",
        "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx?download=true",
    ),
]

VOICE_SOURCES = [
    (
        "GitHub kokoro-onnx release",
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
    ),
]


def is_lfs_pointer(path: Path) -> bool:
    try:
        if path.stat().st_size > 1024:
            return False
        return path.read_bytes()[:256].startswith(b"version https://git-lfs.github.com/spec/")
    except OSError:
        return False


def is_valid_asset(path: Path) -> bool:
    return path.exists() and path.is_file() and not is_lfs_pointer(path)


def format_size(path: Path) -> str:
    if not path.exists():
        return "missing"
    size = path.stat().st_size
    return f"{size / 1024 / 1024:.1f} MB"


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=str(destination.parent),
    )
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "Folio-Kokoro-Setup/1.0"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            total_header = response.headers.get("Content-Length")
            total = int(total_header) if total_header and total_header.isdigit() else None
            downloaded = 0
            last_percent = -1
            with tmp_path.open("wb") as f:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        percent = int(downloaded * 100 / total)
                        if percent >= last_percent + 10:
                            print(f"  {percent}%")
                            last_percent = percent
        if is_lfs_pointer(tmp_path):
            raise RuntimeError(f"Downloaded Git LFS pointer instead of model asset from {url}")
        os.replace(tmp_path, destination)
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def normalize_manual_model(models_dir: Path, force: bool) -> bool:
    target = models_dir / QUALITY_MODEL_FILENAME
    alias = models_dir / MODEL_ALIAS_FILENAME
    if not is_valid_asset(alias):
        return False
    if is_valid_asset(target) and not force:
        return False
    print(f"Using local {MODEL_ALIAS_FILENAME}; saving as {QUALITY_MODEL_FILENAME}")
    os.replace(alias, target)
    return True


def ensure_asset(
    destination: Path,
    sources: list[tuple[str, str]],
    *,
    force: bool,
    label: str,
) -> bool:
    if is_valid_asset(destination) and not force:
        print(f"{label}: present ({destination}, {format_size(destination)})")
        return True

    for source_name, url in sources:
        print(f"{label}: downloading from {source_name}")
        try:
            download(url, destination)
            print(f"{label}: saved {destination} ({format_size(destination)})")
            return True
        except (OSError, RuntimeError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            print(f"{label}: failed from {source_name}: {exc}", file=sys.stderr)

    return False


def check(models_dir: Path) -> bool:
    model = models_dir / QUALITY_MODEL_FILENAME
    voices = models_dir / VOICES_FILENAME
    ok = True
    for label, path in [("full-quality model", model), ("voices", voices)]:
        if is_valid_asset(path):
            print(f"{label}: present ({path}, {format_size(path)})")
        elif path.exists() and is_lfs_pointer(path):
            print(f"{label}: Git LFS pointer only ({path})")
            ok = False
        else:
            print(f"{label}: missing ({path})")
            ok = False
    alias = models_dir / MODEL_ALIAS_FILENAME
    if is_valid_asset(alias) and not is_valid_asset(model):
        print(f"manual source found: {alias}; run without --check to save it as {QUALITY_MODEL_FILENAME}")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Folio Kokoro v1.0 model assets.")
    parser.add_argument("--check", action="store_true", help="Only report whether required assets are present.")
    parser.add_argument("--force", action="store_true", help="Redownload assets even when present.")
    parser.add_argument("--models-dir", default=str(MODELS_DIR), help="Directory for Kokoro model assets.")
    args = parser.parse_args()

    models_dir = Path(args.models_dir).expanduser().resolve()
    models_dir.mkdir(parents=True, exist_ok=True)

    if args.check:
        return 0 if check(models_dir) else 1

    normalize_manual_model(models_dir, args.force)

    model_ok = ensure_asset(
        models_dir / QUALITY_MODEL_FILENAME,
        MODEL_SOURCES,
        force=args.force,
        label="full-quality Kokoro v1.0 model",
    )
    voices_ok = ensure_asset(
        models_dir / VOICES_FILENAME,
        VOICE_SOURCES,
        force=args.force,
        label="Kokoro voices",
    )

    if model_ok and voices_ok:
        print("Kokoro model setup complete.")
        return 0

    print("Kokoro model setup incomplete.", file=sys.stderr)
    if not voices_ok:
        print("voices-v1.0.bin is only downloaded from the kokoro-onnx GitHub release.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
