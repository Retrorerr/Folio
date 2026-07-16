package com.folio.reader.mobile

/**
 * Metadata supplied for one narration chunk. Artwork bytes are intentionally
 * transient: PlaybackStateStore converts them into an app-private file before
 * the queue state is committed, so SharedPreferences never contains a large
 * base64 payload.
 */
data class PlaybackMetadata(
    val bookId: String = "",
    val format: String = "",
    val title: String = "Folio narration",
    val artist: String = "Folio",
    val album: String = "Folio",
    val chapterTitle: String = "",
    val chapterIndex: Int = 0,
    val chapterCount: Int = 0,
    val sentenceIndex: Int = 0,
    val sentenceCount: Int = 0,
    val chunkProgress: Float = 0f,
    val locationUri: String = "",
    val description: String = "",
    val artworkBase64: String? = null,
    val artworkMimeType: String? = null,
)
