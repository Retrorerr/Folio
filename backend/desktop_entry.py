"""Packaged desktop backend entrypoint.

PyInstaller builds this file into the sidecar executable that Tauri launches.
"""

import os
import logging
import sys

import uvicorn


def configure_logging() -> logging.Logger:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    return logging.getLogger("folio.desktop_entry")


def log_environment(logger: logging.Logger) -> None:
    logger.info("Backend executable starting")
    logger.info("Python executable: %s", sys.executable)
    logger.info("Python version: %s", sys.version.replace("\n", " "))
    logger.info("Current working directory: %s", os.getcwd())
    logger.info("Frozen by PyInstaller: %s", bool(getattr(sys, "frozen", False)))
    logger.info("PyInstaller bundle temp dir: %s", getattr(sys, "_MEIPASS", "<not frozen>"))
    for name in [
        "FOLIO_BACKEND_HOST",
        "FOLIO_BACKEND_PORT",
        "KOKORO_READER_DATA_DIR",
        "KOKORO_READER_UPLOAD_DIR",
        "KOKORO_READER_AUDIO_CACHE_DIR",
        "KOKORO_READER_MODELS_DIR",
        "KOKORO_CORS_ORIGINS",
    ]:
        logger.info("env %s=%s", name, os.environ.get(name, "<unset>"))
    logger.info("sys.path: %s", sys.path)


def main() -> None:
    logger = configure_logging()
    log_environment(logger)
    host = os.environ.get("FOLIO_BACKEND_HOST", "127.0.0.1")
    port = int(os.environ.get("FOLIO_BACKEND_PORT", "8000"))
    logger.info("Importing FastAPI application")
    try:
        from main import app
    except Exception:
        logger.exception("Failed to import FastAPI application")
        raise

    logger.info("Starting uvicorn on %s:%s", host, port)
    try:
        uvicorn.run(app, host=host, port=port, log_level="info")
    except Exception:
        logger.exception("Uvicorn exited with an unhandled exception")
        raise


if __name__ == "__main__":
    main()
