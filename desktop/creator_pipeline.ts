// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_pipeline.ts - CREATOR-3 (ADR-0287): the video and 3D render pipeline.
//
// CREATOR-IMG could ask ComfyUI for a still. This is the same conversation carried through to the outputs a
// modern install actually produces (animated webp/png, webm, mp4, glb) plus the two things that were missing
// from the still path and are load-bearing here:
//
//   * A PROBE GATE. A render is refused before a single byte leaves this machine unless the capability the
//     caller asked for was ATTESTED by a live, unexpired probe (CREATOR-1). `configured` is not `ready`, and
//     "the node is probably installed" is not a capability.
//   * A SCAN GATE, fail-closed (invariant 3). Every string a remote server hands back travels with the
//     artifact into the library and, later, into a prompt: the filename, the subfolder, the output key, the
//     content type it claimed. Those are UNTRUSTED INPUT (invariant 5). They are scanned BEFORE the bytes
//     are written, and a scanner that is dead, slow, or malformed BLOCKS the artifact. There is no path
//     through this module where "could not scan" reads as "fine".
//
// Two more honesty rules the tests pin:
//
//   * THE BYTES DECIDE THEIR OWN TYPE. A server's `content-type` header is a claim. `sniffMime` reads the
//     magic bytes, a contradiction is refused by name, and bytes LUCID cannot identify are refused rather
//     than stored under a guessed extension.
//   * /history IS THE AUTHORITY, THE WEBSOCKET IS TELEMETRY. The `/ws` stream makes a long render legible
//     (which node, which step, previews) but it never decides what was produced: a socket that goes silent,
//     lies, or carries another client's frames cannot change the outcome, and cannot hang the render.
//
// I/O lives here; every dependency is injected, so the whole pipeline runs in a unit test with no server, no
// disk, and no clock.

import {
  applyWorkflowTemplate, storeArtifact,
  type ArtifactIo, type ArtifactKind, type CompositionSpec, type CreatorArtifact,
} from "./creator_image.ts";
import {
  applyComfyEvent, decodeComfyFrame, mimeMismatch, newStreamState, sniffMime, wsUrlFor,
  type ComfyOutputRef, type MediaKind, type StreamState,
} from "../harness/creator/comfy_stream.ts";
import {
  createJob, finishJob, recordJobArtifact, startJob,
  type CreatorJobKind, type JobAdmissionSnapshot, type JobIo,
} from "./creator_jobs.ts";

// ── the seams this module is given ──────────────────────────────────────────

/** Structurally what `harness/security/gate.ts`'s `scanAndDecide` returns. Declared here as an interface so
 *  the pipeline can be handed a fake in a test and the real fail-closed gate in dev.ts, without this module
 *  reaching into the scanner's transport. */
export interface ScanVerdict {
  readonly block: boolean;
  readonly reason: string;
  readonly trustLabel: string;
  readonly failClosed: boolean;
}

/** A scan call that may reject. A REJECTION IS A BLOCK: `scanMetadata` converts a thrown error into a
 *  fail-closed verdict rather than letting it escape, because an exception that unwinds past a security gate
 *  is the same bug as a gate that returns "allow". */
export type ScanLike = (text: string) => Promise<ScanVerdict>;

/** The subset of `ComfyClient` this pipeline uses. A structural type, so a test passes a plain object. */
export interface ComfyLike {
  readonly baseUrl: string;
  submit(workflow: unknown, opts?: { clientId?: string }): Promise<{ ok: boolean; promptId?: string; error?: string }>;
  waitForOutputs(promptId: string, opts?: { want?: MediaKind; pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }):
    Promise<{ ok: boolean; refs?: readonly ComfyOutputRef[]; error?: string }>;
  fetchImage(ref: { readonly filename: string; readonly subfolder: string; readonly type: string }):
    Promise<{ ok: boolean; bytes?: Uint8Array; mime?: string; error?: string }>;
}

/** Raw `/ws` frames, in arrival order. An async iterable so the caller owns the socket's lifetime: the
 *  pipeline itself never opens, closes, or reconnects anything. */
export type ProgressFeed = AsyncIterable<string | Uint8Array>;

/** A live `/ws` connection: the frames, plus the handle that ends them. */
export interface ProgressSocket { readonly feed: ProgressFeed; close(): void }

/** How long a stream may say NOTHING before LUCID stops listening. The socket is telemetry, so going quiet
 *  ENDS the feed and the render settles on `/history` instead of hanging. */
export const PROGRESS_IDLE_MS = 45_000;
/** A bound on buffered frames. A chatty (or shared) socket can outrun the drain; dropping the OLDEST frame
 *  keeps the newest progress rather than pinning memory. */
export const PROGRESS_QUEUE_MAX = 512;

/**
 * Open ComfyUI's `/ws` for one render and expose it as an async iterable of raw frames.
 *
 * The credential rides the handshake HEADER: `wsUrlFor` refuses to carry it in the query string, so a token
 * can never end up in a server log. An idle or dead socket ENDS the feed rather than blocking, which is what
 * makes the pipeline's "telemetry cannot hang a render" claim structural instead of aspirational. The caller
 * closes it in a `finally`; an unclosed socket would outlive the render it was describing.
 *
 * Returns null when the base URL cannot carry a websocket, so a caller degrades to polling with no branch.
 */
export function openComfyProgress(
  baseUrl: string,
  token: string,
  clientId: string,
  opts: { idleMs?: number; queueMax?: number } = {},
): ProgressSocket | null {
  const url = wsUrlFor(baseUrl, clientId);
  if (!url) return null;
  const idleMs = Math.max(1, opts.idleMs ?? PROGRESS_IDLE_MS);
  const queueMax = Math.max(1, opts.queueMax ?? PROGRESS_QUEUE_MAX);
  let ws: WebSocket;
  try { ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined); }
  catch { return null; }
  ws.binaryType = "arraybuffer";
  const queue: (string | Uint8Array)[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const nudge = (): void => { const w = wake; wake = null; w?.(); };
  ws.onmessage = (ev: MessageEvent) => {
    queue.push(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
    if (queue.length > queueMax) queue.shift();
    nudge();
  };
  ws.onclose = () => { ended = true; nudge(); };
  ws.onerror = () => { ended = true; nudge(); };
  const feed: ProgressFeed = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) {
          const frame = queue.shift();
          if (frame !== undefined) yield frame;
        }
        if (ended) return;
        const { promise, resolve } = Promise.withResolvers<void>();
        wake = resolve;
        const idle = setTimeout(() => { ended = true; nudge(); }, idleMs);
        await promise;
        clearTimeout(idle);
      }
    },
  };
  return { feed, close: () => { ended = true; try { ws.close(); } catch { /* already gone */ } nudge(); } };
}

export interface PipelineDeps {
  readonly client: ComfyLike;
  readonly artifactIo: ArtifactIo;
  readonly jobIo: JobIo;
  readonly scan: ScanLike;
  readonly now: () => number;
}

// ── input and result ────────────────────────────────────────────────────────

export interface RenderPipelineInput {
  /** What the caller asked for. A finished workflow that produced something else is a REFUSAL, never a
   *  substitution: a still image is not the answer to a video request. */
  readonly kind: MediaKind;
  /** The USER's exported workflow ("Save (API Format)"). LUCID never synthesizes a graph. */
  readonly workflow: unknown;
  readonly spec: CompositionSpec;
  /** Capabilities a live, unexpired probe ATTESTED, i.e. `ProbeCache.discovered(providerId, now)`. An empty
   *  list means the probe expired or never ran, and every render is refused. */
  readonly attested: readonly string[];
  /** The governor's measurement. `null` means admission was never consulted, which is itself a refusal. */
  readonly admission: JobAdmissionSnapshot | null;
  readonly label?: string;
  readonly maxArtifacts?: number;
  readonly feed?: ProgressFeed;
  /** Identifies this caller to ComfyUI so `/ws` frames are addressed to us rather than broadcast. Required
   *  for `feed` to carry OUR render's frames; pointless without it. */
  readonly clientId?: string;
  readonly poll?: { pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> };
}

/** Where the pipeline stopped. A caller shows this verbatim, so a failure is never "something went wrong". */
export type PipelineStage =
  | "capability" | "admission" | "template" | "submit" | "wait" | "fetch" | "scan" | "store" | "done";

export interface StoredMedia {
  readonly artifact: CreatorArtifact;
  readonly path: string;
  readonly ref: ComfyOutputRef;
  /** The mime the BYTES proved, which is not always the one the server claimed. */
  readonly mime: string;
  /** The scan verdict's own words for the metadata that travelled with this artifact. */
  readonly scanned: string;
}

export interface RefusedMedia {
  readonly filename: string;
  readonly reason: string;
}

export interface RenderPipelineResult {
  readonly ok: boolean;
  readonly error: string;
  readonly jobId: string;
  readonly promptId: string;
  readonly stage: PipelineStage;
  readonly kind: MediaKind;
  readonly media: readonly StoredMedia[];
  /** Outputs the server produced that LUCID would not store, each with the reason. Never silently dropped. */
  readonly refused: readonly RefusedMedia[];
  readonly unresolved: readonly string[];
  readonly progress: StreamState | null;
  readonly note: string;
}

const MAX_ARTIFACTS = 8;

/** The capability id (CREATOR-1's closed set) each request kind requires a probe to have attested. */
const CAPABILITY_FOR: Record<MediaKind, string> = { image: "image", video: "video", "model-3d": "model-3d" };

/** The artifact kind each request kind stores as. `model-3d` is spelled the same on both sides; `image` and
 *  `video` are not, so the map is explicit rather than a cast. */
const ARTIFACT_KIND_FOR: Record<MediaKind, ArtifactKind> = { image: "image", video: "video", "model-3d": "model-3d" };

/** A render is a `render` job for video and 3D. A still keeps CREATOR-IMG's `image` kind so the existing
 *  ledger reads consistently. `CreatorJobKind` is closed: nothing here invents a member. */
const JOB_KIND_FOR: Record<MediaKind, CreatorJobKind> = { image: "image", video: "render", "model-3d": "render" };

// ── progress: telemetry, never authority ────────────────────────────────────

/** Fold a `/ws` feed into progress state. Terminates when the stream reports a terminal state for THIS
 *  prompt, when `budget` frames have passed (a noisy shared socket cannot spin forever), or when the feed
 *  ends. It never throws: a feed that rejects mid-iteration returns the last good state, because progress
 *  telemetry failing must not fail a render that is genuinely running. */
export async function trackProgress(
  promptId: string,
  feed: ProgressFeed,
  opts: { onState?: (s: StreamState) => void; budget?: number } = {},
): Promise<StreamState> {
  const budget = Math.max(1, opts.budget ?? 4096);
  let state = newStreamState(promptId);
  let seen = 0;
  try {
    for await (const raw of feed) {
      state = applyComfyEvent(state, decodeComfyFrame(raw));
      opts.onState?.(state);
      if (state.status === "done" || state.status === "error" || state.status === "interrupted") break;
      if (++seen >= budget) break;
    }
  } catch { /* a dead socket is a loss of visibility, not a loss of the render */ }
  return state;
}

// ── the scan gate ───────────────────────────────────────────────────────────

/** Everything a remote server said about one output, as one delimited block of DATA. The delimiters are the
 *  same contract the prompt path uses (invariant 5): the content inside is never instructions. */
export function metadataBlock(ref: ComfyOutputRef, claimedMime: string, source: string): string {
  return [
    "UNTRUSTED_CONTENT_START",
    `source: ${source}`,
    `filename: ${ref.filename}`,
    `subfolder: ${ref.subfolder}`,
    `type: ${ref.type}`,
    `output-key: ${ref.key}`,
    `claimed-mime: ${claimedMime}`,
    "UNTRUSTED_CONTENT_END",
  ].join("\n");
}

/** Scan one output's metadata, fail-closed. A thrown scanner error, a missing verdict, or a malformed
 *  verdict all BLOCK. This is the only place in the pipeline that talks to the scanner, so the law is
 *  enforced in one readable function. */
export async function scanMetadata(scan: ScanLike, text: string): Promise<ScanVerdict> {
  try {
    const v = await scan(text);
    if (!v || typeof v.block !== "boolean") {
      return { block: true, reason: "fail-closed: the scanner returned no usable verdict", trustLabel: "quarantined", failClosed: true };
    }
    return v;
  } catch (err) {
    return { block: true, reason: `fail-closed: scan unavailable (${String(err)})`, trustLabel: "quarantined", failClosed: true };
  }
}

// ── the pipeline ────────────────────────────────────────────────────────────

const fail = (
  stage: PipelineStage, error: string, kind: MediaKind,
  extra: Partial<RenderPipelineResult> = {},
): RenderPipelineResult => ({
  ok: false, error, jobId: "", promptId: "", stage, kind,
  media: [], refused: [], unresolved: [], progress: null, note: "",
  ...extra,
});

/**
 * Run one video, 3D, or still render end to end: gate on the probe, gate on the governor, substitute the
 * user's template, submit, watch, read every output back, prove each one's type from its own bytes, scan the
 * metadata fail-closed, store with provenance, and record the artifacts against the job.
 *
 * Returns a result object; it never throws. Every refusal names the stage and the reason.
 */
export async function runRenderPipeline(
  deps: PipelineDeps,
  base: string,
  input: RenderPipelineInput,
): Promise<RenderPipelineResult> {
  const { client, jobIo, artifactIo } = deps;
  const kind = input.kind;
  const source = `comfyui ${client.baseUrl}`;
  const label = (input.label ?? `${kind} render`).slice(0, 120);

  // 1. The probe gate, BEFORE anything leaves this machine. An expired probe reports nothing attested, so
  //    this is also what makes a stale capability refuse rather than get taken on faith.
  const needed = CAPABILITY_FOR[kind];
  if (!input.attested.includes(needed)) {
    const saw = input.attested.length ? input.attested.join(", ") : "nothing";
    return fail("capability", `No live probe has attested ${needed} on this ComfyUI install (attested: ${saw}). Re-probe the provider, then try again.`, kind);
  }

  // 2. The governor. A refused admission is written down as a `refused` job with the measurement that
  //    refused it, so "why did this not run?" is answerable later from the ledger alone.
  if (!input.admission) {
    return fail("admission", "That render did not consult the resource governor, so it was not started.", kind);
  }
  if (!input.admission.ok) {
    const job = createJob(jobIo, base, { kind: JOB_KIND_FOR[kind], label, provider: "comfyui", admission: input.admission });
    return fail("admission", input.admission.reason, kind, { jobId: job.id });
  }

  // 3. The user's template, substituted. An unresolved placeholder is a refusal: LUCID does not guess a
  //    seed, a model, or an input image, and it does not submit a graph with a hole in it.
  const tpl = applyWorkflowTemplate(input.workflow, input.spec);
  if (tpl.unresolved.length) {
    return fail("template", `That workflow still needs ${tpl.unresolved.join(", ")}. Fill those in, or pick a template that does not ask for them.`, kind, { unresolved: tpl.unresolved });
  }

  const job = createJob(jobIo, base, { kind: JOB_KIND_FOR[kind], label, provider: "comfyui", admission: input.admission });
  startJob(jobIo, base, job.id, input.admission);
  const done = (ok: boolean, error: string): void => { finishJob(jobIo, base, job.id, ok ? "done" : "failed", error); };

  // 4. Submit. ComfyUI's own refusal is passed through in its own words.
  const sub = await client.submit(tpl.workflow, input.clientId ? { clientId: input.clientId } : {});
  if (!sub.ok || !sub.promptId) {
    const error = sub.error ?? "ComfyUI did not return a prompt id";
    done(false, error);
    return fail("submit", error, kind, { jobId: job.id });
  }
  const promptId = sub.promptId;

  // 5. Watch, if the caller opened a socket. The drain runs CONCURRENTLY and is never awaited: a socket
  //    that goes silent, floods, or dies must not be able to delay or fail a render that /history can still
  //    settle. `progress` is whatever the stream had reached when the poll below returned, which is exactly
  //    what telemetry means. The caller owns closing the socket, which is what ends the drain.
  let progress: StreamState | null = null;
  if (input.feed) {
    progress = newStreamState(promptId);
    void trackProgress(promptId, input.feed, { onState: (s) => { progress = s; } });
  }

  // 6. The authority. `want` narrows to the kind asked for, so a workflow that produced stills when video
  //    was requested fails by name instead of handing back a PNG.
  const waited = await client.waitForOutputs(promptId, { want: kind, ...input.poll, now: deps.now });
  if (!waited.ok || !waited.refs?.length) {
    const error = waited.error ?? "that render produced no output";
    done(false, error);
    return fail("wait", error, kind, { jobId: job.id, promptId, progress });
  }

  // 7. Read each output back, prove its type, scan its metadata, then store it.
  const cap = Math.max(1, Math.min(input.maxArtifacts ?? MAX_ARTIFACTS, MAX_ARTIFACTS));
  const media: StoredMedia[] = [];
  const refused: RefusedMedia[] = [];
  let blockedByScan = "";

  for (const ref of waited.refs.slice(0, cap)) {
    const got = await client.fetchImage(ref);
    if (!got.ok || !got.bytes?.length) {
      refused.push({ filename: ref.filename, reason: got.error ?? "that output read back empty" });
      continue;
    }
    const claimed = got.mime ?? "";

    // The bytes decide. A header that contradicts them is refused by name, and bytes LUCID cannot identify
    // are refused rather than stored under a guessed extension.
    const lie = mimeMismatch(claimed, got.bytes);
    if (lie) { refused.push({ filename: ref.filename, reason: lie }); continue; }
    const proven = sniffMime(got.bytes);
    if (!proven) {
      refused.push({ filename: ref.filename, reason: `LUCID could not identify those bytes (the server called them ${claimed || "nothing"}), so it did not store them.` });
      continue;
    }

    // The scan gate. Fail-closed: a dead scanner stops the artifact here, and the job says so.
    const verdict = await scanMetadata(deps.scan, metadataBlock(ref, claimed, source));
    if (verdict.block) {
      const why = `${ref.filename}: ${verdict.reason}`;
      refused.push({ filename: ref.filename, reason: verdict.reason });
      if (verdict.failClosed || !blockedByScan) blockedByScan = why;
      continue;
    }

    const stored = storeArtifact(artifactIo, base, {
      kind: ARTIFACT_KIND_FOR[kind],
      bytes: got.bytes,
      mime: proven,
      width: 0,
      height: 0,
      source,
      prompt: input.spec.prompt,
      model: input.spec.model ?? "",
    });
    if (!stored.ok || !stored.artifact || !stored.path) {
      refused.push({ filename: ref.filename, reason: stored.error ?? "that artifact could not be stored" });
      continue;
    }
    recordJobArtifact(jobIo, base, job.id, stored.artifact.id);
    media.push({ artifact: stored.artifact, path: stored.path, ref, mime: proven, scanned: verdict.reason });
  }

  if (!media.length) {
    const error = blockedByScan
      ? `Nothing was stored: ${blockedByScan}`
      : `That render finished but none of its ${waited.refs.length} output(s) could be stored: ${refused.map((r) => r.reason).join("; ") || "no reason reported"}`;
    done(false, error);
    return fail(blockedByScan ? "scan" : "store", error, kind, { jobId: job.id, promptId, progress, refused });
  }

  done(true, "");
  const skipped = refused.length ? `, ${refused.length} refused` : "";
  return {
    ok: true,
    error: "",
    jobId: job.id,
    promptId,
    stage: "done",
    kind,
    media,
    refused,
    unresolved: [],
    progress,
    // The note states what was PROVEN, not what was hoped: the type came from the bytes, and the metadata
    // that travels with the artifact was scanned. It also says what was NOT scanned, because the Unicode
    // scanner reads text and cannot read a video frame.
    note: `${media.length} ${kind} artifact(s) stored from ${source}${skipped}. Type proven from the bytes; the server-supplied filename, subfolder, output key and content type were scanned before writing. The media bytes themselves carry a sha256, not a content scan.`,
  };
}
