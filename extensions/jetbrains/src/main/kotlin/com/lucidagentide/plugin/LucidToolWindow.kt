package com.lucidagentide.plugin

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import org.json.JSONArray
import org.json.JSONObject
import java.awt.BorderLayout
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextArea

/**
 * P-EXT.3 (ADR-0038) — the JetBrains tool window. A THIN ACP client of `lucid acp` (the gate stays in
 * the launcher, never in the JVM): it resolves the `lucid` binary securely (only-lucid; never a raw
 * agent command), spawns `lucid acp` with the project dir as cwd, and renders the gated session. The
 * Ask-mode permission round-trip is FAIL-CLOSED (cancel/close ⇒ deny); the gate's [BLOCKED] signal
 * surfaces as a banner.
 */
class LucidToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val content = ContentFactory.getInstance().createContent(LucidPanel(project), "Chat", false)
        toolWindow.contentManager.addContent(content)
    }
}

class LucidPanel(private val project: Project) : JPanel(BorderLayout()) {
    private val log = JTextArea().apply { isEditable = false; lineWrap = true; wrapStyleWord = true }
    private val input = JTextArea(3, 40)
    private val banner = JLabel("").apply { isVisible = false }
    private var acp: AcpClient? = null
    private var sessionId: String? = null

    init {
        add(banner, BorderLayout.NORTH)
        add(JScrollPane(log), BorderLayout.CENTER)
        val south = JPanel(BorderLayout())
        south.add(JScrollPane(input), BorderLayout.CENTER)
        south.add(JButton("Send").apply { addActionListener { send() } }, BorderLayout.EAST)
        add(south, BorderLayout.SOUTH)
    }

    private fun ui(block: () -> Unit) = ApplicationManager.getApplication().invokeLater(block)
    private fun append(s: String) = ui { log.append(s); log.caretPosition = log.document.length }

    /** Resolve the launcher + open a gated session. Returns false (and shows why) if Lucid is missing
     *  or the gated agent can't start — NEVER falls back to anything ungated. */
    private fun ensureSession(): Boolean {
        if (acp != null && sessionId != null) return true
        val config = PropertiesComponent.getInstance().getValue("lucid.launcherPath")
        val lucid = Launcher.resolve(Launcher.buildCandidates(config))
        if (lucid == null) {
            ui { Messages.showErrorDialog(project, "The Lucid launcher wasn't found. Install LucidAgentIDE or set lucid.launcherPath.", "LucidAgentIDE") }
            return false
        }
        val cwd = project.basePath ?: System.getProperty("user.dir")
        val client = AcpClient(lucid, listOf("acp"), cwd)
        acp = client
        client.onNotify = { method, params -> if (method == "session/update") onUpdate(params) }
        client.onRequest = { method, params -> onRequest(method, params) }
        client.onStderr = { line -> Launcher.parseBlockLine(line)?.let { showBlock(it) } }
        client.onExit = { code ->
            ui { banner.text = "⛔ Agent exited (code $code) — the gate or scanner is unavailable (fail-closed)."; banner.isVisible = true }
            acp = null; sessionId = null
        }
        return try {
            client.start()
            client.request("initialize", JSONObject().put("protocolVersion", 1).put("clientCapabilities", JSONObject())).get()
            val s = client.request("session/new", JSONObject().put("cwd", cwd).put("mcpServers", JSONObject())).get()
            sessionId = s.optString("sessionId", s.optString("id", ""))
            sessionId!!.isNotEmpty()
        } catch (e: Exception) {
            ui { banner.text = "⛔ Could not start the gated agent: ${e.message}"; banner.isVisible = true }
            acp = null; sessionId = null
            false
        }
    }

    private fun send() {
        val text = input.text.trim()
        if (text.isEmpty()) return
        append("\n› $text\n")
        input.text = ""
        Thread {
            if (!ensureSession()) return@Thread
            runCatching {
                acp!!.request(
                    "session/prompt",
                    JSONObject().put("sessionId", sessionId)
                        .put("prompt", JSONArray().put(JSONObject().put("type", "text").put("text", text))),
                ).get()
            }.onFailure { append("\n[error: ${it.message}]\n") }
        }.apply { isDaemon = true; start() }
    }

    private fun onUpdate(params: JSONObject?) {
        val u = params?.optJSONObject("update") ?: params ?: return
        when (u.optString("sessionUpdate", u.optString("type"))) {
            "agent_message_chunk" -> append(textOf(u.opt("content")))
            "tool_call", "tool_call_update" -> append("\n🔧 ${u.optString("title", "tool")}\n")
            // agent_thought_chunk is display-only (ADR-0027); omitted from the MVP log
        }
    }

    private fun textOf(content: Any?): String = when (content) {
        is String -> content
        is JSONObject -> content.optString("text", "")
        else -> ""
    }

    /** Fail-closed permission round-trip: prompt; deny on cancel/close. */
    private fun onRequest(method: String, params: JSONObject?): JSONObject {
        if (method != "session/request_permission") return JSONObject()
        val options = params?.optJSONArray("options") ?: JSONArray()
        val names = (0 until options.length()).map { options.getJSONObject(it).optString("name", "Allow") }.toTypedArray()
        val tool = params?.optJSONObject("toolCall")?.optString("title") ?: "a tool"
        val choice = invokeAndWait { Messages.showDialog(project, "Allow $tool?", "LucidAgentIDE", names + arrayOf("Deny"), 0, null) }
        return if (choice in names.indices) {
            val opt = options.getJSONObject(choice)
            JSONObject().put("outcome", JSONObject().put("outcome", "selected").put("optionId", opt.optString("optionId", opt.optString("id"))))
        } else {
            JSONObject().put("outcome", JSONObject().put("outcome", "cancelled")) // fail-closed: deny
        }
    }

    private fun <T> invokeAndWait(block: () -> T): T {
        val box = arrayOfNulls<Any?>(1)
        ApplicationManager.getApplication().invokeAndWait { box[0] = block() }
        @Suppress("UNCHECKED_CAST")
        return box[0] as T
    }

    private fun showBlock(b: Launcher.BlockSignal) = ui {
        banner.text = "🛡️ Security gate BLOCKED a ${b.tool} call (severity ${b.severity}, ${b.findings}). The tool never ran."
        banner.isVisible = true
    }
}
