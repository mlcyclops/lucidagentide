// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_monitor.ts - CREATOR-0 (ADR-0283): normalized CPU/GPU/memory telemetry + Creator
// job admission.
//
// Generative media is the first workload in LUCID that can genuinely wedge a machine: a local diffusion
// render, a Blender frame range, and an Unreal cook all sit on the same GPU and the same cores. So
// Creator builds sample MORE than the ADR-0182 aggregate guard (per core, per GPU device, VRAM, thermals,
// power) and keep a bounded window so admission can talk about SUSTAINED pressure the way ADR-0273 does
// for fleet lanes.
//
// Two doctrines, and they are not the same:
//
//   * TELEMETRY FAILS OPEN. A dead collector, a missing vendor tool, a torn payload, or an unreachable
//     remote host produces `null` and an honest label - never a fabricated number, and never a hard stop.
//   * ADMISSION IS EVIDENCE-BASED. It refuses only on MEASURED sustained pressure or a KNOWN unmet hard
//     requirement (no GPU evidence at all when the job needs a GPU is "unknown", not "fine"): a job that
//     needs 40 GB of VRAM on a box that reports 8 GB is refused with both numbers in the reason.
//
// Nothing user-controlled ever reaches a command line: every collector runs a FIXED argv through an
// injected exec, and remote collectors are plain HTTP reads of a user-registered URL.

import { cpuTotals, busyPct, fmtMB, type ProcGroup, type ProfileIo } from "./system_profile.ts";
import { SECRET_SHAPE } from "./creator_registry.ts";

// ── contracts ────────────────────────────────────────────────────────────────

export interface CoreReading {
  readonly id: number;
  /** 0..100 over the sample window, or null when the window carried no evidence. */
  readonly busyPct: number | null;
}

export interface CpuTelemetry {
  readonly model: string;
  readonly cores: number;
  readonly speedMHz: number;
  readonly busyPct: number | null;
  readonly perCore: readonly CoreReading[];
}

export interface MemTelemetry {
  readonly totalMB: number;
  readonly freeMB: number;
  readonly usedPct: number | null;
}

export type GpuVendor = "nvidia" | "amd" | "apple" | "intel" | "unknown";
/** Where a GPU reading came from. `none` means nothing answered - NOT that the GPU is idle. */
export type GpuSource = "nvidia-smi" | "dcgm-exporter" | "lucid-agent" | "none";

export interface GpuDeviceTelemetry {
  readonly index: number;
  readonly name: string;
  readonly vendor: GpuVendor;
  readonly busyPct: number | null;
  readonly memTotalMB: number | null;
  readonly memUsedMB: number | null;
  readonly memPct: number | null;
  readonly tempC: number | null;
  readonly powerW: number | null;
  readonly powerCapW: number | null;
}

export interface GpuTelemetry {
  readonly available: boolean;
  readonly source: GpuSource;
  readonly devices: readonly GpuDeviceTelemetry[];
  /** One honest line for the UI when there is nothing to show. */
  readonly note: string;
}

export type Freshness = "fresh" | "stale" | "blind";

export interface TargetTelemetry {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "remote";
  readonly sampledAt: number;
  readonly ageMs: number;
  readonly freshness: Freshness;
  readonly cpu: CpuTelemetry | null;
  readonly mem: MemTelemetry | null;
  readonly gpu: GpuTelemetry;
  readonly procs: readonly ProcGroup[];
  /** Non-empty when the collector failed. The UI shows it; nothing treats it as load. */
  readonly error: string;
}

/** Older than this and a reading is labeled stale; older than BLIND and it stops counting as evidence. */
export const FRESH_MS = 8_000;
export const BLIND_MS = 30_000;
/** The load line and how long it must hold before Creator refuses a new job (ADR-0273's shape). */
export const CREATOR_PRESSURE_PCT = 90;
export const CREATOR_SUSTAIN_MS = 30_000;
/** Where the odometer turns amber. Presentation only - it never refuses anything. */
export const CREATOR_WARM_PCT = 70;
/** Bounded ring: twice the sustain window at a 3s cadence, so a just-crossed streak survives a trim. */
export const CREATOR_HISTORY_MAX = 240;

export function freshnessOf(sampledAt: number, now: number): Freshness {
  const age = now - sampledAt;
  if (!Number.isFinite(sampledAt) || sampledAt <= 0 || age >= BLIND_MS) return "blind";
  return age >= FRESH_MS ? "stale" : "fresh";
}

// ── local CPU: per core, not just the aggregate ──────────────────────────────

/** Per-core busy% across two os.cpus() readings. A regressed or empty window yields null per core
 *  (evidence only - a sampling gap must never read as 0% idle capacity). */
export function perCoreBusy(
  prev: readonly { times: Record<string, number> }[],
  next: readonly { times: Record<string, number> }[],
): CoreReading[] {
  const n = Math.min(prev.length, next.length);
  const out: CoreReading[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: i, busyPct: busyPct(cpuTotals([prev[i]!]), cpuTotals([next[i]!])) });
  }
  return out;
}

/** Two-point CPU sample with per-core detail plus RAM. Never throws: a failure returns nulls. */
export async function sampleCreatorCpu(io: ProfileIo, delayMs = 250): Promise<{ cpu: CpuTelemetry | null; mem: MemTelemetry | null }> {
  try {
    const a = io.cpus();
    const t0 = cpuTotals(a);
    await io.sleep(delayMs);
    const b = io.cpus();
    const total = Math.round(io.totalmem() / (1024 * 1024));
    const free = Math.round(io.freemem() / (1024 * 1024));
    return {
      cpu: {
        model: (a[0]?.model ?? "").trim(),
        cores: a.length,
        speedMHz: a[0]?.speed ?? 0,
        busyPct: busyPct(t0, cpuTotals(b)),
        perCore: perCoreBusy(a, b),
      },
      mem: { totalMB: total, freeMB: free, usedPct: total > 0 ? Math.max(0, Math.min(100, Math.round(((total - free) / total) * 100))) : null },
    };
  } catch {
    return { cpu: null, mem: null };
  }
}

// ── local GPU: NVIDIA via nvidia-smi (fixed argv, no shell) ──────────────────

/** The ONLY GPU command LUCID runs. Fixed argv, CSV out, no units, nothing interpolated. */
export const NVIDIA_SMI_ARGS: readonly string[] = [
  "nvidia-smi",
  "--query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw,power.limit",
  "--format=csv,noheader,nounits",
] as const;

const num = (raw: string | undefined): number | null => {
  const v = (raw ?? "").trim();
  if (!v || /^\[?n\/?a\]?$/i.test(v) || /not supported/i.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Parse `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`. Unsupported fields come back as
 *  "[N/A]" on real hardware and must stay null, never 0. Torn lines contribute nothing. */
export function parseNvidiaSmi(text: string): GpuDeviceTelemetry[] {
  const out: GpuDeviceTelemetry[] = [];
  for (const line of (text ?? "").split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    const f = raw.split(",").map((c) => c.trim());
    if (f.length < 3) continue;
    const index = num(f[0]);
    const name = f[1] ?? "";
    if (index === null || !name) continue;
    const memTotalMB = num(f[3]);
    const memUsedMB = num(f[4]);
    out.push({
      index,
      name,
      vendor: "nvidia",
      busyPct: num(f[2]),
      memTotalMB,
      memUsedMB,
      memPct: memTotalMB && memTotalMB > 0 && memUsedMB !== null ? Math.max(0, Math.min(100, Math.round((memUsedMB / memTotalMB) * 100))) : null,
      tempC: num(f[5]),
      powerW: num(f[6]),
      powerCapW: num(f[7]),
    });
  }
  return out;
}

export type ExecIo = (argv: readonly string[]) => string;

/** Local GPU sample. NVIDIA is the one vendor with a stable, scriptable, universally-installed query
 *  tool, so it is the CREATOR-0 collector; every other vendor reports honestly unavailable rather than
 *  guessing. Fail-quiet: a missing binary is "no evidence", never an error dialog. */
export function sampleLocalGpu(exec: ExecIo, platform: NodeJS.Platform = process.platform): GpuTelemetry {
  try {
    const devices = parseNvidiaSmi(exec(NVIDIA_SMI_ARGS));
    if (devices.length) return { available: true, source: "nvidia-smi", devices, note: "" };
    return { available: false, source: "none", devices: [], note: "nvidia-smi answered with no devices." };
  } catch {
    const hint = platform === "darwin"
      ? "Apple GPU counters need elevated powermetrics, so GPU load is not read on this Mac."
      : platform === "win32" || platform === "linux"
      ? "No nvidia-smi on PATH. AMD and Intel GPU load is not collected in this build."
      : "GPU telemetry is not collected on this platform.";
    return { available: false, source: "none", devices: [], note: hint };
  }
}

// ── remote targets: a DGX Spark, a GPU VM, or anything behind the VPN ────────

export interface RemoteTargetDef {
  id: string;
  label: string;
  /** Base URL of a DCGM/Prometheus exporter or a LUCID JSON agent. */
  url: string;
  kind: "dcgm-exporter" | "lucid-agent";
  /** Vault credential NAME for a bearer token. Never a value. */
  vaultRef?: string;
  enabled: boolean;
}

export function validateRemoteTarget(def: RemoteTargetDef): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!def.id || !/^[a-z0-9][a-z0-9_-]{1,48}$/.test(def.id)) errors.push("id must be lowercase letters, digits, dash or underscore (2-49 chars)");
  if (!def.label || !def.label.trim()) errors.push("label is required");
  let u: URL | null = null;
  try { u = new URL(def.url); } catch { u = null; }
  if (!u) errors.push("url must be a valid URL");
  else {
    if (u.protocol !== "http:" && u.protocol !== "https:") errors.push("url must be http or https");
    if (u.username || u.password) errors.push("credentials must never be embedded in a URL - store a vault credential instead");
  }
  if (def.kind !== "dcgm-exporter" && def.kind !== "lucid-agent") errors.push("kind must be dcgm-exporter or lucid-agent");
  if (def.vaultRef && (!/^[a-z0-9][a-z0-9_-]{1,64}$/.test(def.vaultRef) || SECRET_SHAPE.test(def.vaultRef))) {
    errors.push("vaultRef must be a credential NAME, not a value");
  }
  return { ok: errors.length === 0, errors };
}

export interface PromSample {
  readonly labels: Record<string, string>;
  readonly value: number;
}

/** Minimal Prometheus text-exposition reader: `name{a="b",c="d"} 12.5`. Comments, blank lines, and
 *  unparseable samples are skipped; NaN and Inf are dropped (they are not measurements). */
export function parsePrometheusText(text: string, wanted: readonly string[]): Record<string, PromSample[]> {
  const want: Record<string, true> = {};
  for (const w of wanted) want[w] = true;
  const out: Record<string, PromSample[]> = {};
  for (const line of (text ?? "").split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const m = raw.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.eE+]+|[+-]?Inf|NaN)\s*(?:[0-9]+)?$/);
    if (!m) continue;
    const name = m[1]!;
    if (!want[name]) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    for (const pair of (m[2] ?? "").replace(/^\{|\}$/g, "").split(",")) {
      const lm = pair.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/);
      if (lm) labels[lm[1]!] = lm[2]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    (out[name] ??= []).push({ labels, value });
  }
  return out;
}

/** DCGM exporter field names LUCID reads. Anything the exporter does not publish stays null. */
export const DCGM_FIELDS: readonly string[] = [
  "DCGM_FI_DEV_GPU_UTIL", "DCGM_FI_DEV_FB_USED", "DCGM_FI_DEV_FB_FREE",
  "DCGM_FI_DEV_GPU_TEMP", "DCGM_FI_DEV_POWER_USAGE",
] as const;

/** Fold a DCGM exporter scrape into GPU telemetry. Devices are keyed by the exporter's `gpu` label. */
export function gpuFromDcgm(text: string): GpuTelemetry {
  const m = parsePrometheusText(text, DCGM_FIELDS);
  const byGpu = new Map<string, { name: string; util: number | null; used: number | null; free: number | null; temp: number | null; power: number | null }>();
  const touch = (labels: Record<string, string>) => {
    const key = labels.gpu ?? labels.GPU ?? labels.device ?? "0";
    const cur = byGpu.get(key) ?? { name: labels.modelName ?? labels.model_name ?? `GPU ${key}`, util: null, used: null, free: null, temp: null, power: null };
    if (!cur.name && labels.modelName) cur.name = labels.modelName;
    byGpu.set(key, cur);
    return byGpu.get(key)!;
  };
  for (const s of m.DCGM_FI_DEV_GPU_UTIL ?? []) touch(s.labels).util = s.value;
  for (const s of m.DCGM_FI_DEV_FB_USED ?? []) touch(s.labels).used = s.value;
  for (const s of m.DCGM_FI_DEV_FB_FREE ?? []) touch(s.labels).free = s.value;
  for (const s of m.DCGM_FI_DEV_GPU_TEMP ?? []) touch(s.labels).temp = s.value;
  for (const s of m.DCGM_FI_DEV_POWER_USAGE ?? []) touch(s.labels).power = s.value;
  if (!byGpu.size) return { available: false, source: "none", devices: [], note: "The exporter answered but published no DCGM GPU fields." };
  const devices: GpuDeviceTelemetry[] = [...byGpu.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([key, d], i) => {
      const total = d.used !== null && d.free !== null ? d.used + d.free : null;
      return {
        index: Number.isFinite(Number(key)) ? Number(key) : i,
        name: d.name,
        vendor: "nvidia" as GpuVendor,
        busyPct: d.util === null ? null : Math.max(0, Math.min(100, Math.round(d.util))),
        memTotalMB: total === null ? null : Math.round(total),
        memUsedMB: d.used === null ? null : Math.round(d.used),
        memPct: total && total > 0 && d.used !== null ? Math.max(0, Math.min(100, Math.round((d.used / total) * 100))) : null,
        tempC: d.temp === null ? null : Math.round(d.temp),
        powerW: d.power === null ? null : Math.round(d.power),
        powerCapW: null,
      };
    });
  return { available: true, source: "dcgm-exporter", devices, note: "" };
}

/** The LUCID JSON agent contract: a remote host may answer `{cpu:{busyPct,cores,model?},
 *  mem:{totalMB,freeMB}, gpu:{devices:[{index,name,busyPct,memTotalMB,memUsedMB,tempC,powerW}]}}`.
 *  Every field is optional and every missing field stays null - a partial payload is still useful. */
export function telemetryFromAgentJson(raw: unknown, target: { id: string; label: string }, now: number): TargetTelemetry {
  const o = (raw ?? {}) as Record<string, unknown>;
  const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const c = rec(o.cpu);
  const mm = rec(o.mem);
  const g = rec(o.gpu);
  const cores = n(c.cores) ?? 0;
  const cpuBusy = n(c.busyPct);
  const totalMB = n(mm.totalMB) ?? 0;
  const freeMB = n(mm.freeMB) ?? 0;
  const rawDevices = Array.isArray(g.devices) ? g.devices : [];
  const devices: GpuDeviceTelemetry[] = rawDevices.slice(0, 16).map((d, i) => {
    const dd = rec(d);
    const memTotalMB = n(dd.memTotalMB);
    const memUsedMB = n(dd.memUsedMB);
    return {
      index: n(dd.index) ?? i,
      name: typeof dd.name === "string" && dd.name.trim() ? dd.name.trim().slice(0, 80) : `GPU ${i}`,
      vendor: ((): GpuVendor => {
        const v = typeof dd.vendor === "string" ? dd.vendor.toLowerCase() : "";
        return v === "nvidia" || v === "amd" || v === "apple" || v === "intel" ? v : "unknown";
      })(),
      busyPct: n(dd.busyPct),
      memTotalMB,
      memUsedMB,
      memPct: memTotalMB && memTotalMB > 0 && memUsedMB !== null ? Math.max(0, Math.min(100, Math.round((memUsedMB / memTotalMB) * 100))) : null,
      tempC: n(dd.tempC),
      powerW: n(dd.powerW),
      powerCapW: n(dd.powerCapW),
    };
  });
  return {
    id: target.id,
    label: target.label,
    kind: "remote",
    sampledAt: now,
    ageMs: 0,
    freshness: "fresh",
    cpu: cores > 0 || cpuBusy !== null ? { model: typeof c.model === "string" ? c.model.slice(0, 80) : "", cores, speedMHz: n(c.speedMHz) ?? 0, busyPct: cpuBusy, perCore: [] } : null,
    mem: totalMB > 0 ? { totalMB, freeMB, usedPct: Math.max(0, Math.min(100, Math.round(((totalMB - freeMB) / totalMB) * 100))) } : null,
    gpu: devices.length ? { available: true, source: "lucid-agent", devices, note: "" } : { available: false, source: "none", devices: [], note: "The agent answered with no GPU devices." },
    procs: [],
    error: "",
  };
}

// ── pressure window + admission ──────────────────────────────────────────────

export interface CreatorSample {
  readonly at: number;
  readonly cpuPct: number | null;
  readonly memPct: number | null;
  readonly gpuPct: number | null;
  readonly vramPct: number | null;
}

export type CreatorMetric = "cpuPct" | "memPct" | "gpuPct" | "vramPct";

/** The worst (highest) reading across devices - one number the odometer can show for "the GPU". */
export function gpuPeak(gpu: GpuTelemetry): { busyPct: number | null; vramPct: number | null } {
  let busy: number | null = null;
  let vram: number | null = null;
  for (const d of gpu.devices) {
    if (d.busyPct !== null) busy = busy === null ? d.busyPct : Math.max(busy, d.busyPct);
    if (d.memPct !== null) vram = vram === null ? d.memPct : Math.max(vram, d.memPct);
  }
  return { busyPct: busy, vramPct: vram };
}

export function sampleOf(t: TargetTelemetry): CreatorSample {
  const peak = gpuPeak(t.gpu);
  return { at: t.sampledAt, cpuPct: t.cpu?.busyPct ?? null, memPct: t.mem?.usedPct ?? null, gpuPct: peak.busyPct, vramPct: peak.vramPct };
}

/** Append a reading, drop what the window can no longer need, and reset on a backwards clock (a clock
 *  jump must never invent a streak). */
export function pushCreatorSample(history: readonly CreatorSample[], sample: CreatorSample, sustainMs = CREATOR_SUSTAIN_MS): CreatorSample[] {
  const newest = history.length ? history[history.length - 1]! : null;
  if (newest && sample.at < newest.at) return [sample];
  const keepFrom = sample.at - sustainMs * 2;
  const kept = history.filter((s) => s.at >= keepFrom);
  const out = [...kept, sample];
  return out.length > CREATOR_HISTORY_MAX ? out.slice(out.length - CREATOR_HISTORY_MAX) : out;
}

/** Unbroken ms at or above `linePct` ending at the newest reading. A cool OR blind reading breaks the
 *  streak, so a sampling gap can never accumulate as load. */
export function hotMsFor(history: readonly CreatorSample[], metric: CreatorMetric, linePct = CREATOR_PRESSURE_PCT): number {
  if (history.length < 2) return 0;
  const newest = history[history.length - 1]!;
  const v = newest[metric];
  if (v === null || v < linePct) return 0;
  let startAt = newest.at;
  for (let i = history.length - 2; i >= 0; i--) {
    const s = history[i]!;
    const sv = s[metric];
    if (sv === null || sv < linePct) break;
    startAt = s.at;
  }
  return Math.max(0, newest.at - startAt);
}

export type PressureLevel = "unknown" | "cool" | "warm" | "hot";

export function pressureLevel(pct: number | null): PressureLevel {
  if (pct === null) return "unknown";
  if (pct >= CREATOR_PRESSURE_PCT) return "hot";
  return pct >= CREATOR_WARM_PCT ? "warm" : "cool";
}

/** What a Creator job says it needs. Absent fields mean "no known requirement", not "zero". */
export interface CreatorJobNeed {
  readonly label: string;
  readonly gpu?: boolean;
  readonly vramMB?: number;
}

export interface CreatorAdmission {
  readonly ok: boolean;
  readonly reason: string;
  readonly cpuPct: number | null;
  readonly memPct: number | null;
  readonly gpuPct: number | null;
  readonly vramPct: number | null;
  readonly cpuHotMs: number;
  readonly memHotMs: number;
  readonly gpuHotMs: number;
  readonly pressurePct: number;
  readonly sustainMs: number;
  /** True when a GPU-needing job could not be checked because nothing reported a GPU. Admission still
   *  passes (fail-open telemetry) but the caller MUST show this - it is not a clean bill of health. */
  readonly gpuEvidenceMissing: boolean;
}

/** The policy the UI echoes so no surface hardcodes the numbers. */
export interface CreatorPolicy {
  readonly pressurePct: number;
  readonly warmPct: number;
  readonly sustainMs: number;
}

/** Exactly what `GET /api/creator/resources` returns. Named here (not derived from a function) so the
 *  renderer view types and the route share one documented contract. */
export interface CreatorResourcesData {
  readonly targets: readonly TargetTelemetry[];
  readonly history: readonly CreatorSample[];
  readonly admission: CreatorAdmission;
  readonly policy: CreatorPolicy;
}

/** Refuse a new Creator job only on MEASURED sustained pressure or a KNOWN unmet VRAM requirement.
 *  Missing evidence never refuses, and never reads as spare capacity either. */
export function creatorAdmission(
  history: readonly CreatorSample[],
  need: CreatorJobNeed,
  gpu: GpuTelemetry,
  linePct = CREATOR_PRESSURE_PCT,
  sustainMs = CREATOR_SUSTAIN_MS,
): CreatorAdmission {
  const newest = history.length ? history[history.length - 1]! : null;
  const cpuHot = hotMsFor(history, "cpuPct", linePct);
  const memHot = hotMsFor(history, "memPct", linePct);
  const gpuHot = hotMsFor(history, "gpuPct", linePct);
  const base = {
    cpuPct: newest?.cpuPct ?? null,
    memPct: newest?.memPct ?? null,
    gpuPct: newest?.gpuPct ?? null,
    vramPct: newest?.vramPct ?? null,
    cpuHotMs: cpuHot,
    memHotMs: memHot,
    gpuHotMs: gpuHot,
    pressurePct: linePct,
    sustainMs,
    gpuEvidenceMissing: !!need.gpu && !gpu.available,
  };
  const held = `held ${linePct}%+ for ${Math.round(sustainMs / 1000)}s is not a burst`;
  const secs = (ms: number) => Math.round(ms / 1000);
  const refuse = (reason: string): CreatorAdmission => ({ ...base, ok: false, reason });

  // A KNOWN hard requirement the hardware cannot meet: refuse with both numbers, never optimism.
  if (need.vramMB && gpu.available) {
    let best: number | null = null;
    for (const d of gpu.devices) if (d.memTotalMB !== null) best = best === null ? d.memTotalMB : Math.max(best, d.memTotalMB);
    if (best !== null && best < need.vramMB) {
      return refuse(`${need.label} needs about ${fmtMB(need.vramMB)} of VRAM and the largest GPU here reports ${fmtMB(best)} - pick a smaller model or a remote target`);
    }
  }
  if (memHot >= sustainMs) return refuse(`system memory has been at ${Math.round(base.memPct ?? linePct)}% for ${secs(memHot)}s (${held}) - let the current work drain before starting ${need.label}`);
  if (cpuHot >= sustainMs) return refuse(`system CPU has been at ${Math.round(base.cpuPct ?? linePct)}% for ${secs(cpuHot)}s (${held}) - let the current work drain before starting ${need.label}`);
  if (gpuHot >= sustainMs) return refuse(`the GPU has been at ${Math.round(base.gpuPct ?? linePct)}% for ${secs(gpuHot)}s (${held}) - let the current render finish before starting ${need.label}`);
  return { ...base, ok: true, reason: "" };
}
