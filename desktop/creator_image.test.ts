// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, test } from "bun:test";
import {
  ComfyClient, MAX_WIRE_FRAMES, applyWorkflowTemplate, artifactDir, artifactLedger, buildGif, buildSpriteSheet,
  decodePngDataUrl, decodeWireFrames, foldArtifacts, isPromptFinished, parseHistoryImages,
  parseObjectInfoModels, storeArtifact, viewUrl, type ArtifactIo, type FetchLike,
} from "./creator_image.ts";

function fakeIo(): ArtifactIo & { files: Record<string, string | Uint8Array>; ledger(): string } {
  let seq = 0;
  const files: Record<string, string | Uint8Array> = {};
  return {
    files,
    ledger: () => String(files[artifactLedger("/creator")] ?? ""),
    ensureDir: () => {},
    writeBytes: (p, b) => { files[p] = b; },
    writeText: (p, t) => { files[p] = t; },
    appendLine: (p, line) => { files[p] = String(files[p] ?? "") + line + "\n"; },
    readText: (p) => String(files[p] ?? ""),
    now: () => 1_700_000_000_000 + (++seq) * 1000,
    id: () => `art${++seq}`,
  };
}
const frame = (w: number, h: number, r: number, g: number, b: number) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; }
  return { width: w, height: h, rgba };
};
const wire = (w: number, h: number, fill = 7) => ({ width: w, height: h, rgbaB64: Buffer.alloc(w * h * 4, fill).toString("base64") });

describe("ComfyUI model discovery (CREATOR-IMG, ADR-0291)", () => {
  const objectInfo = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl_base.safetensors", "flux1-dev.safetensors"], {}] } } },
    UNETLoader: { input: { required: { unet_name: [["wan_video.safetensors"], {}] } } },
    KSampler: { input: { required: { seed: ["INT", { default: 0 }] } } },
  };

  test("the dropdown is a LIVE probe of that server, with the node each name came from", () => {
    const models = parseObjectInfoModels(objectInfo);
    expect(models.map((m) => m.id)).toEqual(["sdxl_base.safetensors", "flux1-dev.safetensors", "wan_video.safetensors"]);
    expect(models[0]!.kind).toBe("checkpoint");
    expect(models[2]!).toMatchObject({ kind: "diffusion", node: "UNETLoader" });
  });

  test("an unknown, empty, or renamed shape yields NO models rather than a guess", () => {
    expect(parseObjectInfoModels(null)).toEqual([]);
    expect(parseObjectInfoModels({})).toEqual([]);
    expect(parseObjectInfoModels({ CheckpointLoaderSimple: { input: { required: {} } } })).toEqual([]);
    expect(parseObjectInfoModels({ CheckpointLoaderSimple: { input: { required: { ckpt_name: ["STRING", {}] } } } })).toEqual([]);
  });

  test("duplicates collapse and non-strings are dropped", () => {
    const models = parseObjectInfoModels({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors", "a.safetensors", 7, "", "b.safetensors"], {}] } } },
    });
    expect(models.map((m) => m.id)).toEqual(["a.safetensors", "b.safetensors"]);
  });
});

describe("workflow templating: the user's graph, LUCID's values", () => {
  const template = {
    "3": { class_type: "KSampler", inputs: { seed: "{{seed}}", steps: 20 } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "{{model}}" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a {{prompt}}, cinematic" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "{{negative}}" } },
    "10": { class_type: "LoadImage", inputs: { image: "{{image:style}}" } },
  };

  test("a whole-string numeric placeholder stays a NUMBER (ComfyUI type-checks inputs)", () => {
    const r = applyWorkflowTemplate(template, { prompt: "neon alley", model: "sdxl_base.safetensors", seed: 42, inputs: [{ role: "style", filename: "ref.png" }] });
    const wf = r.workflow as typeof template;
    expect(wf["3"].inputs.seed).toBe(42);
    expect(typeof wf["3"].inputs.seed).toBe("number");
    expect(wf["6"].inputs.text).toBe("a neon alley, cinematic"); // interpolated inside prose
    expect(wf["4"].inputs.ckpt_name).toBe("sdxl_base.safetensors");
    expect(wf["10"].inputs.image).toBe("ref.png");
    expect(r.unresolved).toEqual([]);
    expect(r.substitutions).toBe(5);
  });

  test("an unsatisfied placeholder is REPORTED, so the caller refuses to submit", () => {
    const r = applyWorkflowTemplate(template, { prompt: "x" });
    expect(r.unresolved).toContain("model");
    expect(r.unresolved).toContain("seed");
    expect(r.unresolved).toContain("image:style");
  });

  test("image roles bind case-insensitively and by name, never by position", () => {
    const r = applyWorkflowTemplate({ a: "{{image:Style}}", b: "{{image:background}}" }, {
      prompt: "", inputs: [{ role: "style", filename: "s.png" }, { role: "BACKGROUND", filename: "bg.png" }],
    });
    expect(r.workflow).toEqual({ a: "s.png", b: "bg.png" });
  });

  test("nested arrays and unrelated values are preserved untouched", () => {
    const r = applyWorkflowTemplate({ links: [["4", 0], ["6", 0]], steps: 20, cfg: 7.5, flag: true, none: null }, { prompt: "p" });
    expect(r.workflow).toEqual({ links: [["4", 0], ["6", 0]], steps: 20, cfg: 7.5, flag: true, none: null });
  });
});

describe("history + view", () => {
  const history = {
    "abc-123": { outputs: { "9": { images: [{ filename: "ComfyUI_0001_.png", subfolder: "", type: "output" }, { filename: "b.png", subfolder: "sub", type: "temp" }] } } },
  };

  test("outputs are extracted from the prompt's own entry", () => {
    const refs = parseHistoryImages(history, "abc-123");
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ filename: "ComfyUI_0001_.png", subfolder: "", type: "output" });
    expect(refs[1]!.type).toBe("temp");
  });

  test("a pending prompt is not finished, and junk yields nothing", () => {
    expect(isPromptFinished(history, "abc-123")).toBe(true);
    expect(isPromptFinished(history, "not-queued")).toBe(false);
    expect(parseHistoryImages({ "abc-123": { outputs: { "9": { images: [{ nope: 1 }] } } } }, "abc-123")).toEqual([]);
    expect(parseHistoryImages(null, "x")).toEqual([]);
  });

  test("the view URL encodes every component (a server filename is untrusted text)", () => {
    const url = viewUrl("http://127.0.0.1:8188/", { filename: "a b&c.png", subfolder: "s/1", type: "output" });
    expect(url.startsWith("http://127.0.0.1:8188/view?")).toBe(true);
    expect(url).toContain("filename=a+b%26c.png");
    expect(url).toContain("subfolder=s%2F1");
  });
});

describe("artifact storage", () => {
  test("an artifact lands with a sha256, its provenance, and its sidecars", () => {
    const io = fakeIo();
    const r = storeArtifact(io, "/creator", {
      kind: "image", bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]), mime: "image/png",
      width: 64, height: 64, source: "comfyui", prompt: "neon alley", model: "sdxl_base.safetensors",
      sidecars: { json: "{}" },
    });
    expect(r.ok).toBe(true);
    expect(r.artifact!.sha256).toHaveLength(64);
    expect(r.artifact!.file.endsWith(".png")).toBe(true);
    expect(r.artifact!.sidecars).toHaveLength(1);
    expect(r.path!.startsWith(artifactDir("/creator"))).toBe(true);
    expect(foldArtifacts(io.ledger())).toHaveLength(1);
    expect(foldArtifacts(io.ledger())[0]!.prompt).toBe("neon alley");
  });

  test("the write path comes from a generated id, so a caller cannot steer it", () => {
    const io = fakeIo();
    const r = storeArtifact(io, "/creator", { kind: "image", bytes: new Uint8Array([1]), mime: "image/png", width: 1, height: 1, source: "../../etc/passwd" });
    expect(r.path).toBe(`${artifactDir("/creator")}/art1.png`);
    expect(Object.keys(io.files).every((p) => p.startsWith("/creator/"))).toBe(true);
  });

  test("a non-image mime and an empty payload are refused", () => {
    const io = fakeIo();
    expect(storeArtifact(io, "/creator", { kind: "image", bytes: new Uint8Array([1]), mime: "application/zip", width: 1, height: 1, source: "x" }).ok).toBe(false);
    expect(storeArtifact(io, "/creator", { kind: "image", bytes: new Uint8Array(0), mime: "image/png", width: 1, height: 1, source: "x" }).ok).toBe(false);
    expect(foldArtifacts(io.ledger())).toEqual([]);
  });

  test("a torn ledger line costs one record", () => {
    const io = fakeIo();
    storeArtifact(io, "/creator", { kind: "gif", bytes: new Uint8Array([1, 2]), mime: "image/gif", width: 2, height: 2, source: "local" });
    expect(foldArtifacts(io.ledger() + '{"id":"x","fil\n')).toHaveLength(1);
  });
});

describe("frames on the wire are fail-closed", () => {
  test("a well-formed batch decodes", () => {
    const r = decodeWireFrames([wire(2, 2), wire(2, 2)]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.frames[0]!.rgba.length).toBe(16);
  });

  test("a byte-count mismatch refuses the WHOLE request, naming the frame", () => {
    const bad = { width: 4, height: 4, rgbaB64: Buffer.alloc(8).toString("base64") };
    const r = decodeWireFrames([wire(4, 4), bad]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Frame 2");
  });

  test("empty input, oversize edges, too many frames, and non-base64 are all refused", () => {
    expect(decodeWireFrames([]).ok).toBe(false);
    expect(decodeWireFrames([{ width: 4096, height: 4, rgbaB64: "" }]).ok).toBe(false);
    expect(decodeWireFrames(Array.from({ length: MAX_WIRE_FRAMES + 1 }, () => wire(1, 1))).ok).toBe(false);
    expect(decodeWireFrames([{ width: 1, height: 1, rgbaB64: "not base64!!" }]).ok).toBe(false);
  });

  test("a PNG data URL must actually be a PNG", () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 1]).toString("base64");
    const ok = decodePngDataUrl(`data:image/png;base64,${png}`);
    expect(ok.ok).toBe(true);
    expect(decodePngDataUrl(`data:image/png;base64,${Buffer.from("not a png").toString("base64")}`).ok).toBe(false);
    expect(decodePngDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=").ok).toBe(false); // SVG is a script risk
    expect(decodePngDataUrl("http://example.com/x.png").ok).toBe(false);
  });
});

describe("the ComfyUI client is honest when the server is not there", () => {
  const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("a reachable server yields its own model list; the token rides a HEADER", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const stub: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      seen.push({ url, auth: headers.get("authorization") });
      return jsonRes({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl.safetensors"], {}] } } } });
    };
    const c = new ComfyClient({ baseUrl: "http://127.0.0.1:8188/", token: "t0ken", fetchImpl: stub });
    const r = await c.probeModels();
    expect(r.ok).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual(["sdxl.safetensors"]);
    expect(seen[0]!.url).toBe("http://127.0.0.1:8188/object_info");
    expect(seen[0]!.auth).toBe("Bearer t0ken");
    expect(seen[0]!.url).not.toContain("t0ken");
  });

  test("an unreachable server is a reason, not an exception, and yields no models", async () => {
    const c = new ComfyClient({ baseUrl: "http://127.0.0.1:1", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    const r = await c.probeModels();
    expect(r.ok).toBe(false);
    expect(r.models).toEqual([]);
    expect(r.note).toContain("Could not reach ComfyUI");
  });

  test("a rejected workflow surfaces ComfyUI's own refusal", async () => {
    const c = new ComfyClient({ baseUrl: "http://x", fetchImpl: async () => jsonRes({ node_errors: { "3": "bad input" } }) });
    const r = await c.submit({});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("rejected the workflow");
  });

  test("waiting stops at the deadline instead of hanging, and a finished prompt returns its images", async () => {
    let calls = 0;
    const pending = new ComfyClient({ baseUrl: "http://x", fetchImpl: async () => { calls++; return jsonRes({}); } });
    const timedOut = await pending.waitForImages("p1", { pollMs: 250, maxWaitMs: 250, sleep: async () => {} });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toContain("did not finish");
    expect(calls).toBeGreaterThan(0);
    const done = new ComfyClient({ baseUrl: "http://x", fetchImpl: async () => jsonRes({ p1: { outputs: { "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } } } }) });
    const r = await done.waitForImages("p1", { pollMs: 250, maxWaitMs: 1000, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.refs![0]!.filename).toBe("a.png");
  });

  test("a finished prompt with no image output says exactly that", async () => {
    const c = new ComfyClient({ baseUrl: "http://x", fetchImpl: async () => jsonRes({ p1: { outputs: {} } }) });
    const r = await c.waitForImages("p1", { pollMs: 250, maxWaitMs: 500, sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no image output");
  });
});

describe("the local builders need no provider at all", () => {
  test("a sprite sheet writes a PNG plus its manifest and CSS", () => {
    const io = fakeIo();
    const r = buildSpriteSheet(io, "/creator", [frame(4, 4, 255, 0, 0), frame(4, 4, 0, 255, 0), frame(4, 4, 0, 0, 255)], { name: "run cycle", columns: 3, durationMs: 300 });
    expect(r.ok).toBe(true);
    expect(r.result!.artifact.kind).toBe("sheet");
    expect(r.result!.artifact.width).toBe(12);
    expect(r.result!.artifact.height).toBe(4);
    expect(r.result!.css).toContain(".run-cycle");
    expect(r.result!.manifest).toContain('"count": 3');
    expect(r.result!.artifact.sidecars.some((s) => s.endsWith(".json"))).toBe(true);
    const png = io.files[r.result!.path];
    expect(png instanceof Uint8Array && png[1] === 0x50).toBe(true);
  });

  test("a GIF is written with the GIF89a header and stored as image/gif", () => {
    const io = fakeIo();
    const r = buildGif(io, "/creator", [frame(4, 4, 10, 20, 30), frame(4, 4, 200, 10, 10)], { delayMs: 120 });
    expect(r.ok).toBe(true);
    expect(r.artifact!.mime).toBe("image/gif");
    const gif = io.files[r.path!];
    expect(gif instanceof Uint8Array ? Buffer.from(gif.subarray(0, 6)).toString("latin1") : "").toBe("GIF89a");
  });

  test("mismatched frames are refused with the reason, and nothing is stored", () => {
    const io = fakeIo();
    const r = buildGif(io, "/creator", [frame(4, 4, 1, 1, 1), frame(5, 4, 1, 1, 1)], {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("share one size");
    expect(foldArtifacts(io.ledger())).toEqual([]);
  });
});
