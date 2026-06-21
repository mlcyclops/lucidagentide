// tools/web/server.ts
//
// Local web dashboard for LucidAgentIDE — the browser-rendered version of the
// security + memory/context dashboards, served straight from agent_obs.duckdb
// and omp's session state. This is the front-end proof-of-concept for an
// Electron/desktop shell: the renderer is just a web page hitting these JSON
// endpoints; an Electron app would embed this page and add an omp `acp` chat
// panel beside it (see tools/acp_probe.ts).
//
//   bun run dashboard:web            # http://localhost:4317
//   PORT=5000 bun run dashboard:web
//
// Everything is READ-ONLY; safe to run while omp + the gate are live.

import { join } from "node:path";
import { securitySnapshot, memorySnapshot } from "./data.ts";
import { isAllowedRequest, reqShape } from "../../desktop/origin_guard.ts";

const PORT = Number(process.env.PORT ?? 4317);
const INDEX = join(import.meta.dir, "index.html");

function json(data: unknown): Response {
  // belt-and-suspenders: data.ts already cleans rows, but guard any stray BigInt.
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // H1 (ADR-0022): loopback only.
  async fetch(req) {
    const url = new URL(req.url);
    // H2 (ADR-0022): loopback-Host gate (defeats DNS rebinding) — read-only, but cheap and consistent.
    if (!isAllowedRequest(reqShape(req), PORT)) return new Response("forbidden", { status: 403 });
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(Bun.file(INDEX), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/api/security") return json({ ok: true, data: await securitySnapshot() });
      if (url.pathname === "/api/memory") return json({ ok: true, data: await memorySnapshot() });
      if (url.pathname === "/api/health") return json({ ok: true, ts: new Date().toISOString() });
    } catch (err) {
      return json({ ok: false, error: String(err) });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`\n  🛡  LucidAgentIDE web dashboard\n  →  http://localhost:${server.port}\n`);
console.log("  security + memory, live from agent_obs.duckdb + omp (read-only).");
console.log("  Ctrl+C to stop.\n");
