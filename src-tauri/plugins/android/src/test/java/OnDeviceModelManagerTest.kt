package com.folio.reader.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OnDeviceModelManagerTest {
    private fun fingerprint(length: Long = 10L) = ModelValidationFingerprint(
        rootModifiedAt = 15L,
        manifest = ModelFileStamp(length, 20L),
        files = mapOf("model.onnx" to ModelFileStamp(length * 2, 30L)),
    )

    @Test
    fun validationCacheRequiresTheSameGenerationAndFileFingerprint() {
        val cache = GenerationValidationCache()
        val current = fingerprint()

        assertFalse(cache.isValid(4L, current))
        cache.markValid(4L, current)
        assertTrue(cache.isValid(4L, current))
        assertFalse(cache.isValid(5L, current))
        assertFalse(cache.isValid(4L, fingerprint(length = 11L)))
    }

    @Test
    fun replacementAndUnloadCanInvalidateAPreviouslyValidatedGeneration() {
        val cache = GenerationValidationCache()
        cache.markValid(8L, fingerprint())
        cache.invalidate()
        assertFalse(cache.isValid(8L, fingerprint()))
    }

    @Test
    fun threadPolicyScalesConservativelyAndKeepsCpuFallback() {
        val oneCore = OnnxRuntimeConfigSelector.select(setOf("CPU"), 1)
        val eightCore = OnnxRuntimeConfigSelector.select(setOf("CPU"), 8)
        assertEquals(OnnxExecutionProvider.CPU, oneCore.provider)
        assertEquals(1, oneCore.intraOpThreads)
        assertEquals(4, eightCore.intraOpThreads)
        assertEquals(1, eightCore.interOpThreads)
    }

    @Test
    fun optionalProviderSelectionIsOnlyUsedWhenExplicitlyRequestedAndAvailable() {
        val unavailable = OnnxRuntimeConfigSelector.select(
            setOf("CPU"),
            8,
            OnnxExecutionProvider.XNNPACK,
        )
        val available = OnnxRuntimeConfigSelector.select(
            setOf("CPU", "XnnpackExecutionProvider"),
            8,
            OnnxExecutionProvider.XNNPACK,
        )
        assertEquals(OnnxExecutionProvider.CPU, unavailable.provider)
        assertEquals(OnnxExecutionProvider.XNNPACK, available.provider)
    }
}
