package com.folio.reader.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackArtworkPolicyTest {
    @Test
    fun normalizesOnlySupportedArtworkTypes() {
        assertEquals("image/jpeg", PlaybackArtworkPolicy.normalizeMimeType(" IMAGE/JPG "))
        assertEquals("image/png", PlaybackArtworkPolicy.normalizeMimeType("image/png"))
        assertEquals("image/svg+xml", PlaybackArtworkPolicy.normalizeMimeType("image/svg+xml"))
        assertEquals(null, PlaybackArtworkPolicy.normalizeMimeType("image/bmp"))
    }

    @Test
    fun boundsEncodedArtworkBeforeDecoding() {
        assertEquals(0L, PlaybackArtworkPolicy.approximateDecodedBytes(""))
        assertEquals(3L, PlaybackArtworkPolicy.approximateDecodedBytes("YWJj"))
        assertTrue(PlaybackArtworkPolicy.approximateDecodedBytes("A".repeat(12 * 1024 * 1024)) > PlaybackArtworkPolicy.MAX_INPUT_BYTES)
    }

    @Test
    fun artworkKeysAreStableAndBookScoped() {
        val first = PlaybackArtworkPolicy.artworkKey("book-a")
        assertEquals(first, PlaybackArtworkPolicy.artworkKey(" book-a "))
        assertNotEquals(first, PlaybackArtworkPolicy.artworkKey("book-b"))
        assertEquals(64, first.length)
    }
}
