// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_probe.ts - CREATOR-1 (ADR-0292): capability probes.
//
// CREATOR-0 could only say "configured": an endpoint exists and a credential is registered. That is not the
// same as "this will work". A probe answers the harder question by ASKING the thing itself, and it reports
// exactly what the answer proves - never more:
//
//   * ComfyUI publishes its node catalog, so its probe is REAL capability discovery: image, video, 3D, and
//     asset-import are attested only when the nodes that do them are actually installed.
//   * ElevenLabs publishes model flags, so its probe attests the capabilities those flags claim.
//   * A local runtime (dots.tts, a Suno partner endpoint) answers "I am here" and nothing more. The probe
//     says reachable, and leaves capability unattested rather than inventing it.
//   * A desktop app (Blender, Unreal) is attested by its executable existing, plus a version line when the
//     tool prints one on a fixed argv.
//
// Every adapter takes injected IO, returns a result object, and never throws: a dead endpoint is a state,
// not an exception. Probe results are in-memory and time-stamped, because a capability answer goes stale the
// moment the user installs a node or their VPN drops.

import type { CreatorCapabilityId, CreatorEndpointDef, CreatorProviderId } from "./creator_registry.ts";

/** Closed set. `skipped` = nothing to probe (no endpoint declared, or a built-in). */
export type ProbeState = "ready" | "unauthorized" | "unreachable" | "not-installed" | "no-capabilities" | "skipped";

export interface ProbeResult {
  readonly providerId: CreatorProviderId;
  readonly state: ProbeState;
  /** When the probe ran (epoch ms). Freshness is presentation: an old answer is labeled, never trusted blind. */
  readonly at: number;
  readonly latencyMs: number;
  /** One honest line for the UI. Contains no credential, ever. */
  readonly detail: string;
  /** Capabilities this answer actually PROVES. Empty is a legitimate result. */
  readonly attested: readonly CreatorCapabilityId[];
  /** Version string when the tool printed one. */
  readonly version: string;
}

export const PROBE_FRESH_MS = 120_000;
export const PROBE_STALE_MS = 900_000;

export type ProbeFreshness = "fresh" | "stale" | "expired";
export function probeFreshness(at: number, now: number): ProbeFreshness {
  const age = now - at;
  if (!Number.isFinite(at) || at <= 0 || age >= PROBE_STALE_MS) return "expired";
  return age >= PROBE_FRESH_MS ? "stale" : "fresh";
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
/** Fixed-argv exec. Throws on a missing binary or a non-zero exit, exactly like execFileSync. */
export type ExecLike = (argv: readonly string[]) => string;

export interface ProbeDeps {
  readonly fetchImpl: FetchLike;
  readonly exec: ExecLike;
  readonly exists: (path: string) => boolean;
  readonly now: () => number;
  /** Secret for this provider, resolved by the caller from env or the vault. Never logged. */
  readonly secret: (providerId: CreatorProviderId) => string;
  readonly timeoutMs?: number;
}

const result = (
  providerId: CreatorProviderId,
  state: ProbeState,
  detail: string,
  startedAt: number,
  now: number,
  attested: readonly CreatorCapabilityId[] = [],
  version = "",
): ProbeResult => ({ providerId, state, at: now, latencyMs: Math.max(0, now - startedAt), detail, attested, version });

// ── ComfyUI: real capability discovery from the installed node set ───────────

/** Node classes that PROVE a capability. A capability is attested only when its node is installed. */
const COMFY_CAPABILITY_NODES: readonly { readonly capability: CreatorCapabilityId; readonly nodes: readonly string[] }[] = [
  { capability: "image", nodes: ["SaveImage", "PreviewImage"] },
  { capability: "video", nodes: ["SaveAnimatedWEBP", "SaveAnimatedPNG", "VHS_VideoCombine", "SaveWEBM"] },
  { capability: "model-3d", nodes: ["SaveGLB", "Load3D", "Preview3D"] },
  { capability: "asset-import", nodes: ["LoadImage", "LoadImageMask"] },
  { capability: "workflow-run", nodes: ["KSampler", "KSamplerAdvanced", "SamplerCustom"] },
  { capability: "runtime-feedback", nodes: ["PreviewImage", "SaveImage"] },
];

/** Which capabilities a `/object_info` payload proves. Unknown shapes attest nothing. */
export function attestComfyCapabilities(objectInfo: unknown): CreatorCapabilityId[] {
  if (!objectInfo || typeof objectInfo !== "object") return [];
  const present = new Set(Object.keys(objectInfo));
  const out: CreatorCapabilityId[] = [];
  for (const { capability, nodes } of COMFY_CAPABILITY_NODES) {
    if (nodes.some((n) => present.has(n)) && !out.includes(capability)) out.push(capability);
  }
  return out;
}

// ── ElevenLabs: the documented model flags ───────────────────────────────────

const ELEVEN_FLAG_CAPABILITY: Record<string, CreatorCapabilityId> = {
  can_do_text_to_speech: "tts",
  can_do_voice_conversion: "dubbing",
  can_use_speaker_boost: "voice-clone",
  can_use_style: "voice-design",
};

/** Which capabilities an ElevenLabs `/v1/models` payload proves. A flag nobody set attests nothing. */
export function attestElevenCapabilities(models: unknown): CreatorCapabilityId[] {
  if (!Array.isArray(models)) return [];
  const out: CreatorCapabilityId[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    for (const [flag, capability] of Object.entries(ELEVEN_FLAG_CAPABILITY)) {
      if (flag in m && m[flag as keyof typeof m] === true && !out.includes(capability)) out.push(capability);
    }
  }
  // Streaming and alignment ride the same synthesis endpoint, so TTS proves them too.
  if (out.includes("tts")) for (const c of ["streaming-audio", "alignment"] as const) if (!out.includes(c)) out.push(c);
  return out;
}

// ── the adapters ─────────────────────────────────────────────────────────────

const authHeaders = (providerId: CreatorProviderId, secret: string): Record<string, string> =>
  providerId === "elevenlabs"
    ? (secret ? { "xi-api-key": secret } : {})
    // A token rides a HEADER for every other provider, never the URL.
    : (secret ? { authorization: `Bearer ${secret}` } : {});

async function readJson(deps: ProbeDeps, url: string, headers: Record<string, string>): Promise<{ status: number; body?: unknown; error?: string }> {
  try {
    const res = await deps.fetchImpl(url, { headers, signal: AbortSignal.timeout(deps.timeoutMs ?? 8000) });
    if (!res.ok) return { status: res.status };
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: 0, error: "no answer" };
  }
}

/** ComfyUI: `/object_info` both proves reachability AND enumerates what this install can do. */
export async function probeComfyui(deps: ProbeDeps, ep: CreatorEndpointDef): Promise<ProbeResult> {
  const startedAt = deps.now();
  const base = (ep.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return result("comfyui", "skipped", "No base URL is declared for this endpoint.", startedAt, deps.now());
  const r = await readJson(deps, `${base}/object_info`, authHeaders("comfyui", deps.secret("comfyui")));
  const now = deps.now();
  if (r.status === 401 || r.status === 403) return result("comfyui", "unauthorized", `${base} refused the credential.`, startedAt, now);
  if (!r.status) return result("comfyui", "unreachable", `${base} did not answer.`, startedAt, now);
  if (r.status >= 400) return result("comfyui", "unreachable", `${base} answered ${r.status}.`, startedAt, now);
  const attested = attestComfyCapabilities(r.body);
  const nodes = r.body && typeof r.body === "object" ? Object.keys(r.body).length : 0;
  // An install is only usable when it can PRODUCE something. A sampler with no save node can queue a graph
  // that yields nothing, so `workflow-run` and `runtime-feedback` are enablers, never the proof by themselves.
  const produces = attested.filter((c) => c === "image" || c === "video" || c === "model-3d");
  if (!produces.length) {
    return result("comfyui", "no-capabilities", `${base} answered with ${nodes} nodes, none of which prove an image, video, or 3D OUTPUT.`, startedAt, now);
  }
  return result("comfyui", "ready", `${nodes} nodes installed; proven: ${attested.join(", ")}.`, startedAt, now, attested);
}

/** ElevenLabs: `/v1/models` validates the key AND reports what the account's models can do. */
export async function probeElevenlabs(deps: ProbeDeps): Promise<ProbeResult> {
  const startedAt = deps.now();
  const secret = deps.secret("elevenlabs");
  if (!secret) return result("elevenlabs", "skipped", "No ElevenLabs API key is present in this build's vault or environment.", startedAt, deps.now());
  const r = await readJson(deps, "https://api.elevenlabs.io/v1/models", authHeaders("elevenlabs", secret));
  const now = deps.now();
  if (r.status === 401 || r.status === 403) return result("elevenlabs", "unauthorized", "ElevenLabs refused that API key.", startedAt, now);
  if (!r.status) return result("elevenlabs", "unreachable", "api.elevenlabs.io did not answer.", startedAt, now);
  if (r.status >= 400) return result("elevenlabs", "unreachable", `api.elevenlabs.io answered ${r.status}.`, startedAt, now);
  const attested = attestElevenCapabilities(r.body);
  if (!attested.length) return result("elevenlabs", "no-capabilities", "The key works, but no model on this account declares a capability LUCID uses.", startedAt, now);
  return result("elevenlabs", "ready", `Key accepted; proven: ${attested.join(", ")}.`, startedAt, now, attested);
}

/** A user-run HTTP service (dots.tts, a Suno partner endpoint). Reachability is ALL this proves, so
 *  capability stays unattested - which is the honest answer, not a gap. */
export async function probeHttpService(deps: ProbeDeps, providerId: CreatorProviderId, ep: CreatorEndpointDef, opts: { paths?: readonly string[]; attestOnOk?: readonly CreatorCapabilityId[] } = {}): Promise<ProbeResult> {
  const startedAt = deps.now();
  const base = (ep.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return result(providerId, "skipped", "No base URL is declared for this endpoint.", startedAt, deps.now());
  const paths = opts.paths ?? ["/v1/models", "/health", "/"];
  let lastStatus = 0;
  for (const path of paths) {
    const r = await readJson(deps, `${base}${path}`, authHeaders(providerId, deps.secret(providerId)));
    if (r.status === 401 || r.status === 403) return result(providerId, "unauthorized", `${base} refused the credential.`, startedAt, deps.now());
    if (r.status && r.status < 400) {
      const attested = opts.attestOnOk ?? [];
      const now = deps.now();
      return attested.length
        ? result(providerId, "ready", `${base}${path} answered; proven: ${attested.join(", ")}.`, startedAt, now, attested)
        : result(providerId, "ready", `${base}${path} answered. Reachability is all this proves: that service publishes no capability endpoint.`, startedAt, now);
    }
    lastStatus = r.status || lastStatus;
  }
  return result(providerId, "unreachable", lastStatus ? `${base} answered ${lastStatus} on every probe path.` : `${base} did not answer.`, startedAt, deps.now());
}

/** A desktop app. Presence of the declared executable is the proof; a version line is a bonus. */
export function probeExecutable(deps: ProbeDeps, providerId: CreatorProviderId, ep: CreatorEndpointDef, opts: { versionArgs?: readonly string[]; attested: readonly CreatorCapabilityId[] }): ProbeResult {
  const startedAt = deps.now();
  const command = (ep.command ?? "").trim();
  if (!command) return result(providerId, "skipped", "No executable is declared for this endpoint.", startedAt, deps.now());
  if (!deps.exists(command)) return result(providerId, "not-installed", `${command} is not on disk.`, startedAt, deps.now());
  let version = "";
  if (opts.versionArgs) {
    try {
      const out = deps.exec([command, ...opts.versionArgs]);
      version = (out.split("\n")[0] ?? "").trim().slice(0, 80);
    } catch { /* a tool that refuses --version is still installed */ }
  }
  return result(providerId, "ready", version ? `${version} responded on this machine.` : `${command} is present.`, startedAt, deps.now(), opts.attested, version);
}

/** three.js: nothing to reach. It ships in the renderer, so it is ready by construction. */
export function probeBuiltIn(deps: ProbeDeps, providerId: CreatorProviderId, attested: readonly CreatorCapabilityId[]): ProbeResult {
  const startedAt = deps.now();
  return result(providerId, "ready", "Built into the renderer: no endpoint, no credential, no network.", startedAt, deps.now(), attested);
}

/** Probe one provider, choosing the adapter its transports imply. */
export async function probeProvider(deps: ProbeDeps, providerId: CreatorProviderId, endpoints: readonly CreatorEndpointDef[]): Promise<ProbeResult> {
  const ep = endpoints.find((e) => e.enabled && e.providerId === providerId);
  switch (providerId) {
    case "threejs":
      return probeBuiltIn(deps, "threejs", ["scene-preview", "render-still", "runtime-feedback", "asset-import"]);
    case "elevenlabs":
      return probeElevenlabs(deps);
    case "comfyui":
      return ep ? probeComfyui(deps, ep) : result("comfyui", "skipped", "No ComfyUI endpoint is declared yet.", deps.now(), deps.now());
    case "dots-tts":
      return ep
        ? probeHttpService(deps, "dots-tts", ep, { paths: ["/v1/models", "/health", "/"], attestOnOk: ["tts"] })
        : result("dots-tts", "skipped", "No dots.tts server is declared yet.", deps.now(), deps.now());
    case "suno":
      return ep
        ? probeHttpService(deps, "suno", ep, { paths: ["/v1/models", "/"] })
        : result("suno", "skipped", "No Suno partner endpoint is declared. The local library works without one.", deps.now(), deps.now());
    case "blender":
      return ep
        ? probeExecutable(deps, "blender", ep, { versionArgs: ["--version"], attested: ["render-still", "render-animation", "runtime-feedback", "asset-import"] })
        : result("blender", "skipped", "No Blender executable is declared yet.", deps.now(), deps.now());
    case "unreal":
      return ep
        ? probeExecutable(deps, "unreal", ep, { attested: ["engine-build", "engine-test", "runtime-feedback"] })
        : result("unreal", "skipped", "No Unreal executable is declared yet.", deps.now(), deps.now());
  }
}

/** The probe cache: last result per provider, plus its freshness at read time. In memory by design. */
export class ProbeCache {
  readonly #byProvider = new Map<CreatorProviderId, ProbeResult>();

  set(r: ProbeResult): void { this.#byProvider.set(r.providerId, r); }
  get(providerId: CreatorProviderId): ProbeResult | null { return this.#byProvider.get(providerId) ?? null; }
  all(): ProbeResult[] { return [...this.#byProvider.values()]; }

  /** Capabilities to hand foldProviderStatus: attested, and only while the answer has not expired. */
  discovered(providerId: CreatorProviderId, now: number): CreatorCapabilityId[] | undefined {
    const r = this.#byProvider.get(providerId);
    if (!r || r.state !== "ready") return undefined;
    return probeFreshness(r.at, now) === "expired" ? undefined : [...r.attested];
  }
}
