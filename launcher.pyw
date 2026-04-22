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
LOG_FILE = os.path.join(APP_DIR, "launcher.log")
PORT = 8000
URL = f"http://127.0.0.1:{PORT}"


def log(msg):
    with open(LOG_FILE, "a") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")


# Add NVIDIA CUDA DLLs to PATH for GPU acceleration
_site_packages = os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "Python",
                              f"Python{sys.version_info.major}{sys.version_info.minor}", "site-packages")
for _nvidia_bin in glob.glob(os.path.join(_site_packages, "nvidia", "*", "bin")):
    if _nvidia_bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = _nvidia_bin + os.pathsep + os.environ.get("PATH", "")

# Add user Scripts to PATH so uvicorn can be found
_scripts = os.path.join(_site_packages, "..", "Scripts")
if os.path.exists(_scripts):
    os.environ["PATH"] = os.path.abspath(_scripts) + os.pathsep + os.environ.get("PATH", "")


def find_python():
    """Find python.exe (not pythonw.exe) for running the server."""
    exe_dir = os.path.dirname(sys.executable)
    p = os.path.join(exe_dir, "python.exe")
    if os.path.exists(p):
        return p
    import shutil
    return shutil.which("python") or sys.executable


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
    with open(LOG_FILE, "w") as f:
        f.write(f"Kokoro Reader Launcher - {time.strftime('%Y-%m-%d %H:%M:%S')}\n")

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    python_exe = find_python()
    log(f"Python: {python_exe}")
    log(f"Backend: {BACKEND_DIR}")
    log(f"CWD: {os.getcwd()}")

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
        # Give the beforeunload beacon a moment to save state
        time.sleep(1)
        if server_proc.poll() is None:
            # Server still running (beacon may not have fired), terminate it
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
