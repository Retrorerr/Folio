use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickEpubRequest {
    pub initial_uri: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickEpubResponse {
    pub uri: Option<String>,
    pub display_name: Option<String>,
    pub persisted: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFolderRequest {
    pub initial_uri: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFolderResponse {
    pub uri: Option<String>,
    pub display_name: Option<String>,
    pub persisted: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDocumentTreeRequest {
    pub tree_uri: String,
    pub recursive: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTreeEntry {
    pub uri: String,
    pub display_name: String,
    pub mime_type: String,
    pub size: i64,
    pub last_modified: u64,
    pub kind: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFailure {
    pub filepath: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDocumentTreeResponse {
    pub tree_uri: String,
    pub display_name: String,
    pub recursive: bool,
    pub permission_granted: bool,
    pub persisted_permission: bool,
    pub visited: u64,
    pub truncated: bool,
    pub documents: Vec<DocumentTreeEntry>,
    pub failures: Vec<DocumentFailure>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentReadRequest {
    pub uri: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentReadResponse {
    pub handle: String,
    pub size: i64,
    pub display_name: String,
    pub mime_type: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocumentChunkRequest {
    pub handle: String,
    pub max_bytes: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocumentChunkResponse {
    pub data_base64: String,
    pub bytes_read: u64,
    pub eof: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseDocumentReadRequest {
    pub handle: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseDocumentReadResponse {
    pub closed: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallModelPackRequest {
    pub engine: String,
    pub download: Option<bool>,
    pub cancel: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallModelPackResponse {
    pub engine: String,
    pub installed: bool,
    pub path: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeRequest {
    pub text: String,
    pub voice: Option<String>,
    pub speed: Option<f32>,
    pub engine: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeResponse {
    pub audio_base64: String,
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub engine: String,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformStatus {
    pub platform: String,
    pub native_tts_available: bool,
    pub native_tts_error: Option<String>,
    pub native_runtime_version: Option<String>,
    pub native_runtime_providers: Vec<String>,
    pub fallback_phonemizer_ready: Option<bool>,
    pub fallback_phonemizer_error: Option<String>,
    pub model_root: String,
    pub model_assets: serde_json::Value,
    pub window_insets: serde_json::Value,
    pub density: Option<f32>,
    pub refresh_rate: Option<f32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemBarsRequest {
    pub theme: Option<String>,
    pub dark_background: Option<bool>,
    pub background_color: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemBarsResponse {
    pub dark_background: bool,
    pub background_color: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundAppResponse {
    pub backgrounded: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HapticRequest {
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HapticResponse {
    pub performed: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayAudioRequest {
    pub audio_base64: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub book_id: Option<String>,
    pub format: Option<String>,
    pub chapter_title: Option<String>,
    pub chapter_index: Option<u64>,
    pub chapter_count: Option<u64>,
    pub sentence_index: Option<u64>,
    pub sentence_count: Option<u64>,
    pub chunk_progress: Option<f64>,
    pub location_uri: Option<String>,
    pub description: Option<String>,
    pub artwork_base64: Option<String>,
    pub artwork_mime_type: Option<String>,
    pub artwork_revision: Option<String>,
    pub position_ms: Option<u64>,
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArtworkRequest {
    pub book_id: String,
    pub artwork_base64: Option<String>,
    pub artwork_mime_type: Option<String>,
    pub artwork_revision: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneArtworkCacheRequest {
    pub book_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlAudioRequest {
    pub action: String,
    pub position_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub state: String,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub session_id: u64,
    pub enqueued_session_id: u64,
    pub queue_session_ids: Vec<u64>,
    #[serde(default)]
    pub queue_locations: Vec<PlaybackQueueLocation>,
    pub current_index: u64,
    pub queue_size: u64,
    pub error: Option<String>,
    pub book_id: Option<String>,
    pub format: Option<String>,
    pub chapter_title: Option<String>,
    pub chapter_index: Option<u64>,
    pub chapter_count: Option<u64>,
    pub sentence_index: Option<u64>,
    pub sentence_count: Option<u64>,
    pub chunk_progress: Option<f64>,
    pub location_uri: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackQueueLocation {
    pub session_id: u64,
    pub book_id: String,
    pub chapter_index: u64,
    pub sentence_index: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playback_queue_fields_survive_the_rust_mobile_boundary() {
        let request: PlayAudioRequest = serde_json::from_value(serde_json::json!({
          "audioBase64": "UklGRg==",
          "title": "Chapter one",
          "bookId": "book-1",
          "format": "epub",
          "chapterTitle": "Chapter one",
          "chapterIndex": 2,
          "chapterCount": 8,
          "sentenceIndex": 4,
          "sentenceCount": 12,
          "chunkProgress": 0.25,
          "locationUri": "android://book-1/chapter-3",
          "description": "Chapter one of eight",
          "artworkBase64": "aGVsbG8=",
          "artworkMimeType": "image/jpeg",
          "positionMs": 120,
          "mode": "append"
        }))
        .unwrap();
        assert_eq!(request.mode.as_deref(), Some("append"));
        assert_eq!(request.book_id.as_deref(), Some("book-1"));
        assert_eq!(request.chapter_index, Some(2));
        assert_eq!(request.chunk_progress, Some(0.25));
        assert_eq!(request.artwork_mime_type.as_deref(), Some("image/jpeg"));

        let status: PlaybackStatus = serde_json::from_value(serde_json::json!({
          "state": "playing",
          "positionMs": 25,
          "durationMs": 400,
          "sessionId": 7,
          "enqueuedSessionId": 9,
          "queueSessionIds": [7, 8, 9],
          "currentIndex": 0,
          "queueSize": 3,
          "error": null,
          "bookId": "book-1",
          "format": "epub",
          "chapterTitle": "Chapter one",
          "chapterIndex": 2,
          "chapterCount": 8,
          "sentenceIndex": 4,
          "sentenceCount": 12,
          "chunkProgress": 0.25,
          "locationUri": "android://book-1/chapter-3"
        }))
        .unwrap();
        assert_eq!(status.enqueued_session_id, 9);
        assert_eq!(status.queue_session_ids, vec![7, 8, 9]);
        assert!(status.queue_locations.is_empty());
        assert_eq!(status.queue_size, 3);
        assert_eq!(status.book_id.as_deref(), Some("book-1"));
        assert_eq!(status.chapter_title.as_deref(), Some("Chapter one"));
        assert_eq!(status.location_uri.as_deref(), Some("android://book-1/chapter-3"));
    }

    #[test]
    fn playback_queue_locations_use_camel_case_and_legacy_status_defaults_empty() {
        let status: PlaybackStatus = serde_json::from_value(serde_json::json!({
          "state": "playing", "positionMs": 25, "durationMs": 400,
          "sessionId": 7, "enqueuedSessionId": 8, "queueSessionIds": [7, 8],
          "queueLocations": [
            { "sessionId": 7, "bookId": "book-1", "chapterIndex": 2, "sentenceIndex": 4 },
            { "sessionId": 8, "bookId": "book-1", "chapterIndex": 3, "sentenceIndex": 0 }
          ],
          "currentIndex": 0, "queueSize": 2, "error": null
        })).unwrap();
        assert_eq!(status.queue_locations[1], PlaybackQueueLocation {
            session_id: 8,
            book_id: "book-1".into(),
            chapter_index: 3,
            sentence_index: 0,
        });
    }

    #[test]
    fn saf_payloads_use_the_kotlin_camel_case_contract() {
        let scan = ScanDocumentTreeRequest {
            tree_uri: "content://provider/tree/library".into(),
            recursive: Some(true),
        };
        let value = serde_json::to_value(scan).unwrap();
        assert_eq!(value["treeUri"], "content://provider/tree/library");
        assert_eq!(value["recursive"], true);

        let chunk: ReadDocumentChunkRequest = serde_json::from_value(serde_json::json!({
          "handle": "reader-1",
          "maxBytes": 262144
        }))
        .unwrap();
        assert_eq!(chunk.max_bytes, Some(262_144));
    }
}
