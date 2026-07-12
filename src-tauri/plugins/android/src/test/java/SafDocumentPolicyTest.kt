package com.folio.reader.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SafDocumentPolicyTest {
    @Test
    fun onlyEpubAndPdfDocumentsAreClassified() {
        assertEquals(SafBookKind.PDF, SafDocumentPolicy.classify("report.bin", "application/pdf"))
        assertEquals(SafBookKind.EPUB, SafDocumentPolicy.classify("NOVEL.EPUB", "application/octet-stream"))
        assertNull(SafDocumentPolicy.classify("archive.zip", "application/zip"))
    }

    @Test
    fun providerNamesAreBoundedAndControlCharactersRemoved() {
        val cleaned = SafDocumentPolicy.safeDisplayName("  unsafe\u0000\n" + "x".repeat(400))
        assertTrue(cleaned.length <= SafDocumentPolicy.MAX_NAME_CHARS)
        assertTrue(cleaned.none { it.code < 32 })
    }

    @Test
    fun bridgeInputsAndChunksHaveStrictBounds() {
        assertTrue(SafDocumentPolicy.MAX_SYNTH_TEXT_CHARS in 1..4_096)
        assertTrue(SafDocumentPolicy.MAX_READ_CHUNK_BYTES <= 256 * 1024)
    }
}
