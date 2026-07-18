package com.folio.reader.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PluginJsonBridgeTest {
    @Test
    fun nestedModelStatusRemainsStructuredAcrossThePluginBoundary() {
        val status = statusJsonObject(
            mapOf(
                "installed" to true,
                "runtimeProviders" to listOf("CPU", "XNNPACK"),
                "telemetry" to mapOf("fallbackCount" to 0),
                "error" to null,
            ),
        )

        assertTrue(status.getBoolean("installed"))
        assertEquals("CPU", status.getJSONArray("runtimeProviders").getString(0))
        assertEquals(0, status.getJSONObject("telemetry").getInt("fallbackCount"))
        assertTrue(status.isNull("error"))
    }

    @Test
    fun queueLocationsRemainCompactStructuredObjects() {
        val status = statusJsonObject(
            mapOf(
                "state" to "playing",
                "queueLocations" to listOf(
                    mapOf("sessionId" to 7L, "bookId" to "book-a", "chapterIndex" to 2, "sentenceIndex" to 9),
                    mapOf("sessionId" to 8L, "bookId" to "book-a", "chapterIndex" to 3, "sentenceIndex" to 0),
                ),
            ),
        )

        val locations = status.getJSONArray("queueLocations")
        assertEquals(2, locations.length())
        assertEquals(7L, locations.getJSONObject(0).getLong("sessionId"))
        assertEquals(3, locations.getJSONObject(1).getInt("chapterIndex"))
        assertEquals(0, locations.getJSONObject(1).getInt("sentenceIndex"))
    }
}
