// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_dgx_cad.ts - the HTTP client for the DGX Loader's CAD service (contract section 2c).
//
// The service runs on a DGX box bound to 127.0.0.1:8089 and is reached through the Loader's SSH forward.
// Three rules hold here:
//   * A MODEL RUN EXECUTES THE USER'S PYTHON on the box, so the request body only ever carries
//     `approved: true` when the caller hands in the exec-approval decision. There is no other way to build
//     that body (`modelRunBody` takes the approval as a required literal), and the route refuses first.
//   * Every upload is bounded (200 MB, the service's own cap) and named by a bare file name with a known
//     extension; a path or an unknown type is refused before any byte leaves this machine.
//   * Remote text (errors, logs, layer names) is bounded untrusted data. The inspect result is passed through
//     as the service shaped it, after a kind check, because the pane renders it and never executes it.

import type { CreatorCapabilityId } from "./creator_registry.ts";
import type { FetchLike } from "./creator_probe.ts";

export type CadOutput = "step" | "stl" | "svg" | "dxf";
export const CAD_OUTPUTS: readonly CadOutput[] = ["step", "stl", "svg", "dxf"] as const;
export const CAD_INSPECT_EXTENSIONS: readonly string[] = [".dxf", ".dwg", ".ifc", ".step", ".stp"] as const;
export const CAD_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const CAD_MAX_SCRIPT_CHARS = 200_000;
export const CAD_MAX_TIMEOUT_SEC = 120;

export interface CadHealth {
  readonly ok: true;
  readonly service: "dgx-cad";
  readonly version: string;
  readonly capabilities: { readonly model: boolean; readonly dxf: boolean; readonly ifc: boolean; readonly dwg: boolean };
  readonly detail: { readonly model?: string; readonly dxf?: string; readonly ifc?: string; readonly dwg?: string };
}

export interface CadArtifactRef { readonly id: string; readonly name: string; readonly kind: string; readonly bytes: number }
export interface CadModelResult {
  readonly ok: boolean;
  readonly artifacts: readonly CadArtifactRef[];
  readonly svg?: string;
  readonly log: string;
  readonly error?: string;
}

export interface CadModelRequest { readonly script: string; readonly outputs: readonly CadOutput[]; readonly timeoutSec: number }

export type ClientResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

const CONTROL = /[\u0000-\u001f\u007f]/;
const bounded = (v: unknown, max = 300): string => (typeof v === "string" ? v.slice(0, max) : "");
/** The service names artifacts by a 32-hex id (contract: ~/dgx-rag-lake/cad/artifacts/<32-hex id>/). */
export const CAD_ARTIFACT_ID = /^[0-9a-f]{32}$/;

export function parseCadHealth(raw: unknown): CadHealth | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec: Record<string, unknown> = { ...raw };
  if (rec.ok !== true || rec.service !== "dgx-cad") return null;
  const caps: Record<string, unknown> = rec.capabilities && typeof rec.capabilities === "object" ? { ...rec.capabilities } : {};
  const det: Record<string, unknown> = rec.detail && typeof rec.detail === "object" ? { ...rec.detail } : {};
  const detail: { model?: string; dxf?: string; ifc?: string; dwg?: string } = {};
  for (const k of ["model", "dxf", "ifc", "dwg"] as const) { const d = bounded(det[k]); if (d) detail[k] = d; }
  return {
    ok: true,
    service: "dgx-cad",
    version: bounded(rec.version, 40),
    capabilities: { model: caps.model === true, dxf: caps.dxf === true, ifc: caps.ifc === true, dwg: caps.dwg === true },
    detail,
  };
}

/** What a health answer PROVES, as Creator capability ids. */
export function cadHealthCapabilities(h: CadHealth): CreatorCapabilityId[] {
  const out: CreatorCapabilityId[] = [];
  if (h.capabilities.model) out.push("cad-model");
  if (h.capabilities.dxf) out.push("cad-drawing");
  if (h.capabilities.dwg) out.push("cad-convert");
  if (h.capabilities.ifc) out.push("bim-inspect");
  return out;
}

/** A bare upload file name with a known extension, or the reason it is refused. */
export function checkInspectName(name: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof name !== "string" || !name.trim()) return { ok: false, error: "Name the file being inspected (name=drawing.dxf)." };
  const n = name.trim();
  if (n.length > 200 || CONTROL.test(n) || /[\\/]/.test(n) || n === "." || n === "..") return { ok: false, error: "The file name must be a bare name, not a path." };
  const dot = n.lastIndexOf(".");
  const ext = dot >= 0 ? n.slice(dot).toLowerCase() : "";
  if (!CAD_INSPECT_EXTENSIONS.includes(ext)) return { ok: false, error: `Only ${CAD_INSPECT_EXTENSIONS.join(", ")} files can be inspected.` };
  return { ok: true, name: n };
}

/** Validate a model-run request. Fail-closed: no script, an unknown output, or a bad timeout refuses. */
export function buildCadModelRequest(input: { script?: unknown; outputs?: unknown; timeoutSec?: unknown }): { ok: true; request: CadModelRequest } | { ok: false; error: string } {
  if (typeof input.script !== "string" || !input.script.trim()) return { ok: false, error: "Send the CadQuery or build123d script; it must assign `result`." };
  if (input.script.length > CAD_MAX_SCRIPT_CHARS) return { ok: false, error: `That script is over ${CAD_MAX_SCRIPT_CHARS} characters.` };
  if (input.script.includes("\u0000")) return { ok: false, error: "That script carries a NUL byte." };
  if (!Array.isArray(input.outputs) || !input.outputs.length) return { ok: false, error: `Pick at least one output: ${CAD_OUTPUTS.join(", ")}.` };
  const outputs: CadOutput[] = [];
  for (const o of input.outputs) {
    if (typeof o !== "string" || !(CAD_OUTPUTS as readonly string[]).includes(o)) return { ok: false, error: `Unknown output ${JSON.stringify(o).slice(0, 40)}; pick from ${CAD_OUTPUTS.join(", ")}.` };
    if (!outputs.includes(o as CadOutput)) outputs.push(o as CadOutput);
  }
  let timeoutSec = 60;
  if (input.timeoutSec !== undefined) {
    if (typeof input.timeoutSec !== "number" || !Number.isFinite(input.timeoutSec) || input.timeoutSec < 1 || input.timeoutSec > CAD_MAX_TIMEOUT_SEC) {
      return { ok: false, error: `timeoutSec must be between 1 and ${CAD_MAX_TIMEOUT_SEC}.` };
    }
    timeoutSec = Math.trunc(input.timeoutSec);
  }
  return { ok: true, request: { script: input.script, outputs, timeoutSec } };
}

/** The ONLY way to build a /v1/model/run body. `approval` is the exec-approval decision; the type admits
 *  nothing but `true`, so an unapproved body cannot be expressed. */
export interface CadModelRunBody { readonly script: string; readonly outputs: CadOutput[]; readonly timeoutSec: number; readonly approved: true }
export function modelRunBody(req: CadModelRequest, approval: true): CadModelRunBody {
  return { script: req.script, outputs: [...req.outputs], timeoutSec: req.timeoutSec, approved: approval };
}

export function parseCadModelResult(raw: unknown): CadModelResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec: Record<string, unknown> = { ...raw };
  if (typeof rec.ok !== "boolean") return null;
  const artifacts: CadArtifactRef[] = [];
  for (const a of Array.isArray(rec.artifacts) ? rec.artifacts.slice(0, 16) : []) {
    if (!a || typeof a !== "object") continue;
    const r: Record<string, unknown> = { ...a };
    if (typeof r.id !== "string" || !CAD_ARTIFACT_ID.test(r.id)) continue;
    artifacts.push({ id: r.id, name: bounded(r.name, 120), kind: bounded(r.kind, 20), bytes: typeof r.bytes === "number" && Number.isFinite(r.bytes) ? r.bytes : 0 });
  }
  const svg = typeof rec.svg === "string" ? rec.svg.slice(0, 5_000_000) : undefined;
  const error = bounded(rec.error, 2000);
  return { ok: rec.ok, artifacts, ...(svg ? { svg } : {}), log: bounded(rec.log, 20_000), ...(error ? { error } : {}) };
}

/** An inspect result must at least say which kind it is; the rest is passed through for the pane. */
export function parseCadInspect(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec: Record<string, unknown> = { ...raw };
  return rec.kind === "dxf" || rec.kind === "ifc" || rec.kind === "step" ? rec : null;
}

export interface DgxCadClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly timeouts?: Partial<Record<"health" | "inspect" | "model" | "artifact", number>>;
}

const DEFAULT_TIMEOUTS = { health: 8_000, inspect: 300_000, model: 180_000, artifact: 120_000 };

export class DgxCadClient {
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #t: typeof DEFAULT_TIMEOUTS;

  constructor(opts: DgxCadClientOptions) {
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
      return { ok: false, status: res.status, error: remote ? `the CAD service answered ${res.status}: ${remote}` : `the CAD service answered ${res.status}.` };
    }
    return { ok: true, data: body };
  }

  async health(): Promise<ClientResult<CadHealth>> {
    const r = await this.#json("/health", { method: "GET" }, this.#t.health);
    if (!r.ok) return r;
    const h = parseCadHealth(r.data);
    return h ? { ok: true, data: h } : { ok: false, error: `${this.#base} answered, but not as the dgx-cad service.` };
  }

  /** POST /v1/inspect?name= with the raw file bytes. */
  async inspect(name: string, bytes: Uint8Array): Promise<ClientResult<Record<string, unknown>>> {
    const n = checkInspectName(name);
    if (!n.ok) return n;
    if (!bytes.length) return { ok: false, error: "That file is empty." };
    if (bytes.length > CAD_MAX_UPLOAD_BYTES) return { ok: false, error: "That file is over the 200 MB inspect limit." };
    const r = await this.#json(`/v1/inspect?name=${encodeURIComponent(n.name)}`, { method: "POST", body: bytes, headers: { "content-type": "application/octet-stream" } }, this.#t.inspect);
    if (!r.ok) return r;
    const out = parseCadInspect(r.data);
    return out ? { ok: true, data: out } : { ok: false, error: "the inspect result did not name a known kind." };
  }

  /** POST /v1/model/run. Only reachable with a body built by `modelRunBody`, i.e. after exec approval. */
  async modelRun(body: CadModelRunBody): Promise<ClientResult<CadModelResult>> {
    const r = await this.#json("/v1/model/run", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, this.#t.model);
    if (!r.ok) return r;
    const out = parseCadModelResult(r.data);
    return out ? { ok: true, data: out } : { ok: false, error: "the model run result was not in the expected shape." };
  }

  /** GET /v1/artifacts/{id} -> bytes, with the service's content type and file name. */
  async artifact(id: string): Promise<ClientResult<{ bytes: Uint8Array; mime: string; filename: string }>> {
    if (!CAD_ARTIFACT_ID.test(id)) return { ok: false, error: "That is not a CAD artifact id." };
    let res: Response;
    try { res = await this.#fetch(`${this.#base}/v1/artifacts/${id}`, { method: "GET", signal: AbortSignal.timeout(this.#t.artifact) }); }
    catch { return { ok: false, error: `${this.#base} did not answer the artifact download.` }; }
    if (!res.ok) return { ok: false, status: res.status, error: `the CAD service answered ${res.status} for that artifact.` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().slice(0, 100) || "application/octet-stream";
    const disp = res.headers.get("content-disposition") ?? "";
    const m = disp.match(/filename="?([^";\r\n]+)"?/i);
    const filename = m && !/[\\/]/.test(m[1]!) ? m[1]!.slice(0, 120) : `${id}.bin`;
    return { ok: true, data: { bytes, mime, filename } };
  }
}
