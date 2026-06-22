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
import { devSnapshot, securitySnapshot } from "../tools/web/data.ts";
import { approveBlock, liveBlocks } from "./security_log.ts";
import { probeRateLimits } from "./ratelimit_probe.ts";
import { OBS_DB_PATH, memorySnapshot, rateLimits, usageLedger } from "../tools/memory_data.ts";
import { backend } from "./acp_backend.ts";
import { listSessions, sessionMessages } from "./sessions.ts";
import { providerAuth } from "./auth_status.ts";
import { cloneRepo, setWorkspace, workspaceInfo } from "./workspace.ts";
import { applyEnv, attribution, chinaModelsAcknowledged, listMcpServers, load as loadSettings, removeMcpServer, setAsksage, setAttributionSkip, setChinaModelsAcknowledged, setDeveloperMode, setKey, setMcpServerEnabled, setProfile, setRateLimitProbe, upsertMcpServer } from "./settings_store.ts";
import { emailDomainAllowed, managedConfig, skipAllowed } from "./managed_config.ts";
import { asksageConfig, listDatasets, listPersonas, monthlyTokens, scanPersona, wrapPersona } from "./asksage.ts";
import { listSkills } from "./skills_data.ts";
import { recordSkillActivated } from "./skills_log.ts";
import { recentTurns } from "./turns_log.ts";
import { headroomStatus, setHeadroomEnabled, startHeadroom } from "./headroom.ts";
import { destroyCui, enablePersonal, estimateChatExport, exportCuiArchive, exportHistory, exportVault, forgetFact, importChatExport, lockCui, lockPersonal, migrateCuiIntoStore, personalGraph, personalStatus, setScope, setupCui, setupPersonal, unlockCui, unlockPersonal } from "./personal.ts";
import { readEditorFile, saveEditorFile } from "./editor.ts";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isAllowedRequest, reqShape, tokenValid } from "./origin_guard.ts";
import { pathWithin } from "./path_guard.ts";
import { randomBytes } from "node:crypto";
import { buildRecall } from "../harness/memory/recall.ts";
import { Db } from "../harness/memory/db.ts";
import type { ImportVendor } from "../harness/personal/import_adapters.ts";
import type { CuiDesignation } from "../harness/export/vault_export.ts";

applyEnv(); // make stored API keys available to a spawned omp acp
if (loadSettings().headroomEnabled) startHeadroom(); // resume the opt-in compression proxy

function ompBin(): string {
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) if (existsSync(c)) return c;
  return "omp";
}

const ROOT = join(import.meta.dir, "renderer");
const PORT = Number(process.env.PORT ?? 5319);
// ADR-0024: per-launch capability token. Minted once per server process, injected into the served
// HTML (only a same-origin document can read it), and required on every sensitive /api call. A new
// random value each launch means a token never outlives the process that issued it.
const TOKEN = randomBytes(32).toString("hex");
const CT: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };

// ADR-0009 Phase A — hand the cross-session recall block to the backend for first-user-turn
// injection (never the frozen prefix; invariant #5/#6). READ-ONLY: the omp gate child is the
// single writer of agent_obs.duckdb, so we open read-only and omit the sessionId — no
// fact_sessions write, hence no two-process DuckDB write contention. Best-effort: a recall
// failure clears recall (setRecall(null)) and never breaks chat.
async function refreshRecall(): Promise<void> {
  try {
    if (!existsSync(OBS_DB_PATH)) { backend.setRecall(null); return; }
    const db = await Db.openReadOnly(OBS_DB_PATH);
    try {
      const { block } = await buildRecall(db, { limit: 20 });
      backend.setRecall(block);
    } finally {
      db.close();
    }
  } catch {
    backend.setRecall(null);
  }
}

// Render a build failure AS the script body so the page shows the real error instead of nothing.
function bundleError(msg: string): { js: string; ok: boolean } {
  return { ok: false, js: `document.body.innerHTML='<pre style="color:#ef5f5f;padding:20px;font:13px monospace;white-space:pre-wrap">'+${JSON.stringify(msg)}+'</pre>';` };
}
async function bundleApp(): Promise<{ js: string; ok: boolean }> {
  try {
    const out = await Bun.build({ entrypoints: [join(ROOT, "app.ts")], target: "browser", sourcemap: "inline" });
    if (!out.success) return bundleError(out.logs.map((l) => String(l)).join("\n"));
    return { ok: true, js: await out.outputs[0]!.text() };
  } catch (e) {
    // A THROW from Bun.build (e.g. an unresolved import in a packaged build where a renderer dep
    // wasn't bundled) must NOT fall through to the generic JSON error handler — that ships as
    // <script>{"ok":false,...}</script>, an invalid-JS blob that leaves the window a silent dark
    // shell (the katex-missing dark-screen bug). Surface the real error in the page instead.
    return bundleError(`Renderer build failed:\n${String((e as Error)?.stack ?? e)}`);
  }
}

const json = (data: unknown) =>
  new Response(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// Typed read of a POST JSON body. Bun types `req.json()` as `unknown`; this helper is the single
// place that cast lives, so each handler below names the exact shape it expects and stays strict.
// Fields the handler funnels through String()/typeof guards are left `unknown` (the guard narrows them).
async function readBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

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
  // On a SUCCESSFUL login the credential lands in omp's vault, but the already-running omp child
  // built its model list at spawn and won't see it. Respawn so the new provider's models surface
  // (mirrors what adding an API key does). The front-end re-fetches /api/config after the badge flips.
  proc.exited.then((code) => { if (code === 0) backend.restart(); }).catch(() => { /* ignore */ });
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
  hostname: "127.0.0.1", // H1 (ADR-0022): loopback only — this control plane handles keys/passphrases.
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    // H2 (ADR-0022): reject anything a web page or DNS-rebind could forge against
    // the fixed local port (foreign Host/Origin, or a non-JSON state-changing body).
    if (!isAllowedRequest(reqShape(req), PORT)) return new Response("forbidden", { status: 403 });
    // ADR-0024: the sensitive /api surface additionally requires the per-launch token (carried by
    // the renderer from the injected HTML). /api/health is exempt — main.ts polls it before the
    // page (and thus the token) exists, and it returns no data. Static assets/HTML aren't /api/*.
    if (p.startsWith("/api/") && p !== "/api/health" && !tokenValid(req.headers.get("x-lucid-token"), TOKEN))
      return new Response("forbidden", { status: 403 });
    try {
      if (p === "/app.js") {
        const { js } = await bundleApp();
        return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      }
      // P-IDE.4 (ADR-0029): serve the vendored Monaco editor (AMD min build) from node_modules so it's
      // local/airgap-clean without committing ~16MB. The read-only viewer runs Monaco on the main thread
      // (no language-service worker). This route reads from THIS server's dir (resources/repo/desktop in
      // a packaged build), so the bundle MUST keep desktop/node_modules/monaco-editor/min — the repo
      // extraResources filter re-includes it past the desktop/node_modules exclusion (electron-builder
      // applies filters in order). The app.asar `files` copy is unreachable from here. Without the
      // re-include this 404s in the installed app (the editor never loads) while working in dev.
      if (p.startsWith("/vendor/monaco/")) {
        const base = join(import.meta.dir, "node_modules", "monaco-editor", "min", "vs");
        const target = join(base, p.slice("/vendor/monaco/".length));
        if (!pathWithin(base, target)) return new Response("forbidden", { status: 403 }); // no path traversal
        const f = Bun.file(target);
        if (await f.exists()) {
          const ext = target.slice(target.lastIndexOf("."));
          return new Response(f, { headers: { "content-type": (CT[ext] ?? "application/octet-stream") + "; charset=utf-8", "cache-control": "max-age=86400" } });
        }
        return new Response("not found", { status: 404 });
      }
      // Security snapshot + the GUI-owned LIVE gate blocks (ADR-0019 C). Live blocks are merged
      // in even when the DuckDB snapshot is null, so a fresh machine still shows quarantines.
      if (p === "/api/security") {
        const snap = await securitySnapshot();
        return json({ ok: true, data: { ...(snap ?? {}), live: liveBlocks() } });
      }
      // Audited fail-closed override: release one quarantined call (ADR-0019 C).
      if (p === "/api/security/approve" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); return json({ ok: true, data: approveBlock(String(b.id ?? "")) }); }
      if (p === "/api/memory") return json({ ok: true, data: await memorySnapshot() });
      // P-MCP.1 (ADR-0020): MCP server registry. The hub does auth + config assembly only; omp owns
      // the MCP transport (configs ride session/new.mcpServers). Changes respawn omp to apply. The
      // list NEVER returns raw tokens (masked status only — like provider keys).
      if (p === "/api/mcp") {
        if (req.method === "POST") {
          const b = await readBody<{ id?: string; name?: unknown; transport?: unknown; url?: unknown; token?: unknown; enabled?: boolean }>(req);
          const e = upsertMcpServer({ id: b.id, name: String(b.name ?? ""), transport: b.transport === "sse" ? "sse" : "http", url: String(b.url ?? ""), token: b.token != null ? String(b.token) : undefined, enabled: b.enabled });
          backend.restart(); // omp re-reads mcpServers on the next session
          return json({ ok: true, data: { id: e.id, name: e.name, transport: e.transport, url: e.url, enabled: e.enabled, hasToken: !!e.token } });
        }
        return json({ ok: true, data: listMcpServers().map((e) => ({ id: e.id, name: e.name, transport: e.transport, url: e.url, enabled: e.enabled, hasToken: !!e.token, tokenLast4: e.token ? e.token.slice(-4) : undefined })) });
      }
      if (p === "/api/mcp/remove" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); removeMcpServer(String(b.id ?? "")); backend.restart(); return json({ ok: true }); }
      if (p === "/api/mcp/toggle" && req.method === "POST") { const b = await readBody<{ id?: unknown; enabled?: unknown }>(req); setMcpServerEnabled(String(b.id ?? ""), !!b.enabled); backend.restart(); return json({ ok: true }); }
      // ADR-0009 Phase D: developer-mode logging view. GET is gated server-side on developerMode
      // (returns null when off); POST {enabled} flips the mode. Read-only, metadata-only.
      if (p === "/api/dev") {
        if (req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); return json({ ok: true, data: setDeveloperMode(!!b.enabled) }); }
        if (!loadSettings().developerMode) return json({ ok: true, data: { enabled: false, snapshot: null, blocks: { quarantined: [], approved: [], total: 0 }, turns: [] } });
        return json({ ok: true, data: { enabled: true, snapshot: await devSnapshot(), blocks: liveBlocks(), turns: recentTurns() } });
      }
      // Light, fast re-read of the provider rate-limit budget (omp's agent.db).
      // Used by the front-end's manual refresh + 5-minute auto-poll.
      if (p === "/api/budget") return json({ ok: true, data: rateLimits() });
      // P10.3: live rate-limit probe for API-KEY providers (opt-in). GET returns probed limits
      // (cached 5 min; [] when off); POST {enabled} flips the opt-in.
      if (p === "/api/ratelimits") {
        if (req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); return json({ ok: true, data: setRateLimitProbe(!!b.enabled) }); }
        return json({ ok: true, data: { enabled: !!loadSettings().rateLimitProbe, limits: await probeRateLimits(url.searchParams.get("force") === "1") } });
      }
      // P10.2: cross-model usage & cost ledger (per-model totals + estimated cache savings).
      if (p === "/api/usage") return json({ ok: true, data: usageLedger() });
      if (p === "/api/health") return json({ ok: true });
      // In-app folder browser (works in the browser build AND Electron — the dev server
      // reads the local FS in both). Lists subdirectories + flags git repos, for Workspace.
      if (p === "/api/fs/list") {
        // M1 (ADR-0022): the folder browser is confined to the user's home subtree.
        // pathWithin canonicalizes (collapsing any ../) and rejects anything outside,
        // so the request path can't turn this into an arbitrary directory-listing oracle.
        const want = url.searchParams.get("path");
        const safe = want ? pathWithin(homedir(), want) : null;
        const base = safe && existsSync(safe) ? safe : homedir();
        const dirs: { name: string; path: string; isGit: boolean }[] = [];
        try {
          for (const name of readdirSync(base)) {
            if (name.startsWith(".")) continue; // hide dotfiles
            const full = join(base, name);
            try { if (statSync(full).isDirectory()) dirs.push({ name, path: full, isGit: existsSync(join(full, ".git")) }); } catch { /* unreadable */ }
          }
        } catch { /* unreadable dir */ }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        const parentDir = dirname(base);
        const parent = parentDir !== base && pathWithin(homedir(), parentDir) ? parentDir : null; // never offer a parent above home
        return json({ ok: true, data: { path: base, parent, home: homedir(), isGit: existsSync(join(base, ".git")), dirs } });
      }

      // real omp ACP backend (genuine model replies + live session config)
      if (p === "/api/sessions") return json({ ok: true, data: listSessions() });
      if (p === "/api/session" && url.searchParams.get("id")) return json({ ok: true, data: sessionMessages(url.searchParams.get("id")!) });
      if (p === "/api/session/load" && req.method === "POST") { const { id } = await readBody<{ id?: unknown }>(req); await backend.loadSession(String(id)); return json({ ok: true }); }

      // workspace (the folder the agent works in; local or cloned remote)
      if (p === "/api/workspace") {
        if (req.method === "POST") { const b = await readBody<{ path?: unknown }>(req); setWorkspace(String(b.path ?? "")); backend.restart(); }
        return json({ ok: true, data: workspaceInfo() });
      }
      if (p === "/api/workspace/clone" && req.method === "POST") {
        const { url } = await readBody<{ url?: unknown }>(req);
        const r = await cloneRepo(String(url ?? ""));
        if (r.ok && r.path) { setWorkspace(r.path); backend.restart(); }
        return json({ ok: r.ok, data: { ...workspaceInfo(), cloned: r.ok, error: r.error } });
      }

      // settings + provider auth
      if (p === "/api/settings") {
        if (req.method === "POST") {
          const b = await readBody<{ skip?: unknown; email?: unknown; username?: unknown }>(req);
          // Enforce enterprise-managed attribution policy server-side (the UI also reflects it).
          if (b.skip && !skipAllowed()) return json({ ok: false, error: "Your organization requires a corporate email.", data: { username: loadSettings().username ?? "", email: loadSettings().email ?? "", attribution: attribution() } });
          if (b.email != null && String(b.email).trim() && !emailDomainAllowed(String(b.email))) {
            const ds = managedConfig().config?.attribution?.allowedEmailDomains ?? [];
            return json({ ok: false, error: `Use your corporate email${ds.length ? " (" + ds.map((d) => "@" + d).join(", ") + ")" : ""}.`, data: { username: loadSettings().username ?? "", email: loadSettings().email ?? "", attribution: attribution() } });
          }
          if (b.skip) setAttributionSkip(); // user skipped the email prompt → workstation attribution
          else setProfile({ username: b.username != null ? String(b.username) : undefined, email: b.email != null ? String(b.email) : undefined });
        }
        const s = loadSettings();
        return json({ ok: true, data: { username: s.username ?? "", email: s.email ?? "", attribution: attribution() } });
      }
      // Enterprise-managed policy (read-only; placed by admins via GPO/MDM). Sanitized — policy only.
      if (p === "/api/managed") {
        const mc = managedConfig();
        return json({ ok: true, data: { managed: !!mc.config, orgName: typeof mc.config?.orgName === "string" ? mc.config.orgName : "", attribution: mc.config?.attribution ?? null, asksageOnly: !!mc.config?.asksageOnly } });
      }
      // P-IDE.1c (ADR-0029): the China-origin data-sovereignty acknowledgement gate. GET returns the
      // flag; POST {acknowledge:true} after the user types ACKNOWLEDGE unlocks those models in the picker.
      if (p === "/api/china-ack") {
        if (req.method === "POST") { const b = await readBody<{ acknowledge?: unknown }>(req); return json({ ok: true, data: { acknowledged: !!setChinaModelsAcknowledged(!!b.acknowledge).chinaModelsAcknowledged } }); }
        return json({ ok: true, data: { acknowledged: chinaModelsAcknowledged() } });
      }
      if (p === "/api/auth") return json({ ok: true, data: providerAuth() });
      if (p === "/api/auth/key" && req.method === "POST") {
        const { env, key } = await readBody<{ env?: unknown; key?: unknown }>(req);
        setKey(String(env), String(key ?? ""));
        backend.restart(); // pick up the new env on next turn
        return json({ ok: true, data: providerAuth() });
      }
      if (p === "/api/auth/oauth" && req.method === "POST") {
        const { oauthId } = await readBody<{ oauthId?: unknown }>(req);
        // omp owns the secure OAuth flow; the broker stays alive + drained until the callback lands.
        return json({ ok: true, data: await startOauthBroker(String(oauthId)) });
      }
      if (p === "/api/auth/logout" && req.method === "POST") {
        const { oauthId } = await readBody<{ oauthId?: unknown }>(req);
        Bun.spawnSync([ompBin(), "auth-broker", "logout", String(oauthId)], { timeout: 4000 });
        return json({ ok: true, data: providerAuth() });
      }
      // AskSage gov gateway (ADR-0007)
      if (p === "/api/asksage") {
        if (req.method === "POST") {
          const b = await readBody<{ baseUrl?: unknown; only?: unknown; limit?: unknown; datasets?: unknown; queryModel?: unknown; persona?: unknown }>(req);
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
        const { id, clear } = await readBody<{ id?: unknown; clear?: unknown }>(req);
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
      // Manual "Refresh models": respawn omp so it re-reads the credential vault, then return the
      // fresh model list. Used after connecting a provider (OAuth or key) without relaunching.
      if (p === "/api/config/refresh" && req.method === "POST") { backend.restart(); return json({ ok: true, data: await backend.getConfig() }); }
      if (p === "/api/commands") return json({ ok: true, data: await backend.getCommands() });
      if (p === "/api/skills") return json({ ok: true, data: await listSkills() });
      if (p === "/api/headroom") {
        if (req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); return json({ ok: true, data: setHeadroomEnabled(!!b.enabled) }); }
        return json({ ok: true, data: headroomStatus() });
      }
      // Personalization knowledge graph (ADR-0010 P9.1 / ADR-0012). Passphrase custody;
      // the passphrase never leaves this handler and is never persisted.
      if (p === "/api/personal") return json({ ok: true, data: personalStatus() });
      if (p === "/api/personal/enable" && req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); return json({ ok: true, data: enablePersonal(!!b.enabled) }); }
      if (p === "/api/personal/setup" && req.method === "POST") { const b = await readBody<{ passphrase?: unknown }>(req); return json({ ok: true, data: setupPersonal(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/unlock" && req.method === "POST") { const b = await readBody<{ passphrase?: unknown }>(req); return json({ ok: true, data: unlockPersonal(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/lock" && req.method === "POST") return json({ ok: true, data: lockPersonal() });
      if (p === "/api/personal/scope" && req.method === "POST") { const b = await readBody<{ scope?: unknown }>(req); return json({ ok: true, data: setScope(String(b.scope ?? "personal") as any) }); }
      // P9.5a: the isolated CUI store has its OWN setup/unlock/lock (separate file + passphrase).
      if (p === "/api/personal/cui/setup" && req.method === "POST") { const b = await readBody<{ passphrase?: unknown }>(req); return json({ ok: true, data: setupCui(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/cui/unlock" && req.method === "POST") { const b = await readBody<{ passphrase?: unknown }>(req); return json({ ok: true, data: unlockCui(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/cui/lock" && req.method === "POST") return json({ ok: true, data: lockCui() });
      // P9.5b: audited migration (move legacy cui out of the main store) + records destruction.
      if (p === "/api/personal/cui/migrate" && req.method === "POST") return json({ ok: true, data: migrateCuiIntoStore() });
      if (p === "/api/personal/cui/destroy" && req.method === "POST") return json({ ok: true, data: destroyCui() });
      if (p === "/api/personal/graph") return json({ ok: true, data: personalGraph((url.searchParams.get("scope") ?? undefined) as any) });
      if (p === "/api/personal/forget" && req.method === "POST") { const b = await readBody<{ factId?: unknown }>(req); return json({ ok: true, data: forgetFact(String(b.factId ?? "")) }); }
      // P9.7: import a ChatGPT / Claude / Gemini export (folder, .json, or .zip). Every imported
      // user message is scanned by the fail-closed gate first. `model:true` runs the richer LLM
      // extractor via a throwaway omp completion (capped); otherwise the offline heuristic.
      if (p === "/api/personal/import" && req.method === "POST") {
        const b = await readBody<{ model?: unknown; path?: unknown; vendor?: ImportVendor }>(req);
        const complete = b.model ? (system: string, user: string) => backend.complete(system, user) : undefined;
        return json({ ok: true, data: await importChatExport(String(b.path ?? ""), { vendorHint: b.vendor, complete }) });
      }
      // P-IMP.2 (ADR-0035): read-only pre-import estimate (message + char counts) so the renderer can
      // warn about AI-mode token cost + runtime before the capped, paid model extraction runs.
      if (p === "/api/personal/import/estimate" && req.method === "POST") {
        const b = await readBody<{ path?: unknown }>(req);
        return json({ ok: true, data: await estimateChatExport(String(b.path ?? "")) });
      }
      // P-IDE.5 (ADR-0036): gated read/write for the in-app code editor. Reads + writes are confined to
      // the workspace; saves pass through the fail-closed scanner gate before anything touches disk.
      if (p === "/api/editor/file" && req.method === "POST") {
        const b = await readBody<{ path?: unknown }>(req);
        return json({ ok: true, data: readEditorFile(String(b.path ?? "")) });
      }
      if (p === "/api/editor/save" && req.method === "POST") {
        const b = await readBody<{ path?: unknown; content?: unknown; baseSha?: unknown; overwrite?: unknown }>(req);
        return json({ ok: true, data: await saveEditorFile({ path: String(b.path ?? ""), content: String(b.content ?? ""), baseSha: b.baseSha != null ? String(b.baseSha) : undefined, overwrite: !!b.overwrite }) });
      }
      // P9.4: audited decrypt→export. Vault excludes CUI unless explicitly listed; the
      // CUI archive is a separate, loud, NARA-aligned records-management path.
      if (p === "/api/personal/vault" && req.method === "POST") {
        const b = await readBody<{ scopes?: unknown; dest?: unknown; reviewer?: unknown }>(req);
        const scopes = Array.isArray(b.scopes) ? b.scopes.map(String).filter((x: string) => x === "personal" || x === "work" || x === "cui") : undefined;
        return json({ ok: true, data: exportVault({ scopes, dest: typeof b.dest === "string" ? b.dest : undefined, reviewer: typeof b.reviewer === "string" ? b.reviewer : undefined }) });
      }
      if (p === "/api/personal/cui-archive" && req.method === "POST") {
        const b = await readBody<{ dest?: unknown; reviewer?: unknown; designation?: CuiDesignation }>(req);
        return json({ ok: true, data: exportCuiArchive({ dest: typeof b.dest === "string" ? b.dest : undefined, reviewer: typeof b.reviewer === "string" ? b.reviewer : undefined, designation: typeof b.designation === "object" && b.designation ? b.designation : undefined }) });
      }
      if (p === "/api/personal/exports") return json({ ok: true, data: exportHistory() });
      if (p === "/api/setConfig" && req.method === "POST") { const { configId, value } = await readBody<{ configId: string; value: string }>(req); return json({ ok: true, data: await backend.setConfig(configId, value) }); }
      // P-ACP.2 (ADR-0027): ACP session modes (Plan / Agent). GET lists them + the active one;
      // POST {modeId} switches via session/set_mode.
      if (p === "/api/modes") {
        if (req.method === "POST") { const b = await readBody<{ modeId?: unknown }>(req); return json({ ok: true, data: await backend.setMode(String(b.modeId ?? "default")) }); }
        return json({ ok: true, data: await backend.getModes() });
      }
      // P-ACP.3: the composer's 3-way Plan/Ask/Agent. Ask = omp `default` + per-tool approval prompts.
      if (p === "/api/uimode" && req.method === "POST") {
        const b = await readBody<{ uiMode?: unknown }>(req);
        const m = b.uiMode === "ask" ? "ask" : b.uiMode === "plan" ? "plan" : "agent";
        return json({ ok: true, data: await backend.setUiMode(m) });
      }
      // P-ACP.3: the renderer's answer to a forwarded tool-permission request (Ask mode). optionId
      // empty/absent ⇒ deny (fail-closed).
      if (p === "/api/chat/permission" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; optionId?: unknown }>(req);
        return json({ ok: true, data: { resolved: backend.resolvePermission(String(b.id ?? ""), b.optionId != null ? String(b.optionId) : null) } });
      }
      // P-ACP.4: Stop — interrupt the in-flight turn (reply + tool calls) via ACP session/cancel.
      if (p === "/api/chat/cancel" && req.method === "POST") { backend.cancel(); return json({ ok: true, data: { cancelled: true } }); }
      // P-IDE.2 (ADR-0029): set/clear the active BUNDLED skill. Its prompt is TRUSTED (app corpus), so
      // it's wrapped in `<active-skill>` and delivered as a user-turn preamble (persona/recall path) —
      // never the frozen prefix. Clearing passes {clear:true}.
      if (p === "/api/skill" && req.method === "POST") {
        const b = await readBody<{ name?: unknown; prompt?: unknown; clear?: unknown }>(req);
        if (b.clear) { backend.setSkill(null); return json({ ok: true, data: { active: "" } }); }
        const name = String(b.name ?? "").slice(0, 80);
        const prompt = String(b.prompt ?? "").slice(0, 8000);
        if (!name || !prompt) return json({ ok: false, error: "name + prompt required" });
        backend.setSkill(`<active-skill name="${name.replace(/"/g, "&quot;")}">\n${prompt}\n</active-skill>`, name);
        return json({ ok: true, data: { active: backend.activeSkillName() } });
      }
      // P-IDE.3 (ADR-0029): record a skill activation as telemetry (metadata only — command/name/source).
      if (p === "/api/skill/activated" && req.method === "POST") {
        const b = await readBody<{ command?: unknown; name?: unknown; source?: unknown }>(req);
        const source = b.source === "project" || b.source === "task" ? b.source : "bundled";
        recordSkillActivated({ command: String(b.command ?? "").slice(0, 80), name: String(b.name ?? "").slice(0, 80), source });
        return json({ ok: true, data: { recorded: true } });
      }
      // ADR-0009 Phase A: re-load the cross-session recall block for the fresh session (read-only).
      if (p === "/api/newSession" && req.method === "POST") { await backend.newSession(); await refreshRecall(); return json({ ok: true }); }
      if (p === "/api/chat" && req.method === "POST") {
        const { text } = await readBody<{ text?: unknown }>(req);
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
      // ADR-0024: serve the HTML with the per-launch token injected as a meta tag. Same-origin
      // policy keeps a cross-origin page from reading this response body, so the token stays secret
      // to the real renderer; no-store so it's never cached across launches.
      if (rel === "index.html") {
        const html = (await Bun.file(join(ROOT, "index.html")).text())
          .replace("</head>", `  <meta name="lucid-token" content="${TOKEN}">\n</head>`);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      const file = Bun.file(join(ROOT, rel));
      if (await file.exists()) {
        const ext = rel.slice(rel.lastIndexOf("."));
        return new Response(file, { headers: { "content-type": (CT[ext] ?? "application/octet-stream") + "; charset=utf-8" } });
      }
    } catch (err) {
      // js/stack-trace-exposure: log the detail server-side, return a generic message to the client
      // so an internal error/stack never reaches the renderer (or a forged caller).
      console.error(`[dev] ${p}:`, err);
      return json({ ok: false, error: "internal error" });
    }
    return new Response("not found", { status: 404 });
  },
});

// Build recall once at startup — the FIRST session is created lazily on the first /api/chat (never
// via /api/newSession), so this is what carries prior-session facts into it. Best-effort; the omp
// child isn't spawned yet here, so the read-only open is uncontended.
await refreshRecall();

console.log(`\n  ◆ LucidAgentIDE desktop renderer (dev)\n  → http://localhost:${server.port}\n`);
