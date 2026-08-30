// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_monitor.ts - CREATOR-0 (ADR-0283): the CPU/GPU pressure odometers + flyout.
//
// Pure builders only (no DOM, no fetch) - app.ts owns the wiring, exactly like system_guard.ts. This
// module OWNS its view types so it never imports bridge.ts (the DOM-types layering rule) and never
// imports desktop/creator_monitor.ts (node-side: child_process).
//
// The honesty rules are visual here, not just semantic:
//   * A null reading renders as an EMPTY dial with "no signal" - never a 0% dial, which would read as
//     "idle" to a human deciding whether to start a 40-minute render.
//   * A stale reading keeps its last value but loses its live pulse and says how old it is.
//   * Every device name, model string, and process name is external text and goes through esc().

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

// ── view types (mirror of desktop/creator_monitor.ts; bridge.ts imports these) ──

export interface CoreReadingView { id: number; busyPct: number | null }
export interface CpuTelemetryView { model: string; cores: number; speedMHz: number; busyPct: number | null; perCore: readonly CoreReadingView[] }
export interface MemTelemetryView { totalMB: number; freeMB: number; usedPct: number | null }
export interface GpuDeviceView {
  index: number; name: string; vendor: string; busyPct: number | null;
  memTotalMB: number | null; memUsedMB: number | null; memPct: number | null;
  tempC: number | null; powerW: number | null; powerCapW: number | null;
}
export interface GpuTelemetryView { available: boolean; source: string; devices: readonly GpuDeviceView[]; note: string }
export interface ProcGroupView { name: string; count: number; memMB: number; cpuSec: number | null }
export interface TargetTelemetryView {
  id: string; label: string; kind: "local" | "remote";
  sampledAt: number; ageMs: number; freshness: "fresh" | "stale" | "blind";
  cpu: CpuTelemetryView | null; mem: MemTelemetryView | null; gpu: GpuTelemetryView;
  procs: readonly ProcGroupView[]; error: string;
}
export interface CreatorSampleView { at: number; cpuPct: number | null; memPct: number | null; gpuPct: number | null; vramPct: number | null }
export interface CreatorAdmissionView {
  ok: boolean; reason: string;
  cpuPct: number | null; memPct: number | null; gpuPct: number | null; vramPct: number | null;
  cpuHotMs: number; memHotMs: number; gpuHotMs: number;
  pressurePct: number; sustainMs: number; gpuEvidenceMissing: boolean;
}
export interface CreatorResourcesView {
  targets: readonly TargetTelemetryView[];
  history: readonly CreatorSampleView[];
  admission: CreatorAdmissionView;
  policy: { pressurePct: number; warmPct: number; sustainMs: number };
}

/** Shape gate for /api/creator/resources. Fail-open: a malformed payload reads as null and the caller
 *  shows "no signal" rather than blocking anything (telemetry is never the security gate). */
export function isCreatorResources(v: unknown): v is CreatorResourcesView {
  const o = v as CreatorResourcesView | null;
  return !!o && Array.isArray(o.targets) && Array.isArray(o.history) && !!o.admission
    && typeof o.admission.ok === "boolean" && !!o.policy && typeof o.policy.pressurePct === "number";
}

// ── presentation helpers ─────────────────────────────────────────────────────

export type LoadBand = "unknown" | "cool" | "warm" | "hot";

/** The colour ramp: green under warm, amber to the pressure line, red at or above it. Null is its own
 *  band - it is NOT the bottom of the scale. */
export function loadBand(pct: number | null, warmPct = 70, hotPct = 90): LoadBand {
  if (pct === null || !Number.isFinite(pct)) return "unknown";
  if (pct >= hotPct) return "hot";
  return pct >= warmPct ? "warm" : "cool";
}

export function fmtMemMB(mb: number | null): string {
  if (mb === null || !Number.isFinite(mb)) return "unknown";
  if (mb >= 1024) { const g = mb / 1024; return `${g >= 10 ? Math.round(g) : Math.round(g * 10) / 10} GB`; }
  return `${Math.max(0, Math.round(mb))} MB`;
}
export function fmtPct(pct: number | null): string {
  return pct === null || !Number.isFinite(pct) ? "--" : `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
}
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return "just now";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

// ── the odometer dial ────────────────────────────────────────────────────────

const SWEEP_DEG = 270;
const START_DEG = 135;
const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const rad = (deg * Math.PI) / 180;
  return [Math.round((cx + r * Math.cos(rad)) * 100) / 100, Math.round((cy + r * Math.sin(rad)) * 100) / 100];
};

/** A 270-degree odometer: graduated track, a coloured value arc, a needle, and the value in the hub.
 *  `pct === null` paints the track and needle at rest with no value arc (the "no signal" face). */
export function odometerSvg(pct: number | null, opts: { size?: number; warmPct?: number; hotPct?: number } = {}): string {
  const size = opts.size ?? 68;
  const cx = size / 2, cy = size / 2;
  const r = size / 2 - 7;
  const band = loadBand(pct, opts.warmPct ?? 70, opts.hotPct ?? 90);
  const frac = pct === null ? 0 : Math.max(0, Math.min(1, pct / 100));
  const [sx, sy] = polar(cx, cy, r, START_DEG);
  const [ex, ey] = polar(cx, cy, r, START_DEG + SWEEP_DEG);
  const arcLen = Math.round(2 * Math.PI * r * (SWEEP_DEG / 360) * 100) / 100;
  const track = `M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}`;
  // Graduations every 45 degrees, so the dial reads as an instrument rather than a progress ring.
  const ticks = Array.from({ length: 7 }, (_, i) => {
    const deg = START_DEG + (SWEEP_DEG / 6) * i;
    const [x1, y1] = polar(cx, cy, r - 3, deg);
    const [x2, y2] = polar(cx, cy, r + 2, deg);
    return `<line class="cod-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
  }).join("");
  const [nx, ny] = polar(cx, cy, r - 5, START_DEG + SWEEP_DEG * frac);
  return `<svg class="cod-dial cod-${band}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true" focusable="false">
    <path class="cod-track" d="${track}" />
    ${ticks}
    ${pct === null ? "" : `<path class="cod-val" d="${track}" style="stroke-dasharray:${arcLen};stroke-dashoffset:${Math.round((arcLen * (1 - frac)) * 100) / 100}" />`}
    <line class="cod-needle" x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" />
    <circle class="cod-hub" cx="${cx}" cy="${cy}" r="3.2" />
  </svg>`;
}

export interface PressureChipModel {
  /** `cpu` or `gpu` - drives the icon, the label, and the data-chip hook app.ts clicks. */
  readonly metric: "cpu" | "gpu";
  readonly label: string;
  readonly pct: number | null;
  readonly freshness: "fresh" | "stale" | "blind";
  /** One-line hover detail: cores, device names, VRAM. Already plain text. */
  readonly detail: string;
  /** Sustained-pressure streak in ms; > 0 means it is holding at the line. */
  readonly hotMs: number;
  readonly sustainMs: number;
}

/** One odometer chip. The label is its own nowrap span and the detail flows in the tooltip, so a
 *  narrow rail never word-wraps it into slivers (invariant 11). */
export function pressureChipHtml(m: PressureChipModel): string {
  const band = loadBand(m.pct);
  const held = m.hotMs > 0 ? ` Held at the line for ${Math.round(m.hotMs / 1000)}s of ${Math.round(m.sustainMs / 1000)}s.` : "";
  const stale = m.freshness === "fresh" ? "" : m.freshness === "stale" ? " Reading is stale." : " No live reading.";
  const tip = `${m.label} pressure|${m.detail}${held}${stale}`;
  return `<button type="button" class="cod-chip cod-${band} cod-${m.freshness}" data-cod-chip="${m.metric}"
    aria-label="${esc(m.label)} pressure ${esc(fmtPct(m.pct))}" data-tip="${esc(tip)}" data-tip-side="left">
    <span class="cod-face">${odometerSvg(m.pct)}<span class="cod-read">${esc(fmtPct(m.pct))}</span></span>
    <span class="cod-meta"><span class="cod-lbl">${icon(m.metric === "cpu" ? "gauge" : "spark", 12)}<span class="cod-name">${esc(m.label)}</span></span>
    <span class="cod-sub">${esc(bandWord(band))}</span></span>
  </button>`;
}

function bandWord(band: LoadBand): string {
  return band === "hot" ? "under pressure" : band === "warm" ? "busy" : band === "cool" ? "healthy" : "no signal";
}

/** The two-chip rail block. */
export function pressureRailHtml(view: CreatorResourcesView | null): string {
  if (!view || !view.targets.length) {
    return `<div class="cod-rail cod-empty">${icon("gauge", 15)}<span>Resource telemetry has not reported yet.</span></div>`;
  }
  const local = view.targets.find((t) => t.kind === "local") ?? view.targets[0]!;
  const a = view.admission;
  // The chip reads from THIS target's own live telemetry, never from the admission window, so a dial can
  // never contradict the availability line underneath it (a GPU with no collector shows "--", not a number).
  let gpuBusy: number | null = null;
  let gpuVram: number | null = null;
  for (const d of local.gpu.devices) {
    if (d.busyPct !== null) gpuBusy = gpuBusy === null ? d.busyPct : Math.max(gpuBusy, d.busyPct);
    if (d.memPct !== null) gpuVram = gpuVram === null ? d.memPct : Math.max(gpuVram, d.memPct);
  }
  const cores = local.cpu ? `${local.cpu.cores} cores` : "core count unknown";
  const gpuNames = local.gpu.devices.map((d) => d.name).join(", ");
  const gpuDetail = local.gpu.available
    ? `${gpuNames || "GPU"} - VRAM ${fmtPct(gpuVram)} used.`
    : local.gpu.note || "No GPU telemetry on this machine.";
  return `<div class="cod-rail">
    ${pressureChipHtml({ metric: "cpu", label: "CPU", pct: local.cpu?.busyPct ?? null, freshness: local.freshness, detail: `${local.cpu?.model || "Processor"} - ${cores}. Memory ${fmtPct(local.mem?.usedPct ?? null)} used.`, hotMs: Math.max(a.cpuHotMs, a.memHotMs), sustainMs: a.sustainMs })}
    ${pressureChipHtml({ metric: "gpu", label: "GPU", pct: local.gpu.available ? gpuBusy : null, freshness: local.gpu.available ? local.freshness : "blind", detail: gpuDetail, hotMs: a.gpuHotMs, sustainMs: a.sustainMs })}
    ${a.ok ? "" : `<p class="cod-refusal">${icon("shield", 12)}${esc(a.reason)}</p>`}
  </div>`;
}

// ── the detailed flyout ──────────────────────────────────────────────────────

function barRow(label: string, pct: number | null, valueText: string): string {
  const band = loadBand(pct);
  const w = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return `<div class="cod-bar-row cod-${band}"><span class="cod-bar-lbl">${esc(label)}</span>
    <span class="cod-bar"><i style="width:${w}%"></i></span>
    <span class="cod-bar-val">${esc(valueText)}</span></div>`;
}

/** Per-core strip: one thin bar per core, so an unbalanced render (one core pegged, fifteen idle) is
 *  visible instead of averaged away. */
export function coreGridHtml(cpu: CpuTelemetryView | null): string {
  if (!cpu || !cpu.perCore.length) return `<p class="cod-none">Per-core detail is not exposed on this platform.</p>`;
  const cells = cpu.perCore.map((c) => {
    const band = loadBand(c.busyPct);
    const h = c.busyPct === null ? 0 : Math.max(2, Math.min(100, c.busyPct));
    return `<span class="cod-core cod-${band}" data-tip="Core ${c.id}|${esc(fmtPct(c.busyPct))} busy" data-tip-side="top"><i style="height:${h}%"></i></span>`;
  }).join("");
  return `<div class="cod-cores" role="img" aria-label="Per-core CPU load">${cells}</div>`;
}

export function gpuDevicesHtml(gpu: GpuTelemetryView): string {
  if (!gpu.available || !gpu.devices.length) {
    return `<p class="cod-none">${esc(gpu.note || "No GPU telemetry available.")} Unknown is not idle: LUCID will not claim spare GPU capacity it cannot measure.</p>`;
  }
  return gpu.devices.map((d) => {
    const vram = d.memTotalMB !== null ? `${fmtMemMB(d.memUsedMB)} of ${fmtMemMB(d.memTotalMB)}` : "VRAM unknown";
    const extra = [
      d.tempC !== null ? `${d.tempC} C` : "",
      d.powerW !== null ? `${d.powerW} W${d.powerCapW !== null ? ` of ${d.powerCapW} W` : ""}` : "",
    ].filter(Boolean).join(" \u00b7 ");
    return `<div class="cod-dev">
      <div class="cod-dev-h"><span class="cod-dev-name">${esc(`${d.index}: ${d.name}`)}</span><span class="cod-dev-tag">${esc(d.vendor)}</span></div>
      ${barRow("load", d.busyPct, fmtPct(d.busyPct))}
      ${barRow("vram", d.memPct, vram)}
      ${extra ? `<p class="cod-dev-sub">${esc(extra)}</p>` : ""}
    </div>`;
  }).join("");
}

/** Sparkline path over the pressure window. Returns "" when there is nothing to draw. */
export function sparkPath(points: readonly (number | null)[], w: number, h: number): string {
  const vals = points.filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length < 2) return "";
  const step = w / (points.length - 1);
  let d = "";
  let started = false;
  points.forEach((v, i) => {
    if (v === null) { started = false; return; } // a gap BREAKS the line rather than interpolating over it
    const x = Math.round(i * step * 10) / 10;
    const y = Math.round((h - (Math.max(0, Math.min(100, v)) / 100) * h) * 10) / 10;
    d += `${started ? "L" : "M"}${x} ${y}`;
    started = true;
  });
  return d;
}

export function historyHtml(history: readonly CreatorSampleView[], pressurePct: number): string {
  if (history.length < 2) return `<p class="cod-none">Not enough samples yet for a trend.</p>`;
  const w = 240, h = 46;
  const lineY = Math.round((h - (pressurePct / 100) * h) * 10) / 10;
  const series: [string, string][] = [
    ["cpu", sparkPath(history.map((s) => s.cpuPct), w, h)],
    ["gpu", sparkPath(history.map((s) => s.gpuPct), w, h)],
    ["mem", sparkPath(history.map((s) => s.memPct), w, h)],
  ];
  const paths = series.filter(([, d]) => d).map(([k, d]) => `<path class="cod-line cod-line-${k}" d="${d}" />`).join("");
  const legend = series.filter(([, d]) => d).map(([k]) => `<span class="cod-key cod-line-${k}">${esc(k.toUpperCase())}</span>`).join("");
  return `<div class="cod-hist"><svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Pressure history">
      <line class="cod-limit" x1="0" y1="${lineY}" x2="${w}" y2="${lineY}" />${paths}
    </svg><div class="cod-keys">${legend}<span class="cod-key cod-key-limit">${esc(`${pressurePct}% line`)}</span></div></div>`;
}

function procsHtml(procs: readonly ProcGroupView[]): string {
  if (!procs.length) return `<p class="cod-none">Process attribution is not available here.</p>`;
  return `<div class="cod-procs">${procs.slice(0, 8).map((p) => `<div class="cod-proc">
    <span class="cod-proc-name">${esc(p.name)}${p.count > 1 ? `<span class="cod-proc-n">x${p.count}</span>` : ""}</span>
    <span class="cod-proc-mem">${esc(fmtMemMB(p.memMB))}</span>
    <span class="cod-proc-cpu">${p.cpuSec !== null ? esc(`${p.cpuSec}s CPU`) : ""}</span></div>`).join("")}</div>`;
}

function targetHtml(t: TargetTelemetryView, pressurePct: number): string {
  const head = `<div class="cod-tgt-h"><span class="cod-tgt-name">${esc(t.label)}</span>
    <span class="cod-tgt-tag">${esc(t.kind === "local" ? "this machine" : "remote")}</span>
    <span class="cod-tgt-age cod-${t.freshness}">${esc(t.freshness === "blind" ? "no signal" : fmtAge(t.ageMs))}</span></div>`;
  if (t.error) return `<section class="cod-tgt">${head}<p class="cod-none">${esc(t.error)}</p></section>`;
  const memText = t.mem ? `${fmtMemMB(t.mem.totalMB - t.mem.freeMB)} of ${fmtMemMB(t.mem.totalMB)}` : "unknown";
  return `<section class="cod-tgt">${head}
    <p class="cod-tgt-sub">${esc(t.cpu?.model || "Processor unknown")}${t.cpu && t.cpu.cores > 0 ? esc(` \u00b7 ${t.cpu.cores} cores`) : ""}${t.cpu && t.cpu.speedMHz > 0 ? esc(` @ ${(t.cpu.speedMHz / 1000).toFixed(1)} GHz`) : ""}</p>
    ${barRow("cpu", t.cpu?.busyPct ?? null, fmtPct(t.cpu?.busyPct ?? null))}
    ${barRow("ram", t.mem?.usedPct ?? null, memText)}
    ${coreGridHtml(t.cpu)}
    <h5 class="cod-h5">GPU</h5>
    ${gpuDevicesHtml(t.gpu)}
    <h5 class="cod-h5">Top processes by memory</h5>
    ${procsHtml(t.procs)}
  </section>`;
}

/** The click-through flyout: every target, its cores, its GPUs, its processes, and the trend. */
export function creatorFlyoutHtml(view: CreatorResourcesView | null): string {
  if (!view) return `<div class="cod-flyout"><p class="cod-none">Resource telemetry is not answering. Nothing is throttled: LUCID simply has no reading to show.</p></div>`;
  const a = view.admission;
  const verdict = !a.ok ? `<p class="cod-refusal">${icon("shield", 12)}${esc(a.reason)}</p>`
    : a.gpuEvidenceMissing ? `<p class="cod-warn">${icon("info", 12)}GPU work is allowed, but no GPU counters answered here, so this is not a measured all-clear.</p>`
    : "";
  return `<div class="cod-flyout">
    <div class="cod-flyout-h"><span class="cod-flyout-t">${icon("gauge", 15)}<span>Creator resources</span></span>
      <button type="button" class="btn-mini" data-cod-refresh>Refresh</button></div>
    ${verdict}
    ${historyHtml(view.history, view.policy.pressurePct)}
    ${view.targets.map((t) => targetHtml(t, view.policy.pressurePct)).join("")}
    <p class="cod-foot">A missing number means the counter is not exposed on this hardware, never that the load is zero.
    Jobs are refused only when a measured reading holds at ${esc(String(view.policy.pressurePct))}% for ${esc(String(Math.round(view.policy.sustainMs / 1000)))}s.</p>
  </div>`;
}
