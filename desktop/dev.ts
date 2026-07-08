// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/dev.ts
//
// Dev/preview server for the desktop renderer. Serves the static renderer,
// bundles renderer/app.ts → /app.js on the fly (Bun.build, browser target), and
// exposes the same live /api/security + /api/memory used by the web dashboard.
// Electron loads this exact renderer; this server makes it runnable + screenshot-
// able in a plain browser (the bridge falls back to simulated chat there).
//
//   bun run desktop:web        # http://localhost:5319

import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildEngineeringUpdate, renderEngineeringBrief, buildPodcastScript, renderScript, type PodcastBackend, type BriefRole } from "../harness/brief/engineering_update.ts";
import { buildComplianceRows, renderPoamCsv, renderCkl } from "../harness/brief/compliance.ts"; // P-REPORT.6/.8: POA&M + CKL
import { renderTurnEvalReport, type ObservedTool, type ObservedTurn } from "../harness/brief/eval_report.ts"; // P-CHAT.C (ADR-0190): settled-turn Model-Evaluation report
import { buildChangeGraph, buildSchemaChanges, renderAnnexes } from "../harness/brief/change_graph.ts"; // P-REPORT.8: report annexes
import { renderRepoActivityAnnex } from "../harness/brief/repo_activity.ts"; // P-REPORT.9: cross-repo activity annex
import { addReportRepo, collectRepoActivity, ghAvailable, listReportRepos, type RepoSelection } from "./repo_collect.ts"; // P-REPORT.9 (ADR-0162)
import { loadChatBg, saveChatBg, type ChatBg } from "./chat_bg.ts"; // P-APPEAR.1: personalized chat background
import { ingestCodeGraph, loadCodeGraph } from "./code_graph.ts"; // P-KG-CODE.1: workspace code graph
import { ingestSymbolGraph, loadSymbolGraph } from "./symbol_graph.ts"; // P-KG-SYM.1: AST symbol graph
import { assessSystem, sampleSystem, topProcesses, type ProcGroup, type SystemSnapshot, type SystemVerdict } from "./system_profile.ts"; // P-SYSRES.1: resource guard
import { saveSpecFile, loadSpecFile, listSpecFiles, deleteSpecFile, saveSpecTrust, loadSpecTrust, listSpecHistory, loadSpecRevision } from "../harness/agent/file_store.ts"; // P-AGENT.2b/.9/.17: spec persistence + trust sidecar + revisions
import { validateSpec } from "../harness/agent/spec.ts"; // P-AGENT.1: fail-closed Agent Spec validation
import { buildAgent } from "../harness/agent/compiler.ts"; // P-AGENT.3: spec -> AgentBundle
import { exportBundle, writeExportPackage, EXPORT_TARGETS, type ExportTarget } from "../harness/agent/export.ts"; // P-AGENT.6: enterprise export
import { exportPortableAgent, parsePortableAgentJson, setupInstructions } from "../harness/agent/portable.ts"; // P-AGENT.9: shareable .lucid-agent JSON
import { specToN8n, n8nToSpec, isN8nWorkflowJson } from "../harness/agent/n8n.ts"; // P-AGENT.10: n8n interop
import { connectorStatus, runConnector } from "./addon_seam.ts"; // P-AGENT.10: enterprise add-on seam
import { importSpec } from "../harness/agent/import_gate.ts"; // P-AGENT.5/.9: fail-closed imported spec scan + trust label
import { ScannerClient } from "../harness/security/scanner_client.ts";
import { startAgentRun, approveAgentRun } from "./agent_run.ts"; // P-AGENT.4-live/.11a: gated runs + enforced approval halts
import { listTraces, loadTrace } from "../harness/agent/trace.ts"; // P-AGENT.13: run traces
import { probeEnabledServers } from "./mcp_probe.ts"; // P-AGENT.12: MCP tool discovery for the Builder catalog
import { archiveBrief, deleteBrief, listBriefs, readBrief, restoreBrief, saveBrief } from "./report_store.ts";
import { OpenAiCompatibleTtsBackend } from "../harness/brief/tts_backend.ts";
import { ElevenLabsTtsBackend, ElevenLabsSttBackend, listElevenVoices } from "../harness/voice/elevenlabs.ts";
import { OpenAiCompatibleSttBackend, type TranscriptionBackend } from "../harness/voice/transcription.ts";
import { devSnapshot, securitySnapshot } from "../tools/web/data.ts";
import { sandboxStatus } from "./sandbox_status.ts"; // P-SANDBOX.5 (ADR-0169)
import { ensureNetdiagWatch, startNetdiagWatch, stopNetdiagWatch, netdiagView } from "./netdiag.ts";
import { clearDisabledCredential } from "./auth_vault.ts";
import { approveBlock, dismissBlock, liveBlocks } from "./security_log.ts";
import { ackArtifact, ackFindings, ackView } from "./security_ack.ts"; // P-SECACK.1 (ADR-0170)
import { deleteSteps, readTurnSteps, syncStepTurns } from "./session_steps.ts"; // P-RESUME.1 (ADR-0171)
import { probeRateLimits } from "./ratelimit_probe.ts";
import { OBS_DB_PATH, codeActivity, memorySnapshot, rateLimits, sessionPathById, usageLedger } from "../tools/memory_data.ts";
import { backend } from "./acp_backend.ts";
import { clearIngestSessions, deleteSession, listSessions, sessionMessages } from "./sessions.ts";
import { providerAuth } from "./auth_status.ts";
import { cloneRepo, setWorkspace, workspaceInfo } from "./workspace.ts";
import { egressAllowAllManaged, egressDecision, egressPosture } from "./egress_policy.ts"; // P-PREVIEW.3b + P-NETWL.5
import { loadWhitelist, removeEntry, saveWhitelist, setPosture, upsertEntry, type WhitelistEntry } from "./network_whitelist.ts"; // P-NETWL.2/.5: whitelist CRUD + posture
import { readPreviewFile, toFsPath } from "./preview_file.ts"; // P-PREVIEW.4: read a local file's content for the preview
import { PREVIEW_FRAME_CSP } from "./preview_resolve.ts"; // P-PREVIEW.4b: per-frame CSP for the served preview doc
import { inlinePreviewAssets } from "./preview_inline.ts"; // P-PREVIEW.4c: fold a multi-file app's relative assets inline
import { injectPreviewBridge } from "./preview_bridge.ts"; // P-PREVIEW.6b (ADR-0153): read-only DOM-inspect bridge
import { InspectRelay } from "./preview_inspect_relay.ts"; // P-PREVIEW.6b: agent preview_inspect ↔ renderer relay
import { parseFigmaFileKey, collectTopFrames, figmaBoardHtml, FIGMA_API, type BoardFrame } from "./figma_client.ts"; // P-FIGMA.1 (ADR-0154)
import { designDocPath, DESIGN_DOC_NAME } from "./design_doc.ts"; // P-FIGMA.2 / P-DESIGN.1 (ADR-0154)
import { listLocalProviders, upsertLocalProvider, removeLocalProvider, setLocalProviderEnabled } from "./settings_store.ts";
import { providerModelsUrl, type LocalProviderDef } from "./local_providers.ts";
import { listRemoteAgents, upsertRemoteAgent, removeRemoteAgent, setRemoteAgentEnabled } from "../harness/mcp/registry.ts";
import { applyEnv, attribution, chinaModelsAcknowledged, listMcpServers, load as loadSettings, removeMcpServer, roleChosen, setAsksage, setAttributionSkip, setChinaModelsAcknowledged, setCodeGraphAgent, setDeveloperMode, setKey, setMcpServerEnabled, setPersonalAiExtract, setProfile, setRateLimitProbe, setThirdPartyProvidersAcknowledged, setTourSeen, setUserRole, setVoiceSettings, thirdPartyProvidersAcknowledged, tourSeen, upsertMcpServer, USER_ROLES, userRole, voiceSettings, type UserRole } from "./settings_store.ts";

// ADR-0088/0089: the /api/settings payload — profile + attribution + the cosmetic role/tour state.
// `role` is null until the user has EXPLICITLY chosen one (so the renderer can fire the first-run role
// picker); once chosen it's the concrete role. tourSeen guards the first-run walkthrough replay.
function settingsData() {
  const s = loadSettings();
  return { username: s.username ?? "", email: s.email ?? "", attribution: attribution(), role: roleChosen() ? userRole() : null, tourSeen: tourSeen() };
}
import { emailDomainAllowed, managedAsksageOnly, managedConfig, managedLocks, skipAllowed } from "./managed_config.ts";
import { asksageConfig, listDatasets, listPersonas, monthlyTokens, scanPersona, wrapPersona } from "./asksage.ts";
import { inspectSkill, listSkills, removeSkill, rescanSkill } from "./skills_data.ts"
import { intelNews } from "./intel_news.ts"; // P-TRIV.3 (ADR-0176): the executive Trivia Wire's news feed
import { seedTrivia } from "./trivia_seed.ts"; // P-TRIV.4 (ADR-0186): AI re-seed the Trivia Wire (scanned, tool-free)
import { detectElectronApp, electronLaunchPlan } from "./preview_electron.ts"; // P-PREVIEW.7 (ADR-0179)
import { listSubagentRuns } from "./subagent_activity.ts"; // P-TASK.5 (ADR-0180): live delegation-card activity
import { emitSecurityEvent } from "./audit_export.ts"; // P-PREVIEW.7: audit the user-initiated external launch
import { spawn as spawnChild } from "node:child_process";
import { installRegistrySkill, type RegistrySkillArtifact } from "./skills_registry.ts"
import { analyzeWork, codifyCandidate, gatherWorkDigest, type SkillCandidate, type StudioWindow } from "./skill_studio.ts"
import { buildSkillArtifact, PublishDispatcher, publishersFor } from "./skill_publish.ts";
import { kbScanner, kbStore } from "./kb_store.ts"
import { ingestDocument } from "../harness/kb/ingest.ts"
import { retrieveKnowledge, type RetrieveMode } from "../harness/kb/retrieve.ts"
import { recordBlock } from "./security_log.ts"
import { importSkill } from "./skills_import.ts";
import { createUserCommand, deleteUserCommand, listUserCommands } from "./user_commands.ts"; // P-CMD.1
import { archiveGoalReport, deleteGoalReport, listResumableLoops, listGoalReports, readGoalReport, restoreGoalReport } from "./goal_memory.ts";
import { createAutomation, deleteAutomation, listAutomations, normalizeCadence, updateAutomation } from "./automations.ts";
import { currentWorkspace } from "./workspace.ts";
import { recordSkillActivated } from "./skills_log.ts";
import { recentTurns } from "./turns_log.ts";
import { headroomStatus, setHeadroomEnabled, startHeadroom } from "./headroom.ts";
import { addReportToKg, destroyCui, enablePersonal, estimateChatExport, exportCuiArchive, exportHistory, exportVault, forgetFact, importChatExport, lockCui, lockPersonal, migrateCuiIntoStore, personalGraph, personalStatus, relateEntities, setScope, setupCui, setupPersonal, unlockCui, unlockPersonal, unrelateEntities } from "./personal.ts";
import { explainCommand } from "./explain_command.ts";
import type { PersonalScope } from "../harness/personal/store.ts";
import { readEditorFile, saveEditorFile } from "./editor.ts";
import { cancelImport, importJobStatus, startImport } from "./import_job.ts";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { listDir } from "./fs_browse.ts";
import { DIAL_TYPES, type LoopDial } from "./exec_policy.ts";
import { audit } from "./audit_export.ts";
import { isRiskTier, managedWorkspaceRoots } from "./managed_config.ts";
import { isAllowedRequest, reqShape, tokenValid } from "./origin_guard.ts";

/** Sanitize an untrusted /api/goal `dial` payload into a LoopDial — only known command types + valid
 *  risk tiers survive; everything else is dropped (the backend clamps it by the managed ceiling anyway). */
function parseLoopDial(raw: unknown): LoopDial | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: LoopDial = {};
  for (const t of DIAL_TYPES) {
    const v = (raw as Record<string, unknown>)[t];
    if (isRiskTier(v)) out[t] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
import { pathWithin } from "./path_guard.ts";
import { randomBytes } from "node:crypto";
import { buildRecall } from "../harness/memory/recall.ts";
import { Db } from "../harness/memory/db.ts";
import type { ImportVendor } from "../harness/personal/import_adapters.ts";
import type { CuiDesignation } from "../harness/export/vault_export.ts";

applyEnv(); // make stored API keys available to a spawned omp acp
if (loadSettings().headroomEnabled) startHeadroom(); // resume the opt-in compression proxy

// 30s memo for /api/code-activity — each rebuild spawns `git log` per workspace (ADR-0030 P-CODE.1).
let codeActivityCache: { at: number; data: ReturnType<typeof codeActivity> } | null = null;

// 5s memo for /api/system — the process listing spawns one fixed-argv command (ADR-0182 P-SYSRES.1).
let sysResCache: { at: number; data: { snap: SystemSnapshot; verdict: SystemVerdict; procs: ProcGroup[] } } | null = null;

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
// P-PREVIEW.3a-shot (ADR-0096): latest PNG of the rendered preview, pushed by the renderer after each render
// (Electron capturePage → /api/preview/shot-cache) and read by the agent's preview_screenshot tool. In-memory.
let latestPreviewShot: string | null = null;
// P-PREVIEW.6b (ADR-0153): relay for the agent's read-only DOM inspect of the sandboxed preview.
const inspectRelay = new InspectRelay();
const CT: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
// Text-ish types take a charset; binary (images/fonts) must not (a bogus "image/png; charset" suffix).
const isTextCT = (ct: string) => /^(text\/|application\/(javascript|json)|image\/svg)/.test(ct);

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
    // shell (the katex-missing dark-screen bug). Surface the error MESSAGE in the page; the full
    // stack stays in the server log (CodeQL js/stack-trace-exposure — never ship stack frames).
    console.error("[bundleApp] renderer build failed:", e);
    return bundleError(`Renderer build failed:\n${e instanceof Error ? e.message : String(e)}`);
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

// P-AGENT.9: lazy scanner sidecar for imported agent files. Shared across imports; FAIL-CLOSED by design —
// if the sidecar is dead or slow, importSpec quarantines the spec (ScanUnavailableError becomes a blocking
// decision), it never passes unscanned.
let _agentScanner: ScannerClient | null = null;
function agentScanner(): ScannerClient {
  if (!_agentScanner) {
    _agentScanner = new ScannerClient({ timeoutMs: 8000 });
    _agentScanner.start();
  }
  return _agentScanner;
}

// P-AGENT.9/.10/.17: the ONE gated import path — every external spec (share file, n8n workflow, template)
// runs the P-AGENT.5 scanner gate and persists WITH its trust label; nothing external skips the gate.
interface GatedImportReply {
  ok: boolean;
  error?: string;
  data: Record<string, unknown>;
}
async function gatedAgentImport(specJson: string, notes: string[]): Promise<GatedImportReply> {
  try {
    const r = await importSpec(agentScanner(), specJson, "import");
    if (!r.ok || !r.spec) {
      const msg = r.errors.join("; ") || r.reason;
      return { ok: false, error: msg, data: { error: msg } };
    }
    saveSpecFile(currentWorkspace(), r.spec);
    saveSpecTrust(currentWorkspace(), r.spec.spec_id, { trustLabel: r.trustLabel, reason: r.reason });
    return { ok: true, data: { spec: r.spec, trustLabel: r.trustLabel, canRun: r.canRun, reason: r.reason, findings: r.findings.length, setup: setupInstructions(r.spec), notes } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, data: { error: msg } };
  }
}

// P-AGENT.17: the in-repo starter-template gallery. Only digest-valid portable files are listed; a
// corrupted/tampered template simply disappears from the gallery (fail-soft for the UI, fail-closed for use).
const TEMPLATES_DIR = join(import.meta.dir, "..", "templates", "agents");
interface AgentTemplateSummary {
  file: string;
  name: string;
  description: string;
  steps: number;
  tools: string[];
}
function listAgentTemplates(): AgentTemplateSummary[] {
  let files: string[];
  try {
    files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".lucid-agent.json"));
  } catch {
    return [];
  }
  const out: AgentTemplateSummary[] = [];
  for (const f of files.sort()) {
    try {
      const parsed = parsePortableAgentJson(readFileSync(join(TEMPLATES_DIR, f), "utf8"));
      if (!parsed.ok || !parsed.spec) continue;
      out.push({ file: f, name: parsed.spec.name, description: parsed.spec.description ?? "", steps: parsed.spec.nodes.length, tools: parsed.spec.tools });
    } catch {
      /* unreadable template → not listed */
    }
  }
  return out;
}

// P-REPORT.8: gather the git change inputs (numstat + name-status) for the report annexes. Default range
// is the recent cycle (up to the last 10 commits); on a shallow/single-commit repo it falls back to the
// working tree. Fail-soft: any git error → empty strings (the annex then reports "no changes detected").
function gitOut(repo: string, args: string[]): string {
  try {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "ignore", timeout: 8000 });
    return r.exitCode === 0 ? r.stdout.toString() : "";
  } catch { return ""; }
}
function gitChangeInputs(repo: string): { numstat: string; nameStatus: string; range: string } {
  const cnt = Number(gitOut(repo, ["rev-list", "--count", "HEAD"]).trim());
  const range = Number.isFinite(cnt) && cnt > 1 ? `HEAD~${Math.min(10, cnt - 1)}..HEAD` : "";
  const args = range ? [range] : [];
  return { numstat: gitOut(repo, ["diff", "--numstat", ...args]), nameStatus: gitOut(repo, ["diff", "--name-status", ...args]), range: range ? `the last ${Math.min(10, cnt - 1)} commits` : "the working tree" };
}

// OAuth via omp's `auth-broker login` — it opens the provider, runs a LOCAL callback server
// (e.g. :1455) for the redirect, exchanges the code, stores the token, then exits. It MUST stay
// alive AND have BOTH pipes drained until the callback lands — otherwise a full stdout/stderr pipe
// blocks it and the callback server goes down (browser → "localhost refused to connect"). We keep
// a reference (no GC), drain both streams in the background, and resolve once we see the auth URL.
// Map keyed by oauthId — lets us look up a running broker to send a device code to its stdin
// (xAI, GitHub, etc. use device-authorization flows where the user copies a code from the browser).
const oauthBrokers = new Map<string, ReturnType<typeof Bun.spawn>>();
function startOauthBroker(oauthId: string): Promise<{ started: boolean; url: string; output: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try { proc = Bun.spawn([ompBin(), "auth-broker", "login", oauthId], { stdout: "pipe", stderr: "pipe", stdin: "pipe" }); }
  // stdin: "pipe" (NOT "ignore") — the broker reads stdin as a fallback for pasting the auth code.
  // "ignore" closes stdin immediately → broker sees EOF → shuts down its callback server
  // before the browser redirect arrives. "pipe" keeps it open; for device-flow providers (xAI)
  // we also WRITE the user-pasted code to it via sendOauthCode().
  // js/stack-trace-exposure: log the real spawn error server-side; hand the client a generic message
  // so an internal exception/stack never reaches the renderer (this object is returned via json()).
  catch (e) { console.error(`[oauth] broker spawn failed for ${oauthId}:`, e); return Promise.resolve({ started: false, url: "", output: "could not start login" }); }
  oauthBrokers.set(oauthId, proc);
  proc.exited.finally(() => { if (oauthBrokers.get(oauthId) === proc) oauthBrokers.delete(oauthId); });
  // On a SUCCESSFUL login the credential lands in omp's vault, but the already-running omp child
  // built its model list at spawn and won't see it. Respawn so the new provider's models surface
  // (mirrors what adding an API key does). The front-end re-fetches /api/config after the badge flips.
  proc.exited.then((code) => {
    if (code !== 0) return;
    // omp's login writes the fresh token but may leave a stale `disabled_cause` from a prior logout,
    // so the just-fetched credential stays ignored. Clear that one flag (token blob untouched) so the
    // login actually "sticks", THEN respawn omp to pick up the now-active provider.
    const r = clearDisabledCredential(oauthId);
    if (r.cleared) console.log(`[oauth] re-enabled ${oauthId} after login (cleared stale disabled flag)`);
    backend.restart();
  }).catch(() => { /* ignore */ });
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
    setTimeout(() => finish(""), 60_000); // 60s — OTP/MFA flows need time (phone unlock, SMS delay)
  });
}
/** Send a device-authorization code to a running broker's stdin (xAI "Grok Build", GitHub device flow, etc.).
 *  The broker prints "Paste the authorization code (or full redirect URL)::" and reads a line from stdin. */
function sendOauthCode(oauthId: string, code: string): { sent: boolean; reason?: string } {
  const proc = oauthBrokers.get(oauthId);
  if (!proc) return { sent: false, reason: "no broker running for " + oauthId };
  const sink = proc.stdin; // Bun types this number | FileSink | undefined; the broker spawns with stdin:"pipe" → FileSink
  if (!sink || typeof sink === "number") return { sent: false, reason: "broker stdin is not writable" };
  try { sink.write(new TextEncoder().encode(code.trim() + "\n")); return { sent: true }; }
  // js/stack-trace-exposure: log detail server-side, return a generic reason to the client (goes via json()).
  catch (e) { console.error(`[oauth] send code failed for ${oauthId}:`, e); return { sent: false, reason: "could not send code" }; }
}

// Stream NDJSON ChatEvents to the browser with a HEARTBEAT. A long maker tool call (e.g. a broad
// codebase search during a /goal loop) can run for >60s emitting nothing; without a keepalive the
// socket goes idle, Bun's `idleTimeout` closes it, and every later event — tool chips AND the final
// answer — is lost while the turn keeps working server-side (it writes the file, the UI stays frozen
// on the last event it saw). A `{type:"ping"}` every 15s keeps the connection alive; the client
// (bridge.ts) drops pings. On a real browser disconnect we log once (developer mode) and keep going.
function ndjsonStream(label: string, run: (emit: (e: unknown) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let writeFailed = false;
      let lastSend = Date.now();
      const emit = (e: unknown) => {
        try { controller.enqueue(enc.encode(JSON.stringify(e) + "\n")); lastSend = Date.now(); }
        catch { if (!writeFailed && loadSettings().developerMode) { writeFailed = true; console.error(`[TURN_DIAG] ${label} stream write failed (browser disconnected) — server turn continues`); } }
      };
      const hb = setInterval(() => { if (Date.now() - lastSend >= 15_000) emit({ type: "ping" }); }, 15_000);
      try { await run(emit); }
      finally { clearInterval(hb); try { controller.close(); } catch { /* already closed */ } }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
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
    // P-PREVIEW.4b (ADR-0096): `/api/preview/serve` is loaded via an <iframe src> (so the previewed app's
    // OWN CSP applies instead of the renderer's strict inherited one). An iframe `src` GET cannot send a
    // custom header, so this ONE endpoint also accepts the per-launch token as a `?t=` query param — same
    // token, still behind the loopback (H1) + Origin/Host/CSRF (H2) gate above. Every other /api needs the header.
    if (p.startsWith("/api/") && p !== "/api/health") {
      // `/api/preview/serve` (iframe src) and `/api/preview/shot` (fetched by the omp subprocess, which
      // inherits a ready URL incl. the token via LUCID_PREVIEW_SHOT_URL) can't set a header, so they also
      // accept the per-launch token as a `?t=` query param — same token, still behind the H1/H2 gate above.
      const queryTokenOk = p === "/api/preview/serve" || p === "/api/preview/shot" || p === "/api/preview/inspect" || p === "/api/preview/act";
      const tok = queryTokenOk ? (req.headers.get("x-lucid-token") ?? url.searchParams.get("t")) : req.headers.get("x-lucid-token");
      if (!tokenValid(tok, TOKEN)) return new Response("forbidden", { status: 403 });
    }
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
      // P-IDE.6: serve a SAME-ORIGIN worker bootstrap so Monaco's language-service workers run under
      // the strict `worker-src 'self'` CSP. Monaco's own getWorker wraps the language worker in a blob:
      // URL (which the CSP — and a locked-down browser — block). This is the same idea, but same-origin:
      // set MonacoEnvironment.baseUrl inside the worker, then importScripts the real (self-contained,
      // classic) language worker. `script-src 'self'` permits the same-origin importScripts.
      if (p === "/vendor/monaco-worker.js") {
        const label = url.searchParams.get("label") ?? "";
        const key = label === "typescript" || label === "javascript" ? "ts"
          : label === "json" ? "json"
          : label === "css" || label === "scss" || label === "less" ? "css"
          : label === "html" || label === "handlebars" || label === "razor" ? "html"
          : "editor";
        let asset = "";
        try {
          const dir = join(import.meta.dir, "node_modules", "monaco-editor", "min", "vs", "assets");
          const re = new RegExp(`^${key}\\.worker-.*\\.js$`);
          for (const f of readdirSync(dir)) if (re.test(f)) { asset = `assets/${f}`; break; }
        } catch { /* no assets dir */ }
        const body = asset
          ? `self.MonacoEnvironment={baseUrl:self.location.origin+"/vendor/monaco/"};importScripts(self.location.origin+"/vendor/monaco/${asset}");`
          : "/* monaco worker asset not found */";
        return new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      }
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
        return json({ ok: true, data: { ...(snap ?? {}), live: liveBlocks(), sandbox: sandboxStatus(), acks: ackView() } });
      }
      // Audited fail-closed override: release one quarantined call (ADR-0019 C).
      if (p === "/api/security/approve" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); return json({ ok: true, data: approveBlock(String(b.id ?? "")) }); }
      if (p === "/api/security/dismiss" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); return json({ ok: true, data: dismissBlock(String(b.id ?? "")) }); }
      // P-SECACK.1 (ADR-0170): mark DB-backed security rows reviewed. GUI-owned ack ledger ONLY -
      // the provenance DB is never written and nothing is released; rows just leave the active view.
      if (p === "/api/security/ack" && req.method === "POST") {
        const b = await readBody<{ ids?: unknown; findings?: unknown }>(req);
        const ids = Array.isArray(b.ids) ? b.ids.map((x) => String(x)).filter((x) => x.trim()) : [];
        for (const id of ids) ackArtifact(id);
        let findingsSeen: number | null = null;
        if (b.findings === true) {
          // Server-side total - the watermark comes from what the DB says NOW, never a stale client count.
          const snap = await securitySnapshot();
          findingsSeen = ackFindings((snap?.findings ?? []).reduce((a, r) => a + Number(r.n ?? 0), 0));
        }
        return json({ ok: true, data: { acked: ids.length, findingsSeen } });
      }
      // Anchor the snapshot to the ACTIVE chat session (its on-disk transcript) so the Context window
      // + Prompt-cache gauges reflect the live conversation; fall back to findSession's cwd match only
      // when there's no active session yet (fresh launch).
      if (p === "/api/memory") return json({ ok: true, data: await memorySnapshot(sessionPathById(backend.currentSessionId())) });
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
      // P-AGENTFW.2 (ADR-0149): remote ACP agent (hermes/openclaw) connections the firewall proxies to. The
      // registry stores command/args (NOT secrets — prefer --token-file); a change respawns omp so enabled
      // connections attach as `agentfw-*` MCP servers on the next session.
      if (p === "/api/agents") {
        if (req.method === "POST") {
          const b = await readBody<{ id?: string; name?: unknown; kind?: unknown; command?: unknown; args?: unknown; cwd?: unknown; remoteUrl?: unknown; permissionPolicy?: unknown; enabled?: boolean }>(req);
          const kind = b.kind === "hermes" || b.kind === "openclaw" ? b.kind : "acp";
          const args = Array.isArray(b.args) ? b.args.map((a) => String(a)) : typeof b.args === "string" ? b.args.split(/\s+/).filter(Boolean) : [];
          const e = upsertRemoteAgent({ id: b.id, name: String(b.name ?? ""), kind, command: String(b.command ?? ""), args, cwd: b.cwd != null ? String(b.cwd) : undefined, remoteUrl: b.remoteUrl != null ? String(b.remoteUrl) : undefined, permissionPolicy: b.permissionPolicy === "allow" ? "allow" : "deny", enabled: b.enabled });
          backend.restart();
          return json({ ok: true, data: { id: e.id, name: e.name, kind: e.kind, command: e.command, args: e.args, remoteUrl: e.remoteUrl, permissionPolicy: e.permissionPolicy ?? "deny", enabled: e.enabled } });
        }
        return json({ ok: true, data: listRemoteAgents().map((e) => ({ id: e.id, name: e.name, kind: e.kind, command: e.command, args: e.args, remoteUrl: e.remoteUrl, permissionPolicy: e.permissionPolicy ?? "deny", enabled: e.enabled })) });
      }
      if (p === "/api/agents/remove" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); removeRemoteAgent(String(b.id ?? "")); backend.restart(); return json({ ok: true }); }
      if (p === "/api/agents/toggle" && req.method === "POST") { const b = await readBody<{ id?: unknown; enabled?: unknown }>(req); setRemoteAgentEnabled(String(b.id ?? ""), !!b.enabled); backend.restart(); return json({ ok: true }); }
      // P-NETWL.2 (ADR-0106): the curated network whitelist CRUD the Settings UI drives. The stored config is
      // NON-secret (domain/IP patterns + zone/scope + an opaque vaultRef); the actual secret lives in the
      // OS-encrypted credential vault (main-process safeStorage), never here. egressDecision reads this file to
      // auto-allow. upsertEntry sanitizes (a malformed entry is dropped → data:null signals rejection).
      if (p === "/api/whitelist") {
        if (req.method === "POST") {
          const b = await readBody<Partial<WhitelistEntry>>(req);
          const id = typeof b.id === "string" && b.id ? b.id : `wl_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
          // A project-scoped entry (e.g. an Agent Builder connection the user approved) binds to THIS workspace.
          const project = b.scope === "project" && !b.project ? currentWorkspace() : b.project;
          const store = upsertEntry(loadWhitelist(), { ...b, id, project } as WhitelistEntry);
          saveWhitelist(store);
          return json({ ok: true, data: store.entries.find((e) => e.id === id) ?? null });
        }
        return json({ ok: true, data: loadWhitelist().entries }); // entries carry no secret, only an opaque vaultRef
      }
      if (p === "/api/whitelist/remove" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); saveWhitelist(removeEntry(loadWhitelist(), String(b.id ?? ""))); return json({ ok: true }); }
      // P-NETWL.5 (ADR-0108): the egress posture (allow-all + web-search toggles). GET returns the EFFECTIVE
      // posture (clamped by any managed policy) + `managedLocked` so the UI can lock the toggle for enterprises.
      if (p === "/api/whitelist/posture") {
        if (req.method === "POST") {
          const b = await readBody<{ allowAll?: unknown; allowWebSearch?: unknown }>(req);
          const patch: { allowAll?: boolean; allowWebSearch?: boolean } = {};
          if (typeof b.allowAll === "boolean") patch.allowAll = b.allowAll;
          if (typeof b.allowWebSearch === "boolean") patch.allowWebSearch = b.allowWebSearch;
          saveWhitelist(setPosture(loadWhitelist(), patch)); // stored raw; the effective value is clamped on read
          return json({ ok: true, data: { ...egressPosture(), managedLocked: egressAllowAllManaged() } });
        }
        return json({ ok: true, data: { ...egressPosture(), managedLocked: egressAllowAllManaged() } });
      }
      // ADR-0009 Phase D: developer-mode logging view. GET is gated server-side on developerMode
      // (returns null when off); POST {enabled} flips the mode. Read-only, metadata-only.
      if (p === "/api/dev") {
        if (req.method === "POST") {
          const b = await readBody<{ enabled?: unknown }>(req);
          const next = !!b.enabled;
          const changed = loadSettings().developerMode !== next;
          const data = setDeveloperMode(next);
          // P-ASKSAGE.1 (ADR-0059): the omp child reads LUCID_ASKSAGE_DEBUG only at spawn. Respawn on a
          // real change so toggling developer mode takes effect immediately (no app restart) — the fresh
          // omp picks up / drops the debug env. Same pattern as an API-key change (backend.restart()).
          if (changed) backend.restart();
          // Run the loopback/OAuth-callback watcher only while developer mode is on (it polls the OS).
          if (next) startNetdiagWatch(); else stopNetdiagWatch();
          return json({ ok: true, data });
        }
        if (!loadSettings().developerMode) return json({ ok: true, data: { enabled: false, snapshot: null, blocks: { quarantined: [], approved: [], total: 0 }, turns: [], asksage: [], gate: [], netdiag: null } });
        ensureNetdiagWatch(); // self-heal: live by the time the Logs panel (or boot-time loadDev) reads it
        return json({ ok: true, data: { enabled: true, snapshot: await devSnapshot(), blocks: liveBlocks(), turns: recentTurns(), asksage: backend.asksageDiagnostics(), gate: backend.gateDiagnostics(), audit: { events: audit.recent(60), sinks: audit.sinkStatuses() }, netdiag: netdiagView() } });
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
      // ADR-0030 P-CODE.1: per-workspace git diffstat for the current month (repo
      // activity, not AI authorship). Read-only, metadata-only, fail-closed per workspace.
      // Cached 30s — each call spawns `git log` per workspace, so don't re-run it on
      // every dashboard poll. `?force=1` bypasses the cache (manual refresh).
      if (p === "/api/code-activity") {
        const now = Date.now();
        if (!codeActivityCache || now - codeActivityCache.at > 30_000 || url.searchParams.get("force") === "1")
          codeActivityCache = { at: now, data: codeActivity() };
        return json({ ok: true, data: codeActivityCache.data });
      }
      if (p === "/api/health") return json({ ok: true });
      // P-ENT.2 (ADR-0069): the unified security-event stream (metadata-only, OCSF-ready) + per-sink
      // delivery status, for the in-app dashboard. Read-only; the file sink is the SIEM export source.
      if (p === "/api/audit") return json({ ok: true, data: { events: audit.recent(100), sinks: audit.sinkStatuses() } });
      // P-BRIEF.3 (ADR-0072): generate the Executive Engineering Update from the repo's own logs. Pure +
      // air-gap (reads DECISIONS.md/PROGRESS.md from the repo root); returns the written brief + the
      // two-host podcast script. Audio synthesis (a TTS backend) is a later slice; this is the brief.
      if (p === "/api/brief") {
        // P-REPORT.1 (ADR-0116): `?role=` tailors which sections lead + the framing; `?save=1` persists the
        // brief to the report store (so the Reports panel lists it). The goal-modal preview omits save.
        // P-REPORT.9 (ADR-0162): a POST body `{ role, save, repos, window }` additionally aggregates recent
        // commits + PRs across the SELECTED repos (fetched read-only) into a Cross-repo activity annex.
        const body = req.method === "POST" ? await readBody<{ role?: unknown; save?: unknown; repos?: unknown; window?: unknown }>(req) : {};
        const roleRaw = url.searchParams.get("role") ?? (body.role != null ? String(body.role) : null);
        const role: BriefRole | undefined = roleRaw === "developer" || roleRaw === "security" || roleRaw === "manager" || roleRaw === "executive" ? roleRaw : undefined;
        const repo = join(import.meta.dir, "..");
        const rd = (f: string) => { try { return existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : ""; } catch { return ""; } };
        const u = buildEngineeringUpdate({ label: "LucidAgentIDE", progressMd: rd("PROGRESS.md"), decisionsMd: rd("DECISIONS.md") });
        const counts = { shipped: u.recentlyShipped.length, loadBearing: u.loadBearingDependencies.length, techDebt: u.techDebt.length, decisions: u.upcomingDecisions.length, risks: u.risks.length };
        let brief = renderEngineeringBrief(u, role);
        // P-REPORT.8: technical audiences (developer/security) get the change-annotated dependency graph +
        // schema-change annexes appended (page-broken in print). Non-technical roles skip them.
        if (role === "developer" || role === "security") {
          const gi = gitChangeInputs(repo);
          brief += "\n\n" + renderAnnexes(buildChangeGraph(gi.numstat, gi.nameStatus, gi.range), buildSchemaChanges(gi.numstat, gi.nameStatus));
        }
        // P-REPORT.9: cross-repo activity annex, only when repos were selected (POST). Fetch is read-only;
        // the annex is appended for ALL roles (it's the whole point of selecting extra repos).
        const rawRepos = Array.isArray(body.repos) ? (body.repos as unknown[]) : [];
        const sel: RepoSelection[] = rawRepos
          .map((r) => (r && typeof r === "object" ? r as Record<string, unknown> : {}))
          .filter((r) => typeof r.path === "string" && r.path)
          .map((r) => ({ path: String(r.path), fetch: r.fetch !== false, prs: r.prs === true }));
        if (sel.length) {
          const window = Number(body.window) || 10;
          const activities = await collectRepoActivity(sel, { fetch: true, prs: false, window });
          brief += "\n\n" + renderRepoActivityAnnex(activities);
        }
        const doSave = url.searchParams.get("save") === "1" || body.save === true;
        const savedRel = doSave ? saveBrief(Date.now().toString(36), role ?? "executive", brief) : null;
        return json({ ok: true, data: { brief, scriptText: renderScript(buildPodcastScript(u, role)), counts, role: role ?? "", savedRel } });
      }
      // P-REPORT.9 (ADR-0162): the candidate repos for a report (workspace ∪ recents ∪ report-only tracked)
      // + whether `gh` is authenticated (drives the PR toggle). Read-only; safe to poll.
      if (p === "/api/report/repos") return json({ ok: true, data: { repos: await listReportRepos(), ghAuth: await ghAvailable() } });
      // Add a report-target repo by local path or clone URL. Does NOT change the active workspace.
      if (p === "/api/report/repos/add" && req.method === "POST") {
        const b = await readBody<{ path?: unknown; url?: unknown }>(req);
        const r = await addReportRepo({ path: b.path != null ? String(b.path) : undefined, url: b.url != null ? String(b.url) : undefined });
        return json({ ok: r.ok, data: { repos: await listReportRepos(), ghAuth: await ghAvailable(), error: r.error } });
      }
      // P-REPORT.8: STIG Viewer .ckl export of the security control crosswalk (native XML checklist).
      if (p === "/api/brief/ckl") {
        const repo = join(import.meta.dir, "..");
        const rd = (f: string) => { try { return existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : ""; } catch { return ""; } };
        const u = buildEngineeringUpdate({ label: "LucidAgentIDE", progressMd: rd("PROGRESS.md"), decisionsMd: rd("DECISIONS.md") });
        const ckl = renderCkl(u, "LucidAgentIDE");
        return json({ ok: true, data: { ckl, rows: buildComplianceRows(u).length, filename: "lucidagentide-crosswalk.ckl" } });
      }
      // P-REPORT.6: POA&M export - the security control crosswalk as an eMASS-aligned POA&M CSV.
      if (p === "/api/brief/poam") {
        const repo = join(import.meta.dir, "..");
        const rd = (f: string) => { try { return existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : ""; } catch { return ""; } };
        const u = buildEngineeringUpdate({ label: "LucidAgentIDE", progressMd: rd("PROGRESS.md"), decisionsMd: rd("DECISIONS.md") });
        const csv = renderPoamCsv(u, "LucidAgentIDE");
        const rows = buildComplianceRows(u).length;
        return json({ ok: true, data: { csv, rows, filename: "lucidagentide-poam.csv" } });
      }
      // P-CHAT.C (ADR-0190): generate a Model-Evaluation engineering report for a just-settled chat turn.
      // The renderer POSTs what it OBSERVED that turn (tool calls + per-file diffstats + tokens/cost/
      // failures); we map it to evals.ts's RunRecord + render the reused Model-Evaluation markdown
      // (harness/brief/eval_report.ts), then SAVE it to the brief store so it lists in the Reports panel
      // (kind=brief, role=evals) and the settled turn's "Open in Reports" link opens it. Fields are coerced
      // defensively - a lossy/hostile payload can never yield a negative LOC or a NaN metric (pure guard).
      if (p === "/api/eval/report" && req.method === "POST") {
        const b = await readBody<Partial<ObservedTurn>>(req);
        const tools: ObservedTool[] = Array.isArray(b.tools)
          ? b.tools.filter((x): x is ObservedTool => !!x && typeof (x as ObservedTool).name === "string").map((x) => ({
              name: String(x.name),
              path: x.path != null ? String(x.path) : undefined,
              add: x.add != null ? Number(x.add) : undefined,
              del: x.del != null ? Number(x.del) : undefined,
            }))
          : [];
        const failures = Array.isArray(b.failures)
          ? b.failures.filter((f): f is NonNullable<ObservedTurn["failures"]>[number] => !!f && typeof f.tool === "string").map((f) => ({ tool: String(f.tool), reason: String(f.reason ?? ""), cmd: f.cmd != null ? String(f.cmd) : undefined }))
          : [];
        const turn: ObservedTurn = {
          runId: typeof b.runId === "string" && b.runId ? b.runId : String(Date.now()),
          model: typeof b.model === "string" && b.model ? b.model : "model",
          ctxTokens: Number(b.ctxTokens) || 0,
          outputTokens: Number(b.outputTokens) || 0,
          totalTokens: Number(b.totalTokens) || 0,
          costUsd: Number(b.costUsd) || 0,
          tools, failures,
          subagents: b.subagents != null ? Number(b.subagents) : undefined,
          when: typeof b.when === "string" ? b.when : undefined,
        };
        const { title, markdown } = renderTurnEvalReport(turn);
        const id = String(Date.now());
        const rel = saveBrief(id, "evals", markdown);
        return json({ ok: !!rel, data: { kind: "brief", id, rel, title }, error: rel ? undefined : "could not save report" });
      }
      // P-REPORT.1 (ADR-0116): the unified Reports list - per-workspace loop AARs + repo-wide saved briefs,
      // most-recent first. GET `/api/report?kind=aar|brief&rel=` reads one (confined to its store).
      if (p === "/api/reports") {
        const archived = url.searchParams.get("archived") === "1"; // P-REPORT.2: the archive view
        const aars = listGoalReports(currentWorkspace(), 50, archived).map((r) => ({ kind: "aar" as const, id: r.id, title: r.goal, outcome: r.outcome, role: "", updatedAt: r.updatedAt, rel: r.rel }));
        const briefs = listBriefs(50, archived).map((b) => ({ kind: "brief" as const, id: b.id, title: b.title, outcome: "", role: b.role, updatedAt: b.updatedAt, rel: b.rel }));
        return json({ ok: true, data: [...aars, ...briefs].sort((a, b) => b.updatedAt - a.updatedAt) });
      }
      if (p === "/api/report") {
        const kind = url.searchParams.get("kind"); const rel = url.searchParams.get("rel") ?? "";
        const archived = url.searchParams.get("archived") === "1";
        const md = kind === "brief" ? readBrief(rel, archived) : readGoalReport(currentWorkspace(), rel);
        return md != null ? json({ ok: true, data: { kind, rel, markdown: md } }) : json({ ok: false, error: "report not found" });
      }
      // P-REPORT.2 (ADR-0117): two-stage lifecycle. `archive` = soft-delete (active → Archive); `restore` =
      // Archive → active; `delete` = PERMANENT and only ever operates on an archived item (the second delete).
      if (p === "/api/report/archive" && req.method === "POST") {
        const b = await readBody<{ kind?: unknown; rel?: unknown }>(req); const rel = String(b.rel ?? "");
        const ok = b.kind === "brief" ? archiveBrief(rel) : archiveGoalReport(currentWorkspace(), rel);
        return json({ ok: true, data: { archived: ok } });
      }
      if (p === "/api/report/restore" && req.method === "POST") {
        const b = await readBody<{ kind?: unknown; rel?: unknown }>(req); const rel = String(b.rel ?? "");
        const ok = b.kind === "brief" ? restoreBrief(rel) : restoreGoalReport(currentWorkspace(), rel);
        return json({ ok: true, data: { restored: ok } });
      }
      if (p === "/api/report/delete" && req.method === "POST") {
        const b = await readBody<{ kind?: unknown; rel?: unknown }>(req); const rel = String(b.rel ?? "");
        const ok = b.kind === "brief" ? deleteBrief(rel) : deleteGoalReport(currentWorkspace(), rel);
        return json({ ok, data: { deleted: ok }, error: ok ? undefined : "only archived reports can be permanently deleted" });
      }
      // P-REPORT.3 (ADR-0117): push a report into the personalization KG as ONE trusted node, in the chosen
      // compartment. `scope` must be an unlocked compartment (the store enforces cui isolation, fail-closed).
      if (p === "/api/report/to-kg" && req.method === "POST") {
        const b = await readBody<{ kind?: unknown; rel?: unknown; scope?: unknown; archived?: unknown }>(req);
        const kind = b.kind === "brief" ? "brief" : "aar", rel = String(b.rel ?? "");
        const scope: PersonalScope = b.scope === "work" || b.scope === "cui" ? b.scope : "personal";
        const md = kind === "brief" ? readBrief(rel, !!b.archived) : readGoalReport(currentWorkspace(), rel);
        if (md == null) return json({ ok: false, error: "report not found" });
        const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? (kind === "brief" ? "Engineering Update" : "After-Action Report");
        const r = addReportToKg(scope, title, md);
        return json({ ok: r.ok, data: r, error: r.error });
      }
      // P-KG-CODE.1: the workspace CODE graph (file → import dependency graph). GET = status + the stored
      // graph (nodes/edges) if already ingested; POST = ingest/re-sync the cwd and return the fresh graph.
      if (p === "/api/codegraph") {
        const root = currentWorkspace();
        // P-KG-SYM.1: `level` = file (import graph) | symbol (AST call/reference graph).
        const bodyLevel = req.method === "POST" ? (await readBody<{ level?: unknown }>(req)).level : url.searchParams.get("level");
        const level = bodyLevel === "symbol" ? "symbol" : "file";
        if (req.method === "POST") {
          if (level === "symbol") { const g = ingestSymbolGraph(root); return json({ ok: true, data: { level, ingested: true, root, fileCount: g.fileCount, symbolCount: g.symbolCount, edgeCount: g.edgeCount, updatedAt: g.updatedAt, nodes: g.nodes, edges: g.edges } }); }
          const g = ingestCodeGraph(root); return json({ ok: true, data: { level, ingested: true, root, fileCount: g.fileCount, symbolCount: 0, edgeCount: g.edgeCount, updatedAt: g.updatedAt, nodes: g.nodes, edges: g.edges } });
        }
        const g = level === "symbol" ? loadSymbolGraph(root) : loadCodeGraph(root);
        const symCount = level === "symbol" ? ((g as { symbolCount?: number } | null)?.symbolCount ?? 0) : 0;
        return json({ ok: true, data: { level, ingested: !!g, root, fileCount: g?.fileCount ?? 0, symbolCount: symCount, edgeCount: g?.edgeCount ?? 0, updatedAt: g?.updatedAt ?? 0, nodes: g?.nodes ?? [], edges: g?.edges ?? [] } });
      }
      // P-KG-SYM.1: expose the code graph to the agent (adds the `codegraph_query` omp tool). POST restarts
      // the backend so the extension loads/unloads; GET reports the current setting.
      if (p === "/api/codegraph/agent") {
        if (req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); setCodeGraphAgent(!!b.enabled); backend.restart(); return json({ ok: true, data: { enabled: !!b.enabled } }); }
        return json({ ok: true, data: { enabled: !!loadSettings().codeGraphAgent } });
      }
      // P-AGENT.2b (ADR-0133): Agent Builder spec persistence as workspace files (.omp/agents/). GET = list
      // all specs (or one via ?id=); POST body {spec} = validate-then-save FAIL-CLOSED (an invalid spec is
      // refused, never written). The engine writes workspace files here because it holds agent_obs.duckdb
      // READ-ONLY (omp's gate child is the DB writer) — so authored specs live with the workspace.
      if (p === "/api/agent") {
        const root = currentWorkspace();
        if (req.method === "POST") {
          const b = await readBody<{ spec?: unknown }>(req);
          const v = validateSpec(b.spec);
          if (!v.ok) return json({ ok: false, error: v.errors.join("; "), data: { errors: v.errors } });
          try {
            saveSpecFile(root, v.spec!);
            return json({ ok: true, data: { saved: true, spec_id: v.spec!.spec_id } });
          } catch (e) {
            return json({ ok: false, error: String((e as { message?: unknown })?.message ?? e) });
          }
        }
        const id = url.searchParams.get("id");
        if (id) return json({ ok: true, data: { spec: loadSpecFile(root, id) } });
        return json({ ok: true, data: { specs: listSpecFiles(root) } });
      }
      if (p === "/api/agent/delete" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        const deleted = typeof b.id === "string" ? deleteSpecFile(currentWorkspace(), b.id) : false;
        return json({ ok: true, data: { deleted } });
      }
      // P-LOCAL.3 (ADR-0135): Local Providers CRUD. Declarations only — the API key lives in the OS-encrypted
      // vault (stored via the credStore IPC in the desktop app), never through this route. upsert validates
      // fail-closed (an invalid provider is refused, never persisted).
      if (p === "/api/local-providers") {
        if (req.method === "POST") {
          const b = await readBody<{ provider?: unknown }>(req);
          try {
            const saved = upsertLocalProvider(b.provider as LocalProviderDef);
            return json({ ok: true, data: { saved: true, id: saved.id } });
          } catch (e) {
            const msg = String((e as { message?: unknown })?.message ?? e);
            return json({ ok: false, error: msg, data: { errors: [msg] } });
          }
        }
        return json({ ok: true, data: { providers: listLocalProviders() } });
      }
      if (p === "/api/local-providers/delete" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        if (typeof b.id === "string") removeLocalProvider(b.id);
        return json({ ok: true, data: { deleted: true } });
      }
      if (p === "/api/local-providers/enable" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; enabled?: unknown }>(req);
        if (typeof b.id === "string") setLocalProviderEnabled(b.id, !!b.enabled);
        return json({ ok: true, data: { ok: true } });
      }
      // P-LOCAL.3 polish: reachability/TLS probe. Hits the OpenAI-compatible /models endpoint with a short
      // timeout and NO key (the vault secret never leaves main) — any HTTP response (even 401/403) proves the
      // host is reachable + the TLS handshake succeeded; a network/TLS/timeout error means it's not.
      // P-FIGMA.1 (ADR-0154): import a Figma file's frames as inlined PNGs into a local design-board HTML,
      // loaded through the normal preview pipeline. The PAT is used SERVER-side only (from the request on the
      // first import, or LUCID_FIGMA_TOKEN injected from the vault by main); it never returns to renderer/agent.
      if (p === "/api/figma/import" && req.method === "POST") {
        const fail = (error: string) => json({ ok: false, error, data: { error } }); // error rides in data (post() unwraps .data)
        const b = await readBody<{ fileUrl?: unknown; pat?: unknown }>(req);
        const pat = typeof b.pat === "string" && b.pat.trim() ? b.pat.trim() : (process.env.LUCID_FIGMA_TOKEN ?? "");
        if (!pat) return fail("Enter a Figma personal access token.");
        const key = parseFigmaFileKey(String(b.fileUrl ?? ""));
        if (!key) return fail("That doesn't look like a Figma file URL or key.");
        try {
          const hdr = { headers: { "X-Figma-Token": pat } };
          const fileRes = await fetch(`${FIGMA_API}/files/${key}?depth=2`, { ...hdr, signal: AbortSignal.timeout(20000) });
          if (fileRes.status === 403) return fail("Figma rejected the token (403) — check the PAT and that it can read this file.");
          if (fileRes.status === 404) return fail("Figma file not found (404) — check the file URL/key.");
          if (!fileRes.ok) return fail(`Figma API error ${fileRes.status}.`);
          const file = (await fileRes.json()) as { name?: string; document?: unknown };
          const fileName = String(file?.name ?? "Figma file").slice(0, 200); // bound the network-derived title we persist
          const frames = collectTopFrames(file?.document as never);
          let board: BoardFrame[] = [];
          if (frames.length) {
            const ids = frames.map((f) => f.id).join(",");
            const imgRes = await fetch(`${FIGMA_API}/images/${key}?ids=${encodeURIComponent(ids)}&format=png&scale=2`, { ...hdr, signal: AbortSignal.timeout(25000) });
            // external API reply: narrow the images map with a guard instead of trusting the shape
            let imgMap: Record<string, string | null> = {};
            if (imgRes.ok) {
              const parsed: unknown = await imgRes.json();
              if (parsed && typeof parsed === "object" && "images" in parsed && parsed.images && typeof parsed.images === "object") {
                imgMap = parsed.images as Record<string, string | null>; // Figma /images contract: id → url | null
              }
            }
            const MAX_IMG_BYTES = 8 * 1024 * 1024; // cap per-frame render we inline + persist to disk
            board = await Promise.all(frames.map(async (f) => {
              const src = imgMap[f.id];
              let dataUrl = "";
              // The render URL comes from Figma's API response (network-controlled / untrusted, CodeQL
              // js/http-to-file-access): fetch it ONLY when it's an https URL (no file://, http://localhost,
              // or other SSRF targets) and BOUND the bytes we inline + write to the local board file.
              if (typeof src === "string" && /^https:\/\//i.test(src)) {
                try {
                  const r = await fetch(src, { signal: AbortSignal.timeout(20000) });
                  const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
                  if (buf && buf.length > 0 && buf.length <= MAX_IMG_BYTES) dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
                } catch { /* leaves a placeholder */ }
              }
              return { name: f.name, page: f.page, dataUrl };
            }));
          }
          const dir = join(currentWorkspace(), ".omp", "figma");
          mkdirSync(dir, { recursive: true });
          const outPath = join(dir, `${key}.html`);
          writeFileSync(outPath, figmaBoardHtml(fileName, board), "utf8");
          // P-FIGMA.2: tell the UI whether this project already has a DESIGN.md, to drive the guided next step.
          const hasDesign = existsSync(designDocPath(currentWorkspace()));
          return json({ ok: true, data: { path: outPath, fileName, frames: board.length, hasDesign } });
        } catch (e) {
          return fail(`Couldn't import the Figma file: ${String((e as { message?: unknown })?.message ?? e).slice(0, 160)}`);
        }
      }
      // P-FIGMA.2 / P-DESIGN.1 (ADR-0154): read the workspace DESIGN.md so the renderer can pop it out in the
      // Monaco IDE for the user to review/edit. Content only — the agent honors it via the preamble (P-DESIGN.1).
      if (p === "/api/design") {
        const dp = designDocPath(currentWorkspace());
        const exists = existsSync(dp);
        let content = "";
        if (exists) { try { content = readFileSync(dp, "utf8"); } catch { /* leave empty */ } }
        return json({ ok: true, data: { exists, path: dp, name: DESIGN_DOC_NAME, content } });
      }
      if (p === "/api/local-providers/test" && req.method === "POST") {
        const b = await readBody<{ baseUrl?: unknown }>(req);
        const target = typeof b.baseUrl === "string" ? providerModelsUrl(b.baseUrl) : null;
        if (!target) return json({ ok: true, data: { reachable: false, error: "invalid base URL" } });
        try {
          const r = await fetch(target, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(4500) });
          return json({ ok: true, data: { reachable: true, status: r.status, authed: r.status === 401 || r.status === 403 } });
        } catch (e) {
          return json({ ok: true, data: { reachable: false, error: String((e as { message?: unknown })?.message ?? e).slice(0, 160) } });
        }
      }
      // P-AGENT.6: enterprise export — compile the spec + write a portable, tamper-evident bundle (with a
      // SHA-256 content digest) for a deploy target under .omp/agent-exports/<spec_id>/<target>/. Fail-closed:
      // an invalid spec is refused before anything is compiled or written.
      if (p === "/api/agent/export" && req.method === "POST") {
        const b = await readBody<{ spec?: unknown; target?: unknown }>(req);
        const v = validateSpec(b.spec);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; ") });
        const target: ExportTarget = (EXPORT_TARGETS as readonly string[]).includes(b.target as string) ? (b.target as ExportTarget) : "electron";
        try {
          const pkg = exportBundle(buildAgent(v.spec!), target);
          const dir = join(currentWorkspace(), ".omp", "agent-exports", v.spec!.spec_id, target);
          const written = writeExportPackage(pkg, dir);
          return json({ ok: true, data: { dir, target, digest: pkg.manifest.digest, files: written.length } });
        } catch (e) {
          return json({ ok: false, error: String((e as { message?: unknown })?.message ?? e) });
        }
      }
      // P-AGENT.9: SHARE — write a portable .lucid-agent.json (spec + setup guidance + spec digest; NEVER
      // credential values) under .omp/agent-shares/ and return the JSON so the renderer can offer a download.
      if (p === "/api/agent/share" && req.method === "POST") {
        const b = await readBody<{ spec?: unknown }>(req);
        const v = validateSpec(b.spec);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; "), data: { error: v.errors.join("; ") } });
        try {
          const file = exportPortableAgent(v.spec!);
          const dir = join(currentWorkspace(), ".omp", "agent-shares");
          mkdirSync(dir, { recursive: true });
          const base = v.spec!.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "agent";
          const fileName = `${base}.lucid-agent.json`;
          const text = `${JSON.stringify(file, null, 2)}\n`;
          writeFileSync(join(dir, fileName), text);
          writeFileSync(join(dir, `${base}.SETUP.md`), file.setup_md);
          return json({ ok: true, data: { path: join(dir, fileName), fileName, json: text, setup: file.setup_md, digest: file.spec_digest } });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ ok: false, error: msg, data: { error: msg } });
        }
      }
      // P-AGENT.9/.10: IMPORT — accepts BOTH share formats: a portable .lucid-agent.json (digest-checked)
      // and a raw n8n workflow JSON (translated; an embedded LUCID block wins for lossless round-trip). Either
      // way the result runs the P-AGENT.5 quarantine gate (scanner sidecar, FAIL-CLOSED: scan unavailable =>
      // quarantined, never "safe") and persists WITH its trust label; non-trusted can't run until approved.
      if (p === "/api/agent/import" && req.method === "POST") {
        const b = await readBody<{ raw?: unknown }>(req);
        const raw = typeof b.raw === "string" ? b.raw : "";
        let specJson: string | null = null;
        let importNotes: string[] = [];
        const portable = parsePortableAgentJson(raw);
        if (portable.ok && portable.spec) {
          specJson = JSON.stringify(portable.spec);
        } else {
          try {
            const parsedRaw: unknown = JSON.parse(raw);
            if (isN8nWorkflowJson(parsedRaw)) {
              const conv = n8nToSpec(parsedRaw);
              importNotes = conv.notes;
              if (conv.embeddedPortableJson) {
                const embedded = parsePortableAgentJson(conv.embeddedPortableJson);
                if (!embedded.ok || !embedded.spec) { const msg = `embedded LUCID agent is invalid: ${embedded.errors.join("; ")}`; return json({ ok: false, error: msg, data: { error: msg } }); }
                specJson = JSON.stringify(embedded.spec);
              } else if (conv.spec) {
                specJson = JSON.stringify(conv.spec);
              }
            }
          } catch { /* not JSON at all — falls through to the honest error below */ }
        }
        if (!specJson) { const msg = portable.errors.join("; ") || "not a portable LUCID agent or an n8n workflow"; return json({ ok: false, error: msg, data: { error: msg } }); }
        return json(await gatedAgentImport(specJson, importNotes));
      }
      // P-AGENT.17: revision history — snapshots written on every save; restore re-saves an old revision as
      // the CURRENT spec (itself snapshotted, so restores are undoable). The trust sidecar is untouched:
      // trust applies to the spec identity, and restoring an untrusted import keeps it untrusted.
      if (p === "/api/agent/history") {
        const id = url.searchParams.get("id") ?? "";
        return json({ ok: true, data: { revisions: listSpecHistory(currentWorkspace(), id) } });
      }
      if (p === "/api/agent/history/restore" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; ts?: unknown }>(req);
        const id = typeof b.id === "string" ? b.id : "";
        const rev = loadSpecRevision(currentWorkspace(), id, Number(b.ts));
        if (!rev) return json({ ok: false, error: "unknown or corrupted revision", data: { error: "unknown or corrupted revision" } });
        const restored = { ...rev, updated_at: Date.now() };
        saveSpecFile(currentWorkspace(), restored);
        return json({ ok: true, data: { spec: restored } });
      }
      // P-AGENT.17: the starter-template gallery — curated .lucid-agent.json files shipped in-repo. \"Use\"
      // routes through the STANDARD import path (scanner gate + trust + approval); curated ≠ exempt.
      if (p === "/api/agent/templates") {
        return json({ ok: true, data: { templates: listAgentTemplates() } });
      }
      if (p === "/api/agent/template-use" && req.method === "POST") {
        const b = await readBody<{ file?: unknown }>(req);
        const file = typeof b.file === "string" ? b.file : "";
        const tpl = listAgentTemplates().find((t) => t.file === file);
        if (!tpl) return json({ ok: false, error: "unknown template", data: { error: "unknown template" } });
        const parsed = parsePortableAgentJson(readFileSync(join(TEMPLATES_DIR, tpl.file), "utf8"));
        if (!parsed.ok || !parsed.spec) return json({ ok: false, error: parsed.errors.join("; "), data: { error: parsed.errors.join("; ") } });
        // fresh identity per use — two users of the same template edit independent agents
        const spec = { ...parsed.spec, spec_id: `agent_${crypto.randomUUID()}`, created_at: Date.now(), updated_at: Date.now() };
        return json(await gatedAgentImport(JSON.stringify(spec), [`created from template ${tpl.file}`]));
      }
      // P-AGENT.10: EXPORT FOR n8n — lower the spec into an importable n8n workflow scaffold (real wait
      // nodes for approvals; provenance sticky embeds the portable agent for lossless round-trip). Written
      // under .omp/agent-shares/ and returned for download. Never carries credential values.
      if (p === "/api/agent/n8n-export" && req.method === "POST") {
        const b = await readBody<{ spec?: unknown }>(req);
        const v = validateSpec(b.spec);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; "), data: { error: v.errors.join("; ") } });
        try {
          const portable = `${JSON.stringify(exportPortableAgent(v.spec!), null, 2)}\n`;
          const wf = specToN8n(v.spec!, portable);
          const dir = join(currentWorkspace(), ".omp", "agent-shares");
          mkdirSync(dir, { recursive: true });
          const base = v.spec!.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "agent";
          const fileName = `${base}.n8n.json`;
          const text = `${JSON.stringify(wf, null, 2)}\n`;
          writeFileSync(join(dir, fileName), text);
          const push = connectorStatus("n8n");
          return json({ ok: true, data: { path: join(dir, fileName), fileName, json: text, pushAvailable: push.installed, pushNote: push.note } });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ ok: false, error: msg, data: { error: msg } });
        }
      }
      // P-AGENT.10: PUSH to a private hosted n8n — the CONNECTOR lives in the enterprise add-on
      // (lucidagentIDEaddon/connectors/n8n); this public seam exports the artifact and dispatches it. With
      // no add-on installed the reply is an honest "not installed" note, never a fake success.
      if (p === "/api/agent/n8n-push" && req.method === "POST") {
        const b = await readBody<{ spec?: unknown }>(req);
        const v = validateSpec(b.spec);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; "), data: { error: v.errors.join("; ") } });
        try {
          const portable = `${JSON.stringify(exportPortableAgent(v.spec!), null, 2)}\n`;
          const wf = specToN8n(v.spec!, portable);
          const dir = join(currentWorkspace(), ".omp", "agent-shares");
          mkdirSync(dir, { recursive: true });
          const base = v.spec!.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "agent";
          const file = join(dir, `${base}.n8n.json`);
          writeFileSync(file, `${JSON.stringify(wf, null, 2)}\n`);
          const r = runConnector("n8n", "push", file);
          return json({ ok: r.ok, data: { ok: r.ok, detail: r.detail, url: r.url ?? "" }, error: r.ok ? undefined : r.detail });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ ok: false, error: msg, data: { error: msg } });
        }
      }
      // P-AGENT.9: APPROVE — the explicit human-review step for an imported agent. untrusted/suspicious can
      // be promoted to trusted after review; a QUARANTINED spec stays blocked (fix the content + re-import).
      if (p === "/api/agent/trust" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        const id = typeof b.id === "string" ? b.id : "";
        if (!loadSpecFile(currentWorkspace(), id)) return json({ ok: false, error: "unknown agent id", data: { error: "unknown agent id" } });
        const cur = loadSpecTrust(currentWorkspace(), id);
        if (cur.trustLabel === "quarantined") {
          const msg = "this agent is quarantined (flagged content) — it cannot be approved; fix the source and re-import";
          return json({ ok: false, error: msg, data: { error: msg } });
        }
        saveSpecTrust(currentWorkspace(), id, { trustLabel: "trusted", reason: "approved by the user after review", reviewed_at: Date.now() });
        return json({ ok: true, data: { trustLabel: "trusted" } });
      }
      // P-AGENT.4-live: run a built agent one-shot through omp (gate + generated allow-list + compiled prompt).
      // Fail-closed: an invalid or non-runnable-trust spec is refused before anything spawns. Returns the
      // agent's final text (or a refusal/error). model defaults to a fast model for cheap runs.
      if (p === "/api/agent/run" && req.method === "POST") {
        const b = await readBody<{ spec?: unknown; prompt?: unknown; model?: unknown }>(req);
        const v = validateSpec(b.spec);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; ") });
        const prompt = typeof b.prompt === "string" ? b.prompt : "";
        const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : "haiku";
        // P-AGENT.9: run under the STORED trust label — an imported, not-yet-approved spec is refused here.
        // P-AGENT.11a: a spec with approval nodes runs SEGMENTED — it halts at each boundary and returns
        // `paused`; the human resumes via /api/agent/run/approve. The halt is enforced by the SegmentedRun
        // machine (the post-approval prompt does not exist until approve), not by model compliance.
        const trust = loadSpecTrust(currentWorkspace(), v.spec!.spec_id);
        const r = await startAgentRun({ spec: v.spec!, prompt, model, workspace: currentWorkspace(), trustLabel: trust.trustLabel });
        return json({ ok: r.ok, data: { output: r.output ?? "", error: r.error ?? "", blocked: !!r.blocked, reason: r.reason ?? "", paused: r.paused ?? null, runId: r.runId ?? "" } });
      }
      // P-AGENT.13: run traces — file-backed provenance under .omp/agent-runs/traces/ (the desktop holds
      // agent_obs.duckdb read-only, so files are the v1 store; see ADR-0141 delta note).
      // P-AGENT.12: the DYNAMIC half of the Builder's tool catalog: tools discovered from the user's
      // ENABLED MCP servers, under the exact `mcp__<server>_<tool>` names omp registers at runtime (so the
      // compiled allow-list matches). Fail-soft: unreachable servers report an error and the picker just
      // shows the built-ins; a probe can never break the Builder.
      if (p === "/api/agent/tools") {
        const results = await probeEnabledServers(listMcpServers());
        return json({
          ok: true,
          data: {
            tools: results.flatMap((r) => r.tools),
            servers: results.map((r) => ({ server: r.server, ok: r.ok, count: r.tools.length, error: r.error ?? "" })),
          },
        });
      }
      if (p === "/api/agent/traces") {
        const spec = url.searchParams.get("spec") ?? "";
        return json({ ok: true, data: { traces: listTraces(currentWorkspace(), spec || undefined) } });
      }
      if (p === "/api/agent/trace") {
        const id = url.searchParams.get("id") ?? "";
        return json({ ok: true, data: { trace: loadTrace(currentWorkspace(), id) } });
      }
      // P-AGENT.11a: resolve a parked approval checkpoint. Deny is terminal; unknown/expired ids refuse.
      if (p === "/api/agent/run/approve" && req.method === "POST") {
        const b = await readBody<{ runId?: unknown; approve?: unknown; reason?: unknown }>(req);
        const runId = typeof b.runId === "string" ? b.runId : "";
        const r = approveAgentRun(runId, b.approve === true, typeof b.reason === "string" ? b.reason : undefined);
        return json({ ok: r.ok, data: { output: r.output ?? "", error: r.error ?? "", blocked: !!r.blocked, reason: r.reason ?? "", paused: r.paused ?? null, runId: r.runId ?? "" } });
      }
      // P-APPEAR.1: the personalized chat-interface background (image + display mode). Its own file, so
      // the hot settings load() never parses the image data URL.
      if (p === "/api/chat-bg") {
        if (req.method === "POST") { const b = await readBody<Partial<ChatBg>>(req); const r = saveChatBg(b); return json({ ok: r.ok, data: r.ok ? r.data : null, error: r.error }); }
        return json({ ok: true, data: loadChatBg() });
      }
      // P-EXEC.3: "TLDR" - explain an intimidating command in plain terms via a cheap keyed model.
      if (p === "/api/explain" && req.method === "POST") {
        const b = await readBody<{ command?: unknown }>(req);
        const r = await explainCommand(String(b.command ?? ""));
        return json({ ok: r.ok, data: r, error: r.error });
      }
      // P-BRIEF.4 (ADR-0113) + P-VOICE.1 (ADR-0115): SYNTHESIZE the podcast to WAV via a TTS backend,
      // returned base64 for the renderer to play + download. Providers:
      //   local-tts  → self-hosted Kokoro (air-gap; no key; LUCID_TTS_URL, default :8880)
      //   openai-tts → ChatGPT/OpenAI TTS (needs OPENAI_API_KEY)
      //   elevenlabs → ElevenLabs (needs ELEVENLABS_API_KEY; two-host uses the user's favorite voices)
      // Fail-safe: a missing key is an actionable note; a synth failure returns the note (never a 500).
      if (p === "/api/brief/audio" && req.method === "POST") {
        const b = await readBody<{ provider?: unknown; voiceId?: unknown }>(req);
        const provider = b.provider === "local-tts" ? "local-tts" : b.provider === "elevenlabs" ? "elevenlabs" : "openai-tts";
        const pickedVoice = typeof b.voiceId === "string" && b.voiceId ? b.voiceId : "";
        const repo = join(import.meta.dir, "..");
        const rd = (f: string) => { try { return existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : ""; } catch { return ""; } };
        const script = buildPodcastScript(buildEngineeringUpdate({ label: "LucidAgentIDE", progressMd: rd("PROGRESS.md"), decisionsMd: rd("DECISIONS.md") }));
        let backend: PodcastBackend;
        if (provider === "local-tts") {
          backend = new OpenAiCompatibleTtsBackend({ baseUrl: process.env.LUCID_TTS_URL || "http://localhost:8880", model: process.env.LUCID_TTS_MODEL || "kokoro", voices: { Host: "af_heart", Engineer: "am_onyx", default: "af_heart" } });
        } else if (provider === "elevenlabs") {
          const key = process.env.ELEVENLABS_API_KEY;
          if (!key) return json({ ok: true, data: { note: "Add your ElevenLabs API key (Settings → Voice) to use ElevenLabs TTS.", audioB64: null, mime: "audio/wav", turns: 0 } });
          const v = voiceSettings();
          const host = pickedVoice || v.ttsVoice || v.ttsVoiceFavorites[0]; // the picker's choice wins for this run
          const engineer = v.ttsVoiceFavorites.find((id) => id !== host) || host;
          backend = new ElevenLabsTtsBackend({ apiKey: key, voices: { ...(host ? { Host: host } : {}), ...(engineer ? { Engineer: engineer } : {}), ...(host ? { default: host } : {}) } });
        } else {
          const key = process.env.OPENAI_API_KEY;
          if (!key) return json({ ok: true, data: { note: "Add your OpenAI API key (Providers → OpenAI) to use ChatGPT TTS, or choose Local TTS (Kokoro) / ElevenLabs.", audioB64: null, mime: "audio/wav", turns: 0 } });
          backend = new OpenAiCompatibleTtsBackend({ baseUrl: process.env.OPENAI_TTS_URL || "https://api.openai.com", apiKey: key, model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voices: { Host: "nova", Engineer: "onyx", default: "alloy" } });
        }
        const result = await backend.synthesize(script);
        const audioB64 = result.audio ? Buffer.from(result.audio).toString("base64") : null;
        return json({ ok: !!audioB64, data: { note: result.note, audioB64, mime: "audio/wav", turns: script.turns.length }, error: audioB64 ? undefined : result.note });
      }
      // P-VOICE.1 (ADR-0115): voice config (STT engine + TTS voice/favorites). GET reads; POST patches.
      if (p === "/api/voice-settings") {
        if (req.method === "POST") { const b = await readBody<Record<string, unknown>>(req); return json({ ok: true, data: setVoiceSettings(b as never) }); }
        return json({ ok: true, data: voiceSettings() });
      }
      // P-VOICE.1: list the account's ElevenLabs voices for the picker (favorites first), + the selection.
      if (p === "/api/voices") {
        const key = process.env.ELEVENLABS_API_KEY;
        const v = voiceSettings();
        if (!key) return json({ ok: true, data: { voices: [], favorites: v.ttsVoiceFavorites, selected: v.ttsVoice, note: "Add your ElevenLabs API key (Settings → Voice) to list voices." } });
        try { return json({ ok: true, data: { voices: await listElevenVoices({ apiKey: key }), favorites: v.ttsVoiceFavorites, selected: v.ttsVoice } }); }
        catch (e) { return json({ ok: true, data: { voices: [], favorites: v.ttsVoiceFavorites, selected: v.ttsVoice, note: `Could not list voices: ${String((e as Error)?.message ?? e)}` } }); }
      }
      // P-VOICE.1: transcribe recorded mic audio → text. Provider from settings: elevenlabs (cloud Scribe)
      // or whisper (offline OpenAI-compatible server). The transcript is ordinary user input (scanned on send).
      if (p === "/api/transcribe" && req.method === "POST") {
        const b = await readBody<{ audioB64?: unknown; mime?: unknown; language?: unknown }>(req);
        const audio = typeof b.audioB64 === "string" && b.audioB64 ? new Uint8Array(Buffer.from(b.audioB64, "base64")) : new Uint8Array();
        const v = voiceSettings();
        let stt: TranscriptionBackend;
        if (v.sttProvider === "elevenlabs") {
          const key = process.env.ELEVENLABS_API_KEY;
          if (!key) return json({ ok: true, data: { text: "", note: "Add your ElevenLabs API key (Settings → Voice), or switch STT to offline Whisper." } });
          stt = new ElevenLabsSttBackend({ apiKey: key });
        } else {
          stt = new OpenAiCompatibleSttBackend({ baseUrl: v.sttUrl, apiKey: process.env.OPENAI_API_KEY, model: process.env.LUCID_STT_MODEL || "whisper-1" });
        }
        const r = await stt.transcribe(audio, { mimeType: typeof b.mime === "string" ? b.mime : undefined, language: typeof b.language === "string" ? b.language : undefined });
        return json({ ok: true, data: { text: r.text, note: r.note } });
      }
      // P-VOICE.1: read arbitrary text aloud (assistant replies, an AAR summary) with the selected voice.
      if (p === "/api/tts/speak" && req.method === "POST") {
        const b = await readBody<{ text?: unknown; voiceId?: unknown; provider?: unknown }>(req);
        const text = String(b.text ?? "").slice(0, 8000);
        if (!text.trim()) return json({ ok: true, data: { audioB64: null, mime: "audio/mpeg", note: "nothing to speak" } });
        const v = voiceSettings();
        const provider = b.provider === "openai-tts" || b.provider === "local-tts" ? String(b.provider) : (v.ttsProvider || "elevenlabs");
        try {
          if (provider === "elevenlabs") {
            const key = process.env.ELEVENLABS_API_KEY;
            if (!key) return json({ ok: true, data: { audioB64: null, mime: "audio/mpeg", note: "Add your ElevenLabs API key (Settings → Voice)." } });
            const { elevenLabsSpeak } = await import("../harness/voice/elevenlabs.ts");
            const voiceId = (typeof b.voiceId === "string" && b.voiceId) || v.ttsVoice || v.ttsVoiceFavorites[0];
            const out = await elevenLabsSpeak(text, { apiKey: key, voiceId, format: "mp3" });
            return json({ ok: true, data: { audioB64: Buffer.from(out.audio).toString("base64"), mime: out.mime, note: "" } });
          }
          const kokoro = provider === "local-tts";
          const key = kokoro ? undefined : process.env.OPENAI_API_KEY;
          if (!kokoro && !key) return json({ ok: true, data: { audioB64: null, mime: "audio/wav", note: "Add your OpenAI API key (Providers → OpenAI), or pick ElevenLabs / Kokoro." } });
          const backend = new OpenAiCompatibleTtsBackend({ baseUrl: kokoro ? (process.env.LUCID_TTS_URL || "http://localhost:8880") : (process.env.OPENAI_TTS_URL || "https://api.openai.com"), apiKey: key, model: kokoro ? (process.env.LUCID_TTS_MODEL || "kokoro") : (process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"), voices: { default: kokoro ? "af_heart" : "alloy" } });
          const r = await backend.synthesize({ title: "read", turns: [{ speaker: "default", text }] });
          const audioB64 = r.audio ? Buffer.from(r.audio).toString("base64") : null;
          return json({ ok: true, data: { audioB64, mime: "audio/wav", note: audioB64 ? "" : r.note } });
        } catch (e) {
          return json({ ok: true, data: { audioB64: null, mime: "audio/mpeg", note: `TTS failed: ${String((e as Error)?.message ?? e)}` } });
        }
      }
      // In-app folder browser (works in the browser build AND Electron). Full-tree traversal
      // (ADR-0103/P-FS.1, superseding ADR-0022 M1): the local authenticated user can browse anywhere on
      // the machine, optionally confined to an org's managed `workspaceRoots`. The endpoint stays behind
      // ADR-0022's still-intact transport gates — loopback bind (H1) + Origin/Host/CSRF + token (H2).
      if (p === "/api/fs/list") {
        return json({ ok: true, data: listDir(url.searchParams.get("path"), { allowedRoots: managedWorkspaceRoots() }) });
      }
      // P-PREVIEW.3b (ADR-0096): may a remote URL load in the preview iframe? Reuses the egress allow-list /
      // managed ceiling (ADR-0062/0094) — a remote preview reaches the internet, so it only loads for a site
      // the user already approved; anything else stays gated (the agent requests it via the normal flow).
      if (p === "/api/preview/egress-check") {
        const target = url.searchParams.get("url") ?? "";
        return json({ ok: true, data: { allow: !!target && egressDecision(target) === "allow" } });
      }
      // P-PREVIEW.4 (ADR-0096): return a LOCAL previewable file's CONTENT so the renderer can show it via
      // the iframe's `srcdoc`. Needed because the renderer is served over http and Chromium blocks a
      // `file://` iframe from an http origin — so `iframe.src = file://…` never rendered. The authenticated
      // bridge fetches this (transport gate: loopback + token), then sets srcdoc (same hardened sandbox).
      // Gated to a local .html/.htm/.svg file, existing, ≤ 5 MB. Read-only; the local user could read it anyway.
      if (p === "/api/preview/file") {
        const target = (url.searchParams.get("path") ?? "").trim();
        const r = readPreviewFile(target);
        return json(r.ok ? { ok: true, data: { html: r.html, label: r.label } } : { ok: false, error: r.error });
      }
      // P-PREVIEW.4b (ADR-0096): serve a local previewable file's CONTENT as an HTML document with its OWN
      // per-frame CSP (PREVIEW_FRAME_CSP), loaded by the renderer via `iframe.src`. A `srcdoc` frame inherits
      // the renderer's `script-src 'self'`, which blocked a previewed app's inline scripts (it rendered only
      // its static HTML). Served via `src`, the document carries PREVIEW_FRAME_CSP: inline JS/CSS run, but
      // `connect-src 'none'` blocks all network egress. The opaque-origin sandbox (set on the iframe) keeps
      // it off LUCID's origin. Behind the transport gate (loopback + token, here via `?t=`). Read-only.
      // P-PREVIEW.3a-shot (ADR-0096): the renderer proactively caches a PNG of the current preview here after
      // each render (capturePage is Electron-only and lives in the main process, unreachable from omp). The
      // agent's `preview_screenshot` tool then FETCHES it from /api/preview/shot below. In-memory, last-writer-wins.
      if (p === "/api/preview/shot-cache" && req.method === "POST") {
        const b = await req.json().catch(() => null) as { png?: unknown } | null;
        latestPreviewShot = typeof b?.png === "string" && b.png.startsWith("data:image/") ? b.png : latestPreviewShot;
        return json({ ok: true, data: { cached: !!latestPreviewShot } });
      }
      // P-PREVIEW.6b (ADR-0153): the agent's `preview_inspect` tool (omp subprocess) reads the live preview
      // DOM. The iframe is opaque-origin sandboxed, so this request is HELD here until the RENDERER runs the
      // query on the frame (via the postMessage bridge) and posts the result back — or an 8s timeout returns a
      // helpful "no preview open" message. Read-only by construction (the command only describes a query).
      if (p === "/api/preview/inspect") {
        const { id, promise } = inspectRelay.enqueue({ selector: url.searchParams.get("selector") ?? undefined, what: url.searchParams.get("what") ?? undefined });
        const t = setTimeout(() => inspectRelay.abandon(id, { error: "no preview is open (or it didn't respond) — open a preview first, then inspect it" }), 8000);
        const result = await promise; clearTimeout(t);
        return json({ ok: true, data: { result } });
      }
      // P-PREVIEW.6c (ADR-0153): the agent's preview_click / preview_type tools — a STRUCTURED action (a named
      // op on a CSS selector) through the same held relay + bridge. Same fail-closed timeout. No arbitrary JS.
      if (p === "/api/preview/act") {
        const { id, promise } = inspectRelay.enqueue({ action: url.searchParams.get("action") ?? undefined, selector: url.searchParams.get("selector") ?? undefined, value: url.searchParams.get("value") ?? undefined });
        const t = setTimeout(() => inspectRelay.abandon(id, { error: "no preview is open (or it didn't respond) — open a preview first, then act on it" }), 8000);
        const result = await promise; clearTimeout(t);
        return json({ ok: true, data: { result } });
      }
      // The renderer pulls the next queued inspect command (poll while a preview is open) …
      if (p === "/api/preview/inspect/next") {
        return json({ ok: true, data: inspectRelay.next() ?? { none: true } });
      }
      // … runs it on the sandboxed frame via postMessage, and posts the result back (resolves the held tool call).
      if (p === "/api/preview/inspect/result" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; result?: unknown }>(req);
        const resolved = typeof b.id === "string" ? inspectRelay.resolve(b.id, b.result) : false;
        return json({ ok: true, data: { resolved } });
      }
      if (p === "/api/preview/shot") {
        return json({ ok: true, data: { png: latestPreviewShot } });
      }
      // P-PREVIEW.7 (ADR-0179): is the previewed file part of an ELECTRON app (which the sandboxed
      // frame cannot run - no Node/require)? Read-only detection for the renderer's explain-overlay.
      if (p === "/api/preview/electron-detect") {
        const det = detectElectronApp((url.searchParams.get("path") ?? "").trim());
        const plan = electronLaunchPlan(det, Bun.which("electron"));
        return json({ ok: true, data: { electron: det.electron, reasons: det.reasons, appDir: det.appDir, launchable: !!plan, via: plan?.via ?? null } });
      }
      // P-PREVIEW.7: USER-initiated external launch - runs the app as a real OS process OUTSIDE
      // LUCID (the sandbox stays sealed), audited as a first-party exec SecurityEvent. Refuses any
      // path that doesn't detect as an Electron app; a missing runtime returns the manual command.
      if (p === "/api/preview/electron-launch" && req.method === "POST") {
        const b = await readBody<{ path?: unknown }>(req);
        const det = detectElectronApp(String(b.path ?? "").trim());
        if (!det.electron) return json({ ok: true, data: { launched: false, reason: "not an Electron app (no electron dependency or start script found)" } });
        const plan = electronLaunchPlan(det, Bun.which("electron"));
        if (!plan) return json({ ok: true, data: { launched: false, reason: "no Electron runtime found - run `npx electron .` in the app folder", appDir: det.appDir } });
        try {
          const child = spawnChild(plan.cmd, plan.args, { cwd: plan.cwd, detached: true, stdio: "ignore", windowsHide: false });
          child.unref();
          emitSecurityEvent({ category: "exec", type: "preview_electron_launch", decision: "allow", severity: "info", tool: "preview", reason: `preview: user launched Electron app at ${det.appDir} (${plan.via} runtime)` });
          return json({ ok: true, data: { launched: true, via: plan.via, appDir: det.appDir } });
        } catch (e) {
          return json({ ok: true, data: { launched: false, reason: `launch failed: ${(e as Error).message}` } });
        }
      }
      if (p === "/api/preview/serve") {
        const target = (url.searchParams.get("path") ?? "").trim();
        const r = readPreviewFile(target);
        const headers: Record<string, string> = {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": PREVIEW_FRAME_CSP,
          "x-content-type-options": "nosniff",
        };
        if (r.ok) {
          // P-PREVIEW.4c (ADR-0096): fold the app's OWN relative assets (css/js/img/fonts) inline so a
          // MULTI-FILE app renders under the opaque-origin, egress-blocked frame CSP. HTML only (an .svg is
          // self-contained); best-effort — a read failure just serves the raw HTML (the CSP blocks the ref).
          let body = r.html;
          if (/\.html?$/i.test(toFsPath(target))) {
            try {
              body = inlinePreviewAssets(body, dirname(toFsPath(target)), {
                readText: (pp) => readFileSync(pp, "utf8"),
                readBytes: (pp) => readFileSync(pp),
              });
            } catch { /* serve raw HTML on any inlining failure */ }
          }
          // P-PREVIEW.6b (ADR-0153): inject the read-only DOM-inspect bridge (inline JS, CSP-allowed; egress
          // still blocked by connect-src 'none'). Only for HTML — an .svg is self-contained + has no DOM to
          // inspect. It answers postMessage queries from the LUCID renderer; it never mutates or evals.
          if (/\.html?$/i.test(toFsPath(target))) body = injectPreviewBridge(body);
          return new Response(body, { headers });
        }
        const safe = r.error.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
        return new Response(
          `<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px system-ui;color:#9aa;background:#0b0b10;padding:1.25rem">Can't preview this file - ${safe}.</body>`,
          { status: 200, headers },
        );
      }

      // P-TASK.5 (ADR-0180): live subagent activity for the delegation card. Reads the CURRENT
      // session's subtask transcripts (omp persists each subtask beside the parent session file) -
      // read-only, path-confined to the resolved session file, fail-quiet [] when nothing delegated.
      if (p === "/api/subagents") {
        try { return json({ ok: true, data: { runs: listSubagentRuns(sessionPathById(backend.currentSessionId())) } }); }
        catch { return json({ ok: true, data: { runs: [] } }); }
      }
      // P-SYSRES.1 (ADR-0182): system resource profile + guard verdict + top processes. Read-only
      // (fixed-argv process listing, nothing user-controlled reaches a command line), memoized 5s
      // (?fresh=1 busts it - the panel's Refresh button). FAIL-OPEN: a failed sample reads as "ok"
      // with no evidence - this is a UX load guard, never the security gate (ADR-0182).
      if (p === "/api/system") {
        const now = Date.now();
        if (url.searchParams.get("fresh") === "1" || !sysResCache || now - sysResCache.at > 5000) {
          const snap = await sampleSystem();
          sysResCache = { at: now, data: { snap, verdict: assessSystem(snap), procs: topProcesses() } };
        }
        return json({ ok: true, data: sysResCache.data });
      }
      // real omp ACP backend (genuine model replies + live session config)
      if (p === "/api/sessions") return json({ ok: true, data: listSessions() });
      if (p === "/api/sessions/ingest/clear" && req.method === "POST") return json({ ok: true, data: clearIngestSessions() }); // P-KG-INGEST.2
      if (p === "/api/session" && url.searchParams.get("id")) { // P-PERF.4: tail-first page (limit=0 = all)
        const lim = Math.max(0, Math.trunc(Number(url.searchParams.get("limit")) || 0));
        const sid = url.searchParams.get("id")!;
        const page = sessionMessages(sid, lim);
        // P-RESUME.1 (ADR-0171): re-anchor the step recorder to the transcript's REAL user count
        // (turns run outside this GUI can't shift later anchors), then merge the restored activity.
        syncStepTurns(sid, page.userTotal);
        return json({ ok: true, data: { ...page, steps: readTurnSteps(sid) } });
      }
      if (p === "/api/session/load" && req.method === "POST") { const { id } = await readBody<{ id?: unknown }>(req); await backend.loadSession(String(id)); return json({ ok: true }); }
      if (p === "/api/session/delete" && req.method === "POST") {
        const { id } = await readBody<{ id?: unknown }>(req);
        const sid = String(id);
        // If it's the live session, close it first so omp releases the file handle (Windows
        // locks open files), then start fresh. newSession() does session/close + ensureSession.
        if (backend.currentSessionId() === sid) await backend.newSession().catch(() => {});
        const res = deleteSession(sid);
        if (res.ok) deleteSteps(sid); // P-RESUME.1: the activity sidecar goes with its session
        return json({ ok: true, data: res });
      }

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
          const b = await readBody<{ skip?: unknown; email?: unknown; username?: unknown; role?: unknown; tourSeen?: unknown }>(req);
          // ADR-0088/0089: role + first-run-tour state are cosmetic and policy-free — set them up front,
          // independent of the email-attribution policy gate below.
          if (b.role != null && (USER_ROLES as string[]).includes(String(b.role))) setUserRole(String(b.role) as UserRole);
          if (b.tourSeen != null) setTourSeen(!!b.tourSeen);
          // Enforce enterprise-managed attribution policy server-side (the UI also reflects it).
          if (b.skip && !skipAllowed()) return json({ ok: false, error: "Your organization requires a corporate email.", data: settingsData() });
          if (b.email != null && String(b.email).trim() && !emailDomainAllowed(String(b.email))) {
            const ds = managedConfig().config?.attribution?.allowedEmailDomains ?? [];
            return json({ ok: false, error: `Use your corporate email${ds.length ? " (" + ds.map((d) => "@" + d).join(", ") + ")" : ""}.`, data: settingsData() });
          }
          if (b.skip) setAttributionSkip(); // user skipped the email prompt → workstation attribution
          else if (b.email != null || b.username != null) setProfile({ username: b.username != null ? String(b.username) : undefined, email: b.email != null ? String(b.email) : undefined });
        }
        return json({ ok: true, data: settingsData() });
      }
      // Enterprise-managed policy (read-only; placed by admins via GPO/MDM). Sanitized — policy only.
      if (p === "/api/managed") {
        const mc = managedConfig();
        return json({ ok: true, data: {
          managed: !!mc.config,
          orgName: typeof mc.config?.orgName === "string" ? mc.config.orgName : "",
          attribution: mc.config?.attribution ?? null,
          asksageOnly: managedAsksageOnly(mc.config),
          locks: managedLocks(mc.config),
        } });
      }
      // P-IDE.1c (ADR-0029): the China-origin data-sovereignty acknowledgement gate. GET returns the
      // flag; POST {acknowledge:true} after the user types ACKNOWLEDGE unlocks those models in the picker.
      if (p === "/api/china-ack") {
        if (req.method === "POST") { const b = await readBody<{ acknowledge?: unknown }>(req); return json({ ok: true, data: { acknowledged: !!setChinaModelsAcknowledged(!!b.acknowledge).chinaModelsAcknowledged } }); }
        return json({ ok: true, data: { acknowledged: chinaModelsAcknowledged() } });
      }
      // The third-party / non-U.S. / custom "More providers" acknowledgement gate (mirrors china-ack).
      if (p === "/api/thirdparty-ack") {
        if (req.method === "POST") { const b = await readBody<{ acknowledge?: unknown }>(req); return json({ ok: true, data: { acknowledged: !!setThirdPartyProvidersAcknowledged(!!b.acknowledge).thirdPartyProvidersAcknowledged } }); }
        return json({ ok: true, data: { acknowledged: thirdPartyProvidersAcknowledged() } });
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
      // Device-authorization flow: xAI "Grok Build", GitHub device flow, etc. The user copies a code
      // from the provider's browser page and pastes it here; we forward it to the broker's stdin.
      if (p === "/api/auth/oauth-code" && req.method === "POST") {
        const { oauthId, code } = await readBody<{ oauthId?: unknown; code?: unknown }>(req);
        const r = sendOauthCode(String(oauthId), String(code ?? ""));
        return json({ ok: true, data: r });
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
      // P-TRIV.3 (ADR-0176): executive Trivia Wire intel news - first-party curated feeds, fetched
      // server-side, scan-gated fail-closed, fail-quiet to [] offline. Audited per fetch (egress events).
      if (p === "/api/intel-news") return json({ ok: true, data: await intelNews() });
      // P-TRIV.4 (ADR-0186): AI re-seed the Trivia Wire. The renderer POSTs the role + opt-in sources; we
      // gather that on-device context, hand it to seedTrivia which SCANS it fail-closed (a finding or a dead
      // scanner drops the whole re-seed - the model is never called), delimits it late, and generates a pack
      // on the user's SELECTED model (throwaway util session, tool-free). Fail-quiet: the caller keeps the seed.
      if (p === "/api/trivia/reseed" && req.method === "POST") {
        const b = await readBody<{ model?: unknown; role?: unknown; sources?: { sessions?: unknown; kg?: unknown; codegraph?: unknown } }>(req);
        const sources = { sessions: !!b.sources?.sessions, kg: !!b.sources?.kg, codegraph: !!b.sources?.codegraph };
        const data = await seedTrivia(
          { role: typeof b.role === "string" ? b.role : "developer", sources, model: typeof b.model === "string" ? b.model : "" },
          {
            providers: {
              sessions: () => listSessions().sessions.map((s) => s.title),
              kg: () => { const g = personalGraph(); return g ? [...g.facts.map((f) => f.statement), ...g.nodes.map((n) => n.name)] : []; },
              code: () => (loadCodeGraph(currentWorkspace())?.nodes ?? []).map((n) => n.name),
            },
            complete: (system, user, m) => backend.complete(system, user, m ? { model: m } : {}),
          },
        );
        return json({ ok: true, data });
      }
      if (p === "/api/skills") return json({ ok: true, data: await listSkills() });
      // P-SKILL.1 (ADR-0045): gated drop-import. Each dropped .md is scanned fail-closed; clean ones
      // are written under .omp/skills/<slug>/SKILL.md, flagged ones are held for Security-panel review.
      if (p === "/api/skills/import" && req.method === "POST") {
        const b = await readBody<{ files?: { name?: unknown; content?: unknown }[] }>(req);
        const files = Array.isArray(b.files) ? b.files.slice(0, 20) : []; // cap one drop at 20 files
        const results = [];
        for (const f of files) {
          const content = String(f?.content ?? "");
          if (!content.trim()) { results.push({ ok: false, name: String(f?.name ?? "skill"), reason: "empty file" }); continue; }
          results.push(await importSkill(String(f?.name ?? "skill.md"), content));
        }
        return json({ ok: true, data: { results } });
      }
      // P-SKILL.4 (ADR-0097): the directory's per-skill management menu. All three resolve the skill by
      // NAME through omp's own discovery (never a client-supplied path) and are pathWithin-confined:
      //   inspect — read the SKILL.md body + resource tree as DATA (the renderer delimits it);
      //   rescan  — run the fail-closed gate + record the verdict (dead scanner ⇒ quarantined);
      //   remove  — delete a project/user skill dir; bundled/agents/plugin are refused (immutable).
      if (p === "/api/skills/inspect" && req.method === "POST") {
        const b = await readBody<{ name?: unknown }>(req);
        return json({ ok: true, data: await inspectSkill(String(b.name ?? "")) });
      }
      if (p === "/api/skills/rescan" && req.method === "POST") {
        const b = await readBody<{ name?: unknown }>(req);
        return json({ ok: true, data: await rescanSkill(String(b.name ?? "")) });
      }
      if (p === "/api/skills/remove" && req.method === "POST") {
        const b = await readBody<{ name?: unknown }>(req);
        return json({ ok: true, data: await removeSkill(String(b.name ?? "")) });
      }
      // P-SKILLREG.1 (ADR-0098): the enterprise-registry READER seam. A connector (private add-on) POSTs a
      // fetched, signed skill artifact; the reader verifies its signature, runs it through the fail-closed
      // scan gate, and installs it locally ONLY if both pass \u2014 then it appears as a `registry` directory row.
      // Fail-closed: unsigned / bad-signature / scan-flagged / dead-scanner \u2192 blocked, nothing written.
      if (p === "/api/skills/registry/install" && req.method === "POST") {
        const b = await readBody<{ artifact?: RegistrySkillArtifact }>(req);
        if (!b.artifact) return json({ ok: true, data: { ok: false, name: "", installed: false, stage: "validate", reason: "missing artifact" } });
        return json({ ok: true, data: await installRegistrySkill(b.artifact) });
      }
      // P-SKILL.5 (ADR-0101): Skill Studio. `analyze` gathers the user's recent work into a delimited DATA
      // digest and asks the most-used model for candidate skills; `draft` codifies ONE reviewed candidate
      // through the SAME fail-closed import gate (clean writes to .omp/skills, flagged blocks). Analysis
      // uses backend.complete (the model call) with the digest's model; nothing is written at analyze time.
      if (p === "/api/skill-studio/analyze" && req.method === "POST") {
        const b = await readBody<{ window?: unknown }>(req);
        const window: StudioWindow = b.window === "today" ? "today" : "week";
        const data = await analyzeWork(window, {
          gather: gatherWorkDigest,
          complete: (system, user, model) => backend.complete(system, user, model ? { model } : {}),
        });
        return json({ ok: true, data });
      }
      if (p === "/api/skill-studio/draft" && req.method === "POST") {
        const b = await readBody<{ candidate?: SkillCandidate }>(req);
        const c = b.candidate;
        if (!c || typeof c.name !== "string" || typeof c.description !== "string" || typeof c.body !== "string") {
          return json({ ok: true, data: { ok: false, name: "", reason: "invalid candidate" } });
        }
        return json({ ok: true, data: await codifyCandidate({ name: c.name, description: c.description, body: c.body }) });
      }
      // P-KB.2b (ADR-0099/0100 desktop plumbing): the compiled knowledge base surface. ingest = scan the
      // source + compile (backend.complete, most-used model) + re-scan each derived page, all fail-closed;
      // retrieve = the router (the vector store is not desktop-wired yet, so vector/hybrid return the
      // compiled hits) delimited + cited; graph = pages + links for the force-graph view.
      if (p === "/api/kb/ingest" && req.method === "POST") {
        const b = await readBody<{ sourcePath?: unknown; title?: unknown; text?: unknown }>(req);
        const text = String(b.text ?? "");
        if (!text.trim()) return json({ ok: true, data: { documentId: "", status: "quarantined", pagesCompiled: 0, pagesQuarantined: 0, links: 0, pageIds: [], blocked: [{ stage: "source", reason: "empty document", trustLabel: "quarantined", findings: 0 }] } });
        const model = usageLedger().models[0]?.model;
        const result = await ingestDocument({
          store: await kbStore(),
          scanner: kbScanner(),
          complete: (system, user) => backend.complete(system, user, model ? { model } : {}),
          sourcePath: String(b.sourcePath ?? "document"),
          title: String(b.title ?? "Untitled"),
          text,
          onBlock: (blk) => recordBlock({ tool: "kb_ingest", severity: "high", findings: String(blk.findings), reason: `KB ${blk.stage} blocked${blk.slug ? ` (${blk.slug})` : ""}: ${blk.reason}` }),
        });
        return json({ ok: true, data: result });
      }
      if (p === "/api/kb/retrieve" && req.method === "POST") {
        const b = await readBody<{ query?: unknown; mode?: unknown }>(req);
        const mode: RetrieveMode = b.mode === "vector" || b.mode === "hybrid" ? b.mode : "compiled";
        return json({ ok: true, data: await retrieveKnowledge({ query: String(b.query ?? ""), mode, compiled: { store: await kbStore() } }) });
      }
      if (p === "/api/kb/graph") {
        const s = await kbStore();
        return json({ ok: true, data: { pages: await s.listPages(), links: await s.listLinks() } });
      }
      // P-SKILLREG.2 (ADR-0102): the PUBLISH seam. Reads a codified skill's SKILL.md and publishes it as a
      // versioned artifact to the configured targets (fail-safe fan-out). Public ships the LOCAL publisher;
      // a declared remote with no registered publisher is a clean no-op. Publishing establishes NO trust:
      // the signature + scan gate still run on the READ side (P-SKILLREG.1) before anything installs.
      if (p === "/api/skills/publish" && req.method === "POST") {
        const b = await readBody<{ name?: unknown; version?: unknown; targets?: unknown }>(req);
        const insp = await inspectSkill(String(b.name ?? ""));
        if (!insp.ok || !insp.body) return json({ ok: true, data: { ok: false, receipts: [], reason: insp.reason ?? "skill not found or empty" } });
        const version = typeof b.version === "string" && b.version ? b.version : "1.0.0";
        const targets = Array.isArray(b.targets) ? b.targets.filter((t): t is string => typeof t === "string") : undefined;
        const dispatcher = new PublishDispatcher();
        dispatcher.setPublishers(publishersFor());
        const receipts = await dispatcher.publish(buildSkillArtifact({ name: insp.name, version, content: insp.body }), targets);
        return json({ ok: true, data: { ok: receipts.some((r) => r.ok), receipts } });
      }
      // P-CMD.1 (ADR-0146): user-authored "/" slash commands. GET = list stored commands; POST = create one
      // (validate → secret-scan → Unicode-scan, all fail-closed → persist). The delete route removes one.
      if (p === "/api/usercommand" && req.method === "GET") return json({ ok: true, data: listUserCommands() });
      if (p === "/api/usercommand" && req.method === "POST") {
        const b = await readBody<{ command?: unknown }>(req);
        return json({ ok: true, data: await createUserCommand(b.command) });
      }
      if (p === "/api/usercommand/delete" && req.method === "POST") {
        const b = await readBody<{ name?: unknown }>(req);
        return json({ ok: true, data: { deleted: deleteUserCommand(String(b.name ?? "")) } });
      }
      if (p === "/api/headroom") {
        if (req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); return json({ ok: true, data: setHeadroomEnabled(!!b.enabled) }); }
        return json({ ok: true, data: headroomStatus() });
      }
      // Personalization knowledge graph (ADR-0010 P9.1 / ADR-0012). Passphrase custody;
      // the passphrase never leaves this handler and is never persisted.
      if (p === "/api/personal") return json({ ok: true, data: personalStatus() });
      if (p === "/api/personal/enable" && req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); return json({ ok: true, data: enablePersonal(!!b.enabled) }); }
      if (p === "/api/personal/ai-extract" && req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); setPersonalAiExtract(!!b.enabled); return json({ ok: true, data: personalStatus() }); }
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
      // P-KG-REL.1 (ADR-0075): user-authored relationship between two existing, visible nodes. First-party
      // (not external content) → no scanner; relateEntities validates both nodes + sanitizes the label.
      if (p === "/api/personal/relate" && req.method === "POST") { const b = await readBody<{ from?: unknown; to?: unknown; relation?: unknown }>(req); return json({ ok: true, data: relateEntities(String(b.from ?? ""), String(b.to ?? ""), b.relation == null ? undefined : String(b.relation)) }); }
      if (p === "/api/personal/unrelate" && req.method === "POST") { const b = await readBody<{ from?: unknown; to?: unknown; relation?: unknown }>(req); return json({ ok: true, data: unrelateEntities(String(b.from ?? ""), String(b.to ?? ""), b.relation == null ? undefined : String(b.relation)) }); } // P-KG-REL.3
      // P9.7: import a ChatGPT / Claude / Gemini export (folder, .json, or .zip). Every imported
      // user message is scanned by the fail-closed gate first. `model:true` runs the richer LLM
      // extractor via a throwaway omp completion (capped); otherwise the offline heuristic.
      if (p === "/api/personal/import" && req.method === "POST") {
        // P-KG-INGEST.1 (ADR-0076): start the import as a BACKGROUND job and return a jobId immediately,
        // so the request never blocks the app for ~25 minutes. The renderer polls /status + can /cancel.
        const b = await readBody<{ model?: unknown; path?: unknown; vendor?: ImportVendor }>(req);
        const path = String(b.path ?? ""), vendor = b.vendor;
        const complete = b.model ? (system: string, user: string) => backend.complete(system, user) : undefined;
        const started = startImport({
          vendor: typeof vendor === "string" ? vendor : undefined,
          run: (onProgress, signal) => importChatExport(path, { vendorHint: vendor, complete, onProgress, signal }),
        });
        return json({ ok: true, data: started });
      }
      if (p === "/api/personal/import/status" && req.method === "GET")
        return json({ ok: true, data: importJobStatus(url.searchParams.get("jobId") ?? undefined) });
      if (p === "/api/personal/import/cancel" && req.method === "POST") {
        const b = await readBody<{ jobId?: unknown }>(req);
        return json({ ok: true, data: cancelImport(b.jobId == null ? undefined : String(b.jobId)) });
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
      if (p === "/api/goal/cancel" && req.method === "POST") { backend.cancelGoal(); return json({ ok: true, data: { cancelled: true } }); } // P-GOAL.2: stop the loop
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
        const { text, images } = await readBody<{ text?: unknown; images?: unknown }>(req);
        // P-VISION.1 (ADR-0136): pasted-image content blocks ride alongside the text (defensively filtered).
        const imgs = Array.isArray(images)
          ? images.filter((im): im is { data: string; mimeType: string } => !!im && typeof (im as { data?: unknown }).data === "string" && typeof (im as { mimeType?: unknown }).mimeType === "string").slice(0, 6)
          : undefined;
        return ndjsonStream("chat", (emit) => backend.prompt(String(text ?? ""), emit, imgs));
      }
      // P-GOAL.1 (ADR-0046): run a /goal loop — maker iterations + a separate verifiable checker, capped
      // and gated. Streams the same NDJSON chat events plus goal-iter / goal-check / goal-done / goal-stop.
      // P-GOAL.4: loops that stopped without meeting their condition (resumable from their memory file).
      // P-GOAL.6 (ADR-0048): the /goal checker MODEL — a distinct, cheaper judge. GET returns the saved
      // choice + the auto recommendation + the accessible list; POST persists the choice ("" = auto).
      if (p === "/api/checker-model" && req.method === "GET") return json({ ok: true, data: backend.checkerModelInfo() });
      if (p === "/api/checker-model" && req.method === "POST") {
        const b = await readBody<{ value?: unknown }>(req);
        return json({ ok: true, data: backend.setCheckerModelChoice(String(b.value ?? "")) });
      }
      if (p === "/api/goal/resumable") return json({ ok: true, data: listResumableLoops(currentWorkspace()) });
      // P-GOAL.14 (ADR-0112): browse PAST After-Action Reports for this workspace. GET lists them
      // (most-recent first); GET with ?rel= returns one report's markdown (confined to .omp/loops/).
      if (p === "/api/goal/reports") {
        const rel = url.searchParams.get("rel");
        if (rel) { const md = readGoalReport(currentWorkspace(), rel); return md != null ? json({ ok: true, data: { rel, markdown: md } }) : json({ ok: false, error: "report not found" }); }
        return json({ ok: true, data: listGoalReports(currentWorkspace()) });
      }
      // P-GOAL.10 (ADR-0055): cross-run evaluation — success rate / avg iters / failure breakdown + recent runs.
      if (p === "/api/goal/stats") return json({ ok: true, data: backend.loopRunStats() });
      // P-GOAL.12 (ADR-0057): Pre-Flight Audit — git scopes for the picker, and the readiness/design pass.
      if (p === "/api/goal/scopes") return json({ ok: true, data: backend.loopScopes() });
      if (p === "/api/goal/preflight" && req.method === "POST") {
        const b = await readBody<Record<string, unknown>>(req);
        const spec = {
          goal: String(b.goal ?? ""), command: b.command ? String(b.command) : undefined, scope: b.scope ? String(b.scope) : undefined,
          budgetUsd: Number(b.budgetUsd) || 0, maxIters: Number(b.maxIters) || undefined, checkerIsCheap: b.checkerIsCheap === true,
          doneDefinition: b.doneDefinition ? String(b.doneDefinition) : undefined, nonGoals: b.nonGoals ? String(b.nonGoals) : undefined,
          risks: b.risks ? String(b.risks) : undefined, feedback: b.feedback ? String(b.feedback) : undefined,
        };
        return json({ ok: true, data: await backend.preflightAudit(spec) });
      }
      if (p === "/api/goal" && req.method === "POST") {
        const b = await readBody<{ goal?: unknown; condition?: unknown; command?: unknown; maxIters?: unknown; resume?: unknown; budgetUsd?: unknown; criteria?: unknown; dial?: unknown }>(req);
        return ndjsonStream("goal", (emit) => backend.runGoal(
          { goal: String(b.goal ?? ""), condition: String(b.condition ?? ""), command: b.command ? String(b.command) : undefined, maxIters: Number(b.maxIters) || 6, resume: b.resume ? String(b.resume) : undefined, budgetUsd: Number(b.budgetUsd) || 0, criteria: b.criteria ? String(b.criteria) : undefined, dial: parseLoopDial(b.dial) },
          emit,
        ));
      }

      // P-GOAL.5 (ADR-0047): scheduled AUTOMATIONS — saved /goal specs the in-process scheduler runs on a
      // cadence (interval or daily) while the app is open. Created DISABLED; the user arms each explicitly.
      if (p === "/api/automations" && req.method === "GET") return json({ ok: true, data: listAutomations(currentWorkspace()) });
      if (p === "/api/automations" && req.method === "POST") {
        const b = await readBody<{ goal?: unknown; condition?: unknown; command?: unknown; maxIters?: unknown; cadence?: unknown; kind?: unknown; agentSpecId?: unknown; agentPrompt?: unknown; agentModel?: unknown }>(req);
        const cadence = normalizeCadence(b.cadence);
        if (!cadence) return json({ ok: false, error: "invalid cadence" });
        const a = createAutomation(currentWorkspace(),
          {
            goal: String(b.goal ?? ""), condition: b.condition ? String(b.condition) : undefined, command: b.command ? String(b.command) : undefined, maxIters: Number(b.maxIters) || 6, cadence,
            // P-AGENT.14: scheduled built-agent runs (created DISARMED like every automation)
            kind: b.kind === "agent" ? "agent" : undefined,
            agentSpecId: b.agentSpecId ? String(b.agentSpecId) : undefined,
            agentPrompt: b.agentPrompt ? String(b.agentPrompt) : undefined,
            agentModel: b.agentModel ? String(b.agentModel) : undefined,
          },
          Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), Date.now());
        return a ? json({ ok: true, data: a }) : json({ ok: false, error: "could not create (check the goal/agent fields)" });
      }
      if (p === "/api/automations/enable" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; enabled?: unknown }>(req);
        const a = updateAutomation(currentWorkspace(), String(b.id ?? ""), { enabled: !!b.enabled });
        return a ? json({ ok: true, data: a }) : json({ ok: false, error: "not found" });
      }
      if (p === "/api/automations/delete" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        return json({ ok: deleteAutomation(currentWorkspace(), String(b.id ?? "")), data: { deleted: true } });
      }
      if (p === "/api/automations/run" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        return ndjsonStream("automation", async (emit) => { await backend.runAutomation(String(b.id ?? ""), emit); });
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
        const ct = CT[ext] ?? "application/octet-stream";
        // Text assets (css/js/svg) must stay fresh so edits show on reload; cache only binary assets
        // (images/fonts), which are large and rarely change.
        return new Response(file, { headers: { "content-type": ct + (isTextCT(ct) ? "; charset=utf-8" : ""), "cache-control": isTextCT(ct) ? "no-store" : "max-age=86400" } });
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

// P-PREVIEW.3a-shot (ADR-0096): hand the omp subprocess a ready-to-use URL (real bound port + token) for the
// agent's preview_screenshot tool to fetch the cached shot. omp is spawned later (lazily, by acp_backend in
// THIS process) and inherits process.env, so setting it here — after the server binds — is enough; no
// ACPClient env plumbing needed. 127.0.0.1 (not localhost) matches the loopback bind.
process.env.LUCID_PREVIEW_SHOT_URL = `http://127.0.0.1:${server.port}/api/preview/shot?t=${TOKEN}`;
// P-PREVIEW.6b (ADR-0153): the agent's preview_inspect tool GETs this (with ?selector=&what=) to read the DOM.
process.env.LUCID_PREVIEW_INSPECT_URL = `http://127.0.0.1:${server.port}/api/preview/inspect?t=${TOKEN}`;
// P-PREVIEW.6c (ADR-0153): preview_click / preview_type GET this (with ?action=&selector=&value=) to act.
process.env.LUCID_PREVIEW_ACT_URL = `http://127.0.0.1:${server.port}/api/preview/act?t=${TOKEN}`;

// Build recall once at startup — the FIRST session is created lazily on the first /api/chat (never
// via /api/newSession), so this is what carries prior-session facts into it. Best-effort; the omp
// child isn't spawned yet here, so the read-only open is uncontended.
await refreshRecall();

// P-GOAL.5 (ADR-0047): arm the in-process automation scheduler. It only ticks while this dev server
// (and thus the app) is running; nothing is registered with the OS, so closing the app stops it.
backend.startAutomationScheduler();

console.log(`\n  ◆ LucidAgentIDE desktop renderer (dev)\n  → http://localhost:${server.port}\n`);
