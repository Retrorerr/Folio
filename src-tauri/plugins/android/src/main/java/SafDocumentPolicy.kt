package com.folio.reader.mobile

internal enum class SafBookKind(val maxBytes: Long) {
    // The WebView must briefly hold provider chunks, one contiguous buffer,
    // parsed content, and the IndexedDB copy. Keep these well below model-pack
    // limits so a valid-but-large book fails cleanly instead of exhausting the
    // Android app heap during import.
    EPUB(64L * 1024L * 1024L),
    PDF(96L * 1024L * 1024L),
}

/** Pure policy shared by the untrusted-provider scanner and unit tests. */
internal object SafDocumentPolicy {
    const val MAX_DEPTH = 16
    const val MAX_VISITED_DOCUMENTS = 10_000
    const val MAX_BOOK_DOCUMENTS = 200
    const val MAX_UNKNOWN_SIZE_DOCUMENTS = 8
    const val MAX_DECLARED_BOOK_BYTES = 1024L * 1024L * 1024L
    const val MAX_FAILURES = 50
    const val MAX_URI_CHARS = 8_192
    const val MAX_NAME_CHARS = 240
    const val MAX_READ_CHUNK_BYTES = 256 * 1024
    const val MAX_ACTIVE_READS = 2
    const val MAX_SYNTH_TEXT_CHARS = 4_096

    fun classify(displayName: String?, mimeType: String?): SafBookKind? {
        val name = displayName.orEmpty().trim().lowercase()
        val mime = mimeType.orEmpty().substringBefore(';').trim().lowercase()
        return when {
            mime == "application/pdf" || name.endsWith(".pdf") -> SafBookKind.PDF
            mime == "application/epub+zip" || name.endsWith(".epub") -> SafBookKind.EPUB
            else -> null
        }
    }

    fun safeDisplayName(value: String?): String {
        val cleaned = value.orEmpty()
            .replace(Regex("[\\u0000-\\u001f\\u007f]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(MAX_NAME_CHARS)
        return cleaned.ifBlank { "book" }
    }
}
