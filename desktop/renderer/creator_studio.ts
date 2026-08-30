// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/creator_studio.ts - CREATOR-0 (ADR-0282): the Creator Studio surface (pure).
//
// Pure builders only - app.ts owns wiring, and this module owns its view types so it never imports
// bridge.ts (the DOM-types layering rule). Two panes:
//
//   * INTEGRATIONS, grouped Audio / Video / 3D / Game / Testing. Every capability carries its honesty
//     label, because the whole point of the registry is that the agent (and the user) can see the
//     difference between "the vendor documents this API", "that only exists in the vendor's web app",
//     and "you must supply the endpoint yourself".
//   * LIBRARY, the local track ledger: listen, review, rate, tag, remix, re-prompt, and lineage.
//
// Invariant 11: every primary label is its own nowrap+ellipsis span in a min-width:0 row, and prose
// (notes, capability detail) flows as a block paragraph rather than as a raw flex sibling.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

// ── view types (mirror desktop/creator_registry.ts + creator_library.ts) ──

export interface CapabilityView { id: string; status: string; surface: string; detail: string }
export interface ProviderStatusView {
  id: string;
  name: string;
  group: string;
  state: string;
  transports: readonly string[];
  consentRequired: boolean;
  docsUrl: string;
  note: string;
  endpointCount: number;
  usable: readonly string[];
  capabilities: readonly CapabilityView[];
}
export interface TrackView {
  id: string; title: string; origin: string; mime: string; bytes: number;
  createdAt: number; updatedAt: number; prompt: string; lyrics: string;
  tags: readonly string[]; rating: number | null; review: string; parentId: string | null; kind: string;
}
export interface LibraryStatsView { tracks: number; remixes: number; reviewed: number; bytes: number; origins: Record<string, number> }
/** CREATOR-1 (ADR-0292): the last probe for one provider - what it PROVED, and how fresh that answer is. */
export interface ProbeResultView {
  providerId: string; state: string; at: number; latencyMs: number; detail: string;
  attested: readonly string[]; version: string;
}
/** CREATOR-1: one recorded job. */
export interface JobView {
  id: string; kind: string; state: string; label: string; provider: string;
  createdAt: number; startedAt: number | null; endedAt: number | null;
  cancelRequested: boolean; error: string; artifacts: readonly string[];
  admission: { ok: boolean; cpuPct: number | null; memPct: number | null; gpuPct: number | null; gpuEvidenceMissing: boolean; reason: string } | null;
}
export interface JobStatsView { total: number; active: number; done: number; failed: number; refused: number }

export interface CreatorStudioView {
  providers: readonly ProviderStatusView[];
  tracks: readonly TrackView[];
  stats: LibraryStatsView;
  probes?: readonly ProbeResultView[];
  jobs?: readonly JobView[];
  jobStats?: JobStatsView;
}

export function isCreatorStudio(v: unknown): v is CreatorStudioView {
  const o = v as CreatorStudioView | null;
  return !!o && Array.isArray(o.providers) && Array.isArray(o.tracks) && !!o.stats && typeof o.stats.tracks === "number";
}

const GROUP_LABEL: Record<string, string> = {
  audio: "Audio and voice",
  video: "Image and video",
  "3d": "3D and scenes",
  game: "Game engines",
  testing: "Testing",
};
const STATE_LABEL: Record<string, string> = {
  ready: "ready",
  configured: "configured",
  "needs-credential": "needs a credential",
  "needs-endpoint": "needs an endpoint",
  "built-in": "built in",
};
const STATUS_LABEL: Record<string, string> = {
  available: "available",
  planned: "planned",
  "product-ui-only": "vendor app only",
  "unverified-endpoint": "bring your endpoint",
};
const STATUS_TIP: Record<string, string> = {
  available: "An official documented surface backs this today.",
  planned: "Mapped in the Creator roadmap; not wired yet.",
  "product-ui-only": "The vendor exposes this only inside its own web product, so LUCID will not pretend to drive it.",
  "unverified-endpoint": "No public self-serve API is published, so you supply the base URL and credential and LUCID probes before it calls anything.",
};

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${Math.round((mb / 1024) * 10) / 10} GB`;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`;
}

function capChipHtml(c: CapabilityView, usable: readonly string[]): string {
  const on = usable.includes(c.id) && c.status === "available";
  return `<span class="cst-cap cst-cap-${esc(c.status)}${on ? " on" : ""}"
    data-tip="${esc(`${c.id} \u00b7 ${STATUS_LABEL[c.status] ?? c.status}|${c.detail} ${STATUS_TIP[c.status] ?? ""}`)}" data-tip-side="top">${esc(c.id)}</span>`;
}

const PROBE_LABEL: Record<string, string> = {
  ready: "proven",
  unauthorized: "credential refused",
  unreachable: "no answer",
  "not-installed": "not on disk",
  "no-capabilities": "nothing proven",
  skipped: "not probed",
};

export function fmtAgo(at: number, now: number): string {
  const ms = now - at;
  if (!Number.isFinite(at) || at <= 0) return "never";
  if (ms < 1000) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/** The probe line: what was proven, when, and how long it took. Never a claim the probe did not make. */
function probeLineHtml(probe: ProbeResultView | undefined, now: number): string {
  if (!probe) return `<p class="cst-probe cst-probe-none">Not probed yet. Probe to find out what this install can actually do.</p>`;
  const label = PROBE_LABEL[probe.state] ?? probe.state;
  return `<p class="cst-probe cst-probe-${esc(probe.state)}">
    <span class="cst-probe-state">${esc(label)}</span>
    <span class="cst-probe-age">${esc(fmtAgo(probe.at, now))}${probe.latencyMs ? esc(` \u00b7 ${probe.latencyMs}ms`) : ""}</span>
    ${esc(probe.detail)}</p>`;
}

function providerRowHtml(p: ProviderStatusView, probe: ProbeResultView | undefined, now: number): string {
  const state = STATE_LABEL[p.state] ?? p.state;
  const caps = p.capabilities.map((c) => capChipHtml(c, p.usable)).join("");
  const actions = p.state === "built-in"
    ? ""
    : `<button type="button" class="btn-mini" data-creator-endpoint="${esc(p.id)}">${p.endpointCount ? "Endpoints" : "Connect"}</button>`;
  return `<div class="cst-row" data-creator-provider="${esc(p.id)}">
    <div class="cst-row-h">
      <span class="cst-name">${esc(p.name)}</span>
      <span class="cst-state cst-state-${esc(p.state)}">${esc(state)}</span>
      ${p.endpointCount ? `<span class="cst-count">${esc(String(p.endpointCount))} configured</span>` : ""}
      ${p.consentRequired ? `<span class="cst-consent" data-tip="Consent required|Voice cloning, voice conversion, and identity-preserving dubbing need recorded consent from the speaker before any reference audio is used.">consent</span>` : ""}
      <button type="button" class="btn-mini" data-creator-probe="${esc(p.id)}" data-tip="Probe|Ask this provider what it can actually do. Only what the answer PROVES becomes usable.">Probe</button>
      ${actions}
    </div>
    <p class="cst-note">${esc(p.note)}</p>
    ${probeLineHtml(probe, now)}
    <div class="cst-caps">${caps}</div>
  </div>`;
}

export function creatorIntegrationsHtml(providers: readonly ProviderStatusView[], probes: readonly ProbeResultView[] = [], now = Date.now()): string {
  if (!providers.length) return `<p class="cst-empty">The integration registry is empty in this build.</p>`;
  const byId = new Map(probes.map((p) => [p.providerId, p] as const));
  const groups = ["audio", "video", "3d", "game", "testing"];
  const sections = groups.map((g) => {
    const rows = providers.filter((p) => p.group === g);
    if (!rows.length) return "";
    return `<section class="cst-group"><h4 class="cst-h4">${esc(GROUP_LABEL[g] ?? g)}</h4>${rows.map((r) => providerRowHtml(r, byId.get(r.id), now)).join("")}</section>`;
  }).join("");
  return `<div class="cst-integrations">
    <div class="cst-probe-all"><button type="button" class="btn-mini ok" data-creator-probe-all>Probe everything</button>
      <span class="cst-probe-hint">A probe reports what a provider PROVED, and only that becomes usable.</span></div>
    ${sections}
    <p class="cst-foot">A label is a promise about DOCUMENTED surfaces, not a guess. LUCID probes a provider before it calls one,
    and it never automates a vendor's web product or an unofficial reseller.</p></div>`;
}

// ── CREATOR-1: the job strip ────────────────────────────────────────────────

const JOB_STATE_LABEL: Record<string, string> = {
  queued: "queued", running: "running", done: "done", failed: "failed", cancelled: "cancelled", refused: "refused",
};

function jobRowHtml(j: JobView, now: number): string {
  const dur = j.startedAt === null ? "" : `${Math.max(0, Math.round(((j.endedAt ?? now) - j.startedAt) / 100) / 10)}s`;
  const live = j.state === "running" || j.state === "queued";
  const measured = j.admission && !j.admission.ok
    ? j.admission.reason
    : j.admission ? `admitted at cpu ${j.admission.cpuPct ?? "--"}%, mem ${j.admission.memPct ?? "--"}%, gpu ${j.admission.gpuPct ?? "--"}%` : "";
  return `<div class="cst-job cst-job-${esc(j.state)}" data-job="${esc(j.id)}">
    <div class="cst-job-h">
      <span class="cst-job-kind">${esc(j.kind)}</span>
      <span class="cst-job-label">${esc(j.label)}</span>
      <span class="cst-job-state">${esc(JOB_STATE_LABEL[j.state] ?? j.state)}${j.cancelRequested && live ? " (stopping)" : ""}</span>
      ${dur ? `<span class="cst-job-dur">${esc(dur)}</span>` : ""}
      ${j.artifacts.length ? `<span class="cst-job-arts">${esc(`${j.artifacts.length} artifact${j.artifacts.length === 1 ? "" : "s"}`)}</span>` : ""}
      ${live && !j.cancelRequested ? `<button type="button" class="btn-mini danger" data-job-cancel="${esc(j.id)}">Stop</button>` : ""}
    </div>
    ${j.error ? `<p class="cst-job-err">${esc(j.error)}</p>` : measured ? `<p class="cst-job-meta">${esc(measured)}</p>` : ""}
  </div>`;
}

/** Recent jobs, newest first, with the governor's measurement attached to each. */
export function creatorJobsHtml(jobs: readonly JobView[] = [], stats?: JobStatsView, now = Date.now()): string {
  if (!jobs.length) return `<p class="cst-empty">No Creator jobs yet. A generation, sheet, GIF, or probe is recorded here with what the resource governor measured when it started.</p>`;
  const head = stats
    ? `<div class="cst-job-stats"><span class="cst-lib-stat">${esc(`${stats.active} active`)}</span><span class="cst-lib-stat">${esc(`${stats.done} done`)}</span>${stats.failed ? `<span class="cst-lib-stat">${esc(`${stats.failed} failed`)}</span>` : ""}${stats.refused ? `<span class="cst-lib-stat">${esc(`${stats.refused} refused`)}</span>` : ""}</div>`
    : "";
  return `<div class="cst-jobs">${head}${jobs.slice(0, 12).map((j) => jobRowHtml(j, now)).join("")}</div>`;
}

// ── library ──────────────────────────────────────────────────────────────────

function starsHtml(rating: number | null): string {
  const n = rating === null ? 0 : Math.max(0, Math.min(5, rating));
  return `<span class="cst-stars" aria-label="${esc(rating === null ? "unrated" : `${n} of 5`)}">${
    Array.from({ length: 5 }, (_, i) => `<button type="button" class="cst-star${i < n ? " on" : ""}" data-track-rate="${i + 1}">${icon("star", 11)}</button>`).join("")
  }</span>`;
}

function trackRowHtml(t: TrackView, lineage: number): string {
  const tags = t.tags.slice(0, 6).map((g) => `<span class="cst-tag">${esc(g)}</span>`).join("");
  const kind = t.kind === "original" ? "" : `<span class="cst-kind">${esc(t.kind)}</span>`;
  return `<div class="cst-track" data-track="${esc(t.id)}">
    <div class="cst-track-h">
      <button type="button" class="cst-play" data-track-play="${esc(t.id)}" aria-label="${esc(`Play ${t.title}`)}" data-tip="Listen|Play this track in LUCID">${icon("volume", 13)}</button>
      <span class="cst-track-title">${esc(t.title)}</span>
      <span class="cst-origin">${esc(t.origin)}</span>
      ${kind}
      ${lineage > 1 ? `<span class="cst-lineage" data-tip="Lineage|${esc(`${lineage} versions in this chain, oldest first`)}">${esc(`v${lineage}`)}</span>` : ""}
      <span class="cst-size">${esc(fmtBytes(t.bytes))}</span>
    </div>
    <div class="cst-track-meta">${starsHtml(t.rating)}${tags}</div>
    ${t.prompt ? `<p class="cst-track-prompt">${esc(t.prompt)}</p>` : ""}
    ${t.review ? `<p class="cst-track-review">${esc(t.review)}</p>` : ""}
    <div class="cst-track-acts">
      <button type="button" class="btn-mini" data-track-review="${esc(t.id)}">Review</button>
      <button type="button" class="btn-mini" data-track-remix="${esc(t.id)}">Remix</button>
      <button type="button" class="btn-mini" data-track-reprompt="${esc(t.id)}">Re-prompt</button>
      <button type="button" class="btn-mini danger" data-track-remove="${esc(t.id)}">Remove</button>
    </div>
  </div>`;
}

export function creatorLibraryHtml(view: CreatorStudioView): string {
  const s = view.stats;
  const head = `<div class="cst-lib-h">
    <span class="cst-lib-t">${icon("folder", 14)}<span>Library</span></span>
    <span class="cst-lib-stat">${esc(`${s.tracks} tracks`)}</span>
    <span class="cst-lib-stat">${esc(`${s.remixes} remixes`)}</span>
    <span class="cst-lib-stat">${esc(`${s.reviewed} reviewed`)}</span>
    <span class="cst-lib-stat">${esc(fmtBytes(s.bytes))}</span>
    <button type="button" class="btn-mini ok" data-track-add>Add audio</button>
  </div>`;
  if (!view.tracks.length) {
    return `<div class="cst-lib">${head}
      <p class="cst-empty">No tracks yet. Add a song you generated anywhere - Suno, ElevenLabs, a local model - and it becomes
      reviewable here with its prompt, tags, rating, notes, and remix lineage stored on this machine.</p></div>`;
  }
  const depth: Record<string, number> = {};
  const byId: Record<string, TrackView> = {};
  for (const t of view.tracks) byId[t.id] = t;
  for (const t of view.tracks) {
    let n = 1, cur: TrackView | undefined = t, guard = 0;
    while (cur?.parentId && guard++ < 20) { cur = byId[cur.parentId]; if (cur) n++; }
    depth[t.id] = n;
  }
  return `<div class="cst-lib">${head}${view.tracks.map((t) => trackRowHtml(t, depth[t.id] ?? 1)).join("")}</div>`;
}

/** The whole Studio body: integrations, the job strip, then the library. */
export function creatorStudioHtml(view: CreatorStudioView | null, now = Date.now()): string {
  if (!view) return `<div class="cst-body"><p class="cst-empty">Creator Studio could not read its registry. Nothing is configured behind your back; try Refresh.</p></div>`;
  return `<div class="cst-body">
    ${creatorIntegrationsHtml(view.providers, view.probes ?? [], now)}
    <section class="cst-group"><h4 class="cst-h4">Recent jobs</h4>${creatorJobsHtml(view.jobs ?? [], view.jobStats, now)}</section>
    ${creatorLibraryHtml(view)}
  </div>`;
}
