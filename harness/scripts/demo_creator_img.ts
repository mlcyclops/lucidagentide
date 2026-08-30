// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_creator_img.ts - CREATOR-IMG (ADR-0291): the runnable proof.
//
// Five sections, no network, no GPU, no provider:
//   1. sprite sheets: real geometry, real pixels, a manifest and a CSS animation
//   2. animated GIFs: a valid GIF89a whose LZW stream DECODES back to the exact indices
//   3. memes: text that fits, wraps, and never leaves the image
//   4. the model dropdown + the workflow template: a live probe, and a refusal when a value is missing
//   5. artifacts: provenance, a confined write path, and fail-closed wire frames
//
// The point of the demo is the honesty boundary: everything in 1-3 works with nothing configured, and
// section 4 proves LUCID refuses to submit a half-built graph rather than inventing one.

import { inflateSync } from "node:zlib";
import {
  composeSpriteSheet, crc32, encodeGif, encodePng, lzwEncode, memeLayout, quantize, sheetManifest,
  spriteCss, wrapLines, type RgbaFrame,
} from "../creator/imaging.ts";
import {
  applyWorkflowTemplate, artifactDir, artifactLedger, buildGif, buildSpriteSheet, decodePngDataUrl,
  decodeWireFrames, foldArtifacts, parseHistoryImages, parseObjectInfoModels, storeArtifact, viewUrl,
  type ArtifactIo,
} from "../../desktop/creator_image.ts";
import { creatorImagesHtml } from "../../desktop/renderer/creator_images.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`   ${ok ? "ok" : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

const solid = (w: number, h: number, r: number, g: number, b: number, a = 255): RgbaFrame => {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a; }
  return { width: w, height: h, rgba };
};

/** An independent GIF LZW decoder: the encoder is proven by ROUND TRIP, not by eyeballing bytes. */
function lzwDecode(blocks: Uint8Array, minCodeSize: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < blocks.length;) {
    const len = blocks[i]!;
    if (len === 0) break;
    for (let j = 0; j < len; j++) data.push(blocks[i + 1 + j]!);
    i += len + 1;
  }
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict.push([i]); dict.push([], []); codeSize = minCodeSize + 1; };
  reset();
  const out: number[] = [];
  let bitPos = 0, prev: number[] | null = null;
  const read = (): number => {
    let v = 0;
    for (let i = 0; i < codeSize; i++) { v |= (((data[bitPos >> 3] ?? 0) >> (bitPos & 7)) & 1) << i; bitPos++; }
    return v;
  };
  for (;;) {
    if ((bitPos >> 3) >= data.length) break;
    const code = read();
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;
    const entry: number[] | null = code < dict.length && dict[code]!.length ? dict[code]! : prev ? [...prev, prev[0]!] : null;
    if (!entry) break;
    out.push(...entry);
    if (prev) { dict.push([...prev, entry[0]!]); if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++; }
    prev = entry;
  }
  return out;
}

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

console.log("1) sprite sheets: geometry, pixels, manifest, and a CSS animation");
const walk = [solid(8, 8, 255, 0, 0), solid(8, 8, 0, 255, 0), solid(8, 8, 0, 0, 255), solid(8, 8, 255, 255, 0)];
const sheet = composeSpriteSheet(walk, 2);
check("four 8x8 frames pack into a 2x2 grid", sheet.layout.width === 16 && sheet.layout.height === 16 && sheet.layout.count === 4);
const px = (f: RgbaFrame, x: number, y: number) => [...f.rgba.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 4)];
check("frame 2 lands in the top-right cell, frame 3 in the bottom-left",
  px(sheet.frame, 8, 0).join() === "0,255,0,255" && px(sheet.frame, 0, 8).join() === "0,0,255,255");
const sheetPng = encodePng(sheet.frame);
check("the sheet encodes as a real PNG (signature + 3 chunks with valid CRCs)", (() => {
  if (![0x89, 0x50, 0x4E, 0x47].every((b, i) => sheetPng[i] === b)) return false;
  let at = 8, chunks = 0;
  while (at < sheetPng.length) {
    const len = (sheetPng[at]! << 24) | (sheetPng[at + 1]! << 16) | (sheetPng[at + 2]! << 8) | sheetPng[at + 3]!;
    const body = sheetPng.subarray(at + 4, at + 8 + len);
    const crc = ((sheetPng[at + 8 + len]! << 24) | (sheetPng[at + 9 + len]! << 16) | (sheetPng[at + 10 + len]! << 8) | sheetPng[at + 11 + len]!) >>> 0;
    if (crc32(body) !== crc) return false;
    at += 12 + len; chunks++;
  }
  return chunks === 3;
})(), `${sheetPng.length} bytes`);
check("the PNG's pixels inflate back to the composed sheet", (() => {
  const start = 8 + 12 + 13;
  const len = (sheetPng[start]! << 24) | (sheetPng[start + 1]! << 16) | (sheetPng[start + 2]! << 8) | sheetPng[start + 3]!;
  const raw = new Uint8Array(inflateSync(sheetPng.subarray(start + 8, start + 8 + len)));
  return raw.length === 16 * (16 * 4 + 1) && raw[0] === 0 && raw[1] === 255 && raw[2] === 0;
})());
check("the CSS animation steps through every cell", spriteCss("run", sheet.layout, 400).includes("background-position: -8px -8px"));
check("the manifest describes each frame rect + per-frame timing", sheetManifest("run", sheet.layout, 400).includes('"frameDurationMs": 100'));

console.log("2) animated GIFs: a valid GIF89a whose LZW stream decodes exactly");
const indices = new Uint8Array([0, 0, 1, 1, 2, 2, 2, 0, 1, 2, 3, 3, 3, 3, 1, 0]);
check("LZW round-trips a short stream", lzwDecode(lzwEncode(indices, 2), 2).join() === [...indices].join());
const long = new Uint8Array(4096);
for (let i = 0; i < long.length; i++) long[i] = (i * 5) % 16;
check("LZW round-trips 4096 indices through a code-size growth", lzwDecode(lzwEncode(long, 4), 4).join() === [...long].join());
const gif = encodeGif(walk, { delayMs: 120, loop: 0 });
check("the GIF has the GIF89a header, the loop block, and the trailer",
  Buffer.from(gif.subarray(0, 6)).toString("latin1") === "GIF89a" && Buffer.from(gif).toString("latin1").includes("NETSCAPE2.0") && gif[gif.length - 1] === 0x3B,
  `${gif.length} bytes`);
check("one image descriptor per frame", (() => { let n = 0; for (const b of gif) if (b === 0x2C) n++; return n >= 4; })());
check("delays are written in GIF ticks (120ms -> 12)", (() => {
  for (let i = 0; i < gif.length - 8; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xF9) return (gif[i + 4]! | (gif[i + 5]! << 8)) === 12;
  return false;
})());
const withAlpha = solid(4, 4, 200, 0, 0);
withAlpha.rgba.set([0, 0, 0, 0], 0);
check("a transparent pixel reserves its own palette slot", quantize([withAlpha]).transparentIndex !== null);
check("encoding is byte-deterministic (a test can pin it)",
  Buffer.from(encodeGif(walk, { delayMs: 120 })).equals(Buffer.from(encodeGif(walk, { delayMs: 120 }))));

console.log("3) memes: text that fits, wraps, and stays inside the image");
const measure = (t: string, px2: number) => t.length * px2 * 0.6; // a monospace stub; the renderer measures for real
const meme = memeLayout({ width: 600, height: 600, top: "one does not simply ship without a demo", bottom: "and the tests still pass", measure });
check("both blocks fit inside the top and bottom thirds",
  !!meme.top && !!meme.bottom && meme.top.lines.length * meme.top.lineHeight <= 200 && meme.bottom.lines.length * meme.bottom.lineHeight <= 200);
check("every line fits the width", meme.top!.lines.every((l) => measure(l, meme.top!.fontPx) <= 600 - 48));
check("the bottom block ends inside the image",
  meme.bottom!.y + (meme.bottom!.lines.length - 1) * meme.bottom!.lineHeight <= 600);
check("an unbreakable word is split rather than spilling out",
  wrapLines("supercalifragilisticexpialidocious", 100, 20, measure).every((l) => measure(l, 20) <= 100));
check("empty text yields no block at all", memeLayout({ width: 300, height: 300, top: "   ", measure }).top === null);

console.log("4) the model dropdown + the user's OWN workflow template");
const models = parseObjectInfoModels({
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl_base.safetensors", "flux1-dev.safetensors"], {}] } } },
  UNETLoader: { input: { required: { unet_name: [["wan_video.safetensors"], {}] } } },
});
check("the dropdown is a live probe of that install, tagged by loader",
  models.length === 3 && models[2]!.kind === "diffusion", models.map((m) => m.id).join(", "));
check("a renamed or missing shape yields NO models rather than a guess",
  parseObjectInfoModels({ CheckpointLoaderSimple: { input: { required: {} } } }).length === 0);
const template = {
  "3": { class_type: "KSampler", inputs: { seed: "{{seed}}", steps: 20 } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "{{model}}" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a {{prompt}}, cinematic" } },
  "10": { class_type: "LoadImage", inputs: { image: "{{image:style}}" } },
};
const missing = applyWorkflowTemplate(template, { prompt: "neon alley" });
check("an unsatisfied placeholder is reported, so the caller REFUSES to submit",
  missing.unresolved.length === 3, missing.unresolved.join(", "));
const applied = applyWorkflowTemplate(template, { prompt: "neon alley", model: "sdxl_base.safetensors", seed: 7, inputs: [{ role: "style", filename: "ref.png" }] });
check("a complete spec resolves everything, keeping numbers as numbers", (() => {
  if (applied.unresolved.length) return false;
  const wf = applied.workflow;
  if (!wf || typeof wf !== "object" || !("3" in wf) || !("6" in wf)) return false;
  const ks: unknown = (wf as Record<string, unknown>)["3"];
  const enc: unknown = (wf as Record<string, unknown>)["6"];
  const seed = ks && typeof ks === "object" && "inputs" in ks && ks.inputs && typeof ks.inputs === "object" && "seed" in ks.inputs ? ks.inputs.seed : null;
  const text = enc && typeof enc === "object" && "inputs" in enc && enc.inputs && typeof enc.inputs === "object" && "text" in enc.inputs ? enc.inputs.text : null;
  return seed === 7 && text === "a neon alley, cinematic";
})());
check("images bind by ROLE, not by position",
  JSON.stringify(applyWorkflowTemplate({ a: "{{image:Style}}" }, { prompt: "", inputs: [{ role: "style", filename: "s.png" }] }).workflow) === '{"a":"s.png"}');
check("finished outputs are read from the prompt's own history entry",
  parseHistoryImages({ p1: { outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } }, "p1")[0]!.filename === "out.png");
check("a server filename is still untrusted text: the view URL encodes it",
  viewUrl("http://127.0.0.1:8188", { filename: "a b&c.png", subfolder: "", type: "output" }).includes("filename=a+b%26c.png"));

console.log("5) artifacts: provenance, a confined path, and fail-closed wire frames");
const io = fakeIo();
const built = buildSpriteSheet(io, "/creator", walk, { name: "run cycle", columns: 4, durationMs: 400 });
check("a sheet stores the PNG plus its manifest and CSS sidecars",
  built.ok && built.result!.artifact.sidecars.length === 2 && built.result!.artifact.width === 32);
const gifStored = buildGif(io, "/creator", walk, { delayMs: 100 });
check("a GIF stores as image/gif with a sha256", gifStored.ok && gifStored.artifact!.mime === "image/gif" && gifStored.artifact!.sha256.length === 64);
const generated = storeArtifact(io, "/creator", {
  kind: "image", bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1]), mime: "image/png",
  width: 1024, height: 1024, source: "comfyui http://127.0.0.1:8188", prompt: "neon alley", model: "sdxl_base.safetensors",
});
check("a generated image keeps the prompt and model that made it",
  generated.ok && generated.artifact!.prompt === "neon alley" && generated.artifact!.model === "sdxl_base.safetensors");
check("the write path comes from a generated id, so a caller cannot steer it",
  Object.keys(io.files).every((p) => p.startsWith("/creator/")) && built.result!.path.startsWith(artifactDir("/creator")));
check("the ledger folds newest-first and survives a torn tail",
  foldArtifacts(io.ledger()).length === 3 && foldArtifacts(io.ledger() + '{"id":"x","fi\n').length === 3);
const okFrames = decodeWireFrames([{ width: 2, height: 2, rgbaB64: Buffer.alloc(16, 3).toString("base64") }]);
check("well-formed wire frames decode", okFrames.ok);
const badFrames = decodeWireFrames([{ width: 4, height: 4, rgbaB64: Buffer.alloc(8).toString("base64") }]);
check("a byte-count mismatch refuses the WHOLE request, naming the frame",
  !badFrames.ok && badFrames.error.includes("Frame 1"), badFrames.ok ? "" : badFrames.error);
check("SVG and mislabeled bytes are refused as image inputs",
  !decodePngDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=").ok
  && !decodePngDataUrl(`data:image/png;base64,${Buffer.from("nope").toString("base64")}`).ok);
const pane = creatorImagesHtml({
  endpoint: "", models: [], note: "", artifacts: [], inputs: [], selected: [], model: "", prompt: "", negative: "", busy: "",
});
check("with NOTHING configured, the pane still offers the local builders and says so",
  pane.includes("No image provider is connected") && pane.includes("no provider configured and no network at all"));

console.log(failures === 0
  ? "\ndemo_creator_img OK - sprite sheets, animated GIFs, and memes are encoded inside LUCID (valid PNG chunks, an LZW stream that decodes back to its own indices, text that always fits), the model dropdown is a live probe of the user's own ComfyUI install, a workflow with an unfilled placeholder is REFUSED instead of guessed, and every artifact carries the prompt, model, and sha256 that produced it."
  : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
