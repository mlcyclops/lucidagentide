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
