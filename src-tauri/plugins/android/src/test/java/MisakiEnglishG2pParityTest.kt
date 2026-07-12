package com.folio.reader.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MisakiEnglishG2pParityTest {
    @Test
    fun lightweightRuntimeMatchesPinnedOfficialMisakiFixtures() {
        val fixtureStream = requireNotNull(javaClass.classLoader?.getResourceAsStream("misaki_en_parity.json"))
        val document = fixtureStream.bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
        assertEquals(MisakiEnglishLexicon.REVISION, document.getString("oracleRevision"))

        var currentFallbackRaw = emptyMap<String, String>()
        val fallbackCalls = mutableListOf<Pair<String, String>>()
        val runtime = MisakiEnglishG2p(
            assetLoader = { path ->
                requireNotNull(javaClass.classLoader?.getResourceAsStream(path)) { "Missing test asset $path" }
            },
            espeakFallback = { word, language ->
                fallbackCalls += word to language
                requireNotNull(currentFallbackRaw[word]) { "Unexpected eSpeak fallback for $word" }
            },
        )

        val fixtures = document.getJSONArray("fixtures")
        for (index in 0 until fixtures.length()) {
            val fixture = fixtures.getJSONObject(index)
            val id = fixture.getString("id")
            val dialect = fixture.getString("dialect")
            val expectedFallback = fixture.getJSONArray("fallbackWords").let { words ->
                (0 until words.length()).map(words::getString)
            }
            currentFallbackRaw = fixture.getJSONObject("fallbackRaw").let { values ->
                values.keys().asSequence().associateWith(values::getString)
            }
            fallbackCalls.clear()

            val result = runtime.phonemize(fixture.getString("text"), british = dialect == "gb")

            assertEquals("$dialect/$id phonemes", fixture.getString("phonemes"), result.phonemes)
            assertEquals("$dialect/$id fallback telemetry", expectedFallback, result.telemetry.fallbackWords)
            assertEquals("$dialect/$id fallback callback count", expectedFallback.size, fallbackCalls.size)
            assertEquals(
                "$dialect/$id fallback callback words",
                expectedFallback,
                fallbackCalls.map(Pair<String, String>::first),
            )
            assertTrue(
                "$dialect/$id fallback language",
                fallbackCalls.all { it.second == if (dialect == "gb") "en-gb" else "en-us" },
            )
            if (id == "ood") {
                assertEquals(listOf("zxqvblorfquangles"), expectedFallback)
                assertNotEquals(
                    "Whole-sentence eSpeak must never become the English primary result",
                    fixture.getString("wholeSentenceEspeak"),
                    result.phonemes,
                )
            } else {
                assertTrue("$dialect/$id should stay on Misaki primary path", fallbackCalls.isEmpty())
            }
        }
    }
}
