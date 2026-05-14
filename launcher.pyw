"""
Kokoro Audiobook Reader - Standalone Launcher
Starts the server and opens the app in a browser window (app mode).
Closing the browser window shuts down the server automatically.
"""
import subprocess
import sys
import os
import time
import glob
import webbrowser
import traceback

APP_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(APP_DIR, "backend")
BACKEND_VENV_DIR = os.path.join(BACKEND_DIR, ".venv")
LOG_FILE = os.path.join(APP_DIR, "launcher.log")
PORT = 8000
URL = f"http://127.0.0.1:{PORT}"


def log(msg):
    # encoding="utf-8" so book titles / paths with non-ASCII chars don't blow
    # up logging on Windows' cp1252 default.
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")


def prepend_path(env, path):
    if not path or not os.path.exists(path):
        return False
    path = os.path.abspath(path)
    current = env.get("PATH", "")
    parts = [p.lower() for p in current.split(os.pathsep) if p]
    if path.lower() not in parts:
        env["PATH"] = path + os.pathsep + current
        return True
    return False


def candidate_site_packages(python_exe):
    """Return likely site-packages folders without importing app code."""
    paths = []
    venv_site = os.path.join(BACKEND_VENV_DIR, "Lib", "site-packages")
    if python_exe.lower().startswith(BACKEND_VENV_DIR.lower()):
        paths.append(venv_site)

    version = None
    try:
        out = subprocess.check_output(
            [python_exe, "-c", "import sys; print(f'{sys.version_info.major}{sys.version_info.minor}')"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
        version = out.strip()
    except Exception:
        version = f"{sys.version_info.major}{sys.version_info.minor}"

    if version:
        paths.extend(
            [
                os.path.join(
                    os.path.expanduser("~"),
                    "AppData",
                    "Roaming",
                    "Python",
                    f"Python{version}",
                    "site-packages",
                ),
                os.path.join(os.path.dirname(os.path.dirname(python_exe)), "Lib", "site-packages"),
            ]
        )

    seen = set()
    result = []
    for path in paths:
        key = os.path.abspath(path).lower()
        if key not in seen and os.path.isdir(path):
            seen.add(key)
            result.append(path)
    return result


def configure_runtime_path(env, python_exe):
    """Expose venv scripts and CUDA DLL folders for Torch, ONNX, and llama.cpp."""
    scripts = os.path.join(os.path.dirname(python_exe))
    if prepend_path(env, scripts):
        log(f"PATH add: {scripts}")

    for site_packages in candidate_site_packages(python_exe):
        for path in glob.glob(os.path.join(site_packages, "nvidia", "*", "bin")):
            if prepend_path(env, path):
                log(f"PATH add: {path}")
        for path in (os.path.join(site_packages, "torch", "lib"),):
            if prepend_path(env, path):
                log(f"PATH add: {path}")


def python_works(python_exe):
    try:
        check = subprocess.run(
            [python_exe, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if check.returncode == 0:
            return True
        log(f"Python candidate failed: {python_exe} :: {check.stderr[:300]}")
    except Exception as exc:
        log(f"Python candidate unavailable: {python_exe} :: {exc}")
    return False


def find_python():
    """Find python.exe (not pythonw.exe) for running the server."""
    preferred = os.environ.get("FOLIO_PYTHON") or os.environ.get("KOKORO_READER_PYTHON")
    if preferred and os.path.exists(preferred) and python_works(preferred):
        return preferred

    venv_python = os.path.join(BACKEND_VENV_DIR, "Scripts", "python.exe")
    if os.path.exists(venv_python) and python_works(venv_python):
        return venv_python

    exe_dir = os.path.dirname(sys.executable)
    p = os.path.join(exe_dir, "python.exe")
    if os.path.exists(p) and python_works(p):
        return p
    import shutil
    path_python = shutil.which("python")
    if path_python and python_works(path_python):
        return path_python
    return sys.executable


def find_browser_app_mode():
    """Find Chrome or Edge to launch in --app mode."""
    candidates = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def wait_for_server(proc, timeout=90):
    """Wait until the server is accepting connections."""
    import urllib.request
    start = time.time()
    while time.time() - start < timeout:
        if proc.poll() is not None:
            log(f"Server process exited with code {proc.returncode}")
            return False
        try:
            urllib.request.urlopen(URL + "/api/recent", timeout=2)
            return True
        except Exception:
            time.sleep(1)
    log("Server timed out after 90s")
    return False


def show_error(msg):
    import ctypes
    ctypes.windll.user32.MessageBoxW(0, msg, "Kokoro Audiobook Reader - Error", 0x10)


def kill_orphan_server():
    """Kill any existing server on our port from a previous crashed session."""
    import urllib.request
    try:
        urllib.request.urlopen(URL + "/api/status", timeout=2)
        # Server is running — send shutdown
        log("Found orphan server, shutting it down")
        try:
            urllib.request.urlopen(
                urllib.request.Request(URL + "/api/shutdown", method="POST"),
                timeout=3,
            )
        except Exception:
            pass
        time.sleep(2)
    except Exception:
        pass  # No server running, good


def main():
    # Clear old log
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        f.write(f"Kokoro Reader Launcher - {time.strftime('%Y-%m-%d %H:%M:%S')}\n")

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    python_exe = find_python()
    log(f"Python: {python_exe}")
    log(f"Backend: {BACKEND_DIR}")
    log(f"CWD: {os.getcwd()}")
    configure_runtime_path(env, python_exe)

    # Clean up orphan server from previous crash
    kill_orphan_server()

    # Check python can import uvicorn
    check = subprocess.run(
        [python_exe, "-c", "import uvicorn; print('ok')"],
        capture_output=True, text=True, env=env
    )
    if check.returncode != 0:
        log(f"uvicorn import failed: {check.stderr}")
        show_error(f"Cannot find uvicorn module.\n\nPython: {python_exe}\nError: {check.stderr[:300]}")
        sys.exit(1)
    log("uvicorn import OK")

    server_log = os.path.join(APP_DIR, "server.log")
    server_log_fh = open(server_log, "w")
    server_proc = subprocess.Popen(
        [python_exe, "-m", "uvicorn", "main:app",
         "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=BACKEND_DIR,
        env=env,
        stdout=server_log_fh,
        stderr=server_log_fh,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    log(f"Server started, PID={server_proc.pid}")

    if not wait_for_server(server_proc):
        server_log_fh.close()
        stderr = ""
        try:
            with open(server_log, "r") as f:
                stderr = f.read()
        except Exception:
            pass
        log(f"Server failed: {stderr[:500]}")
        show_error(f"Server failed to start.\n\n{stderr[:500]}")
        try:
            server_proc.kill()
        except Exception:
            pass
        sys.exit(1)

    log("Server ready, opening browser")

    browser_path = find_browser_app_mode()
    browser_proc = None
    log(f"Browser: {browser_path}")

    if browser_path:
        # Use a dedicated user-data-dir so the browser runs as an independent
        # process even if Edge/Chrome is already open.  Without this, Chromium
        # delegates to the existing instance and our Popen exits immediately.
        app_profile = os.path.join(APP_DIR, ".browser-profile")
        browser_proc = subprocess.Popen([
            browser_path,
            f"--app={URL}",
            f"--user-data-dir={app_profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=1280,900",
        ])
    else:
        webbrowser.open(URL)

    if browser_proc:
        browser_proc.wait()
        log("Browser closed, shutting down server")
        # The browser-side beforeunload shutdown beacon was removed (it kept
        # killing the backend on hard reloads). Send the shutdown POST from
        # here instead so book state gets flushed before SIGTERM.
        if server_proc.poll() is None:
            try:
                import urllib.request
                urllib.request.urlopen(
                    urllib.request.Request(URL + "/api/shutdown", method="POST"),
                    timeout=3,
                )
            except Exception as exc:
                log(f"Graceful shutdown POST failed: {exc}")
            try:
                server_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_proc.terminate()
                try:
                    server_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server_proc.kill()
        else:
            log(f"Server already exited (code={server_proc.returncode})")
    else:
        try:
            server_proc.wait()
        except KeyboardInterrupt:
            server_proc.terminate()

    server_log_fh.close()
    log("Launcher exiting")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {traceback.format_exc()}")
        show_error(f"Launcher crashed:\n\n{traceback.format_exc()[:500]}")
