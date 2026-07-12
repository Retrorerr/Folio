package com.folio.reader.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class NativePhonemizerInstrumentedTest {
    @Test
    fun bundledDataCopiesAndInitializesEspeakFromItsParentDirectory() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val installRoot = File(context.filesDir, "phonemizer")
        installRoot.deleteRecursively()

        val phonemizer = EspeakPhonemizer(context)
        assertTrue("eSpeak NG native library/assets are unavailable", phonemizer.available())

        val generic = runCatching { phonemizer.phonemize("Hello, world.", "en") }
        val american = runCatching { phonemizer.phonemize("Hello, world.", "en-us") }
        val british = runCatching { phonemizer.phonemize("Hello, world.", "en-gb") }

        val diagnostics = "generic=${generic.exceptionOrNull()?.message ?: "ok"}, " +
            "american=${american.exceptionOrNull()?.message ?: "ok"}, " +
            "british=${british.exceptionOrNull()?.message ?: "ok"}"
        assertTrue(diagnostics, american.isSuccess && american.getOrThrow().isNotBlank())
        assertTrue(diagnostics, british.isSuccess && british.getOrThrow().isNotBlank())
        assertTrue(File(installRoot, "espeak-ng-data/phondata").isFile)
        assertEquals(
            "folio-espeak-ng-1",
            File(installRoot, "espeak-ng-data/.folio-data-ready").readText(),
        )
    }

    @Test
    fun misakiIsPrimaryAndRealEspeakIsLimitedToLexiconMisses() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val runtime = MisakiEnglishG2p(context, EspeakPhonemizer(context))

        val primary = runtime.phonemize("The quick brown fox jumps over the lazy dog.", british = false)
        assertEquals("ðə kwˈɪk bɹˈWn fˈɑks ʤˈʌmps ˈOvəɹ ðə lˈAzi dˈɔɡ.", primary.phonemes)
        assertEquals(0, primary.telemetry.fallbackCount)

        val outOfDictionary = runtime.phonemize("Folio zxqvblorfquangles.", british = false)
        assertEquals("fˈOliO zˌiˌɛkskjˌuvˈiblˈɔɹfkwæŋɡᵊlz.", outOfDictionary.phonemes)
        assertEquals(listOf("zxqvblorfquangles"), outOfDictionary.telemetry.fallbackWords)
        assertEquals(1, outOfDictionary.telemetry.fallbackCount)
    }
}
