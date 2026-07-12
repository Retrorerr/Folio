use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::MobileRuntime;
#[cfg(mobile)]
use mobile::MobileRuntime;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the mobile-runtime APIs.
pub trait MobileRuntimeExt<R: Runtime> {
    fn mobile_runtime(&self) -> &MobileRuntime<R>;
}

impl<R: Runtime, T: Manager<R>> crate::MobileRuntimeExt<R> for T {
    fn mobile_runtime(&self) -> &MobileRuntime<R> {
        self.state::<MobileRuntime<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mobile-runtime")
        .invoke_handler(tauri::generate_handler![
            commands::pick_epub,
            commands::pick_folder,
            commands::scan_document_tree,
            commands::open_document_read,
            commands::read_document_chunk,
            commands::close_document_read,
            commands::install_model_pack,
            commands::synthesize,
            commands::platform_status,
            commands::play_audio,
            commands::control_audio,
            commands::audio_status,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let mobile_runtime = mobile::init(app, api)?;
            #[cfg(desktop)]
            let mobile_runtime = desktop::init(app, api)?;
            app.manage(mobile_runtime);
            Ok(())
        })
        .build()
}
