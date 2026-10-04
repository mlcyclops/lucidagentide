// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_dgx_avatar.ts - the HTTP client for the DGX Loader's avatar service (contract section 2a).
//
// The service runs on a DGX box bound to 127.0.0.1:8088 and is reached through the Loader's SSH forward, so
// LUCID only ever dials the declared base URL. Every call has a timeout, every answer is shape-checked before
// anything reads it, and every remote string (an error, a template name) is bounded untrusted text. Nothing
// here decides WHETHER to call: the CUI gate and the job ledger live in the route; this module only speaks
// the contract. The fetch is injected so the tests prove the exact requests without a box.

import type { CreatorCapabilityId } from "./creator_registry.ts";
import type { FetchLike } from "./creator_probe.ts";

export type AvatarEngine = "musetalk" | "echomimic";
export const AVATAR_ENGINES: readonly AvatarEngine[] = ["musetalk", "echomimic"] as const;
export type AvatarVariant = "avatar" | "composed";

export interface AvatarReadiness { readonly ready: boolean; readonly detail?: string }
export interface AvatarHealth {
  readonly ok: boolean;
  readonly service: string;
  readonly version: string;
  readonly engines: Readonly<Record<AvatarEngine, AvatarReadiness>>;
  readonly compose: AvatarReadiness;
}

export interface AvatarTemplate { readonly path: string; readonly name: string; readonly sizeBytes: number }
export interface AvatarTemplates { readonly templates: readonly AvatarTemplate[]; readonly folders: readonly string[] }

export type AvatarJobState = "queued" | "running" | "done" | "failed" | "cancelled";
export interface AvatarJobStatus {
  readonly id: string;
  readonly state: AvatarJobState;
  readonly stage: "render" | "compose" | "done";
  readonly message: string;
  readonly error?: string;
  readonly renderMs?: number;
  readonly composeMs?: number;
  readonly outputs: { readonly avatar: boolean; readonly composed: boolean };
}

export interface AvatarTuning {
  extraMargin?: number; leftCheekWidth?: number; rightCheekWidth?: number; parsingMode?: string;
  steps?: number; guidanceScale?: number; audioGuidanceScale?: number; prompt?: string;
}
export interface AvatarCompose { title?: string; subtitle?: string; captionText?: string }
export interface AvatarJobSpec { engine: AvatarEngine; templatePath: string; tuning?: AvatarTuning; compose?: AvatarCompose }

export type ClientResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

const MAX_REMOTE_TEXT = 300;
const CONTROL = /[\u0000-\u001f\u007f]/;
const bounded = (v: unknown, max = MAX_REMOTE_TEXT): string => (typeof v === "string" ? v.slice(0, max) : "");
const readiness = (v: unknown): AvatarReadiness => {
  if (!v || typeof v !== "object") return { ready: false, detail: "not reported" };
  const rec: Record<string, unknown> = { ...v };
  const detail = bounded(rec.detail);
  return detail ? { ready: rec.ready === true, detail } : { ready: rec.ready === true };
};

/** Shape-check a /health body. Anything that is not the dgx-avatar service is null, never a guess. */
export function parseAvatarHealth(raw: unknown): AvatarHealth | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec: Record<string, unknown> = { ...raw };
  if (rec.ok !== true || rec.service !== "dgx-avatar") return null;
  const engines: Record<string, unknown> = rec.engines && typeof rec.engines === "object" ? { ...rec.engines } : {};
  return {
    ok: true,
    service: "dgx-avatar",
    version: bounded(rec.version, 40),
    engines: { musetalk: readiness(engines.musetalk), echomimic: readiness(engines.echomimic) },
    compose: readiness(rec.compose),
  };
}

/** What a health answer PROVES: avatar-video when at least one engine is ready, video-compose when the
 *  box-side HyperFrames compose is ready. */
export function avatarHealthCapabilities(h: AvatarHealth): CreatorCapabilityId[] {
  const out: CreatorCapabilityId[] = [];
  if (h.engines.musetalk.ready || h.engines.echomimic.ready) out.push("avatar-video");
  if (h.compose.ready) out.push("video-compose");
  return out;
}

export function parseAvatarTemplates(raw: unknown): AvatarTemplates | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec: Record<string, unknown> = { ...raw };
  if (!Array.isArray(rec.templates)) return null;
  const templates: AvatarTemplate[] = [];
  for (const t of rec.templates.slice(0, 500)) {
    if (!t || typeof t !== "object") continue;
    const r: Record<string, unknown> = { ...t };
    if (typeof r.path !== "string" || !r.path || CONTROL.test(r.path)) continue;
    templates.push({ path: r.path.slice(0, 500), name: bounded(r.name, 120) || r.path.slice(0, 120), sizeBytes: typeof r.sizeBytes === "number" && Number.isFinite(r.sizeBytes) ? r.sizeBytes : 0 });
  }
  const folders = Array.isArray(rec.folders) ? rec.folders.filter((f): f is string => typeof f === "string" && !CONTROL.test(f)).slice(0, 100).map((f) => f.slice(0, 500)) : [];
  return { templates, folders };
}

const JOB_STATES: readonly string[] = ["queued", "running", "done", "failed", "cancelled"];
const STAGES: readonly string[] = ["render", "compose", "done"];

export function parseAvatarJob(raw: unknown): AvatarJobStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec: Record<string, unknown> = { ...raw };
  if (typeof rec.id !== "string" || typeof rec.state !== "string" || !JOB_STATES.includes(rec.state)) return null;
  const outputs: Record<string, unknown> = rec.outputs && typeof rec.outputs === "object" ? { ...rec.outputs } : {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const error = bounded(rec.error);
  const renderMs = num(rec.renderMs);
  const composeMs = num(rec.composeMs);
  return {
    id: rec.id.slice(0, 80),
    state: rec.state as AvatarJobState,
    stage: (typeof rec.stage === "string" && STAGES.includes(rec.stage) ? rec.stage : "render") as AvatarJobStatus["stage"],
    message: bounded(rec.message),
    ...(error ? { error } : {}),
    ...(renderMs !== undefined ? { renderMs } : {}),
    ...(composeMs !== undefined ? { composeMs } : {}),
    outputs: { avatar: outputs.avatar === true, composed: outputs.composed === true },
  };
}

const TUNING_NUMBERS = ["extraMargin", "leftCheekWidth", "rightCheekWidth", "steps", "guidanceScale", "audioGuidanceScale"] as const;

/** Validate a caller's render request into the contract's `spec` field. Fail-closed: an unknown engine, a
 *  missing or control-character template path, or a non-numeric tuning value refuses the whole request. */
export function buildAvatarSpec(input: { engine?: unknown; templatePath?: unknown; tuning?: unknown; compose?: unknown }): { ok: true; spec: AvatarJobSpec } | { ok: false; error: string } {
  if (input.engine !== "musetalk" && input.engine !== "echomimic") return { ok: false, error: "engine must be musetalk or echomimic." };
  if (typeof input.templatePath !== "string" || !input.templatePath.trim()) return { ok: false, error: "Pick a template clip on the box (templatePath)." };
  if (CONTROL.test(input.templatePath) || input.templatePath.length > 500) return { ok: false, error: "That template path carries control characters or is too long." };
  const spec: AvatarJobSpec = { engine: input.engine, templatePath: input.templatePath.trim() };
  if (input.tuning !== undefined && input.tuning !== null) {
    if (typeof input.tuning !== "object" || Array.isArray(input.tuning)) return { ok: false, error: "tuning must be an object." };
    const t: Record<string, unknown> = { ...input.tuning };
    const tuning: AvatarTuning = {};
    for (const k of TUNING_NUMBERS) {
      if (t[k] === undefined) continue;
      const v = t[k];
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `tuning.${k} must be a number.` };
      tuning[k] = v;
    }
    if (t.parsingMode !== undefined) {
      if (typeof t.parsingMode !== "string" || CONTROL.test(t.parsingMode)) return { ok: false, error: "tuning.parsingMode must be plain text." };
      tuning.parsingMode = t.parsingMode.slice(0, 40);
    }
    if (t.prompt !== undefined) {
      if (typeof t.prompt !== "string") return { ok: false, error: "tuning.prompt must be text." };
      tuning.prompt = t.prompt.slice(0, 2000);
    }
    if (Object.keys(tuning).length) spec.tuning = tuning;
  }
  if (input.compose !== undefined && input.compose !== null) {
    if (typeof input.compose !== "object" || Array.isArray(input.compose)) return { ok: false, error: "compose must be an object." };
    const c: Record<string, unknown> = { ...input.compose };
    const compose: AvatarCompose = {};
    if (typeof c.title === "string" && c.title.trim()) compose.title = c.title.trim().slice(0, 200);
    if (typeof c.subtitle === "string" && c.subtitle.trim()) compose.subtitle = c.subtitle.trim().slice(0, 200);
    if (typeof c.captionText === "string" && c.captionText.trim()) compose.captionText = c.captionText.trim().slice(0, 8000);
    if (Object.keys(compose).length) spec.compose = compose;
  }
  return { ok: true, spec };
}

export interface DgxAvatarClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  /** Per-call budgets in ms. The video download is the long one. */
  readonly timeouts?: Partial<Record<"health" | "templates" | "submit" | "job" | "video", number>>;
}

const DEFAULT_TIMEOUTS = { health: 8_000, templates: 15_000, submit: 120_000, job: 15_000, video: 300_000 };

/** The client. Never throws: a dead box is a result, not an exception. */
export class DgxAvatarClient {
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #t: typeof DEFAULT_TIMEOUTS;

  constructor(opts: DgxAvatarClientOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#t = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  }

  async #json(path: string, init: RequestInit, timeoutMs: number): Promise<ClientResult<unknown>> {
    let res: Response;
    try { res = await this.#fetch(`${this.#base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { return { ok: false, error: `${this.#base} did not answer.` }; }
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const remote = body && typeof body === "object" && "error" in body ? bounded(body.error) : "";
      return { ok: false, status: res.status, error: remote ? `the avatar service answered ${res.status}: ${remote}` : `the avatar service answered ${res.status}.` };
    }
    return { ok: true, data: body };
  }

  async health(): Promise<ClientResult<AvatarHealth>> {
    const r = await this.#json("/health", { method: "GET" }, this.#t.health);
    if (!r.ok) return r;
    const h = parseAvatarHealth(r.data);
    return h ? { ok: true, data: h } : { ok: false, error: `${this.#base} answered, but not as the dgx-avatar service.` };
  }

  async templates(engine: AvatarEngine): Promise<ClientResult<AvatarTemplates>> {
    const r = await this.#json(`/v1/templates?engine=${encodeURIComponent(engine)}`, { method: "GET" }, this.#t.templates);
    if (!r.ok) return r;
    const t = parseAvatarTemplates(r.data);
    return t ? { ok: true, data: t } : { ok: false, error: "the template list was not in the expected shape." };
  }

  /** POST /v1/jobs (multipart): `audio` = the WAV, `spec` = the JSON spec. 409 = the single worker is busy. */
  async submit(wav: Uint8Array, spec: AvatarJobSpec): Promise<ClientResult<{ jobId: string }>> {
    const form = new FormData();
    form.append("audio", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    form.append("spec", JSON.stringify(spec));
    const r = await this.#json("/v1/jobs", { method: "POST", body: form }, this.#t.submit);
    if (!r.ok) return r.status === 409 ? { ok: false, status: 409, error: `The avatar render queue is full (one GPU render at a time). ${r.error}` } : r;
    const jobId = r.data && typeof r.data === "object" && "jobId" in r.data && typeof r.data.jobId === "string" ? r.data.jobId : "";
    if (!jobId || CONTROL.test(jobId) || jobId.length > 80) return { ok: false, error: "the avatar service accepted the job but returned no usable job id." };
    return { ok: true, data: { jobId } };
  }

  async job(id: string): Promise<ClientResult<AvatarJobStatus>> {
    const r = await this.#json(`/v1/jobs/${encodeURIComponent(id)}`, { method: "GET" }, this.#t.job);
    if (!r.ok) return r;
    const j = parseAvatarJob(r.data);
    return j ? { ok: true, data: j } : { ok: false, error: "the job status was not in the expected shape." };
  }

  async cancel(id: string): Promise<ClientResult<{ ok: boolean }>> {
    const r = await this.#json(`/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }, this.#t.job);
    if (!r.ok) return r;
    return { ok: true, data: { ok: !!r.data && typeof r.data === "object" && "ok" in r.data && r.data.ok === true } };
  }

  /** GET /v1/jobs/{id}/video?variant= -> MP4 bytes. The mime is pinned to video/mp4 by the contract. */
  async video(id: string, variant: AvatarVariant): Promise<ClientResult<{ bytes: Uint8Array; mime: "video/mp4" }>> {
    let res: Response;
    try { res = await this.#fetch(`${this.#base}/v1/jobs/${encodeURIComponent(id)}/video?variant=${variant}`, { method: "GET", signal: AbortSignal.timeout(this.#t.video) }); }
    catch { return { ok: false, error: `${this.#base} did not answer the video download.` }; }
    if (!res.ok) return { ok: false, status: res.status, error: `the avatar service answered ${res.status} for the ${variant} video.` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return { ok: false, error: `the ${variant} video came back empty.` };
    return { ok: true, data: { bytes, mime: "video/mp4" } };
  }
}
