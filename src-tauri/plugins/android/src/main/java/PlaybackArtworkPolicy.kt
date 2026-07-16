package com.folio.reader.mobile

import java.security.MessageDigest

internal object PlaybackArtworkPolicy {
    const val MAX_INPUT_BYTES = 8L * 1024L * 1024L
    const val MAX_ENCODED_CHARS = 12 * 1024 * 1024
    const val MAX_DECODED_PIXELS = 40_000_000L
    const val MAX_DIMENSION = 16_384
    const val MAX_OUTPUT_DIMENSION = 1_024
    const val MAX_OUTPUT_BYTES = 4L * 1024L * 1024L

    private val supportedMimeTypes = setOf(
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
    )

    fun normalizeMimeType(value: String?): String? {
        val normalized = value.orEmpty().trim().lowercase()
        return when {
            normalized == "image/jpg" -> "image/jpeg"
            normalized in supportedMimeTypes -> normalized
            else -> null
        }
    }

    fun approximateDecodedBytes(encoded: String): Long {
        val value = encoded.trim()
        if (value.isEmpty()) return 0L
        val padding = value.takeLastWhile { it == '=' }.length
        return (value.length.toLong() * 3L / 4L - padding).coerceAtLeast(0L)
    }

    fun artworkKey(bookId: String): String {
        val value = bookId.trim().ifEmpty { "unknown-book" }
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { byte -> "%02x".format(byte) }
    }
}
