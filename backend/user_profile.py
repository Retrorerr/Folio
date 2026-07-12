"""Resolve a concise local reader name without network or account access."""

from __future__ import annotations

import getpass
import os
import re
import sys
from functools import lru_cache


def normalize_reader_name(value: object, *, first_name_only: bool = False) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = "".join(char for char in text if char.isprintable())[:40]
    if not text:
        return ""
    if first_name_only:
        text = text.split(" ", 1)[0]
    return text


def _windows_display_name() -> str:
    if sys.platform != "win32":
        return ""
    try:
        import ctypes
        from ctypes import wintypes

        get_user_name = ctypes.windll.secur32.GetUserNameExW
        size = wintypes.ULONG(0)
        get_user_name(3, None, ctypes.byref(size))  # NameDisplay
        if size.value <= 1:
            return ""
        buffer = ctypes.create_unicode_buffer(size.value)
        if get_user_name(3, buffer, ctypes.byref(size)):
            return normalize_reader_name(buffer.value)
    except (AttributeError, OSError, ValueError):
        return ""
    return ""


def _posix_display_name() -> str:
    if os.name == "nt":
        return ""
    try:
        import pwd

        gecos = pwd.getpwuid(os.getuid()).pw_gecos.split(",", 1)[0]
        return normalize_reader_name(gecos)
    except (ImportError, KeyError, OSError):
        return ""


@lru_cache(maxsize=1)
def system_reader_name() -> str:
    display_name = _windows_display_name() or _posix_display_name()
    if display_name:
        return normalize_reader_name(display_name, first_name_only=True)

    try:
        username = getpass.getuser()
    except (ImportError, KeyError, OSError):
        username = ""
    username = username.rsplit("\\", 1)[-1].split("@", 1)[0]
    username = normalize_reader_name(username, first_name_only=True)
    return username[:1].upper() + username[1:] if username else ""
