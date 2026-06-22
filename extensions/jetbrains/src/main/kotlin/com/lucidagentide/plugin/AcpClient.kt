package com.lucidagentide.plugin

import org.json.JSONObject
import java.io.File
import java.io.OutputStreamWriter
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Minimal ACP JSON-RPC-over-stdio client — the Kotlin twin of desktop/acp.ts. Drives `lucid acp`:
 * line-delimited JSON-RPC 2.0 over the child's stdin/stdout, with stderr surfaced for the gate's
 * [BLOCKED] signal. Reader threads are daemons; the gate lives in `lucid acp`, never in the JVM.
 */
class AcpClient(private val cmd: String, private val args: List<String>, private val cwd: String) {
    private var proc: Process? = null
    private var writer: OutputStreamWriter? = null
    private val nextId = AtomicInteger(1)
    private val pending = ConcurrentHashMap<Int, CompletableFuture<JSONObject>>()

    var onNotify: (String, JSONObject?) -> Unit = { _, _ -> }
    var onRequest: (String, JSONObject?) -> JSONObject = { _, _ -> JSONObject() }
    var onStderr: (String) -> Unit = {}
    var onExit: (Int) -> Unit = {}

    fun start() {
        val p = ProcessBuilder(listOf(cmd) + args).directory(File(cwd)).start()
        proc = p
        writer = OutputStreamWriter(p.outputStream, Charsets.UTF_8)
        Thread {
            p.inputStream.bufferedReader(Charsets.UTF_8).forEachLine { handle(it) }
            onExit(runCatching { p.waitFor() }.getOrDefault(-1))
        }.apply { isDaemon = true; name = "lucid-acp-stdout"; start() }
        Thread {
            p.errorStream.bufferedReader(Charsets.UTF_8).forEachLine { onStderr(it) }
        }.apply { isDaemon = true; name = "lucid-acp-stderr"; start() }
    }

    private fun handle(line: String) {
        val t = line.trim()
        if (t.isEmpty()) return
        val msg = runCatching { JSONObject(t) }.getOrNull() ?: return
        // response to one of our requests
        if (msg.has("id") && (msg.has("result") || msg.has("error"))) {
            val fut = pending.remove(msg.getInt("id")) ?: return
            if (msg.has("error")) fut.completeExceptionally(RuntimeException(msg.get("error").toString()))
            else fut.complete(msg.optJSONObject("result") ?: JSONObject())
            return
        }
        // request FROM the agent (needs a response) — e.g. session/request_permission
        if (msg.has("method") && msg.has("id")) {
            val result = runCatching { onRequest(msg.getString("method"), msg.optJSONObject("params")) }.getOrDefault(JSONObject())
            write(JSONObject().put("jsonrpc", "2.0").put("id", msg.get("id")).put("result", result))
            return
        }
        // notification
        if (msg.has("method")) onNotify(msg.getString("method"), msg.optJSONObject("params"))
    }

    fun request(method: String, params: JSONObject? = null): CompletableFuture<JSONObject> {
        val id = nextId.getAndIncrement()
        val fut = CompletableFuture<JSONObject>()
        pending[id] = fut
        write(JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).also { if (params != null) it.put("params", params) })
        return fut
    }

    fun notify(method: String, params: JSONObject? = null) {
        write(JSONObject().put("jsonrpc", "2.0").put("method", method).also { if (params != null) it.put("params", params) })
    }

    @Synchronized
    private fun write(o: JSONObject) {
        runCatching { writer?.apply { write(o.toString() + "\n"); flush() } }
    }

    fun stop() {
        runCatching { proc?.destroy() }
    }
}
