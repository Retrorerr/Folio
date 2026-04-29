#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{path::BaseDirectory, Manager};

const BACKEND_PORT: u16 = 8000;
const BACKEND_URL: &str = "http://127.0.0.1:8000";

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
        if TcpStream::connect(("127.0.0.1", BACKEND_PORT)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

fn shutdown_backend() {
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", BACKEND_PORT)) {
        let request = "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(request.as_bytes());
        let mut response = [0_u8; 256];
        let _ = stream.read(&mut response);
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

    let models_dir = resource_path(app, "resources/backend/models")
        .unwrap_or_else(|| app_data.join("models"));

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
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let child = command.spawn()?;
    Ok(Some(child))
}

fn main() {
    tauri::Builder::default()
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            if env::var("TAURI_ENV_DEBUG").is_err() {
                if let Some(child) = spawn_backend(&app.handle())? {
                    *app.state::<BackendProcess>().0.lock().unwrap() = Some(child);
                    wait_for_backend(Duration::from_secs(90));
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
