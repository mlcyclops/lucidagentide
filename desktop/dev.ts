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
import { memorySnapshot, rateLimits, usageLedger } from "../tools/memory_data.ts";
import { backend } from "./acp_backend.ts";
import { listSessions, sessionMessages } from "./sessions.ts";
import { providerAuth } from "./auth_status.ts";
import { cloneRepo, setWorkspace, workspaceInfo } from "./workspace.ts";
import { applyEnv, load as loadSettings, setAsksage, setKey, setUsername } from "./settings_store.ts";
import { asksageConfig, listDatasets, listPersonas, monthlyTokens, scanPersona, wrapPersona } from "./asksage.ts";
import { listSkills } from "./skills_data.ts";
import { headroomStatus, setHeadroomEnabled, startHeadroom } from "./headroom.ts";
import { destroyCui, enablePersonal, exportCuiArchive, exportHistory, exportVault, forgetFact, importChatExport, lockCui, lockPersonal, migrateCuiIntoStore, personalGraph, personalStatus, setScope, setupCui, setupPersonal, unlockCui, unlockPersonal } from "./personal.ts";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

applyEnv(); // make stored API keys available to a spawned omp acp
if (loadSettings().headroomEnabled) startHeadroom(); // resume the opt-in compression proxy

function ompBin(): string {
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) if (existsSync(c)) return c;
  return "omp";
}

const ROOT = join(import.meta.dir, "renderer");
const PORT = Number(process.env.PORT ?? 5319);
const CT: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };

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

// OAuth via omp's `auth-broker login` — it opens the provider, runs a LOCAL callback server
// (e.g. :1455) for the redirect, exchanges the code, stores the token, then exits. It MUST stay
// alive AND have BOTH pipes drained until the callback lands — otherwise a full stdout/stderr pipe
// blocks it and the callback server goes down (browser → "localhost refused to connect"). We keep
// a reference (no GC), drain both streams in the background, and resolve once we see the auth URL.
const oauthBrokers = new Set<ReturnType<typeof Bun.spawn>>();
function startOauthBroker(oauthId: string): Promise<{ started: boolean; url: string; output: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try { proc = Bun.spawn([ompBin(), "auth-broker", "login", oauthId], { stdout: "pipe", stderr: "pipe", stdin: "ignore" }); }
  catch (e) { return Promise.resolve({ started: false, url: "", output: String((e as Error)?.message ?? e) }); }
  oauthBrokers.add(proc);
  proc.exited.finally(() => oauthBrokers.delete(proc));
  return new Promise((resolve) => {
    const dec = new TextDecoder();
    let out = "", done = false;
    const finish = (url: string) => { if (done) return; done = true; resolve({ started: true, url, output: out.slice(0, 600) }); };
    // Drain stdout fully (never stop) so the broker can't block; grab the URL when it appears.
    (async () => {
      try { for await (const c of proc.stdout as ReadableStream<Uint8Array>) { out += dec.decode(c); const m = out.match(/https?:\/\/\S+/); if (m) finish(m[0]); } } catch { /* stream ended */ }
      finish(""); // EOF without a URL
    })();
    // Drain stderr too (also a finite pipe that would otherwise block the broker).
    (async () => { try { for await (const _ of proc.stderr as ReadableStream<Uint8Array>) { /* discard */ } } catch { /* ended */ } })();
    setTimeout(() => finish(""), 8000); // don't hang the HTTP request if the URL is slow to print
  });
}

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
      // Light, fast re-read of the provider rate-limit budget (omp's agent.db).
      // Used by the front-end's manual refresh + 5-minute auto-poll.
      if (p === "/api/budget") return json({ ok: true, data: rateLimits() });
      // P10.2: cross-model usage & cost ledger (per-model totals + estimated cache savings).
      if (p === "/api/usage") return json({ ok: true, data: usageLedger() });
      if (p === "/api/health") return json({ ok: true });
      // In-app folder browser (works in the browser build AND Electron — the dev server
      // reads the local FS in both). Lists subdirectories + flags git repos, for Workspace.
      if (p === "/api/fs/list") {
        const want = url.searchParams.get("path");
        const base = want && existsSync(want) ? want : homedir();
        const dirs: { name: string; path: string; isGit: boolean }[] = [];
        try {
          for (const name of readdirSync(base)) {
            if (name.startsWith(".")) continue; // hide dotfiles
            const full = join(base, name);
            try { if (statSync(full).isDirectory()) dirs.push({ name, path: full, isGit: existsSync(join(full, ".git")) }); } catch { /* unreadable */ }
          }
        } catch { /* unreadable dir */ }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        const parent = dirname(base);
        return json({ ok: true, data: { path: base, parent: parent !== base ? parent : null, home: homedir(), isGit: existsSync(join(base, ".git")), dirs } });
      }

      // real omp ACP backend (genuine model replies + live session config)
      if (p === "/api/sessions") return json({ ok: true, data: listSessions() });
      if (p === "/api/session" && url.searchParams.get("id")) return json({ ok: true, data: sessionMessages(url.searchParams.get("id")!) });
      if (p === "/api/session/load" && req.method === "POST") { const { id } = await req.json(); await backend.loadSession(String(id)); return json({ ok: true }); }

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
        // omp owns the secure OAuth flow; the broker stays alive + drained until the callback lands.
        return json({ ok: true, data: await startOauthBroker(String(oauthId)) });
      }
      if (p === "/api/auth/logout" && req.method === "POST") {
        const { oauthId } = await req.json();
        Bun.spawnSync([ompBin(), "auth-broker", "logout", String(oauthId)], { timeout: 4000 });
        return json({ ok: true, data: providerAuth() });
      }
      // AskSage gov gateway (ADR-0007)
      if (p === "/api/asksage") {
        if (req.method === "POST") {
          const b = await req.json();
          const prev = asksageConfig();
          setAsksage({
            baseUrl: typeof b.baseUrl === "string" ? b.baseUrl : undefined,
            only: typeof b.only === "boolean" ? b.only : undefined,
            limit: typeof b.limit === "number" ? b.limit : undefined,
            datasets: Array.isArray(b.datasets) ? b.datasets.map(String) : undefined,
            queryModel: typeof b.queryModel === "string" ? b.queryModel : undefined,
            persona: typeof b.persona === "string" ? b.persona : undefined,
          });
          const next = asksageConfig();
          // The omp child reads datasets/model/persona/base from env at spawn - restart to apply.
          if ((typeof b.baseUrl === "string" && next.base !== prev.base) || (b.datasets !== undefined && next.datasets.join(",") !== prev.datasets.join(",")) || (b.queryModel !== undefined && next.queryModel !== prev.queryModel) || (b.persona !== undefined && next.persona !== prev.persona)) backend.restart();
        }
        const c = asksageConfig();
        return json({ ok: true, data: { configured: c.configured, base: c.base, only: c.only, limit: c.limit, datasets: c.datasets, queryModel: c.queryModel, persona: c.persona } });
      }
      if (p === "/api/asksage/tokens") return json({ ok: true, data: await monthlyTokens() });
      if (p === "/api/asksage/datasets") return json({ ok: true, data: await listDatasets() });
      if (p === "/api/asksage/personas") return json({ ok: true, data: await listPersonas() });
      if (p === "/api/asksage/persona" && req.method === "POST") {
        const { id, clear } = await req.json();
        if (clear) { backend.setPersona(null); return json({ ok: true, data: { cleared: true } }); }
        const personas = (await listPersonas()) ?? [];
        const persona = personas.find((x) => x.id === String(id));
        if (!persona) return json({ ok: false, error: "persona not found" });
        const scan = await scanPersona(persona.text); // SAME scanner as tool calls - fail-closed
        if (!scan.ok) { backend.setPersona(null); return json({ ok: true, data: { applied: false, scan } }); }
        backend.setPersona(wrapPersona(persona.id, persona.text)); // delimited, delivered in the user turn
        return json({ ok: true, data: { applied: true, scan } });
      }
      if (p === "/api/config") return json({ ok: true, data: await backend.getConfig() });
      if (p === "/api/commands") return json({ ok: true, data: await backend.getCommands() });
      if (p === "/api/skills") return json({ ok: true, data: await listSkills() });
      if (p === "/api/headroom") {
        if (req.method === "POST") { const b = await req.json(); return json({ ok: true, data: setHeadroomEnabled(!!b.enabled) }); }
        return json({ ok: true, data: headroomStatus() });
      }
      // Personalization knowledge graph (ADR-0010 P9.1 / ADR-0012). Passphrase custody;
      // the passphrase never leaves this handler and is never persisted.
      if (p === "/api/personal") return json({ ok: true, data: personalStatus() });
      if (p === "/api/personal/enable" && req.method === "POST") { const b = await req.json(); return json({ ok: true, data: enablePersonal(!!b.enabled) }); }
      if (p === "/api/personal/setup" && req.method === "POST") { const b = await req.json(); return json({ ok: true, data: setupPersonal(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/unlock" && req.method === "POST") { const b = await req.json(); return json({ ok: true, data: unlockPersonal(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/lock" && req.method === "POST") return json({ ok: true, data: lockPersonal() });
      if (p === "/api/personal/scope" && req.method === "POST") { const b = await req.json(); return json({ ok: true, data: setScope(String(b.scope ?? "personal") as any) }); }
      // P9.5a: the isolated CUI store has its OWN setup/unlock/lock (separate file + passphrase).
      if (p === "/api/personal/cui/setup" && req.method === "POST") { const b = await req.json(); return json({ ok: true, data: setupCui(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/cui/unlock" && req.method === "POST") { const b = await req.json(); return json({ ok: true, data: unlockCui(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/cui/lock" && req.method === "POST") return json({ ok: true, data: lockCui() });
      // P9.5b: audited migration (move legacy cui out of the main store) + records destruction.
      if (p === "/api/personal/cui/migrate" && req.method === "POST") return json({ ok: true, data: migrateCuiIntoStore() });
      if (p === "/api/personal/cui/destroy" && req.method === "POST") return json({ ok: true, data: destroyCui() });
      if (p === "/api/personal/graph") return json({ ok: true, data: personalGraph((url.searchParams.get("scope") ?? undefined) as any) });
      if (p === "/api/personal/forget" && req.method === "POST") { const b = await req.json(); return json({ ok: true, data: forgetFact(String(b.factId ?? "")) }); }
      // P9.7: import a ChatGPT / Claude data export (folder containing conversations.json, or the
      // file itself). Every imported user message is scanned by the fail-closed gate first.
      if (p === "/api/personal/import" && req.method === "POST") { const b = await req.json(); return json({ ok: true, data: await importChatExport(String(b.path ?? ""), b.vendor) }); }
      // P9.4: audited decrypt→export. Vault excludes CUI unless explicitly listed; the
      // CUI archive is a separate, loud, NARA-aligned records-management path.
      if (p === "/api/personal/vault" && req.method === "POST") {
        const b = await req.json();
        const scopes = Array.isArray(b.scopes) ? b.scopes.map(String).filter((x: string) => x === "personal" || x === "work" || x === "cui") : undefined;
        return json({ ok: true, data: exportVault({ scopes, dest: typeof b.dest === "string" ? b.dest : undefined, reviewer: typeof b.reviewer === "string" ? b.reviewer : undefined }) });
      }
      if (p === "/api/personal/cui-archive" && req.method === "POST") {
        const b = await req.json();
        return json({ ok: true, data: exportCuiArchive({ dest: typeof b.dest === "string" ? b.dest : undefined, reviewer: typeof b.reviewer === "string" ? b.reviewer : undefined, designation: typeof b.designation === "object" && b.designation ? b.designation : undefined }) });
      }
      if (p === "/api/personal/exports") return json({ ok: true, data: exportHistory() });
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
