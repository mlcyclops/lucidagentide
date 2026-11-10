// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/secret_intake.ts
//
// P-SECRET-INTAKE.1 (ADR-0476): the engine half of the agent-triggered secret dialog.
//
// FLOW. The omp child's `request_secret` tool (harness/omp/secret_intake_extension.ts) POSTs
// { name, kind, purpose, envName?, workspaceScoped? } to /api/secret/request with the master-only request
// token (secret_routes.ts; the route names the requester from the token, never from the body), then
// polls the same route in short holds (wait()) so no single HTTP request outlives Bun's idle or fetch
// timeouts. SecretIntake.open() validates it, parks it, and emits a `secret-request` ChatEvent into the
// master turn (acp_backend.requestSecretDialog), the same event stream the approval cards ride. The
// renderer shows the LUCID modal; the USER's value comes back on UI-token routes (secret_routes.ts) and
// goes straight into the engine vault (vault_store.vaultPut, source "agent-request"). Only then does the
// parked request resolve, and it resolves to { stored: true, ref, envName } or { stored: false, reason }:
// the value is never part of any result, event, audit record or log line.
//
// Refusals are fail-closed: a vault write that throws leaves the request pending (the dialog shows the
// error and the user may retry or cancel); cancel, timeout and a withdrawn tool call (the user pressed
// Stop) resolve stored:false. Replacing an entry already saved under the ref needs a second, explicit
// confirmation in the dialog (which names the saved entry); without it nothing is written.
// The notepad fallback (secret_fallback.ts) feeds the same submit path.
//
// Env names (security review SECRET-INTAKE-ENVNAME-UNRESTRICTED): a reserved name (env_name_policy.ts:
// PATH, NODE_*, *_PROXY, *_BASE_URL, LUCID_*, ...) is refused, and only a provider's own key env may be a
// global `key:<ENV>`; any other env name is stored workspace-scoped (`ws:`) for the current workspace.
//
// The "Do you keep another secrets manager?" answer is recorded as a NON-secret preference here, and saved
// as a Contract C destination only when the enterprise add-on's kms connector is installed AND a
// destination store is wired (P-VAULT-DEST.1 owns that store; it is injected, never imported here).

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { scanTextsForSecrets } from "../harness/agent/secret_guard.ts";
import { writeAtomic } from "./atomic_file.ts";
import { emitSecurityEvent, type SecurityDecision } from "./audit_export.ts";
import { isEnvName, VAULT_KINDS, type VaultKind } from "./engine_vault.ts";
import { isReservedEnvName, providerKeyEnvs } from "./env_name_policy.ts";
import { startFallback, FallbackRefused, type FallbackOptions, type FallbackSession } from "./secret_fallback.ts";
import {
  SECRET_MANAGER_LABELS, type SecretIntakeResult, type SecretManagerAnswer, type SecretManagerKind, type SecretManagerOutcome,
  type SecretRequestView,
} from "./secret_intake_view.ts";
import { afterWrite, derivedRef } from "./vault_routes.ts";
import { vaultList, vaultPut, type VaultEntryMeta, type VaultPutInput } from "./vault_store.ts";
import { currentWorkspace } from "./workspace.ts";

/** How long a request waits for the user before it resolves stored:false "timeout". */
export const SECRET_REQUEST_TIMEOUT_MS = 10 * 60_000;
/** Requests waiting at once; a further one is refused rather than stacking dialogs. */
export const MAX_PENDING_SECRET_REQUESTS = 3;

/** Control, zero-width and bidi characters: never shown in the dialog (spoofing) or written to audit. */
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

export interface ParsedSecretRequest {
  name: string;
  kind: VaultKind;
  purpose: string;
  envName: string | null;
  workspaceScoped: boolean;
}

/** Validate the tool's arguments. Only the five known fields are read: anything else the agent sends
 *  (a `value`, a pasted secret in another field) is ignored, and a name or purpose that LOOKS like a
 *  secret value is refused, so a secret pasted into chat can never become what this flow stores. */
export function parseSecretRequest(raw: unknown): { ok: true; request: ParsedSecretRequest } | { ok: false; reason: string } {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const name = (typeof o.name === "string" ? o.name : "").replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim();
  const purpose = (typeof o.purpose === "string" ? o.purpose : "").replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, reason: "`name` is required (what the secret is, e.g. \"OpenAI API key\")" };
  if (name.length > 80) return { ok: false, reason: "`name` must be at most 80 characters" };
  if (!purpose) return { ok: false, reason: "`purpose` is required (one sentence the user reads: why you need it)" };
  if (purpose.length > 400) return { ok: false, reason: "`purpose` must be at most 400 characters" };
  const leaks = scanTextsForSecrets([{ where: "name", text: name }, { where: "purpose", text: purpose }]);
  if (leaks.length) {
    return { ok: false, reason: `the ${leaks.map((l) => l.where).join(" and ")} looks like it contains a secret value; never pass secret values, the user types them into the dialog` };
  }
  const kindRaw = typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
  const kind = VAULT_KINDS.find((k) => k === kindRaw) ?? "other";
  const envRaw = typeof o.envName === "string" ? o.envName.trim() : "";
  if (envRaw && !isEnvName(envRaw)) return { ok: false, reason: "`envName` must be an environment variable name (letters, digits, underscore)" };
  if (envRaw && isReservedEnvName(envRaw)) {
    return { ok: false, reason: `\`envName\` ${envRaw} is reserved: it changes how programs run or where they connect (PATH, NODE_*, GIT_*, PYTHON*, *_PROXY, *_BASE_URL, *_ENDPOINT, certificate settings, LUCID_*), so no secret may take it` };
  }
  // A global `key:<ENV>` reaches the engine's env and every later session of every workspace: only a
  // provider's own key env may be one. Any other env name is kept to the current workspace.
  const workspaceScoped = o.workspaceScoped === true || o.workspaceScoped === "true" || (!!envRaw && !providerKeyEnvs().has(envRaw));
  if (workspaceScoped && !envRaw) return { ok: false, reason: "a workspace-scoped secret needs an `envName`" };
  return { ok: true, request: { name, kind, purpose, envName: envRaw || null, workspaceScoped } };
}

/** The value as stored: BOM and surrounding whitespace removed (a paste or a Notepad save adds a trailing
 *  newline); PEM and JSON keep their inner lines with LF endings. Empty means nothing was captured. */
export function normalizeSecretValue(value: string, kind: VaultKind): string {
  const v = value.replace(/^\uFEFF/, "");
  return kind === "pem" || kind === "json" ? v.replace(/\r\n?/g, "\n").trim() : v.trim();
}

export type SubmitOutcome =
  | { ok: true; meta: VaultEntryMeta }
  | { ok: false; code: "not-found" | "empty" | "refused" | "confirm-replace"; error: string };
export type FallbackStart = { ok: true; path: string } | { ok: false; error: string };
export type FallbackOutcome = { ok: true; meta: VaultEntryMeta } | { ok: false; error: string };
/** How the value reached the engine (audit reason only). */
export type SecretVia = "dialog" | "file" | "text-file";

export interface SecretIntakeDeps {
  /** Show the dialog: emit the `secret-request` ChatEvent into the master turn. */
  emit(view: SecretRequestView): void;
  put(input: VaultPutInput): VaultEntryMeta;
  /** The entry stored under `ref` now (metadata only), or null. */
  existing(ref: string): VaultEntryMeta | null;
  /** Ref for (envName, workspace realpath, label): vault_routes.derivedRef. */
  deriveRef(envName: string, workspace: string | undefined, label: string): string;
  /** Refresh the engine-side credential env after a write (vault_routes.afterWrite). */
  afterWrite(ref: string): void;
  workspace(): string;
  /** Metadata-only audit line (names, never values). */
  audit(decision: SecurityDecision, reason: string): void;
  fallback(opts: FallbackOptions): FallbackSession;
  now(): number;
  timeoutMs: number;
}

/** The production dependencies: the engine vault, the current workspace, the security audit sink. */
export function defaultIntakeDeps(emit: (view: SecretRequestView) => void): SecretIntakeDeps {
  return {
    emit,
    put: vaultPut,
    existing: (ref) => vaultList().find((m) => m.ref === ref) ?? null,
    deriveRef: derivedRef,
    afterWrite,
    workspace: currentWorkspace,
    audit: (decision, reason) => {
      emitSecurityEvent({ category: "approval", type: "secret_intake", decision, severity: decision === "block" ? "low" : "info", tool: "request_secret", reason: reason.slice(0, 200) });
    },
    fallback: startFallback,
    now: Date.now,
    timeoutMs: SECRET_REQUEST_TIMEOUT_MS,
  };
}

interface Pending {
  view: SecretRequestView;
  request: ParsedSecretRequest;
  workspace?: string;
  settle: (r: SecretIntakeResult) => void;
  done: Promise<SecretIntakeResult>;
  timer: Timer;
  fallback?: { session: FallbackSession; outcome: Promise<FallbackOutcome> };
}

/** The label (and last-4) of the entry a write would replace, as the dialog names it. */
const savedLabel = (m: VaultEntryMeta): string => `${m.label}${m.last4 ? ` (ends in ${m.last4})` : ""}`;

/** Settled results the agent has not collected yet (its poll may land just after the user answered). */
const MAX_UNCOLLECTED = 32;

export class SecretIntake {
  readonly #pending = new Map<string, Pending>();
  readonly #uncollected = new Map<string, SecretIntakeResult>();
  readonly #deps: SecretIntakeDeps;

  constructor(deps: SecretIntakeDeps) { this.#deps = deps; }

  /** Requests still waiting for the user (the dialog re-syncs from this after a reload). */
  pending(): SecretRequestView[] {
    return [...this.#pending.values()].map((p) => p.view);
  }

  /** Open one `request_secret` call: validate, park it, show the dialog. `requester` is the label of the
   *  caller the route authenticated ("Main agent"). `{ result }` when it is refused at once (invalid, busy);
   *  otherwise `{ id }` to collect the answer with wait(). Never carries a value. */
  open(raw: unknown, requester: string): { id: string } | { result: SecretIntakeResult } {
    const parsed = parseSecretRequest(raw);
    if (!parsed.ok) return { result: { stored: false, reason: `invalid request: ${parsed.reason}` } };
    if (this.#pending.size >= MAX_PENDING_SECRET_REQUESTS) return { result: { stored: false, reason: "busy: other secret requests are already waiting for the user" } };
    const request = parsed.request;
    let workspace: string | undefined;
    if (request.workspaceScoped) {
      try { workspace = realpathSync(this.#deps.workspace()); } catch { return { result: { stored: false, reason: "the current workspace folder does not exist" } }; }
    }
    const ref = this.#deps.deriveRef(request.envName ?? "", workspace, request.name);
    const now = this.#deps.now();
    const held = this.#deps.existing(ref);
    const view: SecretRequestView = {
      id: randomUUID(), requester, name: request.name, kind: request.kind, purpose: request.purpose,
      envName: request.envName, workspace: workspace ? basename(workspace) : null, ref,
      replaces: !!held, replacesLabel: held ? savedLabel(held) : null, createdAt: now, expiresAt: now + this.#deps.timeoutMs,
    };
    const { promise, resolve } = Promise.withResolvers<SecretIntakeResult>();
    const timer = setTimeout(() => this.#finish(view.id, { stored: false, reason: "timeout" }, "block", "no answer before the deadline"), this.#deps.timeoutMs);
    this.#pending.set(view.id, { view, request, workspace, settle: resolve, done: promise, timer });
    this.#deps.audit("prompt", `asked the user for "${request.name}" (${request.kind}) as ${ref}`);
    this.#deps.emit(view);
    return { id: view.id };
  }

  /** The answer to an opened request, held up to `holdMs`: the result once the user answered, canceled
   *  or the deadline passed, or null while it is still waiting (the agent polls again). The tool polls in
   *  short holds so no single HTTP request outlives an idle or fetch timeout. */
  async wait(id: string, holdMs: number): Promise<SecretIntakeResult | null> {
    const p = this.#pending.get(id);
    if (!p) {
      const r = this.#uncollected.get(id);
      this.#uncollected.delete(id);
      return r ?? { stored: false, reason: "unknown request (it ended long ago or never existed)" };
    }
    const { promise: held, resolve } = Promise.withResolvers<null>();
    const t = setTimeout(() => resolve(null), holdMs);
    const r = await Promise.race([p.done, held]);
    clearTimeout(t);
    if (r) this.#uncollected.delete(id);
    return r;
  }

  /** The user's value for a pending request: stored in the vault, then the request resolves stored:true.
   *  Replacing an entry already saved under the ref needs `confirmReplace` (the dialog's second, explicit
   *  confirmation naming the saved entry); without it nothing is written. A refusal of either kind leaves
   *  the request pending so the dialog can show it. */
  submit(id: string, value: string, via: SecretVia, confirmReplace = false): SubmitOutcome {
    const p = this.#pending.get(id);
    if (!p) return { ok: false, code: "not-found", error: "this request is no longer waiting (it was answered, canceled or timed out)" };
    const clean = normalizeSecretValue(value, p.request.kind);
    if (!clean) return { ok: false, code: "empty", error: "nothing was captured" };
    // Without an env name the ref is a free `secret:<label>` slot: re-derive it so an entry written
    // since the dialog opened is never clobbered. With one, the ref is the env name's single slot.
    const ref = p.request.envName ? p.view.ref : this.#deps.deriveRef("", p.workspace, p.request.name);
    const held = this.#deps.existing(ref);
    if (held && !confirmReplace) {
      this.#deps.audit("block", `replacing ${ref} was not confirmed for "${p.request.name}"`);
      return { ok: false, code: "confirm-replace", error: `this replaces your saved ${savedLabel(held)}; confirm the replacement first` };
    }
    let meta: VaultEntryMeta;
    try {
      meta = this.#deps.put({
        ref, value: clean, kind: p.request.kind, label: p.request.name, source: "agent-request",
        scope: p.workspace ? { workspace: p.workspace } : undefined, envName: p.request.envName ?? undefined,
      });
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 200);
      this.#deps.audit("block", `the vault refused "${p.request.name}" as ${ref}: ${why}`);
      return { ok: false, code: "refused", error: `the secret was not stored: ${why}` };
    }
    this.#deps.afterWrite(ref);
    this.#finish(id, { stored: true, ref, envName: p.request.envName }, "allow", `stored "${p.request.name}" as ${ref} via ${via}`);
    return { ok: true, meta };
  }

  /** The user said no (or closed the dialog). */
  cancel(id: string): boolean {
    return this.#finish(id, { stored: false, reason: "cancelled" }, "block", "the user canceled");
  }

  /** The agent's call was stopped (the user pressed Stop): close the dialog's request unanswered. */
  withdraw(id: string): boolean {
    const ended = this.#finish(id, { stored: false, reason: "cancelled" }, "block", "the agent withdrew the request");
    this.#uncollected.delete(id); // nobody is left to collect it
    return ended;
  }

  /** Start the notepad fallback for a pending request: a user-only file outside synced folders and the
   *  workspace, opened in the OS editor. The returned path is for the dialog only. */
  startFallback(id: string, confirmReplace = false): FallbackStart {
    const p = this.#pending.get(id);
    if (!p) return { ok: false, error: "this request is no longer waiting" };
    if (p.fallback) return { ok: true, path: p.fallback.session.path };
    // Same rule as submit: never ask the user to paste a value that would be refused at the end.
    const held = p.request.envName ? this.#deps.existing(p.view.ref) : null;
    if (held && !confirmReplace) return { ok: false, error: `this replaces your saved ${savedLabel(held)}; confirm the replacement first` };
    let session: FallbackSession;
    try {
      session = this.#deps.fallback({ label: p.request.envName ?? p.request.name, workspace: this.#deps.workspace(), timeoutMs: Math.max(1_000, p.view.expiresAt - this.#deps.now()) });
    } catch (e) {
      const why = e instanceof FallbackRefused ? e.message : "the text file could not be prepared";
      this.#deps.audit("block", `text-file fallback refused for "${p.request.name}": ${why}`);
      return { ok: false, error: why };
    }
    const outcome = session.read.then((r): FallbackOutcome => {
      if (p.fallback?.session === session) p.fallback = undefined; // a later attempt may start a new file
      if (!r) return { ok: false, error: "the text file was closed before anything was saved" };
      if ("error" in r) return { ok: false, error: r.error };
      const s = this.submit(id, r.value, "text-file", confirmReplace);
      return s.ok ? { ok: true, meta: s.meta } : { ok: false, error: s.code === "empty" ? "the saved file was empty" : s.error };
    });
    p.fallback = { session, outcome };
    return { ok: true, path: session.path };
  }

  /** Wait for the running fallback of a request: stored, or why not. */
  awaitFallback(id: string): Promise<FallbackOutcome> {
    const f = this.#pending.get(id)?.fallback;
    return f ? f.outcome : Promise.resolve({ ok: false, error: "no text file is open for this request" });
  }

  #finish(id: string, result: SecretIntakeResult, decision: SecurityDecision, reason: string): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    p.fallback?.session.dispose(); // wipes and deletes a still-open text file
    this.#deps.audit(decision, reason);
    this.#uncollected.set(id, result); // wait() takes it (now, or on the agent's next poll)
    if (this.#uncollected.size > MAX_UNCOLLECTED) this.#uncollected.delete(this.#uncollected.keys().next().value ?? "");
    p.settle(result);
    return true;
  }
}

// ── "Do you keep another secrets manager or vault?" ──────────────────────────────────────────────────

/** P-VAULT-DEST.1's destination store (`upsertVaultDestination`), injected at the route seam. Throws on an
 *  incomplete or secret-carrying config. */
export interface DestinationStore {
  upsert(input: { name: string; kind: SecretManagerKind; config: Record<string, string> }): { id: string; name: string; kind: string };
}

/** Non-secret destination config keys the dialog may send (Contract C); anything else is dropped. */
const DESTINATION_CONFIG_KEYS = ["vaultName", "cloud", "auth", "tenantId", "clientId", "region", "project", "address", "mount"];

/** `<LUCID_DATA_ROOT or ~/.omp>/secret-intake.json`: the recorded answer (never a secret). */
export function secretManagerPrefFile(): string {
  return join(process.env.LUCID_DATA_ROOT || join(homedir(), ".omp"), "secret-intake.json");
}

export interface SecretManagerPreference { answer: SecretManagerAnswer; name: string; recordedAt: number }

export function readSecretManagerPreference(file = secretManagerPrefFile()): SecretManagerPreference | null {
  try {
    if (!existsSync(file)) return null;
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const pref = raw && typeof raw === "object" && "secretManager" in raw ? raw.secretManager : null;
    if (!pref || typeof pref !== "object" || !("answer" in pref) || typeof pref.answer !== "string") return null;
    const answer = Object.keys(SECRET_MANAGER_LABELS).find((k): k is SecretManagerAnswer => k === pref.answer);
    if (!answer) return null;
    const name = "name" in pref && typeof pref.name === "string" ? pref.name : SECRET_MANAGER_LABELS[answer];
    const recordedAt = "recordedAt" in pref && typeof pref.recordedAt === "number" ? pref.recordedAt : 0;
    return { answer, name, recordedAt };
  } catch {
    return null;
  }
}

export interface SecretManagerDeps {
  /** connectorStatus("kms").installed */
  kmsInstalled: boolean;
  store: DestinationStore | null;
  file: string;
  now: number;
}

const SETTINGS_HINT = "Settings > Vault destinations (Enterprise)";

/** Record the answer and, when the enterprise add-on is installed and a destination store is wired, save
 *  it as a Contract C destination. Every outcome says exactly what happened; nothing is pushed here. */
export function recordSecretManager(raw: unknown, deps: SecretManagerDeps): SecretManagerOutcome {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const answer = Object.keys(SECRET_MANAGER_LABELS).find((k): k is SecretManagerAnswer => k === o.answer);
  if (!answer) return { saved: false, recorded: false, enterprise: deps.kmsInstalled, detail: "Unknown answer; nothing was recorded." };
  const label = SECRET_MANAGER_LABELS[answer];
  const name = (typeof o.name === "string" ? o.name : "").replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim().slice(0, 80) || label;
  const config: Record<string, string> = {};
  const rawConfig = o.config && typeof o.config === "object" && !Array.isArray(o.config) ? (o.config as Record<string, unknown>) : {};
  for (const key of DESTINATION_CONFIG_KEYS) {
    const v = rawConfig[key];
    if (typeof v === "string" && v.trim()) config[key] = v.trim().slice(0, 200);
  }
  if (scanTextsForSecrets([{ where: "name", text: name }, ...Object.entries(config).map(([k, v]) => ({ where: k, text: v }))]).length) {
    return { saved: false, recorded: false, enterprise: deps.kmsInstalled, detail: "That looks like a secret value; only names and settings belong here. Nothing was recorded." };
  }
  let recorded = true;
  try {
    writeAtomic(deps.file, `${JSON.stringify({ v: 1, secretManager: { answer, name, recordedAt: deps.now } }, null, 2)}\n`);
  } catch {
    recorded = false;
  }
  const noted = recorded ? "Noted." : "Your answer could not be saved on this computer.";
  if (answer === "none") return { saved: false, recorded, enterprise: deps.kmsInstalled, detail: `${noted} The secret stays in LUCID's vault only.` };
  if (answer === "other") return { saved: false, recorded, enterprise: deps.kmsInstalled, detail: `${noted} LUCID has no connector for that manager, so the secret stays in LUCID's vault only.` };
  if (!deps.kmsInstalled) {
    return { saved: false, recorded, enterprise: false, detail: `${noted} Copying secrets to ${label} is an Enterprise feature and the LUCID Enterprise add-on is not installed, so the secret stays in LUCID's vault only.` };
  }
  if (!deps.store) {
    return { saved: false, recorded, enterprise: true, detail: `${noted} This build cannot save destinations from here yet; add ${label} in ${SETTINGS_HINT}.` };
  }
  try {
    const d = deps.store.upsert({ name, kind: answer, config });
    return { saved: true, recorded, enterprise: true, detail: `Saved "${d.name}" as a destination. Push and auto-backup are in ${SETTINGS_HINT}.` };
  } catch (e) {
    const why = String((e as Error)?.message ?? e).slice(0, 200);
    return { saved: false, recorded, enterprise: true, detail: `${noted} The destination was not saved (${why}); finish it in ${SETTINGS_HINT}.` };
  }
}
