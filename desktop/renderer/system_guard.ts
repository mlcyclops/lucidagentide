// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/system_guard.ts — P-SYSRES.1 (ADR-0182): the resource-guard notice + panel (pure).
//
// Pure builders only (no DOM, no fetch) - app.ts owns wiring, exactly like marketplace.ts/about.ts.
// This module OWNS the view types (bridge.ts imports FROM here): renderer modules that harness/desktop
// demo scripts import must never import bridge.ts (the DOM-types layering rule, see trivia_news.ts).
//
// The card renders inside the KG canvas when the verdict is "blocked": it says WHY (the verdict's
// reason lines), shows the machine line, and offers two actions - open the resource panel (what to
// close) and re-check. Every machine/process string is esc()'d: process names and CPU models are
// external text, rendered strictly as data.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

// ── view types (mirrors desktop/system_profile.ts shapes; bridge.ts imports these) ──

export type SystemLevelView = "ok" | "strained" | "blocked";

export interface SystemStatusView {
  snap: {
    cpuModel: string;
    cores: number;
    speedMHz: number;
    cpuBusyPct: number | null;
    memTotalMB: number;
    memFreeMB: number;
  };
  verdict: { level: SystemLevelView; weakCpu: boolean; reasons: string[] };
  procs: { name: string; count: number; memMB: number; cpuSec: number | null }[];
}

/** Shape gate for the /api/system payload. Fail-open by design: a malformed payload reads as null
 *  and the caller treats null as "no evidence → don't block" (this is a UX guard, not the scan gate). */
export function isSystemStatus(v: unknown): v is SystemStatusView {
  const o = v as SystemStatusView | null;
  return !!o && !!o.snap && typeof o.snap.cores === "number" && typeof o.snap.memTotalMB === "number"
    && !!o.verdict && ["ok", "strained", "blocked"].includes(o.verdict.level) && Array.isArray(o.verdict.reasons)
    && Array.isArray(o.procs);
}

/** 1536 → "1.5 GB" (renderer copy of system_profile.fmtMB - kept local so this module stays
 *  importable without pulling desktop/ node code into the renderer graph). */
export function fmtMemMB(mb: number): string {
  if (mb >= 1024) { const g = mb / 1024; return `${g >= 10 ? Math.round(g) : Math.round(g * 10) / 10} GB`; }
  return `${Math.max(0, Math.round(mb))} MB`;
}

/** "Intel i5-7200U · 4 cores @ 2.5 GHz · 2.1 GB of 8 GB free · CPU 92%" (unknown parts drop out). */
export function machineLine(s: SystemStatusView["snap"]): string {
  const parts: string[] = [];
  if (s.cpuModel) parts.push(s.cpuModel.replace(/\s+/g, " ").trim());
  if (s.cores > 0) parts.push(`${s.cores} cores${s.speedMHz > 0 ? ` @ ${(s.speedMHz / 1000).toFixed(1)} GHz` : ""}`);
  if (s.memTotalMB > 0) parts.push(`${fmtMemMB(s.memFreeMB)} of ${fmtMemMB(s.memTotalMB)} free`);
  if (s.cpuBusyPct !== null) parts.push(`CPU ${s.cpuBusyPct}%`);
  return parts.join(" · ");
}

/** The in-canvas blocked card. `feature` names what got paused ("knowledge graph" / "code graph"). */
export function guardBlockedHtml(status: SystemStatusView, feature: string): string {
  const why = status.verdict.reasons.length
    ? `<ul class="sysres-why">${status.verdict.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
    : "";
  return `<div class="kg-empty kg-paused sysres-blocked">${icon("gauge", 30)}
    <div><b>The ${esc(feature)} is paused - your system is under heavy load.</b><br/>
    Building it now would spike an already-strained machine. Free up resources by closing heavy
    applications, then re-check. The agent keeps full access to your data - only this build is waiting.</div>
    ${why}
    <div class="sysres-machine">${esc(machineLine(status.snap))}</div>
    <div class="sysres-actions">
      <button class="btn-mini" data-sys-panel>Show what's using resources</button>
      <button class="btn-mini" data-sys-recheck>Re-check</button>
    </div></div>`;
}

function procRow(p: SystemStatusView["procs"][number]): string {
  return `<div class="sysres-row">
    <span class="sysres-name">${esc(p.name)}${p.count > 1 ? `<span class="sysres-count">×${p.count}</span>` : ""}</span>
    <span class="sysres-mem">${esc(fmtMemMB(p.memMB))}</span>
    <span class="sysres-cpu">${p.cpuSec !== null ? esc(`${p.cpuSec}s CPU`) : ""}</span>
  </div>`;
}

/** Just the panel body (machine line + verdict + rows) - re-rendered in place on Refresh. */
export function resourcePanelBodyHtml(status: SystemStatusView): string {
  const v = status.verdict;
  const chip = v.level === "blocked" ? `<span class="sysres-chip sysres-bad">Heavy features paused</span>`
    : v.level === "strained" ? `<span class="sysres-chip sysres-warn">Strained</span>`
    : `<span class="sysres-chip sysres-ok">Healthy</span>`;
  const rows = status.procs.length
    ? status.procs.map(procRow).join("")
    : `<div class="sysres-empty">Couldn't read the process list on this platform.</div>`;
  return `<div class="sysres-machine">${esc(machineLine(status.snap))} ${chip}</div>
    ${v.reasons.length ? `<ul class="sysres-why">${v.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    <div class="sysres-head"><span>Top processes by memory</span><span>RAM</span><span>CPU time</span></div>
    <div class="sysres-list">${rows}</div>
    <div class="sysres-foot">Close what you don't need, then Refresh. LUCID re-checks before every heavy build.</div>`;
}

/** The whole modal (About/Marketplace scrim conventions; app.ts wires close/refresh). */
export function resourcePanelHtml(status: SystemStatusView): string {
  return `<div class="sysres-modal" role="dialog" aria-label="System resources">
    <div class="sysres-h">${icon("gauge", 18)}<span>System resources</span>
      <button class="btn-mini" data-sys-refresh>Refresh</button>
      <button class="mkt-close" data-sys-close title="Close">${icon("close", 14)}</button></div>
    <div id="sysresBody">${resourcePanelBodyHtml(status)}</div>
  </div>`;
}
