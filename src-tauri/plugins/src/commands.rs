use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::MobileRuntimeExt;
use crate::Result;

#[command]
pub(crate) async fn pick_epub<R: Runtime>(
    app: AppHandle<R>,
    payload: PickEpubRequest,
) -> Result<PickEpubResponse> {
    app.mobile_runtime().pick_epub(payload)
}

#[command]
pub(crate) async fn pick_folder<R: Runtime>(
    app: AppHandle<R>,
    payload: PickFolderRequest,
) -> Result<PickFolderResponse> {
    app.mobile_runtime().pick_folder(payload)
}

#[command]
pub(crate) async fn scan_document_tree<R: Runtime>(
    app: AppHandle<R>,
    payload: ScanDocumentTreeRequest,
) -> Result<ScanDocumentTreeResponse> {
    app.mobile_runtime().scan_document_tree(payload)
}

#[command]
pub(crate) async fn open_document_read<R: Runtime>(
    app: AppHandle<R>,
    payload: OpenDocumentReadRequest,
) -> Result<OpenDocumentReadResponse> {
    app.mobile_runtime().open_document_read(payload)
}

#[command]
pub(crate) async fn read_document_chunk<R: Runtime>(
    app: AppHandle<R>,
    payload: ReadDocumentChunkRequest,
) -> Result<ReadDocumentChunkResponse> {
    app.mobile_runtime().read_document_chunk(payload)
}

#[command]
pub(crate) async fn close_document_read<R: Runtime>(
    app: AppHandle<R>,
    payload: CloseDocumentReadRequest,
) -> Result<CloseDocumentReadResponse> {
    app.mobile_runtime().close_document_read(payload)
}

#[command]
pub(crate) async fn install_model_pack<R: Runtime>(
    app: AppHandle<R>,
    payload: InstallModelPackRequest,
) -> Result<InstallModelPackResponse> {
    app.mobile_runtime().install_model_pack(payload)
}

#[command]
pub(crate) async fn synthesize<R: Runtime>(
    app: AppHandle<R>,
    payload: SynthesizeRequest,
) -> Result<SynthesizeResponse> {
    app.mobile_runtime().synthesize(payload)
}

#[command]
pub(crate) async fn platform_status<R: Runtime>(app: AppHandle<R>) -> Result<PlatformStatus> {
    app.mobile_runtime().platform_status()
}

#[command]
pub(crate) async fn set_system_bars<R: Runtime>(
    app: AppHandle<R>,
    payload: SystemBarsRequest,
) -> Result<SystemBarsResponse> {
    app.mobile_runtime().set_system_bars(payload)
}

#[command]
pub(crate) async fn perform_haptic<R: Runtime>(
    app: AppHandle<R>,
    payload: HapticRequest,
) -> Result<HapticResponse> {
    app.mobile_runtime().perform_haptic(payload)
}

#[command]
pub(crate) async fn play_audio<R: Runtime>(
    app: AppHandle<R>,
    payload: PlayAudioRequest,
) -> Result<PlaybackStatus> {
    app.mobile_runtime().play_audio(payload)
}

#[command]
pub(crate) async fn control_audio<R: Runtime>(
    app: AppHandle<R>,
    payload: ControlAudioRequest,
) -> Result<PlaybackStatus> {
    app.mobile_runtime().control_audio(payload)
}

#[command]
pub(crate) async fn audio_status<R: Runtime>(app: AppHandle<R>) -> Result<PlaybackStatus> {
    app.mobile_runtime().audio_status()
}
