#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{path::BaseDirectory, Manager};

const BACKEND_PORT: u16 = 8000;

struct BackendProcess(Mutex<Option<Child>>);

fn backend_exe_name() -> &'static str {
    if cfg!(windows) {
        "folio-backend.exe"
    } else {
        "folio-backend"
    }
}

fn resource_path(app: &tauri::AppHandle, path: &str) -> Option<PathBuf> {
    app.path().resolve(path, BaseDirectory::Resource).ok()
}

fn wait_for_backend(timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if is_backend_port_open() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

fn is_backend_port_open() -> bool {
    TcpStream::connect(("127.0.0.1", BACKEND_PORT)).is_ok()
}

fn wait_for_backend_down(timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if !is_backend_port_open() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

fn wait_for_backend_logged(timeout: Duration, log_path: &Path) -> bool {
    append_log(
        log_path,
        &format!(
            "[tauri] Waiting up to {}ms for backend on 127.0.0.1:{}",
            timeout.as_millis(),
            BACKEND_PORT
        ),
    );
    let started = Instant::now();
    let ready = wait_for_backend(timeout);
    append_log(
        log_path,
        &format!(
            "[tauri] Backend wait finished ready={} elapsed_ms={}",
            ready,
            started.elapsed().as_millis()
        ),
    );
    ready
}

fn shutdown_backend() {
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", BACKEND_PORT)) {
        let request = "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(request.as_bytes());
        let mut response = [0_u8; 256];
        let _ = stream.read(&mut response);
    }
}

fn append_log(log_path: &Path, message: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{message}");
    }
}

fn describe_path(path: &Path) -> String {
    match fs::metadata(path) {
        Ok(metadata) => format!(
            "{} exists=true is_file={} is_dir={} bytes={}",
            path.display(),
            metadata.is_file(),
            metadata.is_dir(),
            metadata.len()
        ),
        Err(error) => format!("{} exists=false error={}", path.display(), error),
    }
}

fn spawn_backend(app: &tauri::AppHandle) -> tauri::Result<Option<Child>> {
    let backend_path = match resource_path(app, &format!("resources/bin/{}", backend_exe_name())) {
        Some(path) if path.exists() => path,
        _ => return Ok(None),
    };

    let app_data = app.path().app_data_dir()?;
    let data_dir = app_data.join("data");
    let upload_dir = app_data.join("uploads");
    let audio_cache_dir = app_data.join("audio-cache");
    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(&upload_dir)?;
    fs::create_dir_all(&audio_cache_dir)?;
    let log_path = app_data.join("backend.log");
    append_log(&log_path, "");
    append_log(&log_path, "[tauri] ==================== Folio launch ====================");
    append_log(&log_path, "[tauri] Starting Folio backend sidecar");
    append_log(&log_path, &format!("[tauri] app_data={}", app_data.display()));
    append_log(&log_path, &format!("[tauri] data_dir={}", data_dir.display()));
    append_log(&log_path, &format!("[tauri] upload_dir={}", upload_dir.display()));
    append_log(&log_path, &format!("[tauri] audio_cache_dir={}", audio_cache_dir.display()));
    append_log(&log_path, &format!("[tauri] backend_exe={}", describe_path(&backend_path)));

    let models_dir = resource_path(app, "resources/backend/models")
        .unwrap_or_else(|| app_data.join("models"));
    append_log(&log_path, &format!("[tauri] models_dir={}", describe_path(&models_dir)));
    append_log(&log_path, &format!("[tauri] quality_model={}", describe_path(&models_dir.join("kokoro-v1.0.onnx"))));
    append_log(&log_path, &format!("[tauri] fallback_model={}", describe_path(&models_dir.join("kokoro-v1.0.int8.onnx"))));
    append_log(&log_path, &format!("[tauri] voices_file={}", describe_path(&models_dir.join("voices-v1.0.bin"))));

    if is_backend_port_open() {
        append_log(
            &log_path,
            "[tauri] Existing backend detected on 127.0.0.1:8000; requesting shutdown before starting bundled backend",
        );
        shutdown_backend();
        let stopped = wait_for_backend_down(Duration::from_secs(4));
        append_log(&log_path, &format!("[tauri] Existing backend stopped={stopped}"));
    }

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let stderr = stdout.try_clone()?;

    let mut command = Command::new(backend_path);
    command
        .env("PYTHONUNBUFFERED", "1")
        .env("KOKORO_READER_DATA_DIR", data_dir)
        .env("KOKORO_READER_UPLOAD_DIR", upload_dir)
        .env("KOKORO_READER_AUDIO_CACHE_DIR", audio_cache_dir)
        .env("KOKORO_READER_MODELS_DIR", models_dir)
        .env(
            "KOKORO_CORS_ORIGINS",
            "tauri://localhost,http://tauri.localhost,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8000,http://localhost:8000",
        )
        .env("FOLIO_BACKEND_HOST", "127.0.0.1")
        .env("FOLIO_BACKEND_PORT", BACKEND_PORT.to_string())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let child = command.spawn()?;
    append_log(&log_path, &format!("[tauri] Backend child spawned pid={}", child.id()));
    Ok(Some(child))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            if !cfg!(debug_assertions) {
                if let Some(child) = spawn_backend(&app.handle())? {
                    let log_path = app.path().app_data_dir()?.join("backend.log");
                    wait_for_backend_logged(Duration::from_secs(2), &log_path);
                    *app.state::<BackendProcess>().0.lock().unwrap() = Some(child);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    shutdown_backend();
                    if let Some(mut child) = window
                        .state::<BackendProcess>()
                        .0
                        .lock()
                        .unwrap()
                        .take()
                    {
                        let _ = child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}
