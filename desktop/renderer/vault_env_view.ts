// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/vault_env_view.ts
//
// P-VAULT-ENV.1 (ADR-0477): the pure markup of the Settings "Import from .env" card (vault_env_panel.ts
// wires it). Built from what /api/vault/env/scan returns: names, slots, last-4 and status, never a value.
// The follow-ups (blank the file, add it to .gitignore) are unchecked by default, and "write .env
// temporarily" sits in its own collapsed block, never the default path.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

// The wire shapes of vault_env_import.ts (EnvScan / EnvImportResult). Restated here because that module
// is Bun-only and the renderer is type-checked under the Node/DOM config.
export interface EnvScanRow {
  name: string; line: number; slot: "git-host" | "provider-key" | "workspace"; ref: string; envName: string; kind: string;
  host?: string; last4?: string; status: "new" | "same" | "replaces"; blocked?: string;
}
export interface EnvScan {
  workspace: string; file: string; exists: boolean; rows: EnvScanRow[]; problems: Array<{ line: number; reason: string }>;
  isGit: boolean; ignored: boolean; committed: boolean | null;
}
export interface EnvImportResult {
  imported: Array<{ name: string; ref: string; slot: EnvScanRow["slot"]; envName: string }>;
  skipped: Array<{ name: string; reason: string }>;
  blanked: boolean; gitignored: boolean; committed: boolean | null;
}

/** The Settings card name (`data-sec`). */
export const VAULT_ENV_SEC = "vaultEnv";

const SLOT_LABEL: Record<EnvScanRow["slot"], string> = { "git-host": "git token", "provider-key": "provider key", workspace: "this workspace" };
const STATUS_BADGE: Record<EnvScanRow["status"], { text: string; tone: string }> = {
  new: { text: "new", tone: "ok" },
  same: { text: "already stored", tone: "none" },
  replaces: { text: "replaces stored", tone: "warn" },
};

/** Default selection (and what the one-time offer counts): importable rows not already stored as is. */
export const preselected = (r: EnvScanRow): boolean => !r.blocked && r.status !== "same";

/** The static card body: what import does, and the Scan button. */
export function vaultEnvBodyHtml(): string {
  return `<div class="set-note">${icon("shield", 12)} Move the secrets in this workspace's <b>.env</b> file into the encrypted vault. Git tokens (GITHUB_TOKEN, GH_TOKEN, GITLAB_TOKEN, AZURE_DEVOPS_EXT_PAT) fill the per-host git slots, provider keys fill their provider, and everything else becomes a secret of this workspace that agent sessions here receive as environment variables. Only names and the last 4 characters are ever shown.</div>
    <div class="prov-row"><button class="btn-mini" data-venv="scan">${icon("refresh", 12)} Scan .env</button></div>
    <div data-venv-out></div>`;
}

/** The scan result: one row per name, the opt-in follow-ups, and the temporary-write block. */
export function vaultEnvScanHtml(scan: EnvScan): string {
  const file = esc(scan.file);
  if (!scan.exists) return `<div class="empty">No ${file} file in this workspace.</div>`;
  const problems = scan.problems.length
    ? `<div class="set-note">${icon("info", 12)} ${scan.problems.length} line${scan.problems.length === 1 ? "" : "s"} could not be read (line ${scan.problems.map((p) => p.line).join(", ")}); fix them in the file to import them.</div>`
    : "";
  if (!scan.rows.length) return `${problems}<div class="empty">${file} has no NAME=value entries.</div>`;
  const rows = scan.rows.map((r) => {
    const st = STATUS_BADGE[r.status];
    const slot = r.slot === "git-host" ? `git token · ${esc(r.host ?? "")}` : SLOT_LABEL[r.slot];
    const state = r.blocked ? `<span class="abadge none">${esc(r.blocked)}</span>` : `<span class="abadge ${st.tone}">${st.text}</span>`;
    return `<div class="prov"><div class="prov-h">
      <label class="set-toggle"><input type="checkbox" data-venv-name="${esc(r.name)}"${preselected(r) ? " checked" : ""}${r.blocked ? " disabled" : ""} /><span class="prov-name">${esc(r.name)}</span></label>
      <span class="prov-status"><span class="abadge set">${slot}</span>${r.last4 ? `<span class="abadge set">••••${esc(r.last4)}</span>` : ""}${state}</span>
    </div></div>`;
  }).join("");
  const committed = scan.committed
    ? `<div class="set-note" data-venv-rotate><span class="abadge danger">rotate</span> ${file} is in this repository's git history. Removing it now does not remove it from history: after importing, rotate these secrets at their provider.</div>`
    : "";
  const ignore = scan.ignored
    ? `<div class="set-note">${icon("check", 12)} ${file} is already git-ignored.</div>`
    : `<label class="set-toggle"><input type="checkbox" data-venv-opt="gitignore" /><span>Add ${file} to .gitignore</span></label>`;
  return `${problems}${committed}${rows}
    <label class="set-toggle"><input type="checkbox" data-venv-opt="blank" /><span>Afterwards, blank the imported values in ${file} (keeps NAME= placeholders)</span></label>
    ${ignore}
    <div class="prov-row"><button class="btn-mini ok" data-venv="import">${icon("check", 12)} Import selected</button></div>
    <details class="wl-auth">
      <summary>Write ${file} temporarily (for a tool that only reads the file)</summary>
      <div class="set-note">${icon("info", 12)} Writes this workspace's own secrets back into ${file} for a limited time, then blanks them again (also when the engine exits). Requires ${file} to be git-ignored. Agent sessions do not need this: they already receive the secrets as environment variables.</div>
      <div class="prov-row">
        <select class="prov-key" data-venv-minutes><option value="5">5 minutes</option><option value="15" selected>15 minutes</option><option value="60">1 hour</option></select>
        <button class="btn-mini" data-venv="materialize">${icon("download", 12)} Write now</button>
        <button class="btn-mini danger" data-venv="unmaterialize">${icon("close", 12)} Blank now</button>
      </div>
    </details>`;
}

/** The toast text for an import, by counts and names only. */
export function importSummary(r: EnvImportResult): { title: string; desc: string } {
  const n = r.imported.length;
  const parts = [`${n} secret${n === 1 ? "" : "s"} moved into the vault${n ? `: ${r.imported.map((i) => i.name).join(", ")}` : ""}.`];
  if (r.skipped.length) parts.push(`Skipped ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}.`);
  if (r.blanked) parts.push("The file now keeps NAME= placeholders only.");
  if (r.gitignored) parts.push("Added to .gitignore.");
  if (n) parts.push("New agent sessions in this workspace receive them; restart a running one to pick them up now.");
  return { title: n ? "Imported from .env" : "Nothing imported", desc: parts.join(" ") };
}
