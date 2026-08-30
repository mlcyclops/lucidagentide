// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/creator/comfy_stream.ts - CREATOR-3 (ADR-0287): the PURE half of the ComfyUI websocket progress
// stream, of video / 3D output extraction, and of byte-level media sniffing.
//
// Nothing here opens a socket, reads a clock, mints an id, or touches the filesystem. The socket itself, the
// Authorization header on its handshake, and the /history fetch all live in desktop/. This module only
// derives, decodes, folds, and refuses, so the same bytes run in the renderer bundle and in unit tests.
//
// Every string that arrives here came off a remote socket or a remote JSON body, so it is DATA: we cap what
// we retain, we never interpret it, and the caller still runs anything it intends to display or store through
// the security gate (harness/security/gate.ts).
//
// Refusals are values. Nothing in this file throws: a malformed frame becomes an `unknown` event, an unusable
// base URL becomes an empty string, and a bad output entry is dropped.

/** The media kinds this module can name. Declared here on purpose: `ArtifactKind` lives in
 *  `desktop/creator_image.ts` and a harness/ file must never import from desktop/, so this is a minimal
 *  STRUCTURAL subset spelled with exactly the same members it uses. */
export type MediaKind = "image" | "video" | "model-3d";

// Caps on retained untrusted text. A remote server can send a megabyte of node id if it likes; it will not be
// kept, echoed, or measured against anything.
const MAX_ID = 128;
const MAX_MESSAGE = 400;
const MAX_RAW_TYPE = 64;
const MAX_CLIENT_ID = 200;
const MAX_FILENAME = 256;
const MAX_TYPE_FIELD = 32;
const MAX_CACHED_NODES = 64;
const MAX_TEXT_FRAME = 1_048_576;
const MAX_PREVIEW_BYTES = 8_388_608;
const MAX_OUTPUTS = 24;

/** Read one property off a value that may not be an object at all. Returns `unknown`, never a fabricated
 *  shape: every caller narrows the result before using it. */
function prop(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return Reflect.get(value, key);
}

/** Keep an untrusted scalar as a bounded string. Numbers are accepted because ComfyUI spells node ids both
 *  ways. Anything else (null, object, boolean) becomes the empty string. */
function capped(value: unknown, max: number): string {
  if (typeof value === "string") return value.length > max ? value.slice(0, max) : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** A wire counter: a finite number, floored, never negative. Anything else is null, which the caller treats
 *  as a malformed frame. A numeric STRING is not a number here, on purpose. */
function wholeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

// ── websocket url ────────────────────────────────────────────────────────────

/** Derive the ComfyUI progress-socket URL from the HTTP base the provider is configured with.
 *
 *  `http://` becomes `ws://`, `https://` becomes `wss://`, the path gets `/ws` appended (a base path prefix
 *  is preserved so a reverse-proxied ComfyUI still routes, mirroring `viewUrl` in desktop/creator_image.ts),
 *  and the only query parameter is the encoded `clientId`.
 *
 *  The credential NEVER appears here. Any userinfo in the base is stripped, and the token rides an
 *  Authorization header on the handshake, which is the caller's job. An unusable base or client id returns
 *  the empty string: this function does not throw, and the caller reports the refusal. */
export function wsUrlFor(baseUrl: string, clientId: string): string {
  if (typeof baseUrl !== "string" || typeof clientId !== "string") return "";
  const id = clientId.trim();
  if (!id || id.length > MAX_CLIENT_ID) return "";
  const parsed = /^(https?):\/\/([^/?#]*)([^?#]*)/i.exec(baseUrl.trim());
  if (!parsed) return "";
  const scheme = (parsed[1] ?? "").toLowerCase();
  const authority = parsed[2] ?? "";
  // Drop `user:pass@`. A credential in a URL is a credential in a log line.
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  if (!host || /[\s\u0000-\u001f\u007f]/.test(host)) return "";
  const path = (parsed[3] ?? "").replace(/\/+$/, "");
  if (/[\s\u0000-\u001f\u007f]/.test(path)) return "";
  const wsScheme = scheme === "https" ? "wss" : "ws";
  return `${wsScheme}://${host}${path}/ws?clientId=${encodeURIComponent(id)}`;
}

// ── frame decoding ───────────────────────────────────────────────────────────

/** Every event this module can produce. Closed set: an unrecognised frame becomes `unknown`, never a guess
 *  and never a throw. */
export type ComfyEvent =
  | { readonly type: "status"; readonly queueRemaining: number | null }
  | { readonly type: "progress"; readonly value: number; readonly max: number; readonly node: string; readonly promptId: string }
  | { readonly type: "executing"; readonly node: string; readonly promptId: string }
  | { readonly type: "executed"; readonly node: string; readonly promptId: string; readonly outputs: unknown }
  | { readonly type: "start"; readonly promptId: string }
  | { readonly type: "cached"; readonly nodes: readonly string[]; readonly promptId: string }
  | { readonly type: "error"; readonly message: string; readonly node: string; readonly promptId: string }
  | { readonly type: "interrupted"; readonly promptId: string }
  | { readonly type: "preview"; readonly mime: string; readonly bytes: Uint8Array }
  | { readonly type: "unknown"; readonly raw: string };

/** Binary event type 1 is the only one ComfyUI documents: an in-flight preview image. */
const BINARY_PREVIEW_IMAGE = 1;

function unknownEvent(raw: string): ComfyEvent {
  return { type: "unknown", raw: raw.length > MAX_RAW_TYPE ? raw.slice(0, MAX_RAW_TYPE) : raw };
}

function readU32(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset] ?? 0;
  const b = bytes[offset + 1] ?? 0;
  const c = bytes[offset + 2] ?? 0;
  const d = bytes[offset + 3] ?? 0;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Decode one websocket frame. TEXT frames are ComfyUI's `{ type, data }` JSON; BINARY frames are two
 *  big-endian u32 headers (event type, image format) followed by the raw image bytes. */
export function decodeComfyFrame(raw: string | Uint8Array): ComfyEvent {
  if (raw instanceof Uint8Array) return decodeBinaryFrame(raw);
  if (typeof raw !== "string") return unknownEvent("");
  return decodeTextFrame(raw);
}

function decodeBinaryFrame(raw: Uint8Array): ComfyEvent {
  // 8 bytes of header or it is not a frame we can read at all.
  if (raw.length < 8) return unknownEvent(`binary:truncated:${raw.length}`);
  const eventType = readU32(raw, 0);
  if (eventType !== BINARY_PREVIEW_IMAGE) return unknownEvent(`binary:${eventType}`);
  const format = readU32(raw, 4);
  const mime = format === 1 ? "image/jpeg" : format === 2 ? "image/png" : "";
  if (!mime) return unknownEvent(`binary:1:format:${format}`);
  const payload = raw.length - 8;
  if (payload <= 0) return unknownEvent("binary:1:empty");
  if (payload > MAX_PREVIEW_BYTES) return unknownEvent("binary:1:oversize");
  // `slice` copies, so holding the preview does not pin the whole frame buffer alive.
  const bytes = raw.slice(8);
  // The format byte is the server's claim about its own payload. If the magic bytes contradict it, the frame
  // is malformed, not a preview: hand the renderer nothing rather than a mislabelled image.
  if (mimeMismatch(mime, bytes)) return unknownEvent("binary:1:mime-mismatch");
  return { type: "preview", mime, bytes };
}

function decodeTextFrame(raw: string): ComfyEvent {
  if (!raw || raw.length > MAX_TEXT_FRAME) return unknownEvent("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unknownEvent("");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unknownEvent("");
  const wireType = prop(parsed, "type");
  if (typeof wireType !== "string" || !wireType) return unknownEvent("");
  const data = prop(parsed, "data");
  const promptId = capped(prop(data, "prompt_id"), MAX_ID);
  switch (wireType) {
    case "status":
      return { type: "status", queueRemaining: queueRemainingOf(data) };
    case "progress": {
      const value = wholeNumber(prop(data, "value"));
      const max = wholeNumber(prop(data, "max"));
      if (value === null || max === null) return unknownEvent("progress");
      return { type: "progress", value, max, node: capped(prop(data, "node"), MAX_ID), promptId };
    }
    case "executing":
      // `node: null` is ComfyUI's documented "this prompt is finished" signal.
      return { type: "executing", node: capped(prop(data, "node"), MAX_ID), promptId };
    case "executed": {
      // Real ComfyUI spells this `output` (singular). `outputs` is accepted for the shape /history uses.
      const single = prop(data, "output");
      const outputs = single === undefined ? prop(data, "outputs") : single;
      return { type: "executed", node: capped(prop(data, "node"), MAX_ID), promptId, outputs: outputs ?? null };
    }
    case "execution_start":
      return { type: "start", promptId };
    case "execution_cached": {
      const listed = prop(data, "nodes");
      const nodes: string[] = [];
      if (Array.isArray(listed)) {
        for (const entry of listed) {
          const node = capped(entry, MAX_ID);
          if (node) nodes.push(node);
          if (nodes.length >= MAX_CACHED_NODES) break;
        }
      }
      return { type: "cached", nodes, promptId };
    }
    case "execution_error": {
      const message = capped(prop(data, "exception_message"), MAX_MESSAGE) || capped(prop(data, "exception_type"), MAX_MESSAGE);
      const node = capped(prop(data, "node_id"), MAX_ID) || capped(prop(data, "node_type"), MAX_ID);
      return { type: "error", message, node, promptId };
    }
    case "execution_interrupted":
      return { type: "interrupted", promptId };
    default:
      return unknownEvent(wireType);
  }
}

function queueRemainingOf(data: unknown): number | null {
  return wholeNumber(prop(prop(prop(data, "status"), "exec_info"), "queue_remaining"));
}

// ── progress state ───────────────────────────────────────────────────────────

export type StreamStatus = "queued" | "running" | "done" | "error" | "interrupted";

export interface StreamState {
  readonly promptId: string;
  readonly status: StreamStatus;
  readonly node: string;
  readonly step: number;
  readonly total: number;
  /** Null until a progress frame reports a positive max. A bar with no denominator is not 0%, it is unknown. */
  readonly pct: number | null;
  readonly cachedNodes: readonly string[];
  readonly previewCount: number;
  readonly error: string;
}

/** A stream that has been submitted and has not been heard from yet. A blank prompt id yields a state that
 *  matches no event at all, because "anonymous" must never mean "everyone's". */
export function newStreamState(promptId: string): StreamState {
  return {
    promptId: capped(promptId, MAX_ID),
    status: "queued",
    node: "",
    step: 0,
    total: 0,
    pct: null,
    cachedNodes: [],
    previewCount: 0,
    error: "",
  };
}

function isTerminal(status: StreamStatus): boolean {
  return status === "done" || status === "error" || status === "interrupted";
}

/** Fold one event into the stream state. Pure: the argument is never mutated, and an event that changes
 *  nothing returns the SAME object so a renderer can skip the repaint.
 *
 *  The rules that matter: a terminal state is terminal (a late progress frame cannot revive a failure), an
 *  event naming a different prompt is ignored because the socket is shared with every other client, and a
 *  preview only counts, it never decides status. */
export function applyComfyEvent(state: StreamState, ev: ComfyEvent): StreamState {
  if (isTerminal(state.status)) return state;
  // Binary frames carry no prompt id, so on a shared socket this counter is a floor, not a census.
  if (ev.type === "preview") return { ...state, previewCount: state.previewCount + 1 };
  // A queue depth is about the server, and an unrecognised frame is about nothing we can act on.
  if (ev.type === "status" || ev.type === "unknown") return state;
  if (!state.promptId || ev.promptId !== state.promptId) return state;
  switch (ev.type) {
    case "start":
      return { ...state, status: "running" };
    case "cached": {
      if (!ev.nodes.length) return { ...state, status: "running" };
      const merged = [...state.cachedNodes];
      for (const node of ev.nodes) {
        if (merged.length >= MAX_CACHED_NODES) break;
        if (!merged.includes(node)) merged.push(node);
      }
      return { ...state, status: "running", cachedNodes: merged };
    }
    case "executing": {
      if (!ev.node) return { ...state, status: "done", pct: state.pct === null ? null : 100 };
      // Keep the old percentage until the new node reports its own, so the bar does not blink to unknown.
      return { ...state, status: "running", node: ev.node };
    }
    case "executed":
      return { ...state, status: "running" };
    case "progress": {
      const node = ev.node || state.node;
      let pct = state.pct;
      if (ev.max > 0) {
        const measured = ev.value >= ev.max ? 100 : Math.floor((ev.value / ev.max) * 100);
        const bounded = measured < 0 ? 0 : measured > 100 ? 100 : measured;
        // Monotonic within one node; a genuinely new node is a new bar and may read lower.
        pct = node === state.node && state.pct !== null ? Math.max(state.pct, bounded) : bounded;
      }
      return { ...state, status: "running", node, step: ev.value, total: ev.max, pct };
    }
    case "error":
      return {
        ...state,
        status: "error",
        node: ev.node || state.node,
        error: ev.message || "that render failed and the server did not say why",
      };
    case "interrupted":
      return { ...state, status: "interrupted" };
    default:
      return state;
  }
}

// ── history outputs (image, video, 3D) ───────────────────────────────────────

export interface ComfyOutputRef {
  readonly filename: string;
  readonly subfolder: string;
  readonly type: string;
  /** The output key this entry was listed under, kept verbatim for provenance. */
  readonly key: string;
  readonly kind: MediaKind;
  /** Empty when the filename named no format we recognise. An empty mime is a REQUEST to sniff the bytes,
   *  never a licence to store the file under a guess. */
  readonly mime: string;
}

type OutputKey = "images" | "gifs" | "animated" | "videos" | "model_file" | "3d" | "glb";

/** What each output key claims about the files listed under it. */
const OUTPUT_KEYS: Readonly<Record<OutputKey, { readonly kind: MediaKind; readonly mime: string }>> = {
  images: { kind: "image", mime: "image/png" },
  gifs: { kind: "video", mime: "image/gif" },
  animated: { kind: "video", mime: "image/webp" },
  videos: { kind: "video", mime: "video/mp4" },
  model_file: { kind: "model-3d", mime: "model/gltf-binary" },
  "3d": { kind: "model-3d", mime: "model/gltf-binary" },
  glb: { kind: "model-3d", mime: "model/gltf-binary" },
};

/** Fixed visit order, so the result does not depend on the server's JSON key order. */
const KEY_ORDER: readonly OutputKey[] = ["images", "gifs", "animated", "videos", "model_file", "3d", "glb"];

/** What each extension proves. `kind: null` means the container is ambiguous (a PNG, WEBP, or GIF can be a
 *  still or an animation), so the output key decides the kind while the extension still decides the mime. */
const EXTENSIONS: Readonly<Record<string, { readonly mime: string; readonly kind: MediaKind | null }>> = {
  png: { mime: "image/png", kind: null },
  webp: { mime: "image/webp", kind: null },
  gif: { mime: "image/gif", kind: null },
  jpg: { mime: "image/jpeg", kind: "image" },
  jpeg: { mime: "image/jpeg", kind: "image" },
  webm: { mime: "video/webm", kind: "video" },
  mp4: { mime: "video/mp4", kind: "video" },
  glb: { mime: "model/gltf-binary", kind: "model-3d" },
  gltf: { mime: "model/gltf+json", kind: "model-3d" },
};

function extensionOf(filename: string): string {
  const base = filename.slice(Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/** A path component no ComfyUI output ever has, and every traversal payload does. */
function unsafePathText(text: string): boolean {
  return text.includes("..") || /[\u0000-\u001f\u007f]/.test(text);
}

function classify(key: OutputKey, filename: string): { kind: MediaKind; mime: string } {
  const fromKey = OUTPUT_KEYS[key];
  const ext = extensionOf(filename);
  const fact = ext ? EXTENSIONS[ext] : undefined;
  if (!fact) return { kind: fromKey.kind, mime: "" };
  // The extension wins the mime outright, and wins the kind whenever the container settles it.
  return { kind: fact.kind ?? fromKey.kind, mime: fact.mime };
}

function outputsOf(raw: unknown, promptId: string): object | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = promptId && promptId in raw ? prop(raw, promptId) : raw;
  if (!entry || typeof entry !== "object") return null;
  const outputs = prop(entry, "outputs");
  return outputs && typeof outputs === "object" ? outputs : null;
}

/** SaveAnimatedWEBP / SaveAnimatedPNG list their frames under `images` and set a sibling `animated: [true]`
 *  flag. Without this the whole point is lost: those stills are one video, not N pictures. */
function hasAnimatedFlag(nodeOut: object): boolean {
  const flags = prop(nodeOut, "animated");
  return Array.isArray(flags) && flags.some((flag) => flag === true);
}

function toRef(item: unknown, key: OutputKey, animatedFlag: boolean): ComfyOutputRef | null {
  if (!item || typeof item !== "object") return null;
  const named = prop(item, "filename");
  if (typeof named !== "string") return null;
  const filename = named.trim();
  if (!filename || filename.length > MAX_FILENAME || unsafePathText(filename)) return null;
  const folder = prop(item, "subfolder");
  const subfolder = typeof folder === "string" ? folder.trim() : "";
  if (subfolder.length > MAX_FILENAME || unsafePathText(subfolder)) return null;
  const listed = prop(item, "type");
  const type = typeof listed === "string" && listed.trim() ? capped(listed.trim(), MAX_TYPE_FIELD) : "output";
  const kindKey: OutputKey = key === "images" && animatedFlag ? "animated" : key;
  const { kind, mime } = classify(kindKey, filename);
  return { filename, subfolder, type, key, kind, mime };
}

/** Pull every media ref out of a `/history/<promptId>` payload: stills, animations, videos, and 3D files.
 *  Tolerates the whole-history and single-entry shapes exactly as `parseHistoryImages` does, drops anything
 *  that is not a well-formed ref, and caps the list at 24. */
export function parseHistoryOutputs(raw: unknown, promptId: string): readonly ComfyOutputRef[] {
  const outputs = outputsOf(raw, promptId);
  if (!outputs) return [];
  const refs: ComfyOutputRef[] = [];
  for (const nodeOut of Object.values(outputs)) {
    if (!nodeOut || typeof nodeOut !== "object") continue;
    const animatedFlag = hasAnimatedFlag(nodeOut);
    for (const key of KEY_ORDER) {
      const listed = prop(nodeOut, key);
      if (!Array.isArray(listed)) continue;
      for (const item of listed) {
        const ref = toRef(item, key, animatedFlag);
        if (!ref) continue;
        refs.push(ref);
        if (refs.length >= MAX_OUTPUTS) return refs;
      }
    }
  }
  return refs;
}

// ── magic bytes ──────────────────────────────────────────────────────────────

/** Name a payload from its first bytes, or null when nothing recognisable is there. This is the only opinion
 *  about a file's type that is not the remote server's. */
export function sniffMime(bytes: Uint8Array): string | null {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  const at = (i: number): number => (i < bytes.length ? bytes[i] ?? -1 : -1);
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return "video/webm";
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) return "video/mp4";
  if (at(0) === 0x67 && at(1) === 0x6c && at(2) === 0x54 && at(3) === 0x46) return "model/gltf-binary";
  return null;
}

/** Claims that mean the same container, so an honest server is not accused of lying. */
const MIME_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "image/apng": "image/png",
  "image/x-png": "image/png",
  "video/x-matroska": "video/webm",
  "video/quicktime": "video/mp4",
  "model/gltf.binary": "model/gltf-binary",
};

function normalizeMime(claimed: string): string {
  if (typeof claimed !== "string") return "";
  const head = claimed.split(";")[0] ?? "";
  const bare = head.trim().toLowerCase().slice(0, 64);
  return MIME_ALIASES[bare] ?? bare;
}

/** Compare a server's Content-Type claim against the bytes it actually sent. Returns a human sentence when
 *  they contradict each other, and null when they agree or when the bytes say nothing. A Content-Type header
 *  must never be the thing that decides what LUCID writes to disk. */
export function mimeMismatch(claimed: string, bytes: Uint8Array): string | null {
  const sniffed = sniffMime(bytes);
  if (!sniffed) return null;
  const want = normalizeMime(claimed);
  // No claim, or a claim that names nothing, cannot contradict anything.
  if (!want || want === "application/octet-stream" || want === "binary/octet-stream") return null;
  if (want === sniffed) return null;
  return `that download claims to be ${want} but its bytes are ${sniffed}`;
}
