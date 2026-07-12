# Tauri Plugin mobile-runtime

This private Tauri plugin is Folio's typed Android boundary. The React app
invokes snake-case Rust commands; Rust serializes camel-case payloads to the
Kotlin `FolioMobilePlugin` methods.

The boundary covers:

- single-book and persisted document-tree picking;
- bounded, session-based SAF scans and document reads;
- integrity-checked model-pack import and local ONNX synthesis;
- durable Media3 playback with explicit queue `replace`/`append` modes and
  session IDs returned to the frontend.

Keep `build.rs`, `permissions/default.toml`, `src/commands.rs`, `src/models.rs`,
and the platform implementations in sync whenever a Kotlin command or response
field is added. Rust model tests guard the SAF camel-case contract and the
playback queue fields that are easy to lose at this boundary.
