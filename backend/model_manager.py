from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from paths import DATA_DIR

INSTALL_STATE_DIR = DATA_DIR / "model-installs"
INSTALL_STATE_DIR.mkdir(parents=True, exist_ok=True)

ACTIVE_STATES = {"download_queued", "downloading", "verifying"}
TERMINAL_STATES = {"not_installed", "ready", "failed"}

_state_lock = threading.Lock()


class ModelInstallRequired(RuntimeError):
    def __init__(self, engine: str, state: str, message: str):
        super().__init__(message)
        self.engine = engine
        self.state = state
        self.message = message


def state_path(engine: str) -> Path:
    return INSTALL_STATE_DIR / f"{engine}.json"


def default_state(engine: str, label: str, approx_bytes: int = 0) -> dict[str, Any]:
    return {
        "engine": engine,
        "label": label,
        "state": "not_installed",
        "ready": False,
        "downloaded_bytes": 0,
        "total_bytes": int(approx_bytes or 0),
        "progress": 0.0,
        "error": None,
        "updated_at": time.time(),
    }


def load_state(engine: str, label: str, approx_bytes: int = 0) -> dict[str, Any]:
    path = state_path(engine)
    state = default_state(engine, label, approx_bytes)
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                state.update(loaded)
        except Exception:
            state["state"] = "failed"
            state["error"] = "Previous install metadata was unreadable."
    if state.get("state") in ACTIVE_STATES:
        state["state"] = "failed"
        state["ready"] = False
        state["error"] = "A previous download was interrupted. Retry to continue."
    state["label"] = label
    if approx_bytes and not state.get("total_bytes"):
        state["total_bytes"] = int(approx_bytes)
    return state


def save_state(state: dict[str, Any]) -> dict[str, Any]:
    state["updated_at"] = time.time()
    payload = dict(state)
    path = state_path(str(state["engine"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    with _state_lock:
        temp_path = path.with_name(f"{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
        try:
            temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            os.replace(temp_path, path)
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
    return state


def _meaningful_state(state: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in state.items() if key != "updated_at"}


def _save_if_changed(state: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    if _meaningful_state(state) == _meaningful_state(previous):
        return state
    return save_state(state)


def update_progress(state: dict[str, Any], downloaded: int, total: int | None = None) -> dict[str, Any]:
    previous = dict(state)
    total_bytes = int(total if total is not None else state.get("total_bytes") or 0)
    downloaded_bytes = max(0, int(downloaded))
    progress = 0.0
    if total_bytes > 0:
        progress = max(0.0, min(1.0, downloaded_bytes / total_bytes))
    state.update(
        {
            "downloaded_bytes": downloaded_bytes,
            "total_bytes": total_bytes,
            "progress": progress,
        }
    )
    return _save_if_changed(state, previous)


def set_state(
    state: dict[str, Any],
    next_state: str,
    *,
    ready: bool | None = None,
    error: str | None = None,
    downloaded_bytes: int | None = None,
    total_bytes: int | None = None,
) -> dict[str, Any]:
    previous = dict(state)
    state["state"] = next_state
    if ready is not None:
        state["ready"] = bool(ready)
    if error is not None or next_state != "failed":
        state["error"] = error
    if downloaded_bytes is not None:
        state["downloaded_bytes"] = int(downloaded_bytes)
    if total_bytes is not None:
        state["total_bytes"] = int(total_bytes)
    total = int(state.get("total_bytes") or 0)
    downloaded = int(state.get("downloaded_bytes") or 0)
    state["progress"] = max(0.0, min(1.0, downloaded / total)) if total > 0 else 0.0
    return _save_if_changed(state, previous)


def user_install_info(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "engine": state.get("engine"),
        "label": state.get("label"),
        "state": state.get("state", "not_installed"),
        "ready": bool(state.get("ready")),
        "downloaded_bytes": int(state.get("downloaded_bytes") or 0),
        "total_bytes": int(state.get("total_bytes") or 0),
        "progress": float(state.get("progress") or 0.0),
        "error": state.get("error"),
        "updated_at": state.get("updated_at"),
    }
