// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/local_providers.ts — P-LOCAL.1 (ADR-0135): the pure core for "Local Providers".
//
// A Local Provider points LUCID at a self-hosted / custom OpenAI-compatible LLM endpoint (Ollama,
// llama.cpp, vLLM, LM Studio, a DGX box reachable over a SonicWall VPN tunnel, …). This module is
// PURE (no Electron, no IO) so every rule is unit-testable. It owns three things:
//
//   1. The data model (LocalProviderDef / LocalModelDef) — a DECLARATION, never a secret. The API
//      key/token lives ONLY in the OS-encrypted vault (desktop/cred_vault.ts); the def carries an
//      opaque `vaultRef`, never the value. `scanForInlineSecret` refuses a def where the user pasted
//      a key into a text field (mirrors the Agent Builder secret guardrail, ADR-0134).
//   2. Fail-closed validation — a malformed def, a non-http(s) base URL, or a provider id that would
//      SHADOW a built-in vendor (anthropic/openai/…) is rejected, so a local endpoint can never
//      hijack routing for a real provider.
//   3. The omp config-overlay emitter — `toOmpConfigOverlay` produces the exact
//      `{ providers: { <id>: { baseUrl, api, apiKey?, headers?, models:[…] } } }` shape omp loads via
//      `--config`. The secret is injected by the MAIN process at spawn time (P-LOCAL.2); a provider
//      that needs a secret it doesn't have is EXCLUDED (never emitted half-authenticated).
//
// The runtime wiring (materialize the overlay for `omp acp`, register egress in the whitelist) and the
// Settings UI are their own increments (P-LOCAL.2 / .3) built on this contract.

// The omp transport. v1 uses "openai-completions" — the universal OpenAI-compatible path that Ollama
// (via its /v1 endpoint), llama.cpp, vLLM and LM Studio all speak, and the only value omp's models.json
// `api` enum accepts for a self-hosted box. (Ollama's native /api/chat transport is a future add.)
export type LocalProviderApi = "openai-completions";
export const LOCAL_PROVIDER_APIS: LocalProviderApi[] = ["openai-completions"];

// How the endpoint authenticates. "none" = open local runtime (Ollama default); "bearer"/"apikey" =
// a token in the vault (bearer → Authorization: Bearer <t>; apikey → a custom header). "basic" is
// declared but its overlay emission is deferred (P-LOCAL.2b).
export type LocalAuthKind = "none" | "bearer" | "apikey" | "basic";
export const LOCAL_AUTH_KINDS: LocalAuthKind[] = ["none", "bearer", "apikey", "basic"];

// Built-in omp provider ids a Local Provider may NOT reuse — reusing one would override real-vendor
// routing (a local box answering as "anthropic"). Closed, conservative denylist; extend as omp grows.
export const RESERVED_PROVIDER_IDS: readonly string[] = [
  "anthropic", "openai", "openai-codex", "google", "gemini", "azure", "azure-openai", "xai", "grok",
  "perplexity", "groq", "cerebras", "mistral", "openrouter", "deepseek", "moonshot", "kimi", "zai",
  "minimax", "asksage", "elevenlabs", "typesafe", "ollama-cloud", "vertex",
];

/** The wire-shape knobs a self-hosted reasoning model needs, as a CLOSED subset of omp's `compat`
 *  block (`OpenAICompatSchema` in models-config-schema.ts, which also accepts `compat` on a full
 *  model definition, not just on `modelOverrides`). Deliberately narrow: omp drops the ENTIRE
 *  models.yml when any value fails its schema, so LUCID only emits fields whose legal values it can
 *  enumerate and re-check here. Everything else is left to omp's auto-detection.
 *
 *  Why this exists at all: omp infers these from the base URL (`buildOpenAICompat`), and a model
 *  served off a LAN box never matches its vendor's hostname. GLM behind vLLM on a 10.x address is
 *  the case in point - auto-detect sees an unknown host, assumes plain OpenAI-style thinking, and
 *  the reasoning stream is silently lost. */
export interface LocalModelCompat {
  /** How "think" is put on the wire. vLLM chat-template models (GLM, Qwen) need "qwen-chat-template". */
  thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
  /** Assistant field carrying chain-of-thought. vLLM's OpenAI server emits "reasoning". */
  reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";
  /** Whether the endpoint accepts a `reasoning_effort` request param. vLLM's OpenAI server does not. */
  supportsReasoningEffort?: boolean;
}

const THINKING_FORMATS: readonly string[] = ["openai", "openrouter", "zai", "qwen", "qwen-chat-template"];
const REASONING_CONTENT_FIELDS: readonly string[] = ["reasoning_content", "reasoning", "reasoning_text"];

/** Keep only the values omp's schema accepts and drop the rest. Returns undefined when nothing
 *  survives, so a typo can never emit an empty `compat: {}` nor a value that invalidates the file. */
export function sanitizeModelCompat(c: LocalModelCompat | undefined): LocalModelCompat | undefined {
  if (!c || typeof c !== "object") return undefined;
  const out: LocalModelCompat = {};
  if (typeof c.thinkingFormat === "string" && THINKING_FORMATS.includes(c.thinkingFormat)) out.thinkingFormat = c.thinkingFormat;
  if (typeof c.reasoningContentField === "string" && REASONING_CONTENT_FIELDS.includes(c.reasoningContentField)) out.reasoningContentField = c.reasoningContentField;
  if (typeof c.supportsReasoningEffort === "boolean") out.supportsReasoningEffort = c.supportsReasoningEffort;
  return Object.keys(out).length ? out : undefined;
}

export interface LocalModelDef {
  id: string; // the model id the endpoint expects (e.g. "llama-3.1-70b-instruct")
  name?: string; // display label; defaults to id
  contextWindow?: number; // tokens; default 8192
  maxTokens?: number; // max output tokens; default 4096
  reasoning?: boolean; // the model emits reasoning/thinking
  vision?: boolean; // accepts image input
  supportsTools?: boolean; // OpenAI-style tool calling; default true (agents need tools)
  compat?: LocalModelCompat; // wire-shape overrides for reasoning models omp cannot auto-detect by host
}

export interface LocalProviderDef {
  id: string; // stable LUCID id, minted once (lp_<slug>_<base36>)
  name: string; // human label ("DGX Spark · Vienna VA")
  ompProvider: string; // unique slug used as the omp provider key in the overlay
  baseUrl: string; // OpenAI-compatible base, e.g. https://10.20.30.40:8000/v1
  api: LocalProviderApi;
  authKind: LocalAuthKind;
  vaultRef?: string; // opaque reference into the OS-encrypted vault — NEVER the secret
  headerName?: string; // apikey header name (default "Authorization")
  zone: "internal" | "external"; // whitelist zone; VPN/LAN endpoints are "internal"
  models: LocalModelDef[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Lowercase → safe slug (non-alnum runs → "_"); empty folds to "provider". */
export function slugify(s: string): string {
  const out = (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return out || "provider";
}

/** Mint a stable provider id. `now` is passed in so this stays pure/testable. */
export function newLocalProviderId(name: string, now: number): string {
  return `lp_${slugify(name)}_${Math.floor(now).toString(36)}`;
}

/** The OpenAI-compatible list-models endpoint for a base URL (used by the reachability probe). Returns
 *  null for an unparseable base URL. `<baseUrl>/models` — reachable on Ollama/vLLM/llama.cpp/LM Studio. */
export function providerModelsUrl(baseUrl: string): string | null {
  if (!hostFromBaseUrl(baseUrl)) return null;
  return `${baseUrl.trim().replace(/\/+$/, "")}/models`;
}

// ── endpoint model discovery (P-LOCAL.6) ─────────────────────────────────────────────────────────
// `GET <baseUrl>/models` is an OpenAI-shaped list every local server answers (vLLM, Ollama,
// llama.cpp, LM Studio), and vLLM puts the REAL window in `max_model_len`. Asking the server beats
// the curated catalog's editorial guesses, so this is what fills the add form.
//
// The body is UNTRUSTED input on its way into a config file omp parses and a comma-separated form
// field, so parsing is defensive rather than trusting: the caps and the id filter below exist
// because a hostile or broken endpoint must not be able to corrupt either one.

/** Offering more than this many models in one form is a broken endpoint, not a useful list. */
const MAX_DISCOVERED_MODELS = 100;
/** Longest model id accepted. Real ids are short; a huge one only ever bloats models.yml. */
const MAX_MODEL_ID_LEN = 200;
/** Largest `/models` body the caller will read. A real list is a few KB; this only exists so a broken
 *  or hostile endpoint cannot make the engine buffer an unbounded response. */
export const MAX_DISCOVERY_BYTES = 1_000_000;

export interface DiscoveryResult {
  models: LocalModelDef[];
  /** Entries the server returned that were NOT offered (malformed, duplicate, or over a cap).
   *  Surfaced to the user rather than hidden, so a partial list never looks like a complete one. */
  dropped: number;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100_000_000 ? v : undefined;
}

/** Parse an OpenAI-compatible `/models` body into model declarations. Context window follows omp's
 *  own precedence (`max_model_len`, then `context_length`) so LUCID and omp never disagree about a
 *  discovered model; absent both, it is left unset and the caller's default applies. */
export function parseDiscoveredModels(body: unknown): DiscoveryResult {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { models: [], dropped: 0 };
  const models: LocalModelDef[] = [];
  const seen = new Set<string>(); // dynamic membership over a runtime list, not a static table
  let dropped = 0;
  for (const raw of data) {
    const e = raw as Record<string, unknown> | null;
    const id = typeof e?.id === "string" ? e.id.trim() : "";
    // `\p{C}` is every control/format/unassigned code point, which is deliberately wider than
    // "no newlines": it also catches the zero-width and bidi characters the scanner sidecar exists
    // to find. A comma would split one id into two in the add form's field.
    const unusable = !id || id.length > MAX_MODEL_ID_LEN || /[\p{C},]/u.test(id) || seen.has(id);
    if (unusable || models.length >= MAX_DISCOVERED_MODELS) { dropped++; continue; }
    seen.add(id);
    const m: LocalModelDef = { id };
    const ctx = positiveInt(e?.max_model_len) ?? positiveInt(e?.context_length);
    if (ctx) m.contextWindow = ctx;
    models.push(m);
  }
  return { models, dropped };
}

/** Parse the host out of a base URL. Returns null for a non-http(s) or unparseable URL. */
export function hostFromBaseUrl(url: string): { host: string; port: string; isIp: boolean } | null {
  let u: URL;
  try { u = new URL((url ?? "").trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  // IPv4 literal, or bracketed IPv6 (URL.hostname keeps brackets off; test for hex:colon form).
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  return { host, port: u.port, isIp };
}

// High-signal apparent-secret shapes — if any appears in a text field the user pasted a real key
// where a NAME/URL belongs. Mirrors harness/agent/secret_guard.ts (kept independent, no cross-import).
const INLINE_SECRET_RES: { label: string; re: RegExp }[] = [
  { label: "PEM private key", re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: "bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
];

/** Scan the DECLARATION fields (never the vaultRef) for an apparent pasted secret. Returns the first
 *  hit's label, or null when clean. The secret belongs in the vault, not in a name/URL/model field. */
export function scanForInlineSecret(def: Pick<LocalProviderDef, "name" | "baseUrl" | "headerName" | "models" | "ompProvider">): string | null {
  const fields = [def.name, def.baseUrl, def.headerName ?? "", def.ompProvider, ...(def.models ?? []).flatMap((m) => [m.id, m.name ?? ""])];
  for (const f of fields) for (const d of INLINE_SECRET_RES) if (d.re.test(f ?? "")) return d.label;
  return null;
}

/** Fail-closed structural validation. Returns [] when the def is well-formed, else human messages.
 *  (Whether it can actually RUN — enabled + has any needed secret — is `providerRunnable`.) */
export function validateLocalProvider(def: LocalProviderDef): string[] {
  const errs: string[] = [];
  if (!def || typeof def !== "object") return ["provider must be an object"];
  if (!def.name?.trim()) errs.push("name is required");
  if (!SLUG_RE.test(def.ompProvider ?? "")) errs.push("provider id must be a slug (lowercase letters, digits, - or _)");
  else if (RESERVED_PROVIDER_IDS.includes(def.ompProvider)) errs.push(`provider id "${def.ompProvider}" is reserved for a built-in provider`);
  if (!hostFromBaseUrl(def.baseUrl)) errs.push("base URL must be a valid http(s):// URL");
  if (!LOCAL_PROVIDER_APIS.includes(def.api)) errs.push("api must be one of: " + LOCAL_PROVIDER_APIS.join(", "));
  if (!LOCAL_AUTH_KINDS.includes(def.authKind)) errs.push("authKind must be one of: " + LOCAL_AUTH_KINDS.join(", "));
  if (def.zone !== "internal" && def.zone !== "external") errs.push('zone must be "internal" or "external"');
  const models = Array.isArray(def.models) ? def.models : [];
  if (models.length === 0) errs.push("at least one model is required");
  const seen = new Set<string>();
  for (const m of models) {
    if (!m.id?.trim()) { errs.push("every model needs an id"); continue; }
    if (seen.has(m.id)) errs.push(`duplicate model id "${m.id}"`);
    seen.add(m.id);
    for (const [k, v] of [["contextWindow", m.contextWindow], ["maxTokens", m.maxTokens]] as const)
      if (v !== undefined && (!Number.isInteger(v) || v <= 0)) errs.push(`model "${m.id}" ${k} must be a positive integer`);
  }
  const leak = scanForInlineSecret(def);
  if (leak) errs.push(`a ${leak} looks pasted into a text field — put the secret in the vault, not the provider fields`);
  return errs;
}

/** Whether a provider is usable right now: enabled, valid, and (open OR its secret is present). */
export function providerRunnable(def: LocalProviderDef, hasSecret: boolean): { ok: boolean; reason?: string } {
  if (!def.enabled) return { ok: false, reason: "disabled" };
  const errs = validateLocalProvider(def);
  if (errs.length) return { ok: false, reason: errs[0] };
  if (def.authKind !== "none" && !hasSecret) return { ok: false, reason: "needs a credential in the vault" };
  return { ok: true };
}

// ── omp config-overlay emission ─────────────────────────────────────────────────────────────────
// The exact shape omp loads via `--config` (pi-coding-agent models-config-schema): a `providers` map
// keyed by provider id. Model entries carry the required fields (reasoning/input/cost/contextWindow/
// maxTokens). Cost is 0 for a self-hosted box.

export interface OmpModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  supportsTools: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: LocalModelCompat; // omitted entirely unless a sanitized value survives
}
export interface OmpProviderEntry {
  baseUrl: string;
  api: LocalProviderApi;
  auth?: "none"; // REQUIRED by omp for an open endpoint — without it omp demands an apiKey and drops the whole file
  apiKey?: string;
  headers?: Record<string, string>;
  models: OmpModelEntry[];
}
export interface OmpConfigOverlay { providers: Record<string, OmpProviderEntry> }

function toModelEntry(m: LocalModelDef): OmpModelEntry {
  const entry: OmpModelEntry = {
    id: m.id,
    name: m.name?.trim() || m.id,
    reasoning: !!m.reasoning,
    input: m.vision ? ["text", "image"] : ["text"],
    supportsTools: m.supportsTools ?? true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 8192,
    maxTokens: m.maxTokens ?? 4096,
  };
  const compat = sanitizeModelCompat(m.compat);
  if (compat) entry.compat = compat;
  return entry;
}

/** Build the single-provider overlay entry. `secret` (from the vault, main-process only) is placed
 *  where omp expects: a custom apikey header → `headers`; bearer/default → `apiKey`. */
export function toOmpProviderEntry(def: LocalProviderDef, secret?: string): OmpProviderEntry {
  const entry: OmpProviderEntry = { baseUrl: def.baseUrl.trim(), api: def.api, models: def.models.map(toModelEntry) };
  if (def.authKind === "none") {
    entry.auth = "none"; // omp requires this for an unauthenticated endpoint (else it demands an apiKey)
  } else if (secret) {
    const header = def.headerName?.trim();
    if (def.authKind === "apikey" && header && header.toLowerCase() !== "authorization") entry.headers = { [header]: secret };
    else entry.apiKey = secret; // bearer, or apikey via Authorization
  }
  return entry;
}

export interface OverlayResult {
  overlay: OmpConfigOverlay;
  included: string[]; // ompProvider ids emitted
  skipped: { id: string; reason: string }[]; // provider id + why it was left out (fail-closed)
}

/** Emit the omp `--config` overlay for the ENABLED, runnable providers. `secretFor` resolves a
 *  vaultRef to its plaintext (main-process only); a provider whose secret is required but missing is
 *  SKIPPED, never emitted half-authenticated. Pure: the resolver is injected. */
export function toOmpConfigOverlay(defs: LocalProviderDef[], secretFor: (ref: string) => string | undefined): OverlayResult {
  const providers: Record<string, OmpProviderEntry> = {};
  const included: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const def of defs ?? []) {
    if (def.authKind === "basic") { skipped.push({ id: def.ompProvider || def.id, reason: "basic auth is not yet supported" }); continue; }
    const secret = def.authKind !== "none" && def.vaultRef ? secretFor(def.vaultRef) : undefined;
    const run = providerRunnable(def, !!secret);
    if (!run.ok) { skipped.push({ id: def.ompProvider || def.id, reason: run.reason ?? "not runnable" }); continue; }
    if (providers[def.ompProvider]) { skipped.push({ id: def.ompProvider, reason: "duplicate provider id" }); continue; }
    providers[def.ompProvider] = toOmpProviderEntry(def, secret);
    included.push(def.ompProvider);
  }
  return { overlay: { providers }, included, skipped };
}

// ── runtime overlay (secure env-ref delivery) ────────────────────────────────────────────────────
// omp's models.yml value resolver (`resolveConfigValue`) reads a value as an ENV VAR NAME first
// (`Bun.env[value]`), else a literal. So at `omp acp` launch LUCID writes the provider's secret as an
// env-var NAME into models.yml and injects the real value into the omp CHILD's env from the vault - the
// secret never lands in the file. This is the delivery used at runtime (vs. `toOmpConfigOverlay`, which
// inlines a secret for tests/preview).

/** The env var a provider's secret is injected under (referenced from models.yml, resolved by omp). */
export function providerEnvVar(def: Pick<LocalProviderDef, "ompProvider" | "id">): string {
  return `LUCID_LP_${(def.ompProvider || def.id).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_KEY`;
}

/** The headers a discovery probe sends for a SAVED provider. Deliberately mirrors
 *  `toOmpProviderEntry`'s placement, so the probe authenticates exactly the way omp will at run time
 *  and a 200 here really does predict a working model. `{}` without a secret: the caller then reports
 *  `authRequired` instead of guessing, and NEVER takes a key from a request body (ADR-0135). */
export function discoveryHeaders(def: Pick<LocalProviderDef, "authKind" | "headerName">, secret?: string): Record<string, string> {
  if (!secret || def.authKind === "none") return {};
  const header = def.headerName?.trim();
  if (def.authKind === "apikey" && header && header.toLowerCase() !== "authorization") return { [header]: secret };
  return { authorization: `Bearer ${secret}` };
}

export interface RuntimeOverlayResult {
  overlay: OmpConfigOverlay; // apiKey/header values are ENV VAR NAMES here, never secrets
  env: Record<string, string>; // envVarName -> vaultRef; the MAIN process resolves the ref to the secret
  included: string[];
  skipped: { id: string; reason: string }[];
}

/** Build the runtime overlay for `omp acp`. Authed providers reference their secret by ENV VAR NAME
 *  (resolved by omp from the child env at call time); the pure module NEVER sees a secret. A provider
 *  whose vault ref isn't in `availableRefs` is skipped (fail-closed - never emitted un-authed). */
export function toOmpRuntimeOverlay(defs: LocalProviderDef[], availableRefs: ReadonlySet<string>): RuntimeOverlayResult {
  const providers: Record<string, OmpProviderEntry> = {};
  const env: Record<string, string> = {};
  const included: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const def of defs ?? []) {
    const label = def.ompProvider || def.id;
    if (!def.enabled) { skipped.push({ id: label, reason: "disabled" }); continue; }
    const errs = validateLocalProvider(def);
    if (errs.length) { skipped.push({ id: label, reason: errs[0] ?? "invalid" }); continue; }
    if (def.authKind === "basic") { skipped.push({ id: label, reason: "basic auth is not yet supported" }); continue; }
    if (providers[def.ompProvider]) { skipped.push({ id: def.ompProvider, reason: "duplicate provider id" }); continue; }
    if (def.authKind === "none") {
      providers[def.ompProvider] = toOmpProviderEntry(def); // auth:none, no secret
    } else {
      const ref = def.vaultRef;
      if (!ref || !availableRefs.has(ref)) { skipped.push({ id: label, reason: "needs a credential in the vault" }); continue; }
      const envVar = providerEnvVar(def);
      const entry: OmpProviderEntry = { baseUrl: def.baseUrl.trim(), api: def.api, models: def.models.map(toModelEntry) };
      const header = def.headerName?.trim();
      if (def.authKind === "apikey" && header && header.toLowerCase() !== "authorization") entry.headers = { [header]: envVar };
      else entry.apiKey = envVar; // omp resolves this env-var NAME to the injected secret
      providers[def.ompProvider] = entry;
      env[envVar] = ref;
    }
    included.push(def.ompProvider);
  }
  return { overlay: { providers }, env, included, skipped };
}

// ── egress proposal ─────────────────────────────────────────────────────────────────────────────
// A Local Provider's endpoint must be reachable, so it produces a whitelist proposal (host as a
// domain or IP entry). The MAIN process turns this into a WhitelistEntry + AuthRef→vault (P-LOCAL.2).

export interface EgressProposal {
  kind: "domain" | "ip";
  pattern: string; // host only (the whitelist matches on host; port is not part of the pattern)
  zone: "internal" | "external";
  vaultRef?: string; // the credential this endpoint uses, if any (→ AuthRef)
  authKind: LocalAuthKind;
}

/** The egress the provider needs allow-listed. Returns null if the base URL can't be parsed. */
export function egressProposal(def: LocalProviderDef): EgressProposal | null {
  const h = hostFromBaseUrl(def.baseUrl);
  if (!h) return null;
  return { kind: h.isIp ? "ip" : "domain", pattern: h.host, zone: def.zone, vaultRef: def.authKind === "none" ? undefined : def.vaultRef, authKind: def.authKind };
}
