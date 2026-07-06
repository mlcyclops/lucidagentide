// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/skills_dir.ts — P-SKILL.4 (ADR-0097): the Skills directory + inspect PURE builders.
//
// The sandbox_panel.ts / model_favorites.ts convention: rows in → HTML out, no DOM, no I/O, so the
// grouping, trust badges, locked-flagged rows, and escaping are unit-tested directly. app.ts composes
// the rows (bundled INSTALLED_SKILLS + the discovered /api/skills list, each resolved to enabled/trust),
// then hands them here; the click wiring + fetches stay in app.ts.
//
// SECURITY (CLAUDE.md invariant #5, keystone #2): a skill body is UNTRUSTED DATA. Inspect renders it
// escaped inside an explicit "shown as data, not instructions" frame — it is never executed and never
// promoted to instructions. A `suspicious`/`quarantined` row is shown but its enable toggle is LOCKED
// (trustEnableable is false), so a flagged skill can never be turned into active guidance from the UI.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import type { SkillCandidateView, SkillInspectView } from "./bridge.ts";
import type { TrustLabel } from "../../harness/contracts.ts";
import { readinessChecklist, ROOT_LABEL, ROOT_ORDER, type SkillRoot, trustEnableable } from "../skills_gov.ts";

/** One composed directory row (bundled or discovered), fully resolved by app.ts before rendering. */
export interface SkillDirRow {
  key: string;
  name: string;
  description: string;
  root: SkillRoot;
  trust: TrustLabel;
  invocation: string;
  removable: boolean;
  enabled: boolean;
  /** Whether the trust level permits enabling at all (false ⇒ flagged ⇒ toggle is locked off). */
  enableable: boolean;
  /** True for on-disk skills (inspect/rescan/remove target the server); false for the inline bundled corpus. */
  fileBacked: boolean;
  scanned?: { findings: number; at: string } | null;
}

const TRUST_TIP: Record<TrustLabel, string> = {
  trusted: "Reviewed / scanned clean — safe to enable.",
  untrusted: "Not yet scanned. Loads today (status quo); re-scan to certify it clean.",
  suspicious: "Scan found sub-threshold findings — enabling is LOCKED until it re-scans clean.",
  quarantined: "Scan flagged this (or the scanner was unavailable) — enabling is LOCKED (fail-closed).",
};

/** The trust pill for a row. */
function trustPill(trust: TrustLabel): string {
  return `<span class="skdir-trust ${trust}" title="${esc(TRUST_TIP[trust])}">${trust}</span>`;
}

/** The per-row action buttons. Inspect is always available; re-scan only for on-disk skills; remove
 *  only for removable roots; the enable toggle is a locked pill when the trust forbids enabling. */
function rowActions(r: SkillDirRow): string {
  const btns: string[] = [];
  if (r.enableable) {
    btns.push(
      `<button class="skdir-btn skdir-toggle ${r.enabled ? "on" : "off"}" data-skill-act="toggle" data-skill-key="${esc(r.key)}" data-skill-trust="${r.trust}" title="${r.enabled ? "Disable — stop offering + loading this skill" : "Enable — offer + load this skill"}">${r.enabled ? "On" : "Off"}</button>`,
    );
  } else {
    btns.push(`<span class="skdir-locked" title="${esc(TRUST_TIP[r.trust])}">${icon("shield", 12)} locked</span>`);
  }
  btns.push(`<button class="skdir-btn" data-skill-act="inspect" data-skill-name="${esc(r.name)}" data-skill-root="${r.root}" title="Inspect the skill body + bundled resources (as data)">${icon("eye", 12)}</button>`);
  if (r.fileBacked) btns.push(`<button class="skdir-btn" data-skill-act="rescan" data-skill-name="${esc(r.name)}" title="Re-scan through the fail-closed security gate">${icon("scan", 12)}</button>`);
  if (r.removable) btns.push(`<button class="skdir-btn danger" data-skill-act="remove" data-skill-name="${esc(r.name)}" title="Remove this skill (deletes its folder)">${icon("trash", 12)}</button>`);
  return `<div class="skdir-acts">${btns.join("")}</div>`;
}

/** One directory row. */
function row(r: SkillDirRow): string {
  const findings = r.scanned && r.scanned.findings > 0 ? ` · <span class="skdir-findings">${r.scanned.findings} finding${r.scanned.findings === 1 ? "" : "s"}</span>` : "";
  const ready = readinessChecklist({ name: r.name, description: r.description, trust: r.trust });
  const readyOk = ready.filter((i) => i.ok).length;
  const readyTip = ready.map((i) => `${i.ok ? "✓" : "✗"} ${i.label}`).join("\n");
  return `<div class="skdir-row ${r.enabled ? "" : "disabled"}" data-skill-key="${esc(r.key)}">
    <div class="skdir-main">
      <div class="skdir-hd"><b class="skdir-name">${esc(r.name)}</b> ${trustPill(r.trust)}
        <code class="skdir-inv">${esc(r.invocation)}</code>
        <span class="skdir-ready" title="Deployment readiness (advisory)\n${esc(readyTip)}">${readyOk}/${ready.length}</span>${findings}</div>
      <div class="skdir-desc">${esc(r.description || "—")}</div>
    </div>
    ${rowActions(r)}
  </div>`;
}

/**
 * The full directory: a one-line token-cost note, then rows grouped by source root (ROOT_ORDER), each
 * group headed by its label + count. Empty groups are omitted. PURE.
 */
export function renderSkillsDirectory(rows: SkillDirRow[]): string {
  const total = rows.length;
  const active = rows.filter((r) => r.enabled).length;
  const note = `<div class="skdir-note">${icon("info", 12)} Skills cost only a few metadata tokens until a task triggers them — the full body + resources load on invocation. <b>${active}</b> of <b>${total}</b> enabled.</div>`;

  const groups = ROOT_ORDER.map((root) => {
    const inRoot = rows.filter((r) => r.root === root);
    if (!inRoot.length) return "";
    return `<div class="skdir-group"><div class="skdir-group-hd">${esc(ROOT_LABEL[root])} <span class="skdir-count">${inRoot.length}</span></div>${inRoot.map(row).join("")}</div>`;
  }).join("");

  return note + (groups || `<div class="skdir-empty">No skills discovered.</div>`);
}

/**
 * The inspect view for one skill. The body is UNTRUSTED DATA: escaped, framed with an explicit
 * "treated as data, never instructions" banner (invariant #5). Resources + provenance + the readiness
 * checklist (body-aware) round it out. PURE.
 */
export function renderSkillInspect(v: SkillInspectView): string {
  if (!v.ok) return `<div class="skdir-empty">${icon("info", 13)} Could not inspect “${esc(v.name)}”: ${esc(v.reason ?? "unavailable")}.</div>`;
  const trust = (v.trust ?? "untrusted") as TrustLabel;
  const prov = v.provenance ? `<div class="skdir-prov">${icon("info", 12)} ${esc(v.provenance)}</div>` : "";
  const enableNote = trustEnableable(trust) ? "" : `<div class="skdir-locknote">${icon("shield", 12)} ${esc(TRUST_TIP[trust])}</div>`;

  const ready = readinessChecklist({ name: v.name, description: "", trust, body: v.body });
  const readyRows = ready.map((i) => `<li class="${i.ok ? "ok" : "no"}">${icon(i.ok ? "check" : "close", 11)} ${esc(i.label)}</li>`).join("");

  const resources = (v.resources ?? []).map((res) =>
    `<div class="skdir-res"><b>${esc(res.dir)}/</b> ${res.files.map((f) => `<code>${esc(f)}</code>`).join(" ")}</div>`,
  ).join("") || `<div class="skdir-muted">No bundled resources.</div>`;

  return `<div class="skdir-inspect">
    <div class="skdir-inspect-hd"><b>${esc(v.name)}</b> ${trustPill(trust)} <span class="skdir-inspect-root">${esc(v.root ? ROOT_LABEL[v.root] : "")}</span></div>
    ${prov}${enableNote}
    <ul class="skdir-ready-list">${readyRows}</ul>
    <div class="skdir-databanner">${icon("shield", 12)} Skill body — shown as <b>data</b>, never run as instructions.</div>
    <pre class="skdir-body">${esc(v.body ?? "")}</pre>
    <div class="skdir-res-hd">Bundled resources</div>${resources}
  </div>`;
}

/**
 * P-SKILL.5 (ADR-0101): one Skill Studio candidate card. The name/description/rationale + the editable
 * body are all UNTRUSTED MODEL OUTPUT, so every field is escaped (the body sits in a <textarea>, itself
 * escaped). The user edits the body here and hits Codify, which runs it through the fail-closed gate. PURE.
 */
export function renderStudioCandidate(c: SkillCandidateView): string {
  return `<div class="sk-cand" data-cand-name="${esc(c.name)}" data-cand-desc="${esc(c.description)}">
    <div class="sk-cand-hd"><b class="sk-cand-name">${esc(c.name)}</b>
      <button class="skdir-btn sk-cand-codify" data-sk-codify title="Scan through the security gate + save this skill">${icon("check", 12)} Codify</button></div>
    <div class="sk-cand-desc">${esc(c.description)}</div>
    ${c.rationale ? `<div class="sk-cand-rat">${icon("info", 11)} ${esc(c.rationale)}</div>` : ""}
    <textarea class="sk-cand-body" spellcheck="false">${esc(c.body)}</textarea>
  </div>`;
}
