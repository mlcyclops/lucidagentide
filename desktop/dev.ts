// desktop/dev.ts
//
// Dev/preview server for the desktop renderer. Serves the static renderer,
// bundles renderer/app.ts → /app.js on the fly (Bun.build, browser target), and
// exposes the same live /api/security + /api/memory used by the web dashboard.
// Electron loads this exact renderer; this server makes it runnable + screenshot-
// able in a plain browser (the bridge falls back to simulated chat there).
//
//   bun run desktop:web        # http://localhost:5319

import { join } from "node:path";
import { securitySnapshot } from "../tools/web/data.ts";
import { memorySnapshot } from "../tools/memory_data.ts";
import { backend } from "./acp_backend.ts";
import { listSessions } from "./sessions.ts";
import { providerAuth } from "./auth_status.ts";
import { cloneRepo, setWorkspace, workspaceInfo } from "./workspace.ts";
import { applyEnv, load as loadSettings, setKey, setUsername } from "./settings_store.ts";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

applyEnv(); // make stored API keys available to a spawned omp acp

function ompBin(): string {
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) if (existsSync(c)) return c;
  return "omp";
}

const ROOT = join(import.meta.dir, "renderer");
const PORT = Number(process.env.PORT ?? 5319);
const CT: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

async function bundleApp(): Promise<{ js: string; ok: boolean }> {
  const out = await Bun.build({ entrypoints: [join(ROOT, "app.ts")], target: "browser", sourcemap: "inline" });
  if (!out.success) {
    const msg = out.logs.map((l) => String(l)).join("\n");
    return { ok: false, js: `document.body.innerHTML='<pre style="color:#ef5f5f;padding:20px;font:13px monospace;white-space:pre-wrap">'+${JSON.stringify(msg)}+'</pre>';` };
  }
  return { ok: true, js: await out.outputs[0]!.text() };
}

const json = (data: unknown) =>
  new Response(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/app.js") {
        const { js } = await bundleApp();
        return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      }
      if (p === "/api/security") return json({ ok: true, data: await securitySnapshot() });
      if (p === "/api/memory") return json({ ok: true, data: await memorySnapshot() });
      if (p === "/api/health") return json({ ok: true });

      // real omp ACP backend (genuine model replies + live session config)
      if (p === "/api/sessions") return json({ ok: true, data: listSessions() });

      // workspace (the folder the agent works in; local or cloned remote)
      if (p === "/api/workspace") {
        if (req.method === "POST") { const b = await req.json(); setWorkspace(String(b.path ?? "")); backend.restart(); }
        return json({ ok: true, data: workspaceInfo() });
      }
      if (p === "/api/workspace/clone" && req.method === "POST") {
        const { url } = await req.json();
        const r = await cloneRepo(String(url ?? ""));
        if (r.ok && r.path) { setWorkspace(r.path); backend.restart(); }
        return json({ ok: r.ok, data: { ...workspaceInfo(), cloned: r.ok, error: r.error } });
      }

      // settings + provider auth
      if (p === "/api/settings") {
        if (req.method === "POST") { const b = await req.json(); setUsername(String(b.username ?? "")); }
        return json({ ok: true, data: { username: loadSettings().username ?? "" } });
      }
      if (p === "/api/auth") return json({ ok: true, data: providerAuth() });
      if (p === "/api/auth/key" && req.method === "POST") {
        const { env, key } = await req.json();
        setKey(String(env), String(key ?? ""));
        backend.restart(); // pick up the new env on next turn
        return json({ ok: true, data: providerAuth() });
      }
      if (p === "/api/auth/oauth" && req.method === "POST") {
        const { oauthId } = await req.json();
        // omp owns the secure OAuth flow. Spawn it async so it STAYS ALIVE to
        // receive the browser callback; read a little stdout to grab the URL.
        const proc = Bun.spawn([ompBin(), "auth-broker", "login", String(oauthId)], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
        const dec = new TextDecoder();
        let out = "";
        await Promise.race([
          (async () => { for await (const c of proc.stdout) { out += dec.decode(c); if (/https?:\/\//.test(out)) break; } })(),
          new Promise((r) => setTimeout(r, 2500)),
        ]);
        const url = (out.match(/https?:\/\/\S+/) ?? [])[0] ?? "";
        return json({ ok: true, data: { started: true, url, output: out.slice(0, 600) } });
      }
      if (p === "/api/auth/logout" && req.method === "POST") {
        const { oauthId } = await req.json();
        Bun.spawnSync([ompBin(), "auth-broker", "logout", String(oauthId)], { timeout: 4000 });
        return json({ ok: true, data: providerAuth() });
      }
      if (p === "/api/config") return json({ ok: true, data: await backend.getConfig() });
      if (p === "/api/commands") return json({ ok: true, data: await backend.getCommands() });
      if (p === "/api/setConfig" && req.method === "POST") { const { configId, value } = await req.json(); return json({ ok: true, data: await backend.setConfig(configId, value) }); }
      if (p === "/api/newSession" && req.method === "POST") { await backend.newSession(); return json({ ok: true }); }
      if (p === "/api/chat" && req.method === "POST") {
        const { text } = await req.json();
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            await backend.prompt(String(text ?? ""), (e) => { try { controller.enqueue(enc.encode(JSON.stringify(e) + "\n")); } catch { /* stream closed */ } });
            try { controller.close(); } catch { /* already closed */ }
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
      }

      const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const file = Bun.file(join(ROOT, rel));
      if (await file.exists()) {
        const ext = rel.slice(rel.lastIndexOf("."));
        return new Response(file, { headers: { "content-type": (CT[ext] ?? "application/octet-stream") + "; charset=utf-8" } });
      }
    } catch (err) {
      return json({ ok: false, error: String(err) });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`\n  ◆ LucidAgentIDE desktop renderer (dev)\n  → http://localhost:${server.port}\n`);
