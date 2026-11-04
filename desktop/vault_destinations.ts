// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/vault_destinations.ts
//
// P-VAULT-DEST.1 (ADR-0478, Contract C): the core half of enterprise vault destinations. The user's
// engine vault (vault_store.ts) can be backed up to the customer's own secrets manager (Azure Key Vault
// today), listed there, and pulled back newer-wins. The network side is the PRIVATE add-on's kms
// connector (lucidagentIDEaddon, ADR-A044): this module never talks to a cloud. It keeps the non-secret
// destination config in settings (`vaultDestinations`), builds each request, and hands it to the
// connector through the add-on seam (addon_seam.ts runConnectorReply, `bun connectors/kms/src/cli.ts
// <verb> --file <req>`).
//
// The file contract (ADR-A014 / ADR-A044): every request is written 0600 (flag wx) into a fresh user-only
// dir from secret_fallback.ts createUserOnlyDir (a private, non-synced temp base; POSIX 0700 or a
// verified Windows ACL; no such dir = a DestinationError(500) and nothing written), and the whole dir is
// overwritten and removed right after the call, on success, on a connector failure and on a throw. A dir
// a killed engine leaves behind is swept at the next start (sweepOrphanTempDirs). A push goes out in
// batches of PUSH_BATCH_SIZE items, one request dir each, so at most one batch of plaintext is on disk;
// a failed batch stops the rest and the result reports what was pushed so far. A pull's values come
// back ONLY in the request's `out` file inside that dir; they are read into memory, imported through
// vaultImportEntries and the file is wiped with the dir. Values never ride a reply, a log line, an event
// or a route response: replies carry names, versions and counts, and every detail string that leaves
// this module is scrubbed of every value the call involved (item values, the resolved client secret,
// pulled values; raw, JSON-escaped and base64 / base64url forms) as a final guard. A pulled `key:<ENV>`
// reaches process.env only when env_name_policy.ts mayHoldGlobalEnv allows the name.
//
// Without the add-on (connectorStatus("kms") not installed) nothing pretends: every connector operation
// refuses with the seam's own "part of the LUCID enterprise add-on" note, and auto-backup records the
// same refusal instead of a success.
//
// Auto-backup: a destination with `autoBackup` gets every newly stored or rotated value (vault_store.ts
// onVaultWrite, metadata only) pushed shortly after the write; a burst of writes is coalesced into one
// push per destination and pushes run one at a time. The last outcome per destination is kept in
// memory for the Settings view.

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectorStatus, connectorVersion, runConnectorReply, type ConnectorReply } from "./addon_seam.ts";
import { isEnvName, VAULT_KINDS, type VaultEntryMeta, type VaultKind } from "./engine_vault.ts";
import { mayHoldGlobalEnv } from "./env_name_policy.ts";
import { createUserOnlyDir } from "./secret_fallback.ts";
import { load, save, type VaultDestination, type VaultDestinationKind } from "./settings_store.ts";
import { applyVaultEnv } from "./vault_env.ts";
import { isVaultRef, onVaultWrite, vaultExportEntries, vaultGet, vaultImportEntries, vaultList, type VaultExportEntry } from "./vault_store.ts";

// ── Contract C shapes (the stored shape lives in settings_store.ts, beside the other settings types) ──

export const DESTINATION_KINDS: readonly VaultDestinationKind[] = ["azure-kv", "aws-sm", "gcp-sm", "hashicorp-vault"];

/** What a caller saves: a new destination (no id, or an id not stored yet) or an edit of a stored one. */
export interface VaultDestinationInput {
  id?: string;
  name: string;
  kind: VaultDestinationKind;
  config: Record<string, string>;
  autoBackup?: boolean;
}

export type DestinationVerb = "put" | "list" | "pull" | "check";

/** A refusal with the HTTP status the route answers (400 bad input, 404 unknown destination, 409 the
 *  add-on is not installed, 500 the vault could not be read or written). */
export class DestinationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500) {
    super(message);
  }
}

// ── Name mapping (Contract C; char for char the add-on's azureSecretName, ADR-A044) ──────────────────

/** `lucid-` + the vault ref with every char outside [0-9A-Za-z-] replaced by `-`, cut to 127. Nothing is
 *  trimmed or collapsed, so the core and the connector always derive the same name. Throws when nothing
 *  but separators is left. Contract C defines only this mapping; the connector answers "not implemented"
 *  for the other kinds today, so every kind uses it. */
export function azureSecretName(ref: string): string {
  const mapped = (ref ?? "").replace(/[^0-9A-Za-z-]/g, "-");
  if (!/[0-9A-Za-z]/.test(mapped)) {
    throw new Error(`vault ref "${(ref ?? "").slice(0, 80)}" does not map to a Key Vault secret name (no letters or digits left after mapping)`);
  }
  return `lucid-${mapped}`.slice(0, 127);
}

/** Contract C tags: { "lucid-ref", "lucid-kind", "lucid-added" (ISO date) }. */
export function lucidSecretTags(ref: string, kind: string, addedAtMs: number): Record<string, string> {
  return { "lucid-ref": ref, "lucid-kind": kind, "lucid-added": new Date(addedAtMs).toISOString() };
}

// ── Validation (non-secret config only) ──────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_DESTINATIONS = 20;
/** Key Vault names: 3-24 chars, a letter first, a letter or digit last, no consecutive hyphens. */
const AZ_VAULT_RE = /^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/;
/** A tenant (GUID or domain) or client id (GUID). */
const AZ_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/;
const AZ_KEYS: readonly string[] = ["vaultName", "cloud", "auth", "tenantId", "clientId", "clientSecretRef"];
const AZ_CLOUDS: readonly string[] = ["public", "usgov"];
const AZ_AUTH: readonly string[] = ["azure-cli", "managed-identity", "client-secret"];
const GENERIC_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** A config key that names a secret VALUE (not a `...Ref` to one) is refused: config is non-secret. */
const SECRET_KEY_RE = /secret|passw|token|apikey|api_key|credential|privatekey|private_key/i;

const isKindOf = (k: unknown): k is VaultDestinationKind => DESTINATION_KINDS.some((x) => x === k);

function validAzureConfig(config: Record<string, string>, refs: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(config)) if (!AZ_KEYS.includes(k)) errors.push(`unknown azure-kv config field "${k.slice(0, 40)}"`);
  const { vaultName = "", cloud = "", auth = "", tenantId, clientId, clientSecretRef } = config;
  if (!AZ_VAULT_RE.test(vaultName) || vaultName.includes("--")) errors.push("vaultName must be a Key Vault name (3-24 letters, digits or single hyphens, starting with a letter)");
  if (!AZ_CLOUDS.includes(cloud)) errors.push('cloud must be "public" or "usgov"');
  if (!AZ_AUTH.includes(auth)) errors.push('auth must be "azure-cli", "managed-identity" or "client-secret"');
  if (tenantId !== undefined && !AZ_ID_RE.test(tenantId)) errors.push("tenantId is not a tenant id or domain");
  if (clientId !== undefined && !AZ_ID_RE.test(clientId)) errors.push("clientId is not a client id");
  if (auth === "client-secret") {
    if (!tenantId) errors.push("client-secret auth needs tenantId");
    if (!clientId) errors.push("client-secret auth needs clientId");
    if (!clientSecretRef) errors.push("client-secret auth needs clientSecretRef (pick the vault entry holding the client secret)");
  }
  if (clientSecretRef !== undefined && (!isVaultRef(clientSecretRef) || !refs.has(clientSecretRef))) errors.push("clientSecretRef must name an entry in the vault");
  return errors;
}

function validGenericConfig(config: Record<string, string>, refs: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const keys = Object.keys(config);
  if (keys.length > 12) errors.push("at most 12 config fields");
  for (const k of keys) {
    if (!GENERIC_KEY_RE.test(k)) { errors.push(`config field "${k.slice(0, 40)}" is not a plain name`); continue; }
    const isRef = k.endsWith("Ref");
    if (!isRef && SECRET_KEY_RE.test(k)) errors.push(`config field "${k}" looks like a secret: store the secret in the vault and name it with a "${k}Ref" field`);
    if (isRef && (!isVaultRef(config[k]) || !refs.has(config[k]!))) errors.push(`${k} must name an entry in the vault`);
  }
  return errors;
}

/** Validate and clean a destination input. Throws a DestinationError(400) naming every problem. */
export function validateDestinationInput(input: unknown): VaultDestinationInput {
  const o = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const errors: string[] = [];
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name || name.length > 80) errors.push("a name of 1-80 characters is required");
  const kind = isKindOf(o.kind) ? o.kind : null;
  if (!kind) errors.push(`kind must be one of ${DESTINATION_KINDS.join(", ")}`);
  const id = typeof o.id === "string" && o.id ? o.id : undefined;
  if (id !== undefined && !ID_RE.test(id)) errors.push("invalid destination id");
  const rawConfig = o.config && typeof o.config === "object" && !Array.isArray(o.config) ? (o.config as Record<string, unknown>) : null;
  if (!rawConfig) errors.push("config is required");
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawConfig ?? {})) {
    if (typeof v !== "string") { errors.push(`config field "${k.slice(0, 40)}" must be text`); continue; }
    const t = v.trim();
    if (t.length > 300) { errors.push(`config field "${k.slice(0, 40)}" is longer than 300 characters`); continue; }
    if (t) config[k] = t;
  }
  if (kind && rawConfig) {
    const refs = new Set(vaultList().map((m) => m.ref));
    errors.push(...(kind === "azure-kv" ? validAzureConfig(config, refs) : validGenericConfig(config, refs)));
  }
  if (errors.length || !kind) throw new DestinationError(`invalid destination: ${errors.join("; ")}`, 400);
  return { ...(id ? { id } : {}), name, kind, config, autoBackup: o.autoBackup === true };
}

// ── Settings storage ─────────────────────────────────────────────────────────────────────────────────

/** The stored destinations (non-secret). */
export function listVaultDestinations(): VaultDestination[] {
  const raw = load().vaultDestinations;
  return Array.isArray(raw) ? raw : [];
}

/** Add or replace (by id) one destination after validating it. Keeps addedAt on an edit. Throws a
 *  DestinationError(400) on invalid input. */
export function upsertVaultDestination(input: VaultDestinationInput, now = Date.now()): VaultDestination {
  const clean = validateDestinationInput(input);
  const s = load();
  const list = Array.isArray(s.vaultDestinations) ? s.vaultDestinations : [];
  const prev = clean.id ? list.find((d) => d.id === clean.id) : undefined;
  if (!prev && list.length >= MAX_DESTINATIONS) throw new DestinationError(`at most ${MAX_DESTINATIONS} destinations`, 400);
  const dest: VaultDestination = {
    id: clean.id ?? `dest-${randomUUID().slice(0, 8)}`,
    name: clean.name,
    kind: clean.kind,
    config: clean.config,
    ...(clean.autoBackup ? { autoBackup: true } : {}),
    addedAt: prev?.addedAt ?? now,
  };
  s.vaultDestinations = prev ? list.map((d) => (d.id === dest.id ? dest : d)) : [...list, dest];
  save(s);
  return dest;
}

/** Remove one destination by id. False when it was not stored. Nothing is deleted at the destination. */
export function removeVaultDestination(id: string): boolean {
  const s = load();
  const list = Array.isArray(s.vaultDestinations) ? s.vaultDestinations : [];
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) return false;
  s.vaultDestinations = next.length ? next : undefined;
  save(s);
  lastAutoBackup.delete(id);
  return true;
}

/** Turn auto-backup on or off for one destination. Null when the id is not stored. */
export function setVaultDestinationAutoBackup(id: string, on: boolean): VaultDestination | null {
  const s = load();
  const list = Array.isArray(s.vaultDestinations) ? s.vaultDestinations : [];
  const d = list.find((x) => x.id === id);
  if (!d) return null;
  if (on) d.autoBackup = true; else delete d.autoBackup;
  save(s);
  return d;
}

function destinationOf(id: string): VaultDestination {
  const d = listVaultDestinations().find((x) => x.id === id);
  if (!d) throw new DestinationError("unknown destination", 404);
  return d;
}

function requireAddon(): void {
  const st = connectorStatus("kms");
  if (!st.installed) throw new DestinationError(`Enterprise add-on not installed: ${st.note}`, 409);
}

// ── The connector call (private temp dir, 0600 request, wiped right after) ──────────────────────────

export type DestinationRunner = (verb: DestinationVerb, requestFile: string, timeoutMs: number) => Promise<ConnectorReply>;
const defaultRunner: DestinationRunner = (verb, file, timeoutMs) => runConnectorReply("kms", verb, file, timeoutMs);
let runner: DestinationRunner = defaultRunner;
/** Test seam: replace the connector dispatch (null restores the add-on seam). */
export function _setDestinationRunnerForTest(r: DestinationRunner | null): void { runner = r ?? defaultRunner; }

/** The private temp dir prefix (tests and the demo look for leftovers by it). */
export const REQUEST_DIR_PREFIX = "lucid-vdest-";

let requestDirOptions: Parameters<typeof createUserOnlyDir>[1] = {};
/** Test seam: the createUserOnlyDir options for request dirs (bases / restrict / userOnly); null resets. */
export function _setRequestDirOptionsForTest(o: Parameters<typeof createUserOnlyDir>[1] | null): void { requestDirOptions = o ?? {}; }

/** At most this many items ride one `put` request, so less plaintext sits on disk at once. */
export const PUSH_BATCH_SIZE = 25;

/** Replace every known secret value (>= 4 chars, the add-on's own rule) in `text` with [redacted], in
 *  its raw, JSON-escaped, base64 and base64url forms. */
export function scrubValues(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    const b64 = Buffer.from(s, "utf8").toString("base64");
    for (const form of [s, JSON.stringify(s).slice(1, -1), b64, Buffer.from(s, "utf8").toString("base64url"), b64.replace(/=+$/, "")]) {
      if (form.length >= 4) out = out.split(form).join("[redacted]");
    }
  }
  return out;
}

/** Overwrite every file in `dir` with zeros, then remove the dir. Best effort per file; the removal is
 *  retried once and a dir that survives is reported by path only (never content). */
function wipeDir(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try { writeFileSync(p, Buffer.alloc(statSync(p).size)); } catch { /* removed below regardless */ }
    }
  } catch { /* the dir is gone or unreadable: removal below */ }
  for (let i = 0; i < 2 && existsSync(dir); i++) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* retried once */ }
  }
  if (existsSync(dir)) console.error(`[vault-dest] could not remove the request dir ${dir}; delete it by hand`);
}

interface KmsCall { res: ConnectorReply; out: Record<string, string> | null }

/** Write `request` 0600 in a fresh private dir, run the verb, read the pull `out` file when asked, and wipe
 *  the dir whatever happens (success, connector failure, a throw). */
async function callKms(verb: DestinationVerb, request: Record<string, unknown>, timeoutMs: number, wantOut = false): Promise<KmsCall> {
  let dir: string;
  try { dir = createUserOnlyDir(REQUEST_DIR_PREFIX, requestDirOptions); } catch (e) {
    throw new DestinationError(`no private temp folder for the request: ${errText(e)}`, 500);
  }
  try {
    const outPath = join(dir, "pull.out.json");
    const file = join(dir, `${verb}.request.json`);
    writeFileSync(file, JSON.stringify(wantOut ? { ...request, out: outPath } : request), { mode: 0o600, flag: "wx" });
    const res = await runner(verb, file, timeoutMs);
    let out: Record<string, string> | null = null;
    if (wantOut && res.ok) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(outPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out = {};
          for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
        }
      } catch { out = null; }
    }
    return { res, out };
  } finally {
    wipeDir(dir);
  }
}

/** The request's `destination`: kind + config, with a client secret resolved from the vault just-in-time
 *  (and `clientSecretRef` dropped). `secrets` lists what to scrub from every reply. */
function requestDestination(d: VaultDestination): { destination: { kind: VaultDestinationKind; config: Record<string, string> }; secrets: string[] } {
  const config: Record<string, string> = { ...d.config };
  const secrets: string[] = [];
  if (d.kind === "azure-kv" && config.auth === "client-secret") {
    const ref = config.clientSecretRef ?? "";
    const secret = isVaultRef(ref) ? vaultGet(ref) : undefined;
    if (!secret) throw new DestinationError(`the client secret "${ref.slice(0, 80)}" is not in the vault`, 400);
    delete config.clientSecretRef;
    config.clientSecret = secret;
    secrets.push(secret);
  }
  return { destination: { kind: d.kind, config }, secrets };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);

// ── check ────────────────────────────────────────────────────────────────────────────────────────────

export interface DestinationCheckResult { ok: boolean; detail: string }

/** Auth + reachability of one destination (connector `check`). */
export async function checkDestination(id: string): Promise<DestinationCheckResult> {
  const d = destinationOf(id);
  requireAddon();
  const { destination, secrets } = requestDestination(d);
  const { res } = await callKms("check", { destination }, 60_000);
  return { ok: res.ok, detail: scrubValues(res.detail, secrets) };
}

// ── put ──────────────────────────────────────────────────────────────────────────────────────────────

export interface DestinationPushResult {
  ok: boolean;
  /** What the destination now holds, by vault ref. */
  pushed: Array<{ ref: string; name: string; version?: string }>;
  /** Refs not sent, with why (not in the vault, or two refs that map to one destination name). */
  skipped: Array<{ ref: string; reason: string }>;
  detail: string;
}

/** Push vault entries to one destination (all of them, or just `refs`). Two refs that map to one
 *  destination name are both refused rather than one silently overwriting the other. */
export async function pushToDestination(id: string, refs?: readonly string[]): Promise<DestinationPushResult> {
  const d = destinationOf(id);
  requireAddon();
  let entries: VaultExportEntry[];
  try { entries = vaultExportEntries(); } catch (e) { throw new DestinationError(`the vault could not be read: ${errText(e)}`, 500); }
  const skipped: DestinationPushResult["skipped"] = [];
  if (refs) {
    const held = new Set(entries.map((e) => e.ref));
    for (const r of refs) if (!held.has(r)) skipped.push({ ref: r, reason: "not in the vault" });
    const wanted = new Set(refs);
    entries = entries.filter((e) => wanted.has(e.ref));
  }
  const byName = new Map<string, VaultExportEntry[]>();
  for (const e of entries) {
    let name: string;
    try { name = azureSecretName(e.ref); } catch (err) { skipped.push({ ref: e.ref, reason: errText(err) }); continue; }
    byName.set(name, [...(byName.get(name) ?? []), e]);
  }
  const items: Array<{ name: string; value: string; tags: Record<string, string> }> = [];
  const refOfName = new Map<string, string>();
  for (const [name, group] of byName) {
    if (group.length > 1) {
      const all = group.map((g) => g.ref).join(", ");
      for (const g of group) skipped.push({ ref: g.ref, reason: `maps to the same destination name "${name}" as another entry (${all})` });
      continue;
    }
    const e = group[0]!;
    items.push({ name, value: e.value, tags: lucidSecretTags(e.ref, e.kind, e.addedAt) });
    refOfName.set(name, e.ref);
  }
  const skippedNote = skipped.length ? ` (${skipped.length} skipped)` : "";
  if (!items.length) return { ok: skipped.length === 0, pushed: [], skipped, detail: `nothing to push${skippedNote}` };
  const { destination, secrets } = requestDestination(d);
  const values = [...items.map((i) => i.value), ...secrets];
  const pushed: DestinationPushResult["pushed"] = [];
  const details: string[] = [];
  let ok = true;
  // Bounded batches, each its own request dir wiped right after; a failed batch stops the rest.
  for (let at = 0; at < items.length; at += PUSH_BATCH_SIZE) {
    const batch = items.slice(at, at + PUSH_BATCH_SIZE);
    const timeoutMs = 30_000 + batch.length * 2_000;
    let res: ConnectorReply;
    try { ({ res } = await callKms("put", { destination, items: batch }, timeoutMs)); } catch (e) {
      if (!pushed.length) throw e;
      ok = false;
      details.push(errText(e));
      break;
    }
    const rawPushed: unknown[] = res.reply && Array.isArray(res.reply.pushed) ? res.reply.pushed : [];
    for (const p of rawPushed) {
      const o = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
      const name = str(o.name);
      const ref = name ? refOfName.get(name) : undefined;
      if (!name || !ref) continue;
      const version = str(o.version);
      pushed.push({ ref, name, ...(version ? { version } : {}) });
    }
    details.push(res.detail);
    if (!res.ok) { ok = false; break; }
  }
  const stopped = !ok && pushed.length ? ` (stopped after ${pushed.length} of ${items.length} pushed)` : "";
  return { ok, pushed, skipped, detail: scrubValues(details.join("; "), values) + stopped + skippedNote };
}

// ── list ─────────────────────────────────────────────────────────────────────────────────────────────

/** A LUCID secret at the destination. `local`: missing = not in this vault; older = this vault's copy is
 *  older than the destination's; current = this vault's copy is as new or newer (or no date to compare). */
export interface DestinationRemoteItem { name: string; ref: string; kind: VaultKind | null; updatedOn: string | null; local: "missing" | "older" | "current" }
export interface DestinationListResult {
  ok: boolean;
  items: DestinationRemoteItem[];
  /** Secrets at the destination LUCID did not write (no lucid-ref tag, or a tag that does not match the name). */
  unmapped: number;
  detail: string;
}

/** What one destination holds (connector `list`, metadata only). Only secrets whose `lucid-ref` tag maps to
 *  their own name count as LUCID entries, so a mislabelled secret can never land under another ref. */
export async function listDestination(id: string): Promise<DestinationListResult> {
  const d = destinationOf(id);
  requireAddon();
  const { destination, secrets } = requestDestination(d);
  const { res } = await callKms("list", { destination }, 60_000);
  const detail = scrubValues(res.detail, secrets);
  if (!res.ok) return { ok: false, items: [], unmapped: 0, detail };
  const local = new Map(vaultList().map((m) => [m.ref, m]));
  const items: DestinationRemoteItem[] = [];
  let unmapped = 0;
  const raw: unknown[] = res.reply && Array.isArray(res.reply.items) ? res.reply.items : [];
  for (const it of raw) {
    const o = it && typeof it === "object" ? (it as Record<string, unknown>) : {};
    const name = str(o.name);
    const tags = o.tags && typeof o.tags === "object" ? (o.tags as Record<string, unknown>) : {};
    const ref = str(tags["lucid-ref"]);
    let mapsBack = false;
    try { mapsBack = !!name && !!ref && isVaultRef(ref) && azureSecretName(ref) === name; } catch { mapsBack = false; }
    if (!name || !ref || !mapsBack) { unmapped++; continue; }
    const updatedOn = str(o.updatedOn) ?? null;
    const remoteAt = updatedOn ? Date.parse(updatedOn) : Number.NaN;
    const mine = local.get(ref);
    const state: DestinationRemoteItem["local"] = !mine ? "missing" : Number.isFinite(remoteAt) && remoteAt > mine.updatedAt ? "older" : "current";
    items.push({ name, ref, kind: VAULT_KINDS.find((k) => k === tags["lucid-kind"]) ?? null, updatedOn, local: state });
  }
  items.sort((a, b) => a.ref.localeCompare(b.ref));
  return { ok: true, items, unmapped, detail };
}

// ── pull ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DestinationPullResult {
  ok: boolean;
  added: number;
  updated: number;
  /** Pulled but identical to this vault's value (nothing written). */
  unchanged: number;
  /** Not written by the newer-wins import (this vault's copy was newer by the time of the write). */
  skipped: number;
  /** Refs written to this vault. */
  refs: string[];
  detail: string;
}

/** After a pull wrote values: keep a settings-style `key:<ENV>` live in process.env (only when
 *  mayHoldGlobalEnv(ENV): a pulled NODE_OPTIONS stays in the vault, never in the env) and re-resolve the
 *  engine-side credential env, as a vault route write does. Never fails the pull. */
function refreshEnv(refs: readonly string[]): void {
  try {
    for (const ref of refs) {
      if (!ref.startsWith("key:") || !mayHoldGlobalEnv(ref.slice(4))) continue; // never a reserved name (env_name_policy.ts)
      const v = vaultGet(ref);
      if (v) process.env[ref.slice(4)] = v;
    }
    applyVaultEnv();
  } catch (e) {
    console.error(`[vault-dest] env refresh after a pull failed: ${errText(e)}`);
  }
}

/** Pull the LUCID entries this vault lacks or holds older copies of (all of them, or just `refs`) into
 *  this vault, newer-wins, source "destination-pull" for new refs. All-or-nothing: a missing name in the
 *  connector's out file writes nothing. */
export async function pullFromDestination(id: string, refs?: readonly string[]): Promise<DestinationPullResult> {
  const listed = await listDestination(id);
  const none = { added: 0, updated: 0, unchanged: 0, skipped: 0, refs: [] as string[] };
  if (!listed.ok) return { ok: false, ...none, detail: listed.detail };
  const wanted = refs ? new Set(refs) : null;
  const candidates = listed.items.filter((i) => i.local !== "current" && (!wanted || wanted.has(i.ref)));
  if (!candidates.length) return { ok: true, ...none, detail: "this vault already holds the newest copy of every LUCID entry there" };
  const d = destinationOf(id);
  const { destination, secrets } = requestDestination(d);
  const { res, out } = await callKms("pull", { destination, names: candidates.map((c) => c.name) }, Math.min(15 * 60_000, 30_000 + candidates.length * 2_000), true);
  const pulledValues = out ? Object.values(out) : [];
  const scrubbed = (t: string): string => scrubValues(t, [...secrets, ...pulledValues]);
  if (!res.ok) return { ok: false, ...none, detail: scrubbed(res.detail) };
  if (!out) return { ok: false, ...none, detail: "the connector reported success but its out file was unreadable; nothing written" };
  const missing = candidates.filter((c) => typeof out[c.name] !== "string" || !out[c.name]);
  if (missing.length) return { ok: false, ...none, detail: `the out file lacked ${missing.length} of ${candidates.length} secret(s) (${missing.map((m) => m.name).join(", ").slice(0, 300)}); nothing written` };
  const local = new Map(vaultList().map((m) => [m.ref, m]));
  const now = Date.now();
  const entries: VaultExportEntry[] = [];
  let unchanged = 0;
  for (const c of candidates) {
    const value = out[c.name]!;
    const prev = local.get(c.ref);
    if (prev && vaultGet(c.ref) === value) { unchanged++; continue; }
    const remoteAt = c.updatedOn ? Date.parse(c.updatedOn) : Number.NaN;
    const updatedAt = Number.isFinite(remoteAt) ? remoteAt : now;
    if (prev) { entries.push({ ...prev, value, updatedAt }); continue; }
    const envName = c.ref.startsWith("key:") && isEnvName(c.ref.slice(4)) ? c.ref.slice(4) : undefined;
    entries.push({ ref: c.ref, label: c.ref, kind: c.kind ?? "other", source: "destination-pull", addedAt: updatedAt, updatedAt, value, ...(envName ? { envName } : {}) });
  }
  let counts = { added: 0, updated: 0, skipped: 0 };
  if (entries.length) {
    try { counts = vaultImportEntries(entries, "newer-wins"); } catch (e) { return { ok: false, ...none, detail: scrubbed(`the vault did not take the pulled entries: ${errText(e)}`) }; }
  }
  const written = entries.map((e) => e.ref);
  if (counts.added + counts.updated > 0) refreshEnv(written);
  return {
    ok: true, ...counts, unchanged, refs: written,
    detail: scrubbed(`pulled ${candidates.length} secret(s): ${counts.added} added, ${counts.updated} updated, ${unchanged} unchanged, ${counts.skipped} skipped (newer here)`),
  };
}

// ── auto-backup (vault_store.ts onVaultWrite) ────────────────────────────────────────────────────────

export interface AutoBackupStatus { at: number; ok: boolean; pushed: number; detail: string }
const lastAutoBackup = new Map<string, AutoBackupStatus>();
const pendingRefs = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let backupChain: Promise<void> = Promise.resolve();
/** A burst of writes (an .env import, a restore of many keys) becomes one push per destination. */
const AUTO_BACKUP_DELAY_MS = 250;

async function runAutoBackup(refs: string[]): Promise<void> {
  let targets: VaultDestination[];
  try { targets = listVaultDestinations().filter((d) => d.autoBackup === true); } catch { return; }
  for (const d of targets) {
    let status: AutoBackupStatus;
    try {
      const r = await pushToDestination(d.id, refs);
      status = { at: Date.now(), ok: r.ok, pushed: r.pushed.length, detail: r.detail };
    } catch (e) {
      status = { at: Date.now(), ok: false, pushed: 0, detail: errText(e) };
    }
    lastAutoBackup.set(d.id, status);
    // Names and counts only: the detail is already scrubbed of every value the push involved.
    console.log(`[vault-dest] auto-backup to "${d.name}" (${d.kind}): ${status.ok ? "ok" : "failed"}, ${status.pushed} of ${refs.length} pushed: ${status.detail}`);
  }
}

function startFlush(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const refs = [...pendingRefs];
  pendingRefs.clear();
  if (refs.length) backupChain = backupChain.then(() => runAutoBackup(refs));
}

/** vault_store.ts write observer: queue the stored ref for every auto-backup destination. */
function queueAutoBackup(meta: VaultEntryMeta): void {
  let any = false;
  try { any = listVaultDestinations().some((d) => d.autoBackup === true); } catch { return; }
  if (!any) return;
  pendingRefs.add(meta.ref);
  if (!flushTimer) flushTimer = setTimeout(startFlush, AUTO_BACKUP_DELAY_MS);
}

/** Run any queued auto-backup now and wait until every push has settled (tests; a clean shutdown). */
export async function flushAutoBackup(): Promise<void> {
  startFlush();
  await backupChain;
}

/** Test-only: forget queued refs and last outcomes. */
export function _resetAutoBackupForTest(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  pendingRefs.clear();
  lastAutoBackup.clear();
  backupChain = Promise.resolve();
}

onVaultWrite(queueAutoBackup);

// ── the Settings view ────────────────────────────────────────────────────────────────────────────────

export interface DestinationsView {
  addon: { installed: boolean; note: string; version: string | null };
  kinds: readonly VaultDestinationKind[];
  destinations: Array<VaultDestination & { lastAutoBackup?: AutoBackupStatus }>;
}

/** Everything the Settings section shows: whether the add-on is installed, and the non-secret destinations
 *  with their last auto-backup outcome. */
export function destinationsView(): DestinationsView {
  const st = connectorStatus("kms");
  return {
    addon: { installed: st.installed, note: st.note, version: st.installed ? connectorVersion("kms") : null },
    kinds: DESTINATION_KINDS,
    destinations: listVaultDestinations().map((d) => {
      const last = lastAutoBackup.get(d.id);
      return last ? { ...d, lastAutoBackup: last } : { ...d };
    }),
  };
}
