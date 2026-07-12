from __future__ import annotations

import importlib
import threading
from types import ModuleType
from typing import Any


class LazyModule:
    """Import a heavy optional runtime module on its first real use."""

    def __init__(self, module_name: str):
        self._module_name = module_name
        self._module: ModuleType | None = None
        self._lock = threading.Lock()

    def _load(self) -> ModuleType:
        if self._module is not None:
            return self._module
        with self._lock:
            if self._module is None:
                self._module = importlib.import_module(self._module_name)
        return self._module

    def __getattr__(self, name: str) -> Any:
        return getattr(self._load(), name)

    def __dir__(self) -> list[str]:
        return sorted(set(super().__dir__()) | set(dir(self._load())))


class LazyAttribute:
    """Resolve one attribute from a heavy module on first use."""

    def __init__(self, module_name: str, attribute_name: str):
        self._module = LazyModule(module_name)
        self._attribute_name = attribute_name
        self._value: Any = None
        self._lock = threading.Lock()

    def _load(self) -> Any:
        if self._value is not None:
            return self._value
        with self._lock:
            if self._value is None:
                self._value = getattr(self._module, self._attribute_name)
        return self._value

    def __getattr__(self, name: str) -> Any:
        return getattr(self._load(), name)
