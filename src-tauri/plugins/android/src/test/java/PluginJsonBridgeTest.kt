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
}
