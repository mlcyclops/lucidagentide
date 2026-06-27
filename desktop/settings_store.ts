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

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { emailDomainAllowed, managedConfig, skipAllowed } from "./managed_config.ts";

const FILE = join(homedir(), ".omp", "lucid-gui.json");

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
  // AskSage gov gateway (ADR-0007): non-secret base URL + lockdown flag. The key
  // itself lives in `keys.ASKSAGE_API_KEY` like any other provider key.
  asksageBaseUrl?: string;
  asksageOnly?: boolean;
  // Monthly inference-token allowance. AskSage's API reports tokens USED but not
  // the ceiling (admins grant more in the AskSage console - no API to read it), so
  // the limit is a local, user-adjustable value. Everyone starts at 200k.
  asksageLimit?: number;
  // Datasets selected for RAG grounding via AskSage's /query route (ADR-0007).
  asksageDatasets?: string[];
  // Underlying model the "AskSage RAG" (/query) route uses. Default gpt-5.2.
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
  // P-GOAL.6 (ADR-0048): the model the /goal loop's CHECKER runs on, overriding the maker's model.
  // "" / unset = auto (the harness recommends a cheap, capable, recent model from the user's picker).
  checkerModel?: string;
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
  return (load().mcpServers ?? [])
    .filter((e) => e.enabled && e.url)
    .map((e) => ({ type: e.transport, name: e.name, url: e.url, headers: e.token ? [{ name: "Authorization", value: `Bearer ${e.token}` }] : [] }));
}
export function setPersonalScope(scope: GuiSettings["personalScope"]): GuiSettings {
  const s = load(); s.personalScope = scope; save(s); return s;
}

export function load(): GuiSettings {
  try { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {}; } catch { return {}; }
}
export function save(s: GuiSettings): void {
  writeFileSync(FILE, JSON.stringify(s, null, 2), "utf8");
  try { chmodSync(FILE, 0o600); } catch { /* best-effort on Windows */ }
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
/** P-LOC.1 (ADR-0031): the last omp-reported active model, used to tag AI-LOC ledger rows from the
 *  first edit of a session. Empty until omp reports one (then the gate records model 'unknown'). */
export function lastModel(): string { return load().lastModel ?? ""; }
export function setLastModel(model: string): void {
  const m = (model ?? "").trim(); if (!m) return;
  const s = load(); if (s.lastModel === m) return; s.lastModel = m; save(s);
}
/** Whether the user has set the "AskSage only" model lock (the org-managed lock is OR'd in by callers). */
export function asksageOnly(): boolean { return !!load().asksageOnly; }
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
