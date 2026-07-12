package com.folio.reader.mobile

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.charset.StandardCharsets

class NativeTtsPolicyTest {
    @Test
    fun nestedSupertonicTensorIsFlattenedInRowMajorOrder() {
        val tensor = SupertonicTensorParser.fromNested(
            longArrayOf(1, 2, 2),
            listOf(listOf(listOf(1.0, 2.0), listOf(3.0, 4.0))),
        )

        assertArrayEquals(floatArrayOf(1f, 2f, 3f, 4f), tensor.data, 0f)
        assertTrue(tensor.shape.contentEquals(longArrayOf(1, 2, 2)))
    }

    @Test
    fun malformedSupertonicTensorsAreRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            SupertonicTensorParser.fromNested(
                longArrayOf(1, 2, 2),
                listOf(listOf(listOf(1.0), listOf(2.0, 3.0))),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            SupertonicTensorParser.fromNested(
                longArrayOf(1, 1, 1),
                listOf(listOf(listOf(Float.NaN))),
            )
        }
    }

    @Test
    fun kokoroVoiceDialectMatchesDesktopPolicy() {
        assertEquals("en-gb", KokoroSupport.languageForVoice("bf_emma"))
        assertEquals("en-gb", KokoroSupport.languageForVoice("bm_george"))
        assertEquals("en-us", KokoroSupport.languageForVoice("af_heart"))
        assertEquals("en-us", KokoroSupport.languageForVoice("am_adam"))
    }

    @Test
    fun kokoroSilenceTrimKeepsSpeechAndDefinesAllSilenceBehavior() {
        val samples = FloatArray(12_288)
        for (index in 4_096 until 8_192) samples[index] = 0.5f

        val trimmed = KokoroSupport.trimSilence(samples)

        assertTrue(trimmed.size < samples.size)
        assertTrue(trimmed.any { it == 0.5f })
        val silence = FloatArray(4_096)
        assertSame(silence, KokoroSupport.trimSilence(silence))
    }

    @Test
    fun kokoroNpyLayoutIsValidated() {
        val header = "{'descr': '<f4', 'fortran_order': False, 'shape': (510, 1, 256), }\n"
            .toByteArray(StandardCharsets.US_ASCII)
        val payloadSize = 510 * 256 * 4
        val bytes = ByteArray(10 + header.size + payloadSize)
        byteArrayOf(0x93.toByte(), 'N'.code.toByte(), 'U'.code.toByte(), 'M'.code.toByte(), 'P'.code.toByte(), 'Y'.code.toByte())
            .copyInto(bytes)
        bytes[6] = 1
        bytes[7] = 0
        bytes[8] = header.size.toByte()
        bytes[9] = (header.size shr 8).toByte()
        header.copyInto(bytes, 10)

        val layout = KokoroModelAssets.parseNpy(bytes)

        assertEquals(10 + header.size, layout.dataOffset)
        assertEquals(510, layout.rows)
        assertEquals(256, layout.rowWidth)
        assertThrows(IllegalStateException::class.java) {
            KokoroModelAssets.parseNpy(bytes.copyOf(bytes.size - 1))
        }
    }
}
