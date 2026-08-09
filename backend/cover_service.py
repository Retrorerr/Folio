"""EPUB cover extraction and thumbnail caching for Folio."""

from __future__ import annotations

import io
import json
import logging
import mimetypes
import os
import posixpath
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

from bs4 import BeautifulSoup
from PIL import Image, UnidentifiedImageError

logger = logging.getLogger("uvicorn.error")

EXTRACTOR_VERSION = 1
THUMBNAIL_MAX_SIZE = (420, 640)
MAX_COVER_MEMBER_BYTES = 8 * 1024 * 1024
IMAGE_MEDIA_PREFIX = "image/"
FALLBACK_COVER_NAMES = {
    "cover.jpg",
    "cover.jpeg",
    "cover.png",
    "cover.webp",
    "cover.gif",
    "title.jpg",
    "title.jpeg",
    "title.png",
    "frontcover.jpg",
    "frontcover.jpeg",
    "frontcover.png",
}
TITLEPAGE_HINTS = ("titlepage", "title-page", "cover", "frontmatter")


@dataclass(frozen=True)
class CoverResult:
    path: str
    source: str


def ensure_cover_thumbnail(epub_path: str, book_id: str, data_dir: str) -> CoverResult | None:
    """Extract and cache an EPUB cover thumbnail.

    Returns a CoverResult when a usable cover was found. Missing/broken covers
    return None and let the UI keep its default generated book icon.
    """
    covers_dir = Path(data_dir) / "covers"
    covers_dir.mkdir(parents=True, exist_ok=True)
    thumb_path = covers_dir / f"{book_id}.jpg"
    meta_path = covers_dir / f"{book_id}.json"

    if meta_path.exists():
        try:
            mtime = os.path.getmtime(epub_path)
            if meta_path.stat().st_mtime >= mtime:
                data = json.loads(meta_path.read_text(encoding="utf-8"))
                source = data.get("source")
                ext_version = data.get("extractor_version", 0)
                if ext_version == EXTRACTOR_VERSION:
                    if source == "none":
                        logger.info("EPUB cover thumbnail cache reused book_id=%s source=none cache=true", book_id)
                        return None
                    elif source == "failed":
                        created_at = data.get("created_at", 0.0)
                        if time.time() - created_at < 3600.0:
                            logger.info("EPUB cover thumbnail cache reused book_id=%s source=failed cache=true", book_id)
                            return None
                        else:
                            logger.info("EPUB cover thumbnail cache expired for book_id=%s source=failed (TTL exceeded)", book_id)
                    elif source and thumb_path.exists():
                        logger.info(
                            "EPUB cover thumbnail cache reused book_id=%s source=%s cache=true output=%s",
                            book_id,
                            source,
                            thumb_path,
                        )
                        return CoverResult(path=str(thumb_path), source=source)
        except Exception:
            logger.exception("Failed to validate cover cache for book_id=%s path=%s", book_id, epub_path)

    try:
        cover = _extract_cover_bytes(epub_path)
        if cover is None:
            _write_cached_source(meta_path, "none", "")
            logger.info("EPUB cover default fallback book_id=%s path=%s reason=no-cover", book_id, epub_path)
            return None
        data, source, zip_path = cover
        _write_thumbnail(data, thumb_path)
        _write_cached_source(meta_path, source, zip_path)
        logger.info(
            "EPUB cover thumbnail generated book_id=%s source=%s zip_path=%s output=%s",
            book_id,
            source,
            zip_path,
            thumb_path,
        )
        return CoverResult(path=str(thumb_path), source=source)
    except Exception:
        _write_cached_source(meta_path, "failed", "")
        logger.exception("EPUB cover default fallback book_id=%s path=%s reason=extract-failed", book_id, epub_path)
        return None


def _extract_cover_bytes(epub_path: str) -> tuple[bytes, str, str] | None:
    with zipfile.ZipFile(epub_path) as zf:
        opf_path = _find_opf_path(zf)
        if not opf_path:
            return _zip_filename_fallback(zf)

        try:
            opf_root = ET.fromstring(zf.read(opf_path))
        except Exception:
            logger.exception("Failed to parse EPUB OPF path=%s epub=%s", opf_path, epub_path)
            return _zip_filename_fallback(zf)

        manifest = _manifest_items(opf_root)
        opf_dir = posixpath.dirname(opf_path)

        cover_item = _epub3_cover_item(manifest)
        if cover_item:
            found = _read_manifest_item(zf, opf_dir, cover_item)
            if found:
                return found[0], "cover-image", found[1]

        meta_cover_id = _epub2_cover_id(opf_root)
        if meta_cover_id and meta_cover_id in manifest:
            found = _read_manifest_item(zf, opf_dir, manifest[meta_cover_id])
            if found:
                return found[0], "meta-cover", found[1]

        found = _manifest_filename_fallback(zf, opf_dir, manifest)
        if found:
            return found[0], "filename-fallback", found[1]

        found = _titlepage_image_fallback(zf, opf_dir, manifest)
        if found:
            return found[0], "titlepage-fallback", found[1]

        return _zip_filename_fallback(zf)


def _zip_filename_fallback(zf: zipfile.ZipFile) -> tuple[bytes, str, str] | None:
    found = _filename_fallback(zf)
    if not found:
        return None
    return found[0], "zip-filename-fallback", found[1]


def _write_cached_source(meta_path: Path, source: str, zip_path: str) -> None:
    meta_path.write_text(
        json.dumps(
            {
                "source": source,
                "zip_path": zip_path,
                "extractor_version": EXTRACTOR_VERSION,
                "created_at": time.time(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _find_opf_path(zf: zipfile.ZipFile) -> str | None:
    try:
        container = ET.fromstring(zf.read("META-INF/container.xml"))
    except Exception:
        logger.exception("Failed to read EPUB container.xml")
        return None

    for el in container.iter():
        if _local_name(el.tag) == "rootfile":
            full_path = (el.attrib.get("full-path") or "").strip()
            if full_path and full_path in zf.namelist():
                return full_path
    return None


def _manifest_items(opf_root: ET.Element) -> dict[str, dict[str, str]]:
    items: dict[str, dict[str, str]] = {}
    for el in opf_root.iter():
        if _local_name(el.tag) != "item":
            continue
        item_id = (el.attrib.get("id") or "").strip()
        href = (el.attrib.get("href") or "").strip()
        if not item_id or not href:
            continue
        items[item_id] = {
            "id": item_id,
            "href": href,
            "media_type": (el.attrib.get("media-type") or "").strip().lower(),
            "properties": (el.attrib.get("properties") or "").strip().lower(),
        }
    return items


def _epub3_cover_item(manifest: dict[str, dict[str, str]]) -> dict[str, str] | None:
    for item in manifest.values():
        properties = set(item.get("properties", "").split())
        if "cover-image" in properties:
            return item
    return None


def _epub2_cover_id(opf_root: ET.Element) -> str | None:
    for el in opf_root.iter():
        if _local_name(el.tag) != "meta":
            continue
        if (el.attrib.get("name") or "").strip().lower() == "cover":
            return (el.attrib.get("content") or "").strip() or None
    return None


def _manifest_filename_fallback(
    zf: zipfile.ZipFile,
    opf_dir: str,
    manifest: dict[str, dict[str, str]],
) -> tuple[bytes, str] | None:
    image_items = [item for item in manifest.values() if _is_image_item(item)]

    for item in image_items:
        if posixpath.basename(item["href"]).lower() in FALLBACK_COVER_NAMES:
            return _read_manifest_item(zf, opf_dir, item)

    for item in image_items:
        stem = posixpath.splitext(posixpath.basename(item["href"]).lower())[0]
        if any(token in stem for token in ("cover", "front", "title")):
            return _read_manifest_item(zf, opf_dir, item)

    return None


def _titlepage_image_fallback(
    zf: zipfile.ZipFile,
    opf_dir: str,
    manifest: dict[str, dict[str, str]],
) -> tuple[bytes, str] | None:
    docs = [
        item for item in manifest.values()
        if item.get("media_type") in {"application/xhtml+xml", "text/html"}
        and any(hint in posixpath.basename(item.get("href", "")).lower() for hint in TITLEPAGE_HINTS)
    ]

    for item in docs:
        doc_path = _resolve_zip_path(opf_dir, item["href"])
        data = _safe_read(zf, doc_path)
        if data is None:
            continue
        soup = BeautifulSoup(data, "html.parser")
        refs: list[str] = []
        refs.extend(img.get("src") for img in soup.find_all("img") if img.get("src"))
        refs.extend(
            node.get("href") or node.get("xlink:href")
            for node in soup.find_all(["image"])
            if node.get("href") or node.get("xlink:href")
        )
        doc_dir = posixpath.dirname(doc_path)
        for ref in refs:
            img_path = _resolve_zip_path(doc_dir, ref)
            img_data = _safe_read(zf, img_path)
            if img_data and _looks_like_image_path(img_path):
                return img_data, img_path
    return None


def _filename_fallback(zf: zipfile.ZipFile) -> tuple[bytes, str] | None:
    names = [name for name in zf.namelist() if not name.endswith("/") and _looks_like_image_path(name)]
    for name in names:
        if posixpath.basename(name).lower() in FALLBACK_COVER_NAMES:
            data = _safe_read(zf, name)
            if data:
                return data, name
    for name in names:
        stem = posixpath.splitext(posixpath.basename(name).lower())[0]
        if any(token in stem for token in ("cover", "front", "title")):
            data = _safe_read(zf, name)
            if data:
                return data, name
    return None


def _read_manifest_item(
    zf: zipfile.ZipFile,
    opf_dir: str,
    item: dict[str, str],
) -> tuple[bytes, str] | None:
    path = _resolve_zip_path(opf_dir, item["href"])
    data = _safe_read(zf, path)
    if not data:
        return None
    return data, path


def _write_thumbnail(data: bytes, thumb_path: Path) -> None:
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.thumbnail(THUMBNAIL_MAX_SIZE, Image.Resampling.LANCZOS)
            if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
                image = image.convert("RGBA")
                background = Image.new("RGBA", image.size, (255, 255, 255, 255))
                background.alpha_composite(image)
                image = background.convert("RGB")
            else:
                image = image.convert("RGB")
            image.save(thumb_path, format="JPEG", quality=88, optimize=True, progressive=True)
    except UnidentifiedImageError as exc:
        raise ValueError("Cover image bytes are not a supported image") from exc


def _resolve_zip_path(base_dir: str, href: str) -> str:
    href = (href or "").split("#", 1)[0].split("?", 1)[0]
    href = href.lstrip("/")
    return posixpath.normpath(posixpath.join(base_dir, href))


def _safe_read(zf: zipfile.ZipFile, path: str) -> bytes | None:
    path = path.lstrip("/")
    try:
        info = zf.getinfo(path)
    except KeyError:
        return None
    if info.is_dir() or info.file_size <= 0:
        return None
    if info.file_size > MAX_COVER_MEMBER_BYTES:
        logger.warning(
            "Skipping oversized EPUB cover member path=%s bytes=%s limit=%s",
            path,
            info.file_size,
            MAX_COVER_MEMBER_BYTES,
        )
        return None
    try:
        with zf.open(info) as member:
            data = member.read(MAX_COVER_MEMBER_BYTES + 1)
        if len(data) > MAX_COVER_MEMBER_BYTES:
            logger.warning(
                "Skipping EPUB cover member that exceeded its read limit path=%s limit=%s",
                path,
                MAX_COVER_MEMBER_BYTES,
            )
            return None
        return data
    except Exception:
        logger.exception("Failed to read EPUB ZIP member path=%s", path)
        return None


def _is_image_item(item: dict[str, str]) -> bool:
    media_type = item.get("media_type", "")
    return media_type.startswith(IMAGE_MEDIA_PREFIX) or _looks_like_image_path(item.get("href", ""))


def _looks_like_image_path(path: str) -> bool:
    if not path:
        return False
    media_type, _encoding = mimetypes.guess_type(path)
    return bool(media_type and media_type.startswith(IMAGE_MEDIA_PREFIX))


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()
