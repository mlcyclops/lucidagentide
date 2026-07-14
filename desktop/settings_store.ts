// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/settings_store.ts
//
// Local GUI settings: username + provider API keys. Stored under
// ~/.omp/lucid-gui.json with user-only file perms, and injected into the
// environment so a spawned `omp acp` inherits the keys (env vars are omp's
// primary API-key mechanism). Keys never leave the machine; the HTTP API only
// ever returns masked status (set? + last-4), never the raw key.
//
// (OAuth is handled separately via omp's own credential vault / auth-broker -
//  that's the more secure path and omp owns the storage there.)

import { closeSync, fchmodSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { emailDomainAllowed, managedConfig, skipAllowed } from "./managed_config.ts";
import { remoteAgentMcpServers } from "../harness/mcp/registry.ts";
import { DEFAULT_RELAY_URL } from "@oh-my-pi/pi-wire"; // P-COLLAB.3: the public-relay fallback origin
import { validateLocalProvider, type LocalProviderDef } from "./local_providers.ts";

// LUCID_GUI_SETTINGS_FILE: test seam - point the store at a temp file (never set in production).
// Read per call (not at module init) so the seam is immune to module-cache order in the test runner.
const settingsFile = (): string => process.env.LUCID_GUI_SETTINGS_FILE || join(homedir(), ".omp", "lucid-gui.json");

// P-MCP.1 (ADR-0020): one configured MCP server. The token is a bearer credential sent as an
// Authorization header to a remote (HTTP/SSE) MCP server.
export interface McpServerEntry {
  id: string;
  name: string;
  transport: "http" | "sse";
  url: string;
  token?: string;
  enabled: boolean;
}

// ADR-0088 (P-ROLE.1): the four onboarding roles. A role is a COSMETIC presentation preset — it
// shapes which surfaces are foregrounded by default. It never reads into or weakens the security
// gate (invariant #3). Unset folds to "developer", the safe, full-surface default.
export type UserRole = "developer" | "security" | "manager" | "executive";
export const USER_ROLES: UserRole[] = ["developer", "security", "manager", "executive"];

export interface GuiSettings {
  username?: string;
  // Corporate email — the attribution identity for code-activity / per-model LOC (ADR-0030).
  // Prompted on first open if unset. Stored locally only (like username); never sent off-host.
  email?: string;
  // How code activity is attributed. "email" = use `email`; "workstation" = the user skipped the
  // email prompt, so fall back to the machine hostname (still traceable, still rolls up to the
  // dashboard / MCP push). `undefined` = not decided yet → show the first-open prompt.
  attributionMode?: "email" | "workstation";
  keys?: Record<string, string>;
  workspace?: string;
  recentWorkspaces?: string[];
  // P-REPORT.9 (ADR-0162): repos the user wants INCLUDED IN REPORTS but not necessarily opened as the
  // active workspace. Tracked separately from `workspace`/`recentWorkspaces` so adding a report target
  // never restarts the omp session. The Reports repo picker offers the union of all three.
  reportRepos?: string[];
  // AskSage gov gateway (ADR-0007): non-secret base URL + lockdown flag. The key
  // itself lives in `keys.ASKSAGE_API_KEY` like any other provider key.
  asksageBaseUrl?: string;
  asksageOnly?: boolean;
  // ADR-0219: per chat-session CUI vs Search mode. Under lockdown, a "cui" session blocks ALL public egress
  // (spillage protection); a "search" session allows web search (the user affirmed no CUI datasets). Absent/
  // unknown ⇒ "cui" (fail-closed). Keyed by omp session id; pruned to a bounded size.
  sessionModes?: Record<string, "cui" | "search">;
  // ADR-0221: bring-your-own-embeddings config for SEMANTIC knowledge search (non-AskSage RAG increment 2).
  // Non-secret (baseUrl/model/dim/auth); the token lives in the OS vault behind `vaultRef` and is injected into
  // the dev child env by main as LUCID_EMBEDDINGS_KEY (the Figma/git-PAT vault→env pattern). Off ⇒ lexical only.
  embeddings?: { enabled: boolean; baseUrl: string; model: string; dim: number; authKind: "none" | "bearer" | "apikey"; headerName?: string; vaultRef?: string };
  // Monthly inference-token allowance. AskSage's API reports tokens USED but not
  // the ceiling (admins grant more in the AskSage console - no API to read it), so
  // the limit is a local, user-adjustable value. Everyone starts at 200k.
  asksageLimit?: number;
  // Datasets selected for RAG grounding via AskSage's /query route (ADR-0007).
  asksageDatasets?: string[];
  // Underlying model the "AskSage RAG" (/query) route uses. Default gpt-5.6-luna (newest mid-tier GPT).
  asksageQueryModel?: string;
  // Native AskSage persona id applied server-side on the /query (RAG) route. Unlike
  // the composer persona (scanned + delimited into the prompt), this is just an id
  // passed to AskSage - no untrusted text enters our prompt, so no scan is needed.
  asksagePersona?: string;
  // headroom token-compression proxy (opt-in, on-device). See ADR-0008.
  headroomEnabled?: boolean;
  // P10.3: opt-in live rate-limit probe for API-KEY providers (Anthropic/OpenAI). OFF by default —
  // it makes a tiny request per provider to read the rate-limit headers, which costs a token or two.
  rateLimitProbe?: boolean;
  // ADR-0009 Phase D: developer-mode logging view (telemetry + lineage + audit trails, read-only).
  // OFF by default; flips on the "Logs" rail tab. Gated server-side too.
  developerMode?: boolean;
  // P-KG-SYM.1: expose the workspace code graph to the agent as a read-only `codegraph_query` tool.
  codeGraphAgent?: boolean;
  // P-MCP.1 (ADR-0020): configured MCP servers, fed into omp's session/new mcpServers. Tokens live
  // in THIS git-ignored file (mode 0600) like provider keys; safeStorage custody is a later phase.
  mcpServers?: McpServerEntry[];
  // Personalization knowledge graph (ADR-0010, P9.x): opt-in, encrypted-at-rest.
  // OFF by default - no user-fact distillation, recall, or store until enabled.
  personalizationEnabled?: boolean;
  // OFF by default - opt-in richer learning: use the MODEL extractor (one extra model call per
  // turn) instead of the offline heuristic, for semantic facts + relations. Cost vs quality.
  personalAiExtract?: boolean;
  // Active compartment (ADR-0012): work | personal | cui | combined (view). Default personal.
  personalScope?: "work" | "personal" | "cui" | "combined";
  // P-LOC.1 (ADR-0031): the last model omp reported active, persisted so the AI-LOC gate can tag
  // edits with the authoring model from the very first edit of a fresh session (env at spawn).
  lastModel?: string;
  // P-IDE.1c (ADR-0029): the user acknowledged the data-sovereignty warning for China-origin models
  // (DeepSeek/Kimi/MiniMax/GLM/…). Until set, those models are hidden from the picker. Off by default.
  chinaModelsAcknowledged?: boolean;
  // The user acknowledged the third-party / non-U.S. / custom "More providers" warning. Until set, that
  // section's provider list stays hidden behind a typed ACKNOWLEDGE gate. Off by default.
  thirdPartyProvidersAcknowledged?: boolean;
  // P-GOAL.6 (ADR-0048): the model the /goal loop's CHECKER runs on, overriding the maker's model.
  // "" / unset = auto (the harness recommends a cheap, capable, recent model from the user's picker).
  checkerModel?: string;
  // ADR-0088 (P-ROLE.1): the user's chosen role. Cosmetic preset; unset = "developer". Captured at
  // first-run onboarding (before the email step) and switchable in Settings → Profile.
  userRole?: UserRole;
  // ADR-0089 (P-ROLE.1b): the first-run guided walkthrough has been shown (finished OR skipped).
  // Replay-guard so the tour never re-appears uninvited; the About "Take the tour" button ignores it.
  tourSeen?: boolean;
  // P-VOICE.1 (ADR-0115): voice (TTS/STT) config.
  // sttProvider: mic engine — "elevenlabs" (cloud Scribe) or "whisper" (offline, air-gap/DoD). Default whisper.
  sttProvider?: "elevenlabs" | "whisper";
  // sttUrl: the offline OpenAI-compatible Whisper server (whisper.cpp / faster-whisper). Default :9000.
  sttUrl?: string;
  // ttsProvider: default engine for the brief podcast + read-aloud — "elevenlabs" | "openai-tts" | "local-tts".
  ttsProvider?: "elevenlabs" | "openai-tts" | "local-tts";
  // ttsVoice: selected ElevenLabs voice id; ttsVoiceFavorites: starred voice ids (favorites shown first).
  ttsVoice?: string;
  ttsVoiceFavorites?: string[];
  // P-LOCAL.1 (ADR-0135): self-hosted / custom OpenAI-compatible LLM endpoints (Ollama, llama.cpp,
  // vLLM, a DGX box over a VPN tunnel, …). DECLARATIONS only — each carries an opaque `vaultRef`; the
  // API key/token lives ONLY in the OS-encrypted vault (cred_vault.ts), never in this file.
  localProviders?: LocalProviderDef[];
  // P-COLLAB.3 (ADR-0192): live-session collaboration relay. Self-hosted is the DEFAULT posture — a bare
  // public relay is used only when the user opts in. The relay only ever sees ciphertext (E2E), but it is
  // still network egress, so the URL is explicit and, absent both a self-hosted URL and the opt-in,
  // sharing fails closed (no relay authorized → cannot start a share).
  collabRelayUrl?: string;          // wss:// self-hosted relay origin (no /r/… path); empty = none configured
  collabPublicRelayOptIn?: boolean; // allow the public DEFAULT_RELAY_URL fallback when no self-hosted URL is set
  // P-COLLAB.17 (ADR-0202): prefer a DIRECT WebRTC peer-to-peer connection - the relay is used only for the
  // signaling handshake + as an automatic fallback, so session frames never transit the broker when a
  // DataChannel forms. STUN/TURN servers help traverse NAT (empty = LAN/VPN host candidates suffice).
  collabPreferDirectP2P?: boolean;
  collabIceUrls?: string[];         // stun:/turn: server URLs for NAT traversal
  collabTurnUsername?: string;      // TURN long-term credential (user-local file; not a high-value secret)
  collabTurnCredential?: string;
}

export const ASKSAGE_DEFAULT_LIMIT = 200_000;

/** Base directory for all personalization artifacts. Defaults to `~/.omp`; `LUCID_PERSONAL_DIR`
 *  relocates the whole set (store, CUI store, audit, exports) as one unit — for tests and isolated
 *  demos that must NOT touch the real encrypted store. Override-only; it changes WHERE the encrypted
 *  file lives, never WHETHER content is gated (the security gate is independent of this path). */
export function personalBaseDir(): string {
  return process.env.LUCID_PERSONAL_DIR || join(homedir(), ".omp");
}
/** Default on-disk location of the encrypted personalization store (P9.1) — work + personal. */
export function personalStorePath(): string {
  return join(personalBaseDir(), "lucid-personal.kg.enc");
}
/** The SEPARATE encrypted CUI store (P9.5a, ADR-0014) — its own file, DEK, and passphrase, so
 *  one key never decrypts both CUI and non-CUI. */
export function personalCuiStorePath(): string {
  return join(personalBaseDir(), "lucid-cui.kg.enc");
}
/** Metadata-only audit log for personalization exports (P9.4). NDJSON; counts + hashes
 *  only, never fact content (the full, private trail lives encrypted inside the store). */
export function personalAuditPath(): string {
  return join(personalBaseDir(), "lucid-personal-audit.ndjson");
}
/** Default export destinations (P9.4). The CUI archive is deliberately separate. */
export function personalVaultDir(): string { return join(personalBaseDir(), "lucid-vault"); }
export function personalCuiArchiveDir(): string { return join(personalBaseDir(), "lucid-cui-archive"); }
export function setPersonalization(enabled: boolean): GuiSettings {
  const s = load(); s.personalizationEnabled = enabled; save(s); return s;
}
export function setPersonalAiExtract(enabled: boolean): GuiSettings {
  const s = load(); s.personalAiExtract = enabled; save(s); return s;
}
export function setRateLimitProbe(enabled: boolean): GuiSettings {
  const s = load(); s.rateLimitProbe = enabled; save(s); return s;
}
export function setDeveloperMode(enabled: boolean): GuiSettings {
  const s = load(); s.developerMode = enabled; save(s); return s;
}
export function setCodeGraphAgent(enabled: boolean): GuiSettings {
  const s = load(); s.codeGraphAgent = enabled; save(s); return s;
}

// P-COLLAB.3 (ADR-0192): the authorized live-collab relay, or null when none is (fail-closed). Self-hosted
// wins; the public relay is used only on explicit opt-in. `wsBase` is the origin (no path); `httpBase` is
// its http(s) form for the browser deep link.
export interface CollabRelayConfig { wsBase: string; httpBase: string; label: string; source: "self-hosted" | "public" }
export function collabRelayConfig(): CollabRelayConfig | null {
  const s = load();
  const self = (s.collabRelayUrl ?? "").trim().replace(/\/+$/, "");
  if (self) return { wsBase: self, httpBase: wsToHttp(self), label: originLabel(self), source: "self-hosted" };
  if (s.collabPublicRelayOptIn) {
    const pub = DEFAULT_RELAY_URL.replace(/\/+$/, "");
    return { wsBase: pub, httpBase: wsToHttp(pub), label: `${originLabel(pub)} (public)`, source: "public" };
  }
  return null; // no relay authorized → sharing cannot start
}
export function setCollabRelay(patch: { url?: string; publicOptIn?: boolean }): GuiSettings {
  const s = load();
  if (patch.url !== undefined) s.collabRelayUrl = patch.url.trim();
  if (patch.publicOptIn !== undefined) s.collabPublicRelayOptIn = !!patch.publicOptIn;
  save(s); return s;
}

// P-COLLAB.17 (ADR-0202): the direct-P2P preference + STUN/TURN config. `iceUrls` are stun:/turn: URLs; the
// creds apply to TURN only. Kept in the same user-local file as the relay URL (never committed).
export interface CollabP2PConfig { preferDirect: boolean; iceUrls: string[]; turnUsername?: string; turnCredential?: string }
export function collabP2PConfig(): CollabP2PConfig {
  const s = load();
  return {
    preferDirect: !!s.collabPreferDirectP2P,
    iceUrls: Array.isArray(s.collabIceUrls) ? s.collabIceUrls.filter((u) => typeof u === "string" && u.trim()).map((u) => u.trim()) : [],
    turnUsername: (s.collabTurnUsername ?? "").trim() || undefined,
    turnCredential: (s.collabTurnCredential ?? "").trim() || undefined,
  };
}
export function setCollabP2P(patch: { preferDirect?: boolean; iceUrls?: string[]; turnUsername?: string; turnCredential?: string }): GuiSettings {
  const s = load();
  if (patch.preferDirect !== undefined) s.collabPreferDirectP2P = !!patch.preferDirect;
  if (patch.iceUrls !== undefined) s.collabIceUrls = patch.iceUrls.filter((u) => typeof u === "string" && u.trim()).map((u) => u.trim());
  if (patch.turnUsername !== undefined) s.collabTurnUsername = patch.turnUsername.trim();
  if (patch.turnCredential !== undefined) s.collabTurnCredential = patch.turnCredential.trim();
  save(s); return s;
}
function wsToHttp(u: string): string { return u.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:"); }
function originLabel(u: string): string { try { return new URL(u).host; } catch { return u; } }

// P-VOICE.1 (ADR-0115): voice (TTS/STT) config. Effective values with defaults, for the server + UI.
export interface VoiceSettings {
  sttProvider: "elevenlabs" | "whisper";
  sttUrl: string;
  ttsProvider: "elevenlabs" | "openai-tts" | "local-tts";
  ttsVoice: string;
  ttsVoiceFavorites: string[];
}
export function voiceSettings(): VoiceSettings {
  const s = load();
  return {
    sttProvider: s.sttProvider === "elevenlabs" ? "elevenlabs" : "whisper", // offline is the safe default
    sttUrl: s.sttUrl || process.env.LUCID_STT_URL || "http://localhost:9000",
    ttsProvider: s.ttsProvider ?? "elevenlabs",
    ttsVoice: s.ttsVoice ?? "",
    ttsVoiceFavorites: Array.isArray(s.ttsVoiceFavorites) ? s.ttsVoiceFavorites : [],
  };
}
/** Merge a partial voice-settings patch. Favorites are replaced wholesale (the UI sends the full list). */
export function setVoiceSettings(patch: Partial<VoiceSettings>): VoiceSettings {
  const s = load();
  if (patch.sttProvider) s.sttProvider = patch.sttProvider === "elevenlabs" ? "elevenlabs" : "whisper";
  if (patch.sttUrl !== undefined) s.sttUrl = patch.sttUrl.trim() || undefined;
  if (patch.ttsProvider) s.ttsProvider = patch.ttsProvider;
  if (patch.ttsVoice !== undefined) s.ttsVoice = patch.ttsVoice.trim() || undefined;
  if (patch.ttsVoiceFavorites) s.ttsVoiceFavorites = patch.ttsVoiceFavorites.slice(0, 100);
  save(s); return voiceSettings();
}

// ── ADR-0088 / ADR-0089 (P-ROLE.1 / .1b): onboarding role + first-run tour state ──────────────
/** Fold any stored/incoming value to a valid role — unknown/empty → the safe "developer" default.
 *  Pure (no file IO) so it is unit-testable without touching the on-disk settings. */
export function normalizeRole(r: string | undefined | null): UserRole {
  return r && (USER_ROLES as string[]).includes(r) ? (r as UserRole) : "developer";
}
/** The user's effective role. Unset or unknown folds to the safe, full-surface "developer" default. */
export function userRole(): UserRole { return normalizeRole(load().userRole); }
/** Whether the user has explicitly chosen a role yet (drives the first-run role step). */
export function roleChosen(): boolean {
  const r = load().userRole;
  return !!r && (USER_ROLES as string[]).includes(r);
}
export function setUserRole(role: UserRole): GuiSettings {
  const s = load(); s.userRole = normalizeRole(role); save(s); return s;
}
/** Whether the first-run walkthrough has already been shown (finished or skipped). */
export function tourSeen(): boolean { return !!load().tourSeen; }
export function setTourSeen(seen: boolean): GuiSettings {
  const s = load(); s.tourSeen = !!seen; save(s); return s;
}

// ── P-MCP.1 (ADR-0020): MCP server registry ───────────────────────────────────────
export function listMcpServers(): McpServerEntry[] { return load().mcpServers ?? []; }
/** Add or update (by id) an MCP server. Returns the stored entry. */
export function upsertMcpServer(e: { id?: string; name: string; transport?: "http" | "sse"; url: string; token?: string; enabled?: boolean }): McpServerEntry {
  const s = load(); s.mcpServers = s.mcpServers ?? [];
  const id = e.id || `mcp-${randomUUID().slice(0, 8)}`;
  const entry: McpServerEntry = { id, name: e.name.trim() || "MCP server", transport: e.transport ?? "http", url: e.url.trim(), token: e.token?.trim() || undefined, enabled: e.enabled ?? true };
  const i = s.mcpServers.findIndex((x) => x.id === id);
  if (i >= 0) s.mcpServers[i] = entry; else s.mcpServers.push(entry);
  save(s); return entry;
}
export function removeMcpServer(id: string): void { const s = load(); s.mcpServers = (s.mcpServers ?? []).filter((x) => x.id !== id); save(s); }
export function setMcpServerEnabled(id: string, enabled: boolean): void { const s = load(); const e = (s.mcpServers ?? []).find((x) => x.id === id); if (e) { e.enabled = enabled; save(s); } }
/** The ACP `session/new.mcpServers` array for ENABLED servers (ADR-0020 Decision 6: omp owns the
 *  MCP transport; we only assemble the authenticated config). Bearer token → Authorization header. */
export function mcpServersForAcp(): Record<string, unknown>[] {
  const http = (load().mcpServers ?? [])
    .filter((e) => e.enabled && e.url)
    .map((e) => ({ type: e.transport, name: e.name, url: e.url, headers: e.token ? [{ name: "Authorization", value: `Bearer ${e.token}` }] : [] }));
  // P-AGENTFW.1 (ADR-0147): enabled remote ACP agents (hermes/openclaw) attach as stdio "agent-firewall"
  // MCP servers — omp spawns `lucid agent-firewall --conn <id>`, which scans both directions fail-closed.
  return [...http, ...remoteAgentMcpServers()];
}
export function setPersonalScope(scope: GuiSettings["personalScope"]): GuiSettings {
  const s = load(); s.personalScope = scope; save(s); return s;
}

// ── P-LOCAL.1 (ADR-0135): Local Providers registry ────────────────────────────────────────────
// Persist ONLY the declaration. `vaultRef` is an opaque handle into the OS-encrypted vault; the
// secret itself never reaches this file (fail-closed: a def failing validateLocalProvider throws,
// and any stray secret-ish field is stripped before write).
export function listLocalProviders(): LocalProviderDef[] { return load().localProviders ?? []; }
/** Add or update (by id) a Local Provider. Validates first (invalid → throws, never persisted) and
 *  writes a CLEAN copy carrying only known fields (no inline secret can ride along). */
export function upsertLocalProvider(def: LocalProviderDef): LocalProviderDef {
  const clean: LocalProviderDef = {
    id: def.id, name: def.name?.trim() ?? "", ompProvider: def.ompProvider, baseUrl: def.baseUrl?.trim() ?? "",
    api: def.api, authKind: def.authKind, vaultRef: def.vaultRef || undefined, headerName: def.headerName?.trim() || undefined,
    zone: def.zone, enabled: def.enabled !== false,
    models: (def.models ?? []).map((m) => ({
      id: m.id, name: m.name?.trim() || undefined, contextWindow: m.contextWindow, maxTokens: m.maxTokens,
      reasoning: m.reasoning || undefined, vision: m.vision || undefined, supportsTools: m.supportsTools,
    })),
    createdAt: def.createdAt, updatedAt: def.updatedAt,
  };
  const errs = validateLocalProvider(clean);
  if (errs.length) throw new Error("invalid local provider: " + errs.join("; "));
  const s = load(); s.localProviders = s.localProviders ?? [];
  const i = s.localProviders.findIndex((x) => x.id === clean.id);
  if (i >= 0) s.localProviders[i] = clean; else s.localProviders.push(clean);
  save(s); return clean;
}
export function removeLocalProvider(id: string): void {
  const s = load(); s.localProviders = (s.localProviders ?? []).filter((x) => x.id !== id); save(s);
}
export function setLocalProviderEnabled(id: string, enabled: boolean): void {
  const s = load(); const e = (s.localProviders ?? []).find((x) => x.id === id); if (e) { e.enabled = enabled; save(s); }
}

// P-PERF.5 (ADR-0132): load() used to read + JSON.parse the file on EVERY call - and nearly every
// request handler calls it (often several times). Memoize the parse on the file's mtime; callers get a
// structuredClone so today's read-modify-save pattern keeps its exact semantics (every load() is an
// independent object - a caller mutating without save() can never corrupt the memo). A missing or
// corrupt file is just {}.
// Memo key = mtime AND size: two writes can land in the same mtime tick, but a content change almost
// always changes the byte length too. (Residual blind spot - same-ms, same-size external rewrite -
// is accepted: this process is the file's only writer in practice.)
// stat and read/write go through ONE file descriptor (fstat on the open fd), so the metadata the memo
// is keyed on always describes the exact bytes read/written - no check-then-use race (js/file-system-race).
let loadMemo: { file: string; mtimeMs: number; size: number; s: GuiSettings } | null = null;
export function load(): GuiSettings {
  const file = settingsFile();
  try {
    const fd = openSync(file, "r"); // throws when missing -> {}
    try {
      const st = fstatSync(fd);
      if (!loadMemo || loadMemo.file !== file || loadMemo.mtimeMs !== st.mtimeMs || loadMemo.size !== st.size) {
        loadMemo = { file, mtimeMs: st.mtimeMs, size: st.size, s: JSON.parse(readFileSync(fd, "utf8")) as GuiSettings };
      }
    } finally { closeSync(fd); }
    return structuredClone(loadMemo.s);
  } catch { return {}; }
}
export function save(s: GuiSettings): void {
  const file = settingsFile();
  const fd = openSync(file, "w");
  try {
    writeFileSync(fd, JSON.stringify(s, null, 2), "utf8");
    try { fchmodSync(fd, 0o600); } catch { /* best-effort on Windows */ }
    try {
      const st = fstatSync(fd);
      loadMemo = { file, mtimeMs: st.mtimeMs, size: st.size, s: structuredClone(s) };
    } catch { loadMemo = null; }
  } finally { closeSync(fd); }
}

/** Push stored keys + AskSage base URL into process.env so child `omp acp`
 *  (and the AskSage extension) inherit them. */
export function applyEnv(): void {
  const s = load();
  for (const [k, v] of Object.entries(s.keys ?? {})) if (v) process.env[k] = v;
  if (s.asksageBaseUrl) process.env.ASKSAGE_BASE_URL = s.asksageBaseUrl;
  if (s.asksageDatasets?.length) process.env.ASKSAGE_DATASETS = s.asksageDatasets.join(",");
  if (s.asksageQueryModel) process.env.ASKSAGE_QUERY_MODEL = s.asksageQueryModel;
  if (s.asksagePersona) process.env.ASKSAGE_PERSONA = s.asksagePersona;
}
export function setAsksage(opts: { baseUrl?: string; only?: boolean; limit?: number; datasets?: string[]; queryModel?: string; persona?: string }): GuiSettings {
  const s = load();
  if (opts.baseUrl !== undefined) {
    s.asksageBaseUrl = opts.baseUrl || undefined;
    if (opts.baseUrl) process.env.ASKSAGE_BASE_URL = opts.baseUrl;
    else delete process.env.ASKSAGE_BASE_URL;
  }
  if (opts.only !== undefined) s.asksageOnly = opts.only;
  if (opts.limit !== undefined) s.asksageLimit = Math.max(0, Math.round(opts.limit)) || undefined;
  if (opts.datasets !== undefined) {
    s.asksageDatasets = opts.datasets.length ? opts.datasets : undefined;
    if (opts.datasets.length) process.env.ASKSAGE_DATASETS = opts.datasets.join(",");
    else delete process.env.ASKSAGE_DATASETS;
  }
  if (opts.queryModel !== undefined) {
    s.asksageQueryModel = opts.queryModel || undefined;
    if (opts.queryModel) process.env.ASKSAGE_QUERY_MODEL = opts.queryModel;
    else delete process.env.ASKSAGE_QUERY_MODEL;
  }
  if (opts.persona !== undefined) {
    s.asksagePersona = opts.persona || undefined;
    if (opts.persona) process.env.ASKSAGE_PERSONA = opts.persona;
    else delete process.env.ASKSAGE_PERSONA;
  }
  save(s); return s;
}
export function setUsername(name: string): GuiSettings {
  const s = load(); s.username = name; save(s); return s;
}
/** Set profile fields (username and/or corporate email). Only provided fields change. A non-empty
 *  email also locks attribution to "email". */
export function setProfile(p: { username?: string; email?: string }): GuiSettings {
  const s = load();
  if (p.username !== undefined) s.username = p.username;
  if (p.email !== undefined) {
    s.email = p.email.trim();
    if (s.email) s.attributionMode = "email";
  }
  save(s); return s;
}
/** P-IDE.1c (ADR-0029): the data-sovereignty acknowledgement gate for China-origin models. */
export function chinaModelsAcknowledged(): boolean { return !!load().chinaModelsAcknowledged; }
export function setChinaModelsAcknowledged(on: boolean): GuiSettings {
  const s = load(); s.chinaModelsAcknowledged = on; save(s); return s;
}
/** Acknowledgement gate for the third-party / non-U.S. / custom "More providers" section. */
export function thirdPartyProvidersAcknowledged(): boolean { return !!load().thirdPartyProvidersAcknowledged; }
export function setThirdPartyProvidersAcknowledged(on: boolean): GuiSettings {
  const s = load(); s.thirdPartyProvidersAcknowledged = on; save(s); return s;
}
/** P-LOC.1 (ADR-0031): the last omp-reported active model, used to tag AI-LOC ledger rows from the
 *  first edit of a session. Empty until omp reports one (then the gate records model 'unknown'). */
export function lastModel(): string { return lastModelPending ?? load().lastModel ?? ""; }
// P-PERF.5 (ADR-0132): omp reports its active model repeatedly and picker flips can burst, so the
// lastModel write is DEBOUNCED write-behind (250ms, generation-token - no stored timer handle).
// ONLY this low-stakes, high-frequency setter is deferred; keys/MCP/scopes stay synchronous.
// lastModel() reads its own pending write; a pending value is flushed on process exit.
let lastModelPending: string | null = null;
let lastModelGen = 0;
export function flushPendingSettings(): void {
  if (lastModelPending === null) return;
  const m = lastModelPending;
  lastModelPending = null; lastModelGen++;
  const s = load(); if (s.lastModel !== m) { s.lastModel = m; save(s); }
}
process.on("exit", flushPendingSettings);
export function setLastModel(model: string): void {
  const m = (model ?? "").trim(); if (!m) return;
  lastModelPending = m;
  const gen = ++lastModelGen;
  setTimeout(() => { if (gen === lastModelGen) flushPendingSettings(); }, 250);
}
/** Whether the user has set the "AskSage only" model lock (the org-managed lock is OR'd in by callers). */
export function asksageOnly(): boolean { return !!load().asksageOnly; }
/** ADR-0221: the stored embeddings config (non-secret), or null when semantic search was never set up. */
export type StoredEmbeddingsConfig = NonNullable<GuiSettings["embeddings"]>;
export function embeddingsConfig(): StoredEmbeddingsConfig | null { return load().embeddings ?? null; }
/** Persist (or clear, with null) the embeddings config. The secret is NOT here - it's vaulted behind vaultRef. */
export function setEmbeddingsConfig(cfg: StoredEmbeddingsConfig | null): GuiSettings {
  const s = load();
  if (cfg) s.embeddings = cfg; else delete s.embeddings;
  save(s);
  return s;
}
/** ADR-0219: the CUI vs Search mode for a chat session. Fail-closed default "cui" (blocks egress under
 *  lockdown) for an unknown/absent session id. */
export function sessionMode(id: string): "cui" | "search" {
  const m = load().sessionModes?.[id];
  return m === "search" ? "search" : "cui";
}
/** ADR-0219: persist a session's CUI/Search mode. Prunes to the most recent ~200 entries so the map can't
 *  grow unbounded across many sessions (order-preserving: newest write kept). */
export function setSessionMode(id: string, mode: "cui" | "search"): GuiSettings {
  const s = load();
  const map = { ...(s.sessionModes ?? {}) };
  delete map[id]; // re-insert at the end so it survives pruning
  map[id] = mode === "search" ? "search" : "cui";
  const keys = Object.keys(map);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete map[k];
  s.sessionModes = map;
  save(s);
  return s;
}
/** P-GOAL.6: the user's chosen checker model ("" = auto/recommended). */
export function checkerModel(): string { return load().checkerModel ?? ""; }
/** Persist the checker-model choice. Empty string clears it (back to auto). */
export function setCheckerModel(model: string): void {
  const m = (model ?? "").trim();
  const s = load(); if ((s.checkerModel ?? "") === m) return; s.checkerModel = m || undefined; save(s);
}
/** User skipped the email prompt: attribute by workstation hostname instead (recorded, not forced).
 *  No-op when managed policy disallows skipping (the caller should check `skipAllowed()` first). */
export function setAttributionSkip(): GuiSettings {
  const s = load(); if (skipAllowed()) s.attributionMode = "workstation"; save(s); return s;
}

export interface Attribution {
  identity: string; source: "email" | "workstation"; email: string; workstation: string; decided: boolean;
  // Managed-policy view (drives the UI: hide Skip, require/validate email, show "Managed by …").
  managed: boolean; orgName: string; requireEmail: boolean; allowSkip: boolean; allowedDomains: string[];
}
/** The effective attribution identity, folding in enterprise-managed policy. `decided` is false until
 *  the user satisfies policy (provides a compliant email, or skips when allowed) → drives the prompt.
 *  Workstation fallback keeps every metric traceable + roll-up-able when skipping is permitted. */
export function attribution(): Attribution {
  const s = load();
  const workstation = hostname();
  const email = s.email ?? "";
  const mc = managedConfig().config;
  const orgName = typeof mc?.orgName === "string" ? mc.orgName : "";
  const requireEmail = !!mc?.attribution?.requireEmail;
  const allowSkip = skipAllowed();
  const allowedDomains = mc?.attribution?.allowedEmailDomains ?? [];
  const base = { email, workstation, managed: !!mc, orgName, requireEmail, allowSkip, allowedDomains };
  const emailOk = !!email && emailDomainAllowed(email);
  // A prior skip only counts if skipping is (still) allowed by policy.
  if (s.attributionMode === "workstation" && allowSkip) return { ...base, identity: workstation, source: "workstation", decided: true };
  if (emailOk) return { ...base, identity: email, source: "email", decided: true };
  // Undecided (no compliant email, and skip not taken/allowed) → prompt; fall back to a traceable id.
  return { ...base, identity: email || workstation, source: email ? "email" : "workstation", decided: false };
}
export function setKey(env: string, key: string): GuiSettings {
  const s = load(); s.keys = s.keys ?? {};
  if (key) { s.keys[env] = key; process.env[env] = key; }
  else { delete s.keys[env]; delete process.env[env]; }
  save(s); return s;
}
