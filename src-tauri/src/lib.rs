#![cfg_attr(mobile, allow(dead_code, unused_imports))]

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_mobile_runtime::init())
        .run(tauri::generate_context!())
        .expect("error while running Folio Android application");
}
