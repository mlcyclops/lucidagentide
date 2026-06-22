package com.lucidagentide.plugin

import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * P-EXT.3 — runs the Kotlin Launcher against the SHARED, language-neutral spec
 * (harness/launcher/ext_parity.json) that the TS extension's ext_parity.test.ts also runs. So both
 * editors honor one verified security contract: only-lucid launcher acceptance + the [BLOCKED] parser.
 * A drift in the Kotlin port fails here.
 */
class ParityTest {
    private fun spec(): JSONObject {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "harness/launcher/ext_parity.json")
            if (f.exists()) return JSONObject(f.readText())
            dir = dir.parentFile
        }
        error("ext_parity.json not found walking up from ${File(".").absolutePath}")
    }

    @Test
    fun launcherAcceptanceMatchesSpec() {
        val cases = spec().getJSONArray("launcherAccept")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getBoolean("accept"), Launcher.isLucidBinary(c.getString("path")), "path=${c.getString("path")}")
        }
    }

    @Test
    fun blockLineParsingMatchesSpec() {
        val cases = spec().getJSONArray("blockLines")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val got = Launcher.parseBlockLine(c.getString("line"))
            if (c.isNull("expect")) {
                assertNull(got, "line=${c.getString("line")}")
            } else {
                assertNotNull(got)
                val e = c.getJSONObject("expect")
                assertEquals(e.getString("tool"), got.tool)
                assertEquals(e.getString("severity"), got.severity)
                assertEquals(e.getString("findings"), got.findings)
            }
        }
    }
}
