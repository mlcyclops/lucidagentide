// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/vault_dest_card.ts
//
// P-VAULT-DEST.1 (ADR-0478): the Settings section "Vault destinations (Enterprise)", pure builders only (no
// DOM, no fetch) so every state is unit-testable. vault_dest_ui.ts hydrates and wires it. The section is
// collapsed by default and shows names, kinds, dates and outcomes only: the engine never sends a secret
// value here, and the client secret of an app registration is PICKED from the vault (a ref), never typed.
//
// Without the enterprise add-on the section says so and offers nothing that would pretend to work (a
// destination saved earlier can still be removed, which needs no connector).

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

export const VAULT_DEST_SEC = "vaultDest";
export const VAULT_DEST_TITLE = "Vault destinations (Enterprise)";
export const VAULT_DEST_SUB = "Azure Key Vault \u00b7 backup \u00b7 restore";

/** The engine's GET /api/vault/destinations data (vault_destinations.ts DestinationsView), mirrored here so
 *  the renderer never imports engine modules. */
export interface DestAutoBackup { at: number; ok: boolean; pushed: number; detail: string }
export interface DestRow {
  id: string;
  name: string;
  kind: string;
  config: Record<string, string>;
  autoBackup?: boolean;
  addedAt: number;
  lastAutoBackup?: DestAutoBackup;
}
export interface DestinationsData {
  addon: { installed: boolean; note: string; version: string | null };
  kinds: readonly string[];
  destinations: DestRow[];
}
/** One vault entry the client-secret picker may offer (GET /api/vault/list metadata). */
export interface VaultRefOption { ref: string; label: string; kind: string }

const KIND_LABEL: Record<string, string> = {
  "azure-kv": "Azure Key Vault", "aws-sm": "AWS Secrets Manager", "gcp-sm": "Google Secret Manager", "hashicorp-vault": "HashiCorp Vault",
};
const CLOUD_LABEL: Record<string, string> = { public: "Azure public cloud", usgov: "Azure Government" };
const AUTH_LABEL: Record<string, string> = {
  "azure-cli": "Azure CLI sign-in (az login)", "managed-identity": "Managed identity", "client-secret": "App registration + client secret",
};

const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function cardShell(open: boolean, body: string): string {
  return `<div class="set-sec set-coll${open ? " open" : ""}" data-sec="${VAULT_DEST_SEC}">
    <button class="set-coll-h" data-setcard="${VAULT_DEST_SEC}"><span class="set-lbl">${esc(VAULT_DEST_TITLE)} <span class="set-sub">${esc(VAULT_DEST_SUB)}</span></span><span class="set-coll-chev">${icon("chevron", 15)}</span></button>
    <div class="set-coll-body">${body}</div></div>`;
}

/** The one-line summary under a destination's name. */
export function destSummary(d: DestRow): string {
  const c = d.config;
  const parts = d.kind === "azure-kv"
    ? [c.vaultName ?? "", CLOUD_LABEL[c.cloud ?? ""] ?? c.cloud ?? "", AUTH_LABEL[c.auth ?? ""] ?? c.auth ?? ""]
    : Object.entries(c).map(([k, v]) => `${k} ${v}`);
  return [...parts.filter(Boolean), `added ${when(d.addedAt)}`].join(" \u00b7 ");
}

/** The auto-backup status line for a destination, or "" when it is off and never ran. */
export function autoBackupLine(d: DestRow): string {
  const last = d.lastAutoBackup;
  if (!last) return d.autoBackup ? "Auto-backup on: new and rotated secrets are pushed right after they are saved." : "";
  return last.ok
    ? `Last auto-backup ${when(last.at)}: ${last.pushed} pushed.`
    : `Last auto-backup ${when(last.at)} failed: ${last.detail}`;
}

function destRowHtml(d: DestRow, installed: boolean): string {
  const auto = autoBackupLine(d);
  const failed = d.lastAutoBackup && !d.lastAutoBackup.ok;
  const actions = installed
    ? `<button class="btn-mini" data-vd-check title="Check sign-in and that the destination is reachable">Test</button>
       <button class="btn-mini" data-vd-list title="See which LUCID entries the destination holds (names and dates only)">Contents</button>
       <button class="btn-mini" data-vd-push title="Push every entry in this machine's vault to the destination">Push all now</button>
       <button class="btn-mini" data-vd-pull title="Bring entries this machine lacks, or holds older copies of, into the vault (newer wins)">Pull to this machine</button>
       <button class="btn-mini" data-vd-edit title="Edit this destination">Edit</button>`
    : "";
  return `<div class="lp-row-wrap" data-vd-id="${esc(d.id)}">
    <div class="lp-row">
      <div class="lp-meta">
        <div class="lp-name"><span class="vd-ttl">${esc(d.name)}</span><span class="lp-pill ok">${esc(KIND_LABEL[d.kind] ?? d.kind)}</span></div>
        <div class="lp-sub">${esc(destSummary(d))}</div>
      </div>
      <button class="btn-mini danger" data-vd-remove title="Remove this destination from LUCID (nothing is deleted at the destination)">${icon("close", 12)}</button>
    </div>
    ${installed ? `<div class="vd-actions">${actions}</div>
    <label class="lp-ext vd-auto"><input type="checkbox" data-vd-auto ${d.autoBackup ? "checked" : ""}/> <span>Auto-backup new secrets to this destination</span></label>` : ""}
    ${auto ? `<div class="lp-sub vd-last${failed ? " vd-bad" : ""}" title="${esc(auto)}">${esc(auto)}</div>` : ""}
    <div class="set-note vd-result" data-vd-result hidden><span></span></div>
  </div>`;
}

function selectHtml(id: string, options: Record<string, string>, selected: string): string {
  return `<select class="prov-key" id="${id}">${Object.entries(options).map(([v, l]) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
}

/** The add / edit form (azure-kv, the one kind the add-on implements today). Edits are filled in by
 *  vault_dest_ui.ts from the row's stored config. */
export function destFormHtml(refs: readonly VaultRefOption[]): string {
  const refOpts = refs.length
    ? `<option value="">Pick the vault entry holding the client secret</option>${refs.map((r) => `<option value="${esc(r.ref)}">${esc(r.label && r.label !== r.ref ? `${r.label} (${r.ref})` : r.ref)}</option>`).join("")}`
    : `<option value="">The vault has no entries yet: add the client secret to the vault first</option>`;
  return `<div class="lp-add vd-add">
    <button class="lp-add-h" data-lp-addtoggle type="button">${icon("plus", 12)} <span data-vd-form-title>Add an Azure Key Vault destination</span><span class="lp-add-chev">${icon("chevron", 14)}</span></button>
    <div class="lp-add-body">
      <input type="hidden" id="vdId" value="" />
      <input class="prov-key" id="vdName" placeholder="Name (e.g. Team Key Vault)" maxlength="80" />
      <input class="prov-key" id="vdVault" placeholder="Key Vault name (e.g. contoso-lucid-kv)" maxlength="24" autocomplete="off" />
      <div class="lp-add-row">${selectHtml("vdCloud", CLOUD_LABEL, "public")}${selectHtml("vdAuth", AUTH_LABEL, "azure-cli")}</div>
      <input class="prov-key" id="vdTenant" placeholder="Tenant id or domain (optional for Azure CLI)" autocomplete="off" />
      <div class="vd-client" hidden>
        <input class="prov-key" id="vdClient" placeholder="Application (client) id" autocomplete="off" />
        <select class="prov-key" id="vdSecretRef">${refOpts}</select>
      </div>
      <label class="lp-ext"><input type="checkbox" id="vdAutoNew" /> <span>Auto-backup new secrets to this destination</span></label>
      <div class="lp-add-actions">
        <button class="btn-mini ok" data-vd-save>${icon("check", 12)} Save destination</button>
        <button class="btn-mini" data-vd-cancel hidden>Cancel edit</button>
      </div>
      <div class="set-note"><span>Destination settings hold no secret. With an app registration, the client secret stays in this machine's vault and is handed to the connector only for the call. AWS Secrets Manager, Google Secret Manager and HashiCorp Vault destinations are not available in this add-on version yet.</span></div>
    </div>
  </div>`;
}

/** The whole section. `data` null = the engine did not answer (`error` says why). */
export function vaultDestCardHtml(data: DestinationsData | null, refs: readonly VaultRefOption[], open: boolean, error = ""): string {
  if (!data) return cardShell(open, `<div class="set-note warn">${icon("info", 12)}<span>Couldn't read the vault destinations${error ? `: ${esc(error)}` : "."}</span></div>`);
  const rows = data.destinations.map((d) => destRowHtml(d, data.addon.installed)).join("");
  if (!data.addon.installed) {
    const stale = data.destinations.length
      ? `<div class="set-note">${icon("info", 12)}<span>${data.destinations.length} destination${data.destinations.length === 1 ? " was" : "s were"} saved while the add-on was installed. ${data.destinations.length === 1 ? "It does" : "They do"} nothing until the add-on is back; you can remove ${data.destinations.length === 1 ? "it" : "them"}.</span></div><div class="lp-list">${rows}</div>`
      : "";
    return cardShell(open, `<div class="set-note warn" data-vd-state="not-installed">${icon("shield", 12)}<span>Enterprise add-on not installed. Vault destinations back up this machine's LUCID vault to your organization's own secrets manager (Azure Key Vault, public or Government cloud) and restore from it. They are part of the LUCID enterprise add-on.</span></div>
      <div class="set-note">${icon("info", 12)}<span>${esc(data.addon.note)}</span></div>${stale}`);
  }
  const version = data.addon.version ? ` (kms connector ${esc(data.addon.version)})` : "";
  const list = rows
    ? `<div class="lp-list">${rows}</div>`
    : `<div class="set-note">${icon("info", 12)}<span>No destinations yet. Add your Key Vault below, then Test it before the first push.</span></div>`;
  return cardShell(open, `<div class="set-note ok" data-vd-state="installed">${icon("shield", 12)}<span>Enterprise add-on installed${version}. Secrets go from this machine's vault to your secrets manager through the add-on, named <code>lucid-&lt;ref&gt;</code> and tagged with the ref, kind and date added.</span></div>
    ${list}${destFormHtml(refs)}`);
}
