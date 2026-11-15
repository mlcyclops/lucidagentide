// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/image_edit.ts - P-ASKLUCID.9 (ADR-0600): edit an image the user attached, through the best
// connected cloud image model, only after the user pressed Confirm on an "Edit image" card.
//
// This is the engine core. It has no route and no UI: the route hands it the user's image, the change they
// asked for, the model, the process env, fetch, and an egress check, and gets back the edited image or a
// user-facing error. Then saveEditedImage puts it in the managed folder for the Preview panel.
//
// FAIL-CLOSED. Every failure returns { ok: false } and nothing is written: no key, an egress block, an HTTP
// error, a reply with no image, bytes that are not a real PNG, JPEG or WebP by their magic numbers, an image
// over the cap, a timeout. Error text is for the user: it never carries the key, and a provider's own
// message appears only short, one line and with anything key-shaped removed.

import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sniffImage } from "../harness/creator/design/sniff.ts";

export type ImageProvider = "openai" | "google" | "xai";
export type ImageKeyEnv = "OPENAI_API_KEY" | "GEMINI_API_KEY" | "XAI_API_KEY";
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ImageEditModel {
  id: string;
  provider: ImageProvider;
  label: string;
  /** The env var that carries this provider's key into the engine (desktop/auth_status.ts MAJORS). */
  envVar: ImageKeyEnv;
  /** Artificial Analysis AA-Image-Editing v2.1 rank (human preference). */
  rank: number;
  /** Its Elo there, when published. */
  elo: number | null;
  why: string;
}

/** Best first. Anthropic has no image model, and an OAuth-only sign-in gives the engine no key, so neither
 *  appears: a provider is usable for edits only through its API key. */
export const IMAGE_EDIT_MODELS: readonly ImageEditModel[] = [
  { id: "gpt-image-2.6-sunburst", provider: "openai", label: "GPT Image 2.6 Sunburst (OpenAI)", envVar: "OPENAI_API_KEY", rank: 1, elo: 1210, why: "Best precision for edits" },
  { id: "gpt-image-2.6-flare", provider: "openai", label: "GPT Image 2.6 Flare (OpenAI)", envVar: "OPENAI_API_KEY", rank: 2, elo: null, why: "Nearly as precise, and faster" },
  { id: "gemini-nano-banana-2.1", provider: "google", label: "Nano Banana 2.1 (Google)", envVar: "GEMINI_API_KEY", rank: 9, elo: 1152, why: "Close to the top for about a sixth of the price" },
  { id: "grok-imagine-image-2.0", provider: "xai", label: "Grok Imagine 2.0 (xAI)", envVar: "XAI_API_KEY", rank: 23, elo: 1118, why: "Good edits with an xAI key" },
];

export const IMAGE_PROVIDER_NAME: Record<ImageProvider, string> = { openai: "OpenAI", google: "Google", xai: "xAI" };

/** Where each provider's edit request goes. The route checks these hosts against egress before anything leaves. */
export const IMAGE_EDIT_ENDPOINTS: Record<ImageProvider, string> = {
  openai: "https://api.openai.com/v1/images/edits",
  google: "https://generativelanguage.googleapis.com/v1beta/interactions",
  xai: "https://api.x.ai/v1/images/edits",
};
export const GEMINI_API_REVISION = "2026-05-20";

export const IMAGE_EDIT_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
export type ImageEditQuality = (typeof IMAGE_EDIT_QUALITIES)[number];

const MB = 1024 * 1024;
export const IMAGE_EDIT_LIMITS = {
  /** The user's image, decoded. */
  inputBytes: 20 * MB,
  /** The edited image, decoded. */
  outputBytes: 30 * MB,
  /** The change, as sent to the model. */
  prompt: 4000,
  /** A provider reply body: a base64 image of outputBytes plus room for the JSON around it. */
  responseBytes: Math.ceil((30 * MB) / 3) * 4 + 2 * MB,
  /** Edits on the best models can take a minute or two. */
  timeoutMs: 180_000,
} as const;

const MIME_BY_FORMAT: Record<string, ImageMime> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const EXT_BY_MIME: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export type ImageEnv = Readonly<Record<string, string | undefined>>;

function keyFor(env: ImageEnv, m: ImageEditModel): string {
  const v = env[m.envVar];
  return typeof v === "string" ? v.trim() : "";
}

/** PURE: the models whose provider key is present in the engine env, best first. */
export function availableImageModels(env: ImageEnv): ImageEditModel[] {
  return IMAGE_EDIT_MODELS.filter((m) => keyFor(env, m) !== "");
}

export type ImageModelPick =
  | { kind: "choice"; model: ImageEditModel }
  | { kind: "ask"; options: ImageEditModel[] }
  | { kind: "none" };

/** PURE: which model Confirm uses. The user's saved choice wins while it is still usable; one usable model
 *  needs no question; several and nothing saved means the card asks, the recommendation (best) first. */
export function pickImageModel(available: readonly ImageEditModel[], saved?: string | null): ImageModelPick {
  if (available.length === 0) return { kind: "none" };
  const kept = saved ? available.find((m) => m.id === saved) : undefined;
  if (kept) return { kind: "choice", model: kept };
  if (available.length === 1) return { kind: "choice", model: available[0]! };
  return { kind: "ask", options: [...available] };
}

// ── editImage ──────────────────────────────────────────────────────────────────────────────────────────

export interface ImageEditRequest {
  modelId: string;
  prompt: string;
  /** The user's image: base64 (no data: prefix) and its declared type. The bytes decide; see below. */
  image: { data: string; mimeType: string };
  /** OpenAI only; ignored by the others. */
  quality?: ImageEditQuality;
}

export type ImageFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ImageEditDeps {
  env: ImageEnv;
  fetch: ImageFetch;
  /** The engine's egress verdict for one URL (egress policy plus the CUI lockdown rules). */
  egress: (url: string) => Promise<{ allow: boolean; reason?: string }>;
  timeoutMs?: number;
}

export interface ImageEditOk {
  ok: true;
  mimeType: ImageMime;
  data: Uint8Array;
  model: string;
  provider: ImageProvider;
  /** sha256 of the user's decoded image, for the saved record. */
  sourceSha256: string;
}
export interface ImageEditFail { ok: false; error: string; status?: number }
export type ImageEditResult = ImageEditOk | ImageEditFail;

class EditFail extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
const TIMEOUT = Symbol("timeout");

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Strict base64 to bytes, or null. The encoded length is checked BEFORE decoding so an oversize string
 *  is refused without allocating its bytes. */
function decodeB64(s: string, maxBytes: number): Uint8Array | null | "too-large" {
  if (s.length > Math.ceil(maxBytes / 3) * 4 + 4) return "too-large";
  if (s.length === 0 || s.length % 4 !== 0 || !B64.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  return buf.length > maxBytes ? "too-large" : new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** The real type of these bytes when they are a PNG, JPEG or WebP, else null. Magic numbers, never the label. */
function realMime(bytes: Uint8Array): ImageMime | null {
  return MIME_BY_FORMAT[sniffImage(bytes).format] ?? null;
}

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

const KEYISH = [/sk-[A-Za-z0-9_-]{8,}/g, /AIza[0-9A-Za-z_-]{20,}/g, /xai-[A-Za-z0-9_-]{8,}/g, /Bearer\s+\S+/gi];
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]+", "g");
/** A provider's message as one short line with the key and anything key-shaped removed. */
export function sanitizeProviderMessage(raw: unknown, key: string): string {
  if (typeof raw !== "string") return "";
  let s = raw;
  if (key.length >= 4) s = s.split(key).join("[redacted]");
  for (const re of KEYISH) s = s.replace(re, "[redacted]");
  s = s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function providerMessage(body: unknown): unknown {
  const r = rec(body);
  if (!r) return undefined;
  const e = r.error;
  if (typeof e === "string") return e;
  return rec(e)?.message ?? r.message;
}

/** Reads a body up to `max` bytes; a longer one is cancelled and refused. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new EditFail("The reply was larger than the size limit.");
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length > max) throw new EditFail("The reply was larger than the size limit.");
    return b;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new EditFail("The reply was larger than the size limit.");
    }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
}

/** Google's interaction output, read defensively: every image block in document order, the LAST one wins
 *  (outputs follow any echoed input). Shapes: {type:"image", data, mime_type} and {inline_data:{data}}. */
export function lastGeminiImage(body: unknown): string | null {
  let found: string | null = null;
  let budget = 20_000;
  const walk = (v: unknown, depth: number): void => {
    if (depth > 16 || --budget < 0) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const r = rec(v);
    if (!r) return;
    if (r.type === "image" && typeof r.data === "string") found = r.data;
    const inline = rec(r.inline_data) ?? rec(r.inlineData);
    if (inline && typeof inline.data === "string") found = inline.data;
    for (const k of Object.keys(r)) if (k !== "data") walk(r[k], depth + 1);
  };
  walk(body, 0);
  return found;
}

/** PURE: the request for one provider. Exported for the tests and for the route's egress check. */
export function buildImageEditRequest(model: ImageEditModel, key: string, prompt: string, image: { b64: string; bytes: Uint8Array; mime: ImageMime }, quality?: ImageEditQuality): { url: string; init: RequestInit } {
  const url = IMAGE_EDIT_ENDPOINTS[model.provider];
  if (model.provider === "openai") {
    const form = new FormData();
    form.append("model", model.id);
    form.append("prompt", prompt);
    form.append("image", new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mime }), `image.${EXT_BY_MIME[image.mime]}`);
    if (quality) form.append("quality", quality);
    form.append("output_format", "png");
    // No Content-Type: fetch writes the multipart boundary.
    return { url, init: { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form } };
  }
  if (model.provider === "google") {
    const body = { model: model.id, input: [{ type: "text", text: prompt }, { type: "image", data: image.b64, mime_type: image.mime }] };
    return { url, init: { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json", "Api-Revision": GEMINI_API_REVISION }, body: JSON.stringify(body) } };
  }
  // xAI takes JSON with the image as a data URL, not multipart.
  const body = { model: model.id, prompt, image: { url: `data:${image.mime};base64,${image.b64}`, type: "image_url" } };
  return { url, init: { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) } };
}

async function allowed(deps: ImageEditDeps, url: string): Promise<void> {
  let verdict: { allow: boolean; reason?: string };
  try { verdict = await deps.egress(url); } catch { verdict = { allow: false }; }
  if (verdict?.allow === true) return;
  const host = new URL(url).host;
  const why = sanitizeProviderMessage(verdict?.reason, "").replace(/[.\s]+$/, "");
  throw new EditFail(`The network policy does not allow ${host}${why ? `: ${why}` : ""}.`);
}

function httpError(provider: string, status: number, body: unknown, key: string): EditFail {
  const msg = sanitizeProviderMessage(providerMessage(body), key);
  const head = status === 401 || status === 403
    ? `${provider} refused the key (HTTP ${status})`
    : status === 429
      ? `${provider} is rate limiting or out of quota (HTTP ${status})`
      : `${provider} could not edit the image (HTTP ${status})`;
  return new EditFail(msg ? `${head}: ${msg}` : `${head}.`, status);
}

/** Bytes from a base64 image in a reply, checked: size, then the real type by magic numbers. */
function checkedOutput(b64: string, provider: string): { bytes: Uint8Array; mime: ImageMime } {
  const bytes = decodeB64(b64.replace(/\s+/g, ""), IMAGE_EDIT_LIMITS.outputBytes);
  if (bytes === "too-large") throw new EditFail(`${provider} sent an image over the ${IMAGE_EDIT_LIMITS.outputBytes / MB} MB limit.`);
  if (!bytes) throw new EditFail(`${provider} sent an image that was not valid base64.`);
  return checkedBytes(bytes, provider);
}
function checkedBytes(bytes: Uint8Array, provider: string): { bytes: Uint8Array; mime: ImageMime } {
  if (bytes.length > IMAGE_EDIT_LIMITS.outputBytes) throw new EditFail(`${provider} sent an image over the ${IMAGE_EDIT_LIMITS.outputBytes / MB} MB limit.`);
  const mime = realMime(bytes);
  if (!mime) throw new EditFail(`${provider} sent something that is not a PNG, JPEG or WebP image.`);
  return { bytes, mime };
}

/** Edits one image. Never throws; never returns or logs the key. */
export async function editImage(req: ImageEditRequest, deps: ImageEditDeps): Promise<ImageEditResult> {
  const model = IMAGE_EDIT_MODELS.find((m) => m.id === req?.modelId);
  if (!model) return { ok: false, error: "That image model is not one LUCID knows." };
  const name = IMAGE_PROVIDER_NAME[model.provider];
  const key = keyFor(deps.env, model);
  if (!key) return { ok: false, error: `No ${name} API key is connected, so ${model.label} cannot be used. Add the key in Settings.` };

  const prompt = typeof req.prompt === "string" ? req.prompt.trim() : "";
  if (!prompt) return { ok: false, error: "Say what to change in the image." };
  if (prompt.length > IMAGE_EDIT_LIMITS.prompt) return { ok: false, error: `The change is over ${IMAGE_EDIT_LIMITS.prompt} characters.` };
  if (req.quality !== undefined && !(IMAGE_EDIT_QUALITIES as readonly string[]).includes(req.quality)) return { ok: false, error: "That quality setting is not one the model takes." };

  const declared = req.image?.mimeType;
  if (declared !== "image/png" && declared !== "image/jpeg" && declared !== "image/webp") return { ok: false, error: "Only PNG, JPEG and WebP images can be edited." };
  const b64 = typeof req.image.data === "string" ? req.image.data : "";
  const bytes = decodeB64(b64, IMAGE_EDIT_LIMITS.inputBytes);
  if (bytes === "too-large") return { ok: false, error: `The image is over the ${IMAGE_EDIT_LIMITS.inputBytes / MB} MB limit for edits.` };
  if (!bytes) return { ok: false, error: "The image could not be read." };
  // The bytes decide the type, not the label: a mislabeled real image is sent as what it is.
  const mime = realMime(bytes);
  if (!mime) return { ok: false, error: "Only PNG, JPEG and WebP images can be edited, and this file is none of them." };
  const sourceSha256 = sha256(bytes);

  const { url, init } = buildImageEditRequest(model, key, prompt, { b64, bytes, mime }, model.provider === "openai" ? req.quality : undefined);
  const ms = deps.timeoutMs ?? IMAGE_EDIT_LIMITS.timeoutMs;
  const ctl = new AbortController();
  const { promise: deadline, reject: expire } = Promise.withResolvers<never>();
  const timer = setTimeout(() => { ctl.abort(); expire(TIMEOUT); }, ms);

  const run = async (): Promise<{ bytes: Uint8Array; mime: ImageMime }> => {
    await allowed(deps, url);
    let res: Response;
    try { res = await deps.fetch(url, { ...init, signal: ctl.signal }); } catch {
      if (ctl.signal.aborted) throw TIMEOUT;
      throw new EditFail(`Could not reach ${name}.`);
    }
    const raw = await readCapped(res, IMAGE_EDIT_LIMITS.responseBytes);
    const body = parseJson(raw);
    if (!res.ok) throw httpError(name, res.status, body, key);
    if (body === undefined) throw new EditFail(`${name} sent a reply that was not JSON.`);

    if (model.provider === "google") {
      const data = lastGeminiImage(body);
      if (!data) throw new EditFail(`${name} returned no image.`);
      return checkedOutput(data, name);
    }
    const list = rec(body)?.data;
    const first = Array.isArray(list) ? rec(list[0]) : null;
    const encoded = first?.b64_json;
    const link = first?.url;
    if (typeof encoded === "string" && encoded) return checkedOutput(encoded, name);
    if (model.provider === "xai" && typeof link === "string") return fetchResultUrl(link, name, deps, ctl.signal);
    throw new EditFail(`${name} returned no image.`);
  };

  try {
    const out = await Promise.race([run(), deadline]);
    return { ok: true, mimeType: out.mime, data: out.bytes, model: model.id, provider: model.provider, sourceSha256 };
  } catch (e) {
    if (e === TIMEOUT || ctl.signal.aborted) {
      const s = Math.max(1, Math.round(ms / 1000));
      return { ok: false, error: `${name} did not finish the edit within ${s} second${s === 1 ? "" : "s"}.` };
    }
    if (e instanceof EditFail) return e.status === undefined ? { ok: false, error: e.message } : { ok: false, error: e.message, status: e.status };
    return { ok: false, error: `${name} sent a reply LUCID could not read.` };
  } finally {
    clearTimeout(timer);
  }
}

/** xAI may answer with only a URL. Fetched ONCE: https only, through egress, no key sent, no redirects
 *  followed, the same deadline, and the same size and type checks. */
async function fetchResultUrl(raw: string, name: string, deps: ImageEditDeps, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: ImageMime }> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new EditFail(`${name} returned an image link that is not valid.`); }
  if (u.protocol !== "https:") throw new EditFail(`${name} returned an image link that is not https.`);
  await allowed(deps, u.href);
  let res: Response;
  try { res = await deps.fetch(u.href, { method: "GET", redirect: "error", signal }); } catch {
    if (signal.aborted) throw TIMEOUT;
    throw new EditFail(`Could not download the edited image from ${name}.`);
  }
  if (!res.ok) throw new EditFail(`Could not download the edited image from ${name} (HTTP ${res.status}).`, res.status);
  return checkedBytes(await readCapped(res, IMAGE_EDIT_LIMITS.outputBytes), name);
}

// ── saveEditedImage ────────────────────────────────────────────────────────────────────────────────────

export interface ImageSaveFs {
  mkdir(path: string, opts: { recursive: true }): unknown;
  /** `flag: "wx"`: never overwrite an existing file. */
  writeFile(path: string, data: Uint8Array | string, opts: { flag: "wx" }): unknown;
  rm(path: string): unknown;
}
export interface ImageSaveDeps {
  /** The managed LUCID data folder (absolute). */
  root: string;
  now: () => number;
  /** A fresh id for the file name: letters, digits, "-" and "_". */
  id: () => string;
  fs: ImageSaveFs;
}
export interface ImageSaveMeta {
  id: string;
  createdAt: string;
  provider: ImageProvider;
  model: string;
  promptSha256: string;
  sourceSha256: string;
  bytes: number;
  mimeType: ImageMime;
}
export type ImageSaveResult = { ok: true; path: string; ext: string; metaPath: string; meta: ImageSaveMeta } | { ok: false; error: string };

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const pad = (n: number): string => String(n).padStart(2, "0");

/** Writes <root>/ask-lucid/images/<YYYY-MM-DD>/<id>.<ext> and <id>.json beside it. The record holds hashes,
 *  never the prompt text or a key. A failure removes what was written. */
export async function saveEditedImage(out: ImageEditOk, meta: { prompt: string }, deps: ImageSaveDeps): Promise<ImageSaveResult> {
  if (!deps.root || !isAbsolute(deps.root)) return { ok: false, error: "The image folder is not set." };
  const id = deps.id();
  if (!SAFE_ID.test(id)) return { ok: false, error: "The edited image could not be named." };
  const mime = realMime(out.data);
  if (!mime || mime !== out.mimeType || out.data.length > IMAGE_EDIT_LIMITS.outputBytes) return { ok: false, error: "The edited image is not a PNG, JPEG or WebP within the size limit." };

  const t = deps.now();
  const d = new Date(t);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ext = EXT_BY_MIME[mime];
  const base = resolve(deps.root, "ask-lucid", "images");
  const dir = join(base, day);
  const path = join(dir, `${id}.${ext}`);
  const metaPath = join(dir, `${id}.json`);
  for (const p of [path, metaPath]) {
    const rel = relative(base, p);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, error: "The edited image would land outside its folder." };
  }
  const record: ImageSaveMeta = {
    id, createdAt: d.toISOString(), provider: out.provider, model: out.model,
    promptSha256: sha256(typeof meta?.prompt === "string" ? meta.prompt : ""), sourceSha256: out.sourceSha256,
    bytes: out.data.length, mimeType: mime,
  };

  const failed: ImageSaveResult = { ok: false, error: "The edited image could not be saved." };
  // A partial write is removed; a file that already existed ("wx" refused it) is not ours to remove.
  const ours = (e: unknown): boolean => (e as { code?: string } | null)?.code !== "EEXIST";
  const remove = async (p: string): Promise<void> => {
    try { await deps.fs.rm(p); } catch { /* already gone */ }
  };
  try {
    await deps.fs.mkdir(dir, { recursive: true });
  } catch {
    return failed;
  }
  try {
    await deps.fs.writeFile(path, out.data, { flag: "wx" });
  } catch (e) {
    if (ours(e)) await remove(path);
    return failed;
  }
  try {
    await deps.fs.writeFile(metaPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  } catch (e) {
    await remove(path);
    if (ours(e)) await remove(metaPath);
    return failed;
  }
  return { ok: true, path, ext, metaPath, meta: record };
}
