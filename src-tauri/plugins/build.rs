const COMMANDS: &[&str] = &[
    "pick_epub",
    "pick_folder",
    "scan_document_tree",
    "open_document_read",
    "read_document_chunk",
    "close_document_read",
    "install_model_pack",
    "synthesize",
    "platform_status",
    "set_system_bars",
    "background_app",
    "perform_haptic",
    "play_audio",
    "control_audio",
    "update_artwork",
    "prune_artwork_cache",
    "audio_status",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
