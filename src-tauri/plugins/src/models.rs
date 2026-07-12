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
    pub model_root: String,
    pub model_assets: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayAudioRequest {
    pub audio_base64: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub position_ms: Option<u64>,
    pub mode: Option<String>,
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
    pub current_index: u64,
    pub queue_size: u64,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playback_queue_fields_survive_the_rust_mobile_boundary() {
        let request: PlayAudioRequest = serde_json::from_value(serde_json::json!({
          "audioBase64": "UklGRg==",
          "title": "Chapter one",
          "positionMs": 120,
          "mode": "append"
        }))
        .unwrap();
        assert_eq!(request.mode.as_deref(), Some("append"));

        let status: PlaybackStatus = serde_json::from_value(serde_json::json!({
          "state": "playing",
          "positionMs": 25,
          "durationMs": 400,
          "sessionId": 7,
          "enqueuedSessionId": 9,
          "queueSessionIds": [7, 8, 9],
          "currentIndex": 0,
          "queueSize": 3,
          "error": null
        }))
        .unwrap();
        assert_eq!(status.enqueued_session_id, 9);
        assert_eq!(status.queue_session_ids, vec![7, 8, 9]);
        assert_eq!(status.queue_size, 3);
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
