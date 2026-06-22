package com.lucidagentide.plugin

import java.io.File

/**
 * P-EXT.3 (ADR-0038) — the security-critical launcher logic, the Kotlin twin of
 * harness/launcher/ide_client.ts. The plugin spawns ONLY a `lucid` launcher (`lucid acp`), never a raw
 * agent command, so installing the plugin can never produce an ungated session (invariants #3/#4).
 *
 * isLucidBinary + parseBlockLine are pinned by the shared spec harness/launcher/ext_parity.json
 * (ParityTest reads the same file the TS extension does), so both editors honor one verified contract.
 */
object Launcher {
    fun isWindows(os: String = System.getProperty("os.name").orEmpty().lowercase()): Boolean = os.contains("win")
    fun launcherBinaryName(windows: Boolean = isWindows()): String = if (windows) "lucid.exe" else "lucid"

    // Byte-for-byte the ide_client.ts regex: basename is exactly `lucid` or `lucid.exe`.
    private val LUCID_RE = Regex("(^|[\\\\/])lucid(\\.exe)?\$")

    /** SECURITY: a path is a launcher candidate only if its basename is exactly lucid[.exe]. Keeps
     *  `omp` and look-alikes (lucidd, lucid-helper, lucid.sh) out of the candidate list. */
    fun isLucidBinary(path: String): Boolean = LUCID_RE.containsMatchIn(path)

    /** Per-OS install locations of the compiled `lucid` launcher (resources/repo/bin/lucid[.exe]). */
    fun installedAppLauncherPaths(env: Map<String, String> = System.getenv(), windows: Boolean = isWindows()): List<String> {
        val bin = launcherBinaryName(windows)
        fun inRepo(root: String) = listOf(root, "resources", "repo", "bin", bin).joinToString(File.separator)
        return when {
            windows -> env["LOCALAPPDATA"]?.let { listOf(inRepo(listOf(it, "Programs", "LucidAgentIDE").joinToString(File.separator))) } ?: emptyList()
            System.getProperty("os.name").orEmpty().lowercase().contains("mac") ->
                listOf(inRepo("/Applications/LucidAgentIDE.app/Contents"))
            else -> listOf(inRepo("/opt/LucidAgentIDE"), "/usr/local/bin/$bin")
        }
    }

    /**
     * Ordered launcher candidates: explicit config path → installed app → PATH dirs. Filtered so ONLY
     * the explicit config path or a `lucid` binary can appear — nothing else can steer the spawn.
     */
    fun buildCandidates(configPath: String?, env: Map<String, String> = System.getenv(), windows: Boolean = isWindows()): List<String> {
        val bin = launcherBinaryName(windows)
        val config = configPath?.trim()?.ifEmpty { null }
        val out = mutableListOf<String>()
        if (config != null) out += config
        out += installedAppLauncherPaths(env, windows)
        (env["PATH"] ?: "").split(File.pathSeparatorChar).filter { it.isNotBlank() }.forEach { out += it.trim() + File.separator + bin }
        return out.filter { it == config || isLucidBinary(it) }
    }

    /** First existing candidate, or null. The caller MUST then prompt to install Lucid — never a fallback. */
    fun resolve(candidates: List<String>, exists: (String) -> Boolean = { File(it).exists() }): String? =
        candidates.firstOrNull { exists(it) }

    data class BlockSignal(val tool: String, val severity: String, val findings: String)

    // Byte-for-byte the ide_client.ts / acp_backend.ts:182 parser.
    private val BLOCK_RE = Regex("\\[BLOCKED tool_call:(\\w+)\\].*?severity=(\\w+).*?findings=(\\S+)")

    /** Parse the gate's authoritative [BLOCKED] stderr line into a block signal, or null. */
    fun parseBlockLine(line: String): BlockSignal? {
        val m = BLOCK_RE.find(line) ?: return null
        return BlockSignal(m.groupValues[1], m.groupValues[2], m.groupValues[3])
    }
}
