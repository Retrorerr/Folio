#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fmt::Write as _,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{path::BaseDirectory, Emitter, Manager};

const BACKEND_PORT: u16 = 8000;

struct BackendProcess(Mutex<Option<Child>>);
struct PendingOpenFile(Mutex<Option<String>>);
struct ApiToken(String);
struct AppShutdown(Mutex<bool>);

fn reap_backend_child(app: &tauri::AppHandle) {
    if let Some(mut child) = app.state::<BackendProcess>().0.lock().unwrap().take() {
        let _ = child.try_wait();
        let _ = wait_for_backend_down(Duration::from_secs(3));
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn backend_exe_resource_path() -> &'static str {
    if cfg!(windows) {
        "resources/bin/folio-backend/folio-backend.exe"
    } else {
        "resources/bin/folio-backend/folio-backend"
    }
}

fn resource_path(app: &tauri::AppHandle, path: &str) -> Option<PathBuf> {
    app.path().resolve(path, BaseDirectory::Resource).ok()
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

fn generate_api_token() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).expect("could not generate Folio API token");
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut token, "{byte:02x}");
    }
    token
}

fn shutdown_backend_with_token(api_token: &str) {
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", BACKEND_PORT)) {
        let timeout = Some(Duration::from_secs(1));
        let _ = stream.set_read_timeout(timeout);
        let _ = stream.set_write_timeout(timeout);
        let token_header = if api_token.is_empty() {
            String::new()
        } else {
            format!("X-Folio-Api-Token: {api_token}\r\n")
        };
        let request = format!(
            "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:8000\r\n{token_header}Content-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let _ = stream.write_all(request.as_bytes());
        let mut response = [0_u8; 256];
        let _ = stream.read(&mut response);
    }
}

fn shutdown_backend(api_token: &str) {
    shutdown_backend_with_token(api_token);
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

fn normalize_epub_arg(arg: &str, cwd: Option<&str>) -> Option<String> {
    let trimmed = arg.trim().trim_matches('"');
    if !trimmed.to_ascii_lowercase().ends_with(".epub") {
        return None;
    }

    let path = PathBuf::from(trimmed);
    let resolved = if path.is_absolute() {
        path
    } else if let Some(cwd) = cwd {
        PathBuf::from(cwd).join(path)
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(path)
    };

    Some(resolved.to_string_lossy().to_string())
}

fn first_epub_arg<I>(args: I, cwd: Option<&str>) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter()
        .find_map(|arg| normalize_epub_arg(&arg, cwd))
}

fn dispatch_open_file(app: &tauri::AppHandle, filepath: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("folio-open-file", filepath);
    } else if let Ok(mut pending) = app.state::<PendingOpenFile>().0.lock() {
        *pending = Some(filepath);
    }
}

fn spawn_backend(app: &tauri::AppHandle, api_token: &str) -> tauri::Result<Option<Child>> {
    let backend_path = match resource_path(app, backend_exe_resource_path()) {
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

    let models_dir = app_data.join("models");
    fs::create_dir_all(&models_dir)?;
    append_log(&log_path, &format!("[tauri] models_dir={}", describe_path(&models_dir)));
    append_log(&log_path, &format!("[tauri] quality_model={}", describe_path(&models_dir.join("kokoro-v1.0.onnx"))));
    append_log(&log_path, &format!("[tauri] fallback_model={}", describe_path(&models_dir.join("kokoro-v1.0.int8.onnx"))));
    append_log(&log_path, &format!("[tauri] voices_file={}", describe_path(&models_dir.join("voices-v1.0.bin"))));
    let supertonic_dir = models_dir.join("supertonic-3");
    append_log(&log_path, &format!("[tauri] supertonic_dir={}", describe_path(&supertonic_dir)));
    append_log(&log_path, &format!("[tauri] supertonic_vocoder={}", describe_path(&supertonic_dir.join("onnx").join("vocoder.onnx"))));
    append_log(&log_path, &format!("[tauri] supertonic_voice_styles={}", describe_path(&supertonic_dir.join("voice_styles"))));

    if is_backend_port_open() {
        append_log(
            &log_path,
            "[tauri] Existing backend detected on 127.0.0.1:8000; requesting shutdown before starting bundled backend",
        );
        shutdown_backend(api_token);
        let stopped = wait_for_backend_down(Duration::from_secs(4));
        append_log(&log_path, &format!("[tauri] Existing backend stopped={stopped}"));
        if !stopped {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "Port 8000 is still occupied after requesting backend shutdown",
            )
            .into());
        }
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
        .env("FOLIO_API_TOKEN", api_token)
        .env("FOLIO_ALLOWED_HOSTS", "127.0.0.1,localhost,::1")
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

#[tauri::command]
fn start_backend(app: tauri::AppHandle) -> Result<bool, String> {
    if cfg!(debug_assertions) {
        return Ok(is_backend_port_open());
    }

    {
        let backend_state = app.state::<BackendProcess>();
        let mut guard = backend_state.0.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_status)) => {
                    *guard = None;
                }
                Ok(None) => {
                    return Ok(true);
                }
                Err(error) => {
                    *guard = None;
                    return Err(format!("Backend process check failed: {error}"));
                }
            }
        }
    }

    let api_token = app.state::<ApiToken>().0.clone();
    match spawn_backend(&app, &api_token) {
        Ok(Some(child)) => {
            *app.state::<BackendProcess>().0.lock().unwrap() = Some(child);
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(error) => Err(format!("Backend startup failed: {error}")),
    }
}

#[tauri::command]
fn stop_backend(app: tauri::AppHandle) -> Result<bool, String> {
    let api_token = app.state::<ApiToken>().0.clone();
    shutdown_backend(&api_token);
    reap_backend_child(&app);
    Ok(!is_backend_port_open())
}

#[tauri::command]
fn get_api_token(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app.state::<ApiToken>().0.clone())
}

#[tauri::command]
fn take_pending_open_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let pending_state = app.state::<PendingOpenFile>();
    let mut pending = pending_state
        .0
        .lock()
        .map_err(|error| format!("Pending file lock failed: {error}"))?;
    Ok(pending.take())
}

#[tauri::command]
fn backend_log_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("backend.log")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn open_backend_log(app: tauri::AppHandle) -> Result<bool, String> {
    let log_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("backend.log");

    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create log directory: {error}"))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Could not open log file: {error}"))?;

    #[cfg(windows)]
    {
        Command::new("notepad.exe")
            .arg(&log_path)
            .spawn()
            .map_err(|error| format!("Could not launch log viewer: {error}"))?;
        return Ok(true);
    }

    #[allow(unreachable_code)]
    Ok(false)
}

#[tauri::command]
fn select_library_folder(initial_dir: Option<String>) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a Folio library folder'
$dialog.ShowNewFolderButton = $true
if ($env:FOLIO_INITIAL_LIBRARY_DIR -and (Test-Path -LiteralPath $env:FOLIO_INITIAL_LIBRARY_DIR -PathType Container)) {
  $dialog.SelectedPath = $env:FOLIO_INITIAL_LIBRARY_DIR
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
"#;
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-STA", "-Command", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(initial) = initial_dir {
            command.env("FOLIO_INITIAL_LIBRARY_DIR", initial);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        let output = command
            .output()
            .map_err(|error| format!("Could not open folder picker: {error}"))?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if error.is_empty() {
                "Folder picker did not complete.".to_string()
            } else {
                error
            });
        }
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(if selected.is_empty() { None } else { Some(selected) });
    }

    #[allow(unreachable_code)]
    Ok(None)
}

fn main() {
    let initial_open_file = first_epub_arg(std::env::args().skip(1), None);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(filepath) = first_epub_arg(args, Some(cwd.as_str())) {
                dispatch_open_file(app, filepath);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(BackendProcess(Mutex::new(None)))
        .manage(PendingOpenFile(Mutex::new(initial_open_file)))
        .manage(ApiToken(generate_api_token()))
        .manage(AppShutdown(Mutex::new(false)))
        .invoke_handler(tauri::generate_handler![
            start_backend,
            stop_backend,
            get_api_token,
            take_pending_open_file,
            backend_log_path,
            open_backend_log,
            select_library_folder
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let app_handle = window.app_handle().clone();
                    let should_start_shutdown = {
                        let shutdown_state = app_handle.state::<AppShutdown>();
                        let mut guard = shutdown_state.0.lock().unwrap();
                        if *guard {
                            false
                        } else {
                            *guard = true;
                            true
                        }
                    };
                    let _ = window.hide();

                    if should_start_shutdown {
                        thread::spawn(move || {
                            let api_token = app_handle.state::<ApiToken>().0.clone();
                            shutdown_backend(&api_token);
                            reap_backend_child(&app_handle);
                            app_handle.exit(0);
                        });
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}
