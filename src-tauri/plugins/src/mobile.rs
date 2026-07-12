use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mobile_runtime);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<MobileRuntime<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.folio.reader.mobile", "FolioMobilePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mobile_runtime)?;
    Ok(MobileRuntime(handle))
}

/// Access to the mobile-runtime APIs.
pub struct MobileRuntime<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> MobileRuntime<R> {
    pub fn pick_epub(&self, payload: PickEpubRequest) -> crate::Result<PickEpubResponse> {
        self.0
            .run_mobile_plugin("pickEpub", payload)
            .map_err(Into::into)
    }

    pub fn pick_folder(&self, payload: PickFolderRequest) -> crate::Result<PickFolderResponse> {
        self.0
            .run_mobile_plugin("pickFolder", payload)
            .map_err(Into::into)
    }

    pub fn scan_document_tree(
        &self,
        payload: ScanDocumentTreeRequest,
    ) -> crate::Result<ScanDocumentTreeResponse> {
        self.0
            .run_mobile_plugin("scanDocumentTree", payload)
            .map_err(Into::into)
    }

    pub fn open_document_read(
        &self,
        payload: OpenDocumentReadRequest,
    ) -> crate::Result<OpenDocumentReadResponse> {
        self.0
            .run_mobile_plugin("openDocumentRead", payload)
            .map_err(Into::into)
    }

    pub fn read_document_chunk(
        &self,
        payload: ReadDocumentChunkRequest,
    ) -> crate::Result<ReadDocumentChunkResponse> {
        self.0
            .run_mobile_plugin("readDocumentChunk", payload)
            .map_err(Into::into)
    }

    pub fn close_document_read(
        &self,
        payload: CloseDocumentReadRequest,
    ) -> crate::Result<CloseDocumentReadResponse> {
        self.0
            .run_mobile_plugin("closeDocumentRead", payload)
            .map_err(Into::into)
    }

    pub fn install_model_pack(
        &self,
        payload: InstallModelPackRequest,
    ) -> crate::Result<InstallModelPackResponse> {
        self.0
            .run_mobile_plugin("installModelPack", payload)
            .map_err(Into::into)
    }

    pub fn synthesize(&self, payload: SynthesizeRequest) -> crate::Result<SynthesizeResponse> {
        self.0
            .run_mobile_plugin("synthesize", payload)
            .map_err(Into::into)
    }

    pub fn platform_status(&self) -> crate::Result<PlatformStatus> {
        self.0
            .run_mobile_plugin("platformStatus", serde_json::json!({}))
            .map_err(Into::into)
    }

    pub fn play_audio(&self, payload: PlayAudioRequest) -> crate::Result<PlaybackStatus> {
        self.0
            .run_mobile_plugin("playAudio", payload)
            .map_err(Into::into)
    }

    pub fn control_audio(&self, payload: ControlAudioRequest) -> crate::Result<PlaybackStatus> {
        self.0
            .run_mobile_plugin("controlAudio", payload)
            .map_err(Into::into)
    }

    pub fn audio_status(&self) -> crate::Result<PlaybackStatus> {
        self.0
            .run_mobile_plugin("audioStatus", serde_json::json!({}))
            .map_err(Into::into)
    }
}
