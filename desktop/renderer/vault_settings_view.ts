// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/vault_settings_view.ts - P-VAULT-UI.1 (ADR-0475): the Settings "Credential vault"
// section, pure builders (no DOM, no fetch) so the markup and the labels are unit-testable. The wiring
// (fetch, popovers, toasts, file save/pick) lives in vault_settings.ts.
//
// What a row may show: label, ref, kind, where it is used, last-4, added/updated dates and source. Never a
// value: the engine's /api/vault/list never sends one, and these builders read only the named metadata
// fields, so a stray field on an entry is never rendered either.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

/** The metadata /api/vault/list returns per entry (mirror of desktop/engine_vault.ts VaultEntryMeta). */
export interface VaultMetaView {
  ref: string;
  label: string;
  kind: string;
  source: string;
  scope?: { workspace?: string };
  envName?: string;
  addedAt: number;
  updatedAt: number;
  rotatedAt?: number;
  expiresAt?: number;
  rotationIntervalDays?: number;
  last4?: string;
}
/** /api/vault/list `status` (custody, crypto module, entry count). */
export interface VaultStatusView {
  state: string;
  custody?: string;
  entries: number;
  crypto?: { module: string; fips: boolean; detail?: string };
}
export interface VaultListView { status: VaultStatusView; entries: VaultMetaView[] }

export const VAULT_SEC = "vault";

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  typed: "Typed",
  "migrated-settings": "Migrated (settings)",
  "migrated-safestorage": "Migrated (OS vault)",
  "env-import": ".env import",
  "agent-request": "Agent request",
  restore: "Restore",
  "destination-pull": "Destination pull",
  "migrated-agentdb": "Migrated (omp agent.db)",
  "oauth-login": "Sign-in",
};
export const sourceLabel = (s: string): string => SOURCE_LABEL[s] ?? s;

const KIND_LABEL: Readonly<Record<string, string>> = {
  apikey: "API key", token: "Token", bearer: "Bearer", pat: "PAT", oauth: "OAuth", password: "Password", basic: "User / pass",
  pem: "PEM", jwt: "JWT", saml: "SAML", json: "JSON", other: "Other",
};
export const kindLabel = (k: string): string => KIND_LABEL[k] ?? k;

/** The last path segment of a workspace folder (either separator). */
const folderName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** Where an entry is used, from its ref convention (vault_store.ts) and metadata: provider key, git host,
 *  MCP server, workspace, and the legacy credential names. */
export function whereUsed(m: VaultMetaView): string {
  const r = m.ref;
  if (r.startsWith("ws:")) {
    const env = m.envName ?? r.split(":").slice(2).join(":");
    return `Workspace ${m.scope?.workspace ? folderName(m.scope.workspace) : "(unknown folder)"} \u00b7 ${env}`;
  }
  if (r.startsWith("key:")) return `Provider key \u00b7 ${r.slice(4)}`;
  if (r.startsWith("mcp:")) return `MCP server \u00b7 ${r.slice(4)}`;
  if (r.startsWith("account:")) return `Account \u00b7 ${r.slice(8)}`;
  if (r.startsWith("oauth:")) return `OAuth \u00b7 ${r.split(":")[1] ?? ""}`;
  if (r.startsWith("kg:dek:")) return "Knowledge graph encryption";
  if (r === "turn:credential") return "Agent turn credential";
  if (r === "git_pat") return "Git \u00b7 all hosts";
  if (r.startsWith("git_pat_")) return `Git host \u00b7 ${r.slice(8)}`;
  if (r === "figma_pat") return "Figma";
  if (r === "meeting_hub_token") return "Meeting Hub";
  if (r.startsWith("lpkey_")) return `Local provider \u00b7 ${r.slice(6)}`;
  if (m.envName) return `Environment \u00b7 ${m.envName}`;
  return "Stored credential";
}

/** A short local date, or a dash for a missing/invalid timestamp. */
export function shortDate(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "\u2013";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Passphrase strength hint for a backup (0 weak .. 4 strong). Length dominates; character variety helps.
 *  A hint only: the engine enforces the minimum length (vault_backup.ts BACKUP_MIN_PASSPHRASE). */
export function passphraseStrength(p: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  const n = [...p].length;
  if (n < 10) return { score: 0, label: n ? "Too short (10+ characters)" : "" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  const words = p.trim().split(/\s+/).length;
  let score = n >= 20 ? 3 : n >= 14 ? 2 : 1;
  if (classes >= 3 || words >= 4) score += 1;
  if (/^(.)\1+$/.test(p)) score = 1;
  const s = Math.min(4, score) as 1 | 2 | 3 | 4;
  return { score: s, label: (["", "Weak", "Fair", "Good", "Strong"] as const)[s] };
}

function row(m: VaultMetaView): string {
  const ref = esc(m.ref);
  const label = esc(m.label || m.ref);
  const last4 = m.last4 ? `<span class="abadge set" data-tip="Last 4|Only the last four characters are ever shown.">\u2022\u2022\u2022\u2022${esc(m.last4)}</span>` : "";
  const dates = `Added ${esc(shortDate(m.addedAt))} \u00b7 Updated ${esc(shortDate(m.updatedAt))}`;
  return `<div class="prov vault-row" data-vault-ref="${ref}">
      <div class="prov-h"><span class="prov-name vault-name" title="${label}">${label}</span>
        <span class="prov-status"><span class="abadge ok">${esc(kindLabel(m.kind))}</span>${last4}<span class="abadge set">${esc(sourceLabel(m.source))}</span></span></div>
      <div class="vault-line vault-ref" title="${ref}">${ref}</div>
      <div class="vault-line">${esc(whereUsed(m))}</div>
      <div class="vault-line">${dates}</div>
      <div class="prov-row">
        ${m.ref.startsWith("oauth:") ? "" /* P-VAULT-KEYS.2: a sign-in is renewed by signing in again, never by typing a value */ : `<button class="btn-mini" data-vault-rotate="${ref}" data-tip="Rotate|Replace the stored value in place. The reference stays the same, so everything using it keeps working.">${icon("refresh", 12)} Rotate</button>`}
        <button class="btn-mini danger" data-vault-remove="${ref}" data-tip="Remove|Delete this secret from the vault. Anything that uses it stops working until it is entered again.">${icon("close", 12)} Remove</button>
      </div></div>`;
}

const CUSTODY_LABEL: Readonly<Record<string, string>> = {
  dpapi: "Windows DPAPI", keychain: "the macOS Keychain", libsecret: "the Linux Secret Service", "plaintext-file": "a local key file",
};

function statusNote(s: VaultStatusView | undefined): string {
  if (!s) return "";
  if (s.state !== "ok") {
    return `<div class="set-note danger">${icon("shield", 12)} The vault is ${esc(s.state)} on this machine. Nothing is listed or changed until it is readable again.</div>`;
  }
  const mod = s.crypto ? `${esc(s.crypto.module)}${s.crypto.fips ? " (FIPS 140 validated)" : ""}` : "";
  const custody = esc(CUSTODY_LABEL[s.custody ?? ""] ?? s.custody ?? "the OS key store");
  return `<div class="set-note">${icon("shield", 12)} Sealed with AES-256-GCM under a key held by ${custody}${mod ? `; crypto module ${mod}` : ""}. Only names, kinds, dates and the last 4 characters are shown here; a value never leaves the engine.</div>`;
}

function backupForms(): string {
  return `<div class="prov vault-tools" style="border-style:dashed">
      <div class="prov-h"><span class="prov-name vault-name">${icon("download", 13)} Back up now</span></div>
      <div class="prov-body">
        <div class="prov-row"><input id="vaultBkPass" class="prov-key" type="password" autocomplete="new-password" placeholder="Backup passphrase (10+ characters)" /></div>
        <div class="prov-row"><input id="vaultBkPass2" class="prov-key" type="password" autocomplete="new-password" placeholder="Type the passphrase again" /></div>
        <div class="vault-line vault-strength" id="vaultBkStrength" data-score="0"></div>
        <div class="prov-row"><button class="btn-mini ok" data-vault-backup>${icon("download", 12)} Back up now</button></div>
        <div class="set-note">${icon("info", 12)} Makes an encrypted <b>.lucidvault</b> file (AES-256-GCM, key from your passphrase by PBKDF2-HMAC-SHA256, 600,000 rounds). Keep the passphrase somewhere safe: without it the file cannot be opened, and LUCID cannot recover it.</div>
      </div></div>
    <div class="prov vault-tools" style="border-style:dashed">
      <div class="prov-h"><span class="prov-name vault-name">${icon("refresh", 13)} Restore</span></div>
      <div class="prov-body">
        <input id="vaultRsFile" type="file" accept=".lucidvault,application/json" hidden />
        <div class="prov-row"><button class="btn-mini" data-vault-pick>${icon("folder", 12)} Choose file</button></div>
        <div class="vault-line" id="vaultRsName">No file chosen</div>
        <div class="prov-row"><input id="vaultRsPass" class="prov-key" type="password" autocomplete="off" placeholder="The backup's passphrase" /></div>
        <div class="prov-row"><button class="btn-mini ok" data-vault-restore>${icon("check", 12)} Restore</button></div>
        <div class="vault-line" id="vaultRsResult"></div>
        <div class="set-note">${icon("info", 12)} Newer wins: an entry missing here is added, one the backup holds a newer copy of is updated, anything else is kept as is. A wrong passphrase or an altered file restores nothing.</div>
      </div></div>`;
}

/** The section body: status, one row per entry (or the empty state, or the load error), backup + restore. */
export function vaultSectionBody(view: VaultListView | null, error?: string): string {
  if (!view) {
    return `<div class="set-note danger">${icon("shield", 12)} ${esc(error || "The vault could not be loaded.")}</div>`;
  }
  const rows = view.entries.length
    ? view.entries.map(row).join("")
    : `<div class="empty">No secrets in the vault yet. Keys you add under Providers, git tokens and credentials the agent asks for land here.</div>`;
  return `${statusNote(view.status)}<div class="vault-list">${rows}</div>${backupForms()}`;
}

/** The whole section, in the markup of app.ts setCard(..., collapsible = true): collapsed unless `open`
 *  (the caller keeps the user's open state), toggled by app.ts's shared `[data-setcard]` handler. */
export function vaultSectionHtml(view: VaultListView | null, open: boolean, error?: string): string {
  const n = view ? view.entries.length : 0;
  const sub = `${n} ${n === 1 ? "secret" : "secrets"} \u00b7 names only \u00b7 encrypted backup`;
  return `<div class="set-sec set-coll${open ? " open" : ""}" data-sec="${VAULT_SEC}">
    <button class="set-coll-h" data-setcard="${VAULT_SEC}"><span class="set-lbl">Credential vault <span class="set-sub">${esc(sub)}</span></span><span class="set-coll-chev">${icon("chevron", 15)}</span></button>
    <div class="set-coll-body">${vaultSectionBody(view, error)}</div></div>`;
}

/** Narrow the /api/vault/list payload; null when it is not the expected shape. */
export function parseVaultList(data: unknown): VaultListView | null {
  if (!data || typeof data !== "object" || !("entries" in data) || !("status" in data) || !Array.isArray(data.entries)) return null;
  const status = data.status;
  if (!status || typeof status !== "object" || !("state" in status) || typeof status.state !== "string") return null;
  const entries: VaultMetaView[] = [];
  for (const e of data.entries) {
    if (!e || typeof e !== "object" || !("ref" in e) || typeof e.ref !== "string") return null;
    const fields = new Map<string, unknown>(Object.entries(e));
    const str = (k: string): string | undefined => { const v = fields.get(k); return typeof v === "string" ? v : undefined; };
    const num = (k: string): number | undefined => { const v = fields.get(k); return typeof v === "number" && Number.isFinite(v) ? v : undefined; };
    const scope = fields.get("scope");
    const ws = scope && typeof scope === "object" && "workspace" in scope && typeof scope.workspace === "string" ? scope.workspace : undefined;
    entries.push({
      ref: e.ref, label: str("label") ?? e.ref, kind: str("kind") ?? "other", source: str("source") ?? "typed",
      envName: str("envName"), last4: str("last4"), addedAt: num("addedAt") ?? 0, updatedAt: num("updatedAt") ?? 0,
      rotatedAt: num("rotatedAt"), expiresAt: num("expiresAt"), rotationIntervalDays: num("rotationIntervalDays"),
      ...(ws ? { scope: { workspace: ws } } : {}),
    });
  }
  const crypto = "crypto" in status && status.crypto && typeof status.crypto === "object" && "module" in status.crypto && typeof status.crypto.module === "string"
    ? { module: status.crypto.module, fips: "fips" in status.crypto && status.crypto.fips === true }
    : undefined;
  return {
    status: {
      state: status.state,
      custody: "custody" in status && typeof status.custody === "string" ? status.custody : undefined,
      entries: "entries" in status && typeof status.entries === "number" ? status.entries : entries.length,
      ...(crypto ? { crypto } : {}),
    },
    entries,
  };
}
