use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<MobileRuntime<R>> {
    Ok(MobileRuntime(app.clone()))
}

/// Access to the mobile-runtime APIs.
pub struct MobileRuntime<R: Runtime>(AppHandle<R>);

impl<R: Runtime> MobileRuntime<R> {
    pub fn pick_epub(&self, _payload: PickEpubRequest) -> crate::Result<PickEpubResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn pick_folder(&self, _payload: PickFolderRequest) -> crate::Result<PickFolderResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn scan_document_tree(
        &self,
        _payload: ScanDocumentTreeRequest,
    ) -> crate::Result<ScanDocumentTreeResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn open_document_read(
        &self,
        _payload: OpenDocumentReadRequest,
    ) -> crate::Result<OpenDocumentReadResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn read_document_chunk(
        &self,
        _payload: ReadDocumentChunkRequest,
    ) -> crate::Result<ReadDocumentChunkResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn close_document_read(
        &self,
        _payload: CloseDocumentReadRequest,
    ) -> crate::Result<CloseDocumentReadResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn install_model_pack(
        &self,
        _payload: InstallModelPackRequest,
    ) -> crate::Result<InstallModelPackResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn synthesize(&self, _payload: SynthesizeRequest) -> crate::Result<SynthesizeResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn platform_status(&self) -> crate::Result<PlatformStatus> {
        Err(crate::Error::Unsupported)
    }

    pub fn set_system_bars(
        &self,
        _payload: SystemBarsRequest,
    ) -> crate::Result<SystemBarsResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn background_app(&self) -> crate::Result<BackgroundAppResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn perform_haptic(&self, _payload: HapticRequest) -> crate::Result<HapticResponse> {
        Err(crate::Error::Unsupported)
    }

    pub fn play_audio(&self, _payload: PlayAudioRequest) -> crate::Result<PlaybackStatus> {
        Err(crate::Error::Unsupported)
    }

    pub fn control_audio(&self, _payload: ControlAudioRequest) -> crate::Result<PlaybackStatus> {
        Err(crate::Error::Unsupported)
    }

    pub fn update_artwork(&self, _payload: UpdateArtworkRequest) -> crate::Result<PlaybackStatus> {
        Err(crate::Error::Unsupported)
    }

    pub fn prune_artwork_cache(
        &self,
        _payload: PruneArtworkCacheRequest,
    ) -> crate::Result<PlaybackStatus> {
        Err(crate::Error::Unsupported)
    }

    pub fn audio_status(&self) -> crate::Result<PlaybackStatus> {
        Err(crate::Error::Unsupported)
    }
}
