"""Packaged desktop backend entrypoint.

PyInstaller builds this file into the sidecar executable that Tauri launches.
"""

import os

import uvicorn


def main() -> None:
    host = os.environ.get("FOLIO_BACKEND_HOST", "127.0.0.1")
    port = int(os.environ.get("FOLIO_BACKEND_PORT", "8000"))
    uvicorn.run("main:app", host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
