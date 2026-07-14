package com.folio.reader.mobile

/**
 * The Android catalog is deliberately pinned to the same asset revisions as
 * OnDeviceModelManager. Downloads are individual files so a failed transfer
 * can never publish a partially assembled model directory.
 */
internal data class AndroidModelDownloadAsset(val path: String, val url: String)

internal object AndroidModelCatalog {
    private const val KOKORO_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
    private const val SUPERTONIC_BASE = "https://huggingface.co/Supertone/supertonic-3/resolve/724fb5abbf5502583fb520898d45929e62f02c0b/"

    private val KOKORO = listOf(
        AndroidModelDownloadAsset("kokoro-v1.0.onnx", "${KOKORO_BASE}kokoro-v1.0.onnx"),
        AndroidModelDownloadAsset("voices-v1.0.bin", "${KOKORO_BASE}voices-v1.0.bin"),
    )

    private val SUPERTONIC = listOf(
        "onnx/duration_predictor.onnx",
        "onnx/text_encoder.onnx",
        "onnx/vector_estimator.onnx",
        "onnx/vocoder.onnx",
        "onnx/tts.json",
        "onnx/unicode_indexer.json",
        "voice_styles/F1.json",
        "voice_styles/F2.json",
        "voice_styles/F3.json",
        "voice_styles/F4.json",
        "voice_styles/F5.json",
        "voice_styles/M1.json",
        "voice_styles/M2.json",
        "voice_styles/M3.json",
        "voice_styles/M4.json",
        "voice_styles/M5.json",
    ).map { path -> AndroidModelDownloadAsset(path, "$SUPERTONIC_BASE$path") }

    fun assets(engine: String): List<AndroidModelDownloadAsset> = when (engine) {
        "kokoro" -> KOKORO
        "supertonic" -> SUPERTONIC
        else -> throw IllegalArgumentException("Unknown local TTS engine: $engine")
    }
}
