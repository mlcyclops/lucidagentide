// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/image_edit.test.ts - P-ASKLUCID.9 (ADR-0600): the image edit engine core. The catalog and its
// order, which models a user's keys make usable, how one is picked, the exact request each provider gets,
// how each reply is read, every fail-closed case, and where the result is saved (with no prompt text).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  IMAGE_EDIT_ENDPOINTS,
  IMAGE_EDIT_LIMITS,
  IMAGE_EDIT_MODELS,
  availableImageModels,
  editImage,
  lastGeminiImage,
  pickImageModel,
  sanitizeProviderMessage,
  saveEditedImage,
  type ImageEditDeps,
  type ImageEditOk,
  type ImageSaveFs,
} from "./image_edit.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 13, 0, 0, 0, 0x2f, 3, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0]);
const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const sha = (d: Uint8Array | string): string => createHash("sha256").update(d).digest("hex");

const KEYS = { OPENAI_API_KEY: "sk-live-OPENAI0123456789", GEMINI_API_KEY: "AIzaGEMINI0123456789abcdefgh", XAI_API_KEY: "xai-XAI0123456789" };
const ALL = (): boolean => true;
const IMG = { data: b64(PNG), mimeType: "image/png" };

interface Call { url: string; init: RequestInit }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function harness(replies: Array<Response | ((call: Call) => Promise<Response>)>, over: Partial<ImageEditDeps> = {}): { deps: ImageEditDeps; calls: Call[]; egressed: string[] } {
  const calls: Call[] = [];
  const egressed: string[] = [];
  const deps: ImageEditDeps = {
    env: KEYS,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      const r = replies.shift();
      if (!r) throw new Error("no reply queued");
      return typeof r === "function" ? r(call) : r;
    },
    egress: async (url) => { egressed.push(url); return { allow: true }; },
    allowed: () => true,
    ...over,
  };
  return { deps, calls, egressed };
}
const headers = (init: RequestInit): Record<string, string> => Object.fromEntries(new Headers(init.headers).entries());

describe("the catalog", () => {
  test("best first, each with a provider, key, label and a reason", () => {
    expect(IMAGE_EDIT_MODELS.map((m) => m.id)).toEqual(["gpt-image-2.6-sunburst", "gpt-image-2.6-flare", "gemini-nano-banana-2.1", "grok-imagine-image-2.0"]);
    expect(IMAGE_EDIT_MODELS.map((m) => m.envVar)).toEqual(["OPENAI_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"]);
    expect(IMAGE_EDIT_MODELS.map((m) => m.rank)).toEqual([1, 2, 9, 23]);
    expect(IMAGE_EDIT_MODELS[0]!.label).toBe("GPT Image 2.6 Sunburst (OpenAI)");
    expect(IMAGE_EDIT_MODELS[0]!.why).toBe("Best precision for edits");
    expect(IMAGE_EDIT_MODELS[2]!.why).toBe("Close to the top for about a sixth of the price");
    for (const m of IMAGE_EDIT_MODELS) expect(m.label.length > 5 && m.why.length > 5).toBe(true);
    expect(IMAGE_EDIT_MODELS.some((m) => (m.provider as string) === "anthropic")).toBe(false);
  });

  test("a model is available only when its key is present and not blank", () => {
    expect(availableImageModels({}, ALL).length).toBe(0);
    expect(availableImageModels({ OPENAI_API_KEY: "sk-a" }, ALL).map((m) => m.id)).toEqual(["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"]);
    expect(availableImageModels({ GEMINI_API_KEY: "   ", XAI_API_KEY: "" }, ALL).length).toBe(0);
    expect(availableImageModels({ XAI_API_KEY: "xai-a", GEMINI_API_KEY: "g" }, ALL).map((m) => m.id)).toEqual(["gemini-nano-banana-2.1", "grok-imagine-image-2.0"]);
    expect(availableImageModels(KEYS, ALL).map((m) => m.id)).toEqual(IMAGE_EDIT_MODELS.map((m) => m.id));
    expect(availableImageModels({ ANTHROPIC_API_KEY: "sk-ant" }, ALL).length).toBe(0);
  });

  test("pick: one available, a saved one, ask with the recommendation first, or none", () => {
    expect(pickImageModel([])).toEqual({ kind: "none" });
    expect(pickImageModel([], "gpt-image-2.6-sunburst")).toEqual({ kind: "none" });
    const xai = availableImageModels({ XAI_API_KEY: "x" }, ALL);
    expect(pickImageModel(xai)).toEqual({ kind: "choice", model: xai[0]! });
    const all = availableImageModels(KEYS, ALL);
    expect(pickImageModel(all, "gemini-nano-banana-2.1")).toEqual({ kind: "choice", model: all[2]! });
    const ask = pickImageModel(all);
    expect(ask.kind === "ask" && ask.options.map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect(ask.kind === "ask" && ask.options[0]!.id).toBe("gpt-image-2.6-sunburst");
    // A saved model whose key is gone no longer counts.
    expect(pickImageModel(all.slice(2), "gpt-image-2.6-sunburst").kind).toBe("ask");
    expect(pickImageModel(xai, "gpt-image-2.6-sunburst")).toEqual({ kind: "choice", model: xai[0]! });
  });
});

describe("the request each provider gets", () => {
  test("OpenAI: multipart to /v1/images/edits with the model, prompt, image file, quality and a bearer key", async () => {
    const { deps, calls, egressed } = harness([json({ data: [{ b64_json: b64(JPEG) }] })]);
    const r = await editImage({ modelId: "gpt-image-2.6-sunburst", prompt: "  Make the sky a sunset. ", image: IMG, quality: "high" }, deps);
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/edits");
    expect(egressed).toEqual([IMAGE_EDIT_ENDPOINTS.openai]);
    expect(calls[0]!.init.method).toBe("POST");
    const h = headers(calls[0]!.init);
    expect(h.authorization).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
    expect(h["content-type"]).toBeUndefined(); // fetch writes the multipart boundary
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const form = calls[0]!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-image-2.6-sunburst");
    expect(form.get("prompt")).toBe("Make the sky a sunset.");
    expect(form.get("quality")).toBe("high");
    expect(form.get("output_format")).toBe("png");
    const file = form.get("image") as File;
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("image.png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  });

  test("OpenAI without a quality sends none", async () => {
    const { deps, calls } = harness([json({ data: [{ b64_json: b64(PNG) }] })]);
    await editImage({ modelId: "gpt-image-2.6-flare", prompt: "p", image: IMG }, deps);
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2.6-flare");
    expect(form.has("quality")).toBe(false);
  });

  test("Google: JSON to /v1beta/interactions with the key header, the API revision, text then image", async () => {
    const { deps, calls } = harness([json({ outputs: [{ type: "image", data: b64(PNG), mime_type: "image/png" }] })]);
    const r = await editImage({ modelId: "gemini-nano-banana-2.1", prompt: "Add a hat.", image: { data: b64(JPEG), mimeType: "image/jpeg" }, quality: "max" }, deps);
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    const h = headers(calls[0]!.init);
    expect(h["x-goog-api-key"]).toBe(KEYS.GEMINI_API_KEY);
    expect(h["content-type"]).toBe("application/json");
    expect(h["api-revision"]).toBe("2026-05-20");
    expect(h.authorization).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: "gemini-nano-banana-2.1",
      input: [{ type: "text", text: "Add a hat." }, { type: "image", data: b64(JPEG), mime_type: "image/jpeg" }],
    }); // quality is OpenAI-only and is not sent
  });

  test("xAI: JSON (not multipart) with the image as a data URL and a bearer key", async () => {
    const { deps, calls } = harness([json({ data: [{ b64_json: b64(PNG) }] })]);
    const r = await editImage({ modelId: "grok-imagine-image-2.0", prompt: "Make it night.", image: { data: b64(WEBP), mimeType: "image/webp" } }, deps);
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/images/edits");
    const h = headers(calls[0]!.init);
    expect(h.authorization).toBe(`Bearer ${KEYS.XAI_API_KEY}`);
    expect(h["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ model: "grok-imagine-image-2.0", prompt: "Make it night.", image: { url: `data:image/webp;base64,${b64(WEBP)}`, type: "image_url" } });
  });

  test("the bytes decide the type: a JPEG labeled PNG is sent as a JPEG", async () => {
    const { deps, calls } = harness([json({ data: [{ b64_json: b64(PNG) }] })]);
    await editImage({ modelId: "grok-imagine-image-2.0", prompt: "p", image: { data: b64(JPEG), mimeType: "image/png" } }, deps);
    expect(JSON.parse(calls[0]!.init.body as string).image.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});

describe("reading the reply", () => {
  test("OpenAI: data[0].b64_json, typed by its magic bytes, with the source hash", async () => {
    const { deps } = harness([json({ created: 1, data: [{ b64_json: b64(JPEG) }] })]);
    const r = await editImage({ modelId: "gpt-image-2.6-sunburst", prompt: "p", image: IMG }, deps);
    expect(r).toEqual({ ok: true, mimeType: "image/jpeg", data: JPEG, model: "gpt-image-2.6-sunburst", provider: "openai", sourceSha256: sha(PNG) });
  });

  test("Google: the LAST image block in the interaction wins, after text and any echoed input", async () => {
    const body = {
      id: "int-1",
      input: [{ type: "image", data: b64(GIF) }],
      outputs: [{ type: "text", text: "Here you go." }, { type: "image", data: b64(JPEG), mime_type: "image/jpeg" }, { content: [{ type: "image", data: b64(WEBP), mime_type: "image/webp" }] }],
    };
    expect(lastGeminiImage(body)).toBe(b64(WEBP));
    expect(lastGeminiImage({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data: b64(PNG) } }] } }] })).toBe(b64(PNG));
    expect(lastGeminiImage({ outputs: [{ type: "text", text: "no" }] })).toBeNull();
    const { deps } = harness([json(body)]);
    const r = await editImage({ modelId: "gemini-nano-banana-2.1", prompt: "p", image: IMG }, deps);
    expect(r.ok && r.mimeType).toBe("image/webp");
    expect(r.ok && r.provider).toBe("google");
  });

  test("xAI: b64_json when present", async () => {
    const { deps } = harness([json({ data: [{ b64_json: b64(PNG), url: "https://img.x.ai/ignored.png" }] })]);
    const r = await editImage({ modelId: "grok-imagine-image-2.0", prompt: "p", image: IMG }, deps);
    expect(r.ok && r.mimeType).toBe("image/png");
  });

  test("xAI URL only: fetched once over https, through egress, with no key and no redirects", async () => {
    const link = "https://imgen.x.ai/xai-imgen/abc.jpeg";
    const { deps, calls, egressed } = harness([json({ data: [{ url: link }] }), new Response(JPEG, { status: 200 })]);
    const r = await editImage({ modelId: "grok-imagine-image-2.0", prompt: "p", image: IMG }, deps);
    expect(r).toMatchObject({ ok: true, mimeType: "image/jpeg", provider: "xai" });
    expect(r.ok && r.data).toEqual(JPEG);
    expect(calls.length).toBe(2);
    expect(calls[1]!.url).toBe(link);
    expect(calls[1]!.init.method).toBe("GET");
    expect(calls[1]!.init.redirect).toBe("error");
    expect(headers(calls[1]!.init).authorization).toBeUndefined();
    expect(JSON.stringify(calls[1]!.init)).not.toContain(KEYS.XAI_API_KEY);
    expect(egressed).toEqual([IMAGE_EDIT_ENDPOINTS.xai, link]);
  });

  test("xAI URL only: http, a blocked host, an HTTP error or an oversize download all fail", async () => {
    const run = async (replies: Response[], over: Partial<ImageEditDeps> = {}) => editImage({ modelId: "grok-imagine-image-2.0", prompt: "p", image: IMG }, harness(replies, over).deps);
    expect(await run([json({ data: [{ url: "http://imgen.x.ai/a.png" }] })])).toMatchObject({ ok: false, error: expect.stringContaining("not https") });
    const blockCdn = async (url: string) => ({ allow: url.startsWith(IMAGE_EDIT_ENDPOINTS.xai), reason: "not on the list" });
    expect(await run([json({ data: [{ url: "https://cdn.evil.example/a.png" }] })], { egress: blockCdn })).toMatchObject({ ok: false, error: expect.stringContaining("cdn.evil.example") });
    expect(await run([json({ data: [{ url: "https://imgen.x.ai/a.png" }] }), new Response("gone", { status: 404 })])).toMatchObject({ ok: false, status: 404 });
    const MB = 1024 * 1024;
    const chunk = new Uint8Array(MB);
    chunk.set(PNG);
    let sent = 0;
    const huge = new ReadableStream<Uint8Array>({ pull(c) { if (sent >= 40) c.close(); else { sent += 1; c.enqueue(chunk); } } });
    const big = await run([json({ data: [{ url: "https://imgen.x.ai/a.png" }] }), new Response(huge)]);
    expect(big).toMatchObject({ ok: false, error: expect.stringContaining("size limit") });
    expect(sent).toBeLessThan(40); // the read stopped at the cap
  });
});

describe("FAIL-CLOSED", () => {
  const req = { modelId: "gpt-image-2.6-sunburst", prompt: "Make the sky a sunset.", image: IMG };

  test("an egress block, or an egress check that throws, sends nothing", async () => {
    const blocked = harness([], { egress: async () => ({ allow: false, reason: "CUI lockdown is on." }) });
    const r = await editImage(req, blocked.deps);
    expect(r).toEqual({ ok: false, error: "The network policy does not allow api.openai.com: CUI lockdown is on." });
    expect(blocked.calls.length).toBe(0);
    const broken = harness([], { egress: async () => { throw new Error("policy file unreadable"); } });
    expect((await editImage(req, broken.deps)).ok).toBe(false);
    expect(broken.calls.length).toBe(0);
  });

  test("no key, an unknown model, an empty or oversize prompt, a bad quality: refused before any call", async () => {
    const h = harness([]);
    expect(await editImage(req, { ...h.deps, env: { GEMINI_API_KEY: "g" } })).toMatchObject({ ok: false, error: expect.stringContaining("No OpenAI API key") });
    expect(await editImage({ ...req, modelId: "dall-e-9" }, h.deps)).toMatchObject({ ok: false });
    expect(await editImage({ ...req, prompt: "   " }, h.deps)).toMatchObject({ ok: false });
    expect(await editImage({ ...req, prompt: "x".repeat(IMAGE_EDIT_LIMITS.prompt + 1) }, h.deps)).toMatchObject({ ok: false });
    expect(await editImage({ ...req, quality: "ultra" as never }, h.deps)).toMatchObject({ ok: false });
    expect(h.calls.length).toBe(0);
    expect(h.egressed.length).toBe(0);
  });

  test("the input must be a real PNG, JPEG or WebP, valid base64, and within 20 MB", async () => {
    const h = harness([]);
    expect(await editImage({ ...req, image: { data: b64(GIF), mimeType: "image/gif" } }, h.deps)).toMatchObject({ ok: false, error: expect.stringContaining("PNG, JPEG and WebP") });
    expect(await editImage({ ...req, image: { data: b64(GIF), mimeType: "image/png" } }, h.deps)).toMatchObject({ ok: false, error: expect.stringContaining("none of them") });
    expect(await editImage({ ...req, image: { data: "not base64!", mimeType: "image/png" } }, h.deps)).toMatchObject({ ok: false });
    expect(await editImage({ ...req, image: { data: `data:image/png;base64,${b64(PNG)}`, mimeType: "image/png" } }, h.deps)).toMatchObject({ ok: false });
    const over = "A".repeat(Math.ceil(IMAGE_EDIT_LIMITS.inputBytes / 3) * 4 + 8);
    expect(await editImage({ ...req, image: { data: over, mimeType: "image/png" } }, h.deps)).toMatchObject({ ok: false, error: expect.stringContaining("20 MB") });
    expect(h.calls.length).toBe(0);
  });

  test("HTTP 4xx and 5xx fail with the status and a short provider message, never the key", async () => {
    const leak = `Incorrect API key provided: ${KEYS.OPENAI_API_KEY}. Also sk-otherKEY123456789 and Bearer abc.def`;
    const r401 = await editImage(req, harness([json({ error: { message: leak, type: "invalid_request_error" } }, 401)]).deps);
    expect(r401.ok).toBe(false);
    expect(!r401.ok && r401.status).toBe(401);
    expect(!r401.ok && r401.error).toContain("OpenAI refused the key (HTTP 401)");
    expect(JSON.stringify(r401)).not.toContain(KEYS.OPENAI_API_KEY);
    expect(JSON.stringify(r401)).not.toContain("sk-otherKEY");
    expect(JSON.stringify(r401)).not.toContain("abc.def");
    expect(!r401.ok && r401.error).toContain("[redacted]");

    const r400 = await editImage(req, harness([json({ error: { message: "Your request was rejected by the safety system.\nDetails follow." } }, 400)]).deps);
    expect(r400).toEqual({ ok: false, status: 400, error: "OpenAI could not edit the image (HTTP 400): Your request was rejected by the safety system. Details follow." });
    const r500 = await editImage({ ...req, modelId: "gemini-nano-banana-2.1" }, harness([new Response("<html>oops</html>", { status: 503 })]).deps);
    expect(r500).toEqual({ ok: false, status: 503, error: "Google could not edit the image (HTTP 503)." });
    const r429 = await editImage({ ...req, modelId: "grok-imagine-image-2.0" }, harness([json({ error: "x".repeat(900) }, 429)]).deps);
    expect(!r429.ok && r429.error.length).toBeLessThan(300);
    expect(!r429.ok && r429.error).toContain("rate limiting");
  });

  test("sanitizeProviderMessage: one line, short, no key, nothing key-shaped", () => {
    expect(sanitizeProviderMessage("bad key MYSECRETKEY here", "MYSECRETKEY")).toBe("bad key [redacted] here");
    expect(sanitizeProviderMessage("AIzaSyA0123456789abcdefghijklmn and xai-abcdef123456", "")).toBe("[redacted] and [redacted]");
    expect(sanitizeProviderMessage(42, "k")).toBe("");
    expect(sanitizeProviderMessage("a\u0000b\nc", "").includes("\n")).toBe(false);
  });

  test("a reply with no image, or not JSON, fails", async () => {
    expect(await editImage(req, harness([json({ data: [] })]).deps)).toMatchObject({ ok: false, error: "OpenAI returned no image." });
    expect(await editImage(req, harness([json({ data: [{ url: "https://x/a.png" }] })]).deps)).toMatchObject({ ok: false, error: "OpenAI returned no image." }); // URLs are xAI-only
    expect(await editImage({ ...req, modelId: "gemini-nano-banana-2.1" }, harness([json({ outputs: [{ type: "text", text: "I cannot." }] })]).deps)).toMatchObject({ ok: false, error: "Google returned no image." });
    expect(await editImage(req, harness([new Response("not json", { status: 200 })]).deps)).toMatchObject({ ok: false });
  });

  test("an output that is not a PNG, JPEG or WebP by its magic bytes fails, whatever it claims", async () => {
    const gif = await editImage(req, harness([json({ data: [{ b64_json: b64(GIF) }] })]).deps);
    expect(gif).toMatchObject({ ok: false, error: expect.stringContaining("not a PNG, JPEG or WebP") });
    const html = await editImage({ ...req, modelId: "gemini-nano-banana-2.1" }, harness([json({ outputs: [{ type: "image", mime_type: "image/png", data: b64(new TextEncoder().encode("<html>hi</html>")) }] })]).deps);
    expect(html.ok).toBe(false);
    expect((await editImage(req, harness([json({ data: [{ b64_json: "%%%%" }] })]).deps)).ok).toBe(false);
  });

  test("an output over 30 MB fails", async () => {
    const over = "A".repeat(Math.ceil(IMAGE_EDIT_LIMITS.outputBytes / 3) * 4 + 8);
    const r = await editImage(req, harness([json({ data: [{ b64_json: over }] })]).deps);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("30 MB") });
  });

  test("a timeout fails, whether fetch honors the abort or hangs", async () => {
    let aborted = false;
    const honors = harness([(call) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      call.init.signal!.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
      return promise;
    }], { timeoutMs: 20 });
    expect(await editImage(req, honors.deps)).toEqual({ ok: false, error: "OpenAI did not finish the edit within 1 second." });
    expect(aborted).toBe(true);
    const hangs = harness([() => Promise.withResolvers<Response>().promise], { timeoutMs: 1500 });
    const r = await editImage(req, hangs.deps);
    expect(r).toEqual({ ok: false, error: "OpenAI did not finish the edit within 2 seconds." });
  });

  test("a network error says the provider could not be reached, with nothing else", async () => {
    const r = await editImage(req, harness([async () => { throw new TypeError(`connect ECONNREFUSED ${KEYS.OPENAI_API_KEY}`); }]).deps);
    expect(r).toEqual({ ok: false, error: "Could not reach OpenAI." });
  });
});

describe("saveEditedImage", () => {
  const ROOT = resolve("/lucid-data");
  const NOW = new Date(2026, 10, 15, 21, 30).getTime(); // local time: the folder is the user's day
  const OUT: ImageEditOk = { ok: true, mimeType: "image/png", data: PNG, model: "gpt-image-2.6-sunburst", provider: "openai", sourceSha256: sha(JPEG) };
  function memFs(fail: { image?: string; meta?: string } = {}): { fs: ImageSaveFs; files: Map<string, Uint8Array | string>; dirs: string[]; removed: string[] } {
    const files = new Map<string, Uint8Array | string>();
    const dirs: string[] = [];
    const removed: string[] = [];
    const fs: ImageSaveFs = {
      mkdir: (p) => { dirs.push(p); },
      writeFile: (p, d, o) => {
        expect(o).toEqual({ flag: "wx" });
        const code = p.endsWith(".json") ? fail.meta : fail.image;
        if (code) throw Object.assign(new Error("write failed"), { code });
        files.set(p, d);
      },
      rm: (p) => { removed.push(p); files.delete(p); },
    };
    return { fs, files, dirs, removed };
  }

  test("writes <root>/ask-lucid/images/<day>/<id>.<ext> and a record with hashes, not the prompt", async () => {
    const m = memFs();
    const prompt = "Make the sky a sunset over the harbor.";
    const r = await saveEditedImage(OUT, { prompt }, { root: ROOT, now: () => NOW, id: () => "img_01", fs: m.fs });
    const dir = join(ROOT, "ask-lucid", "images", "2026-11-15");
    expect(r).toMatchObject({ ok: true, path: join(dir, "img_01.png"), ext: "png", metaPath: join(dir, "img_01.json") });
    expect(m.dirs).toEqual([dir]);
    expect(m.files.get(join(dir, "img_01.png"))).toEqual(PNG);
    const text = m.files.get(join(dir, "img_01.json")) as string;
    expect(text).not.toContain("sunset");
    expect(text).not.toContain(KEYS.OPENAI_API_KEY);
    expect(JSON.parse(text)).toEqual({
      id: "img_01", createdAt: new Date(NOW).toISOString(), provider: "openai", model: "gpt-image-2.6-sunburst",
      promptSha256: sha(prompt), sourceSha256: sha(JPEG), bytes: PNG.length, mimeType: "image/png",
    });
  });

  test("the extension follows the real bytes", async () => {
    const m = memFs();
    const r = await saveEditedImage({ ...OUT, mimeType: "image/jpeg", data: JPEG }, { prompt: "p" }, { root: ROOT, now: () => NOW, id: () => "a", fs: m.fs });
    expect(r.ok && r.ext).toBe("jpg");
    const w = await saveEditedImage({ ...OUT, mimeType: "image/webp", data: WEBP }, { prompt: "p" }, { root: ROOT, now: () => NOW, id: () => "b", fs: m.fs });
    expect(w.ok && w.ext).toBe("webp");
    // A label that disagrees with the bytes is refused.
    expect((await saveEditedImage({ ...OUT, mimeType: "image/png", data: JPEG }, { prompt: "p" }, { root: ROOT, now: () => NOW, id: () => "c", fs: m.fs })).ok).toBe(false);
  });

  test("an id that could climb out of the folder, or a relative root, writes nothing", async () => {
    for (const id of ["../../evil", "..", "a/b", "a\\b", "", "x".repeat(65), "C:"]) {
      const m = memFs();
      expect((await saveEditedImage(OUT, { prompt: "p" }, { root: ROOT, now: () => NOW, id: () => id, fs: m.fs })).ok).toBe(false);
      expect(m.files.size + m.dirs.length).toBe(0);
    }
    const m = memFs();
    expect((await saveEditedImage(OUT, { prompt: "p" }, { root: "relative/dir", now: () => NOW, id: () => "a", fs: m.fs })).ok).toBe(false);
    expect(m.files.size + m.dirs.length).toBe(0);
  });

  test("a failed record write removes the image; an existing file is never removed", async () => {
    const m = memFs({ meta: "ENOSPC" });
    const r = await saveEditedImage(OUT, { prompt: "p" }, { root: ROOT, now: () => NOW, id: () => "a", fs: m.fs });
    expect(r).toEqual({ ok: false, error: "The edited image could not be saved." });
    expect(m.files.size).toBe(0);
    const clash = memFs({ image: "EEXIST" });
    expect((await saveEditedImage(OUT, { prompt: "p" }, { root: ROOT, now: () => NOW, id: () => "a", fs: clash.fs })).ok).toBe(false);
    expect(clash.removed).toEqual([]);
  });
});

describe("the org's model policy", () => {
  test("a model the policy forbids is not offered, and is refused before anything leaves even when named", async () => {
    const noOpenAI = (ref: string) => !ref.startsWith("openai/");
    expect(availableImageModels(KEYS, noOpenAI).map((m) => m.provider)).not.toContain("openai");
    const h = harness([], { allowed: noOpenAI });
    const r = await editImage({ modelId: "gpt-image-2.6-sunburst", prompt: "p", image: IMG }, h.deps);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("model policy") });
    expect(h.egressed).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("a policy check that throws refuses (fail-closed)", async () => {
    const h = harness([], { allowed: () => { throw new Error("policy unreadable"); } });
    expect(await editImage({ modelId: "gemini-nano-banana-2.1", prompt: "p", image: IMG }, h.deps)).toMatchObject({ ok: false });
    expect(h.calls).toEqual([]);
  });
});
