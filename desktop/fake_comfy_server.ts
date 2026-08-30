// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/fake_comfy_server.ts - a TEST FIXTURE, not a product surface.
//
// A minimal server that speaks the DOCUMENTED ComfyUI routes LUCID actually calls, so the whole Creator
// image path (probe -> upload -> submit -> poll -> read back -> store) can be verified on a machine with no
// ComfyUI, no GPU, and no network. It is the ComfyUI analogue of desktop/fake_acp_agent.ts.
//
// It implements ONLY what LUCID uses, and it implements it the way the real server behaves in the ways that
// matter to us:
//   GET  /object_info        the node catalog (this is what capability attestation reads)
//   POST /upload/image       returns the stored filename
//   POST /prompt             queues a graph, returns { prompt_id }
//   GET  /history/<id>       ABSENT until the prompt finishes, then carries outputs (the real semantics)
//   GET  /view?filename=...  the produced image bytes
//
// Flags let a verifier exercise the unhappy paths too:
//   --port N          bind port (default 8188)
//   --delay MS        how long a "render" takes before /history lists it (default 400)
//   --no-video        omit the video node, so attestation must NOT claim `video`
//   --bare            publish a catalog with no output node at all (attestation: nothing proven)
//   --require-token T reject requests without `Authorization: Bearer T` (the unauthorized path)
//   --reject-submit   answer /prompt with node_errors (the rejected-workflow path)

import { encodePng } from "../harness/creator/imaging.ts";

const arg = (name: string, fallback = ""): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const PORT = Number(arg("port", "8188")) || 8188;
const DELAY_MS = Number(arg("delay", "400")) || 400;
const REQUIRE_TOKEN = arg("require-token");
const NO_VIDEO = flag("no-video");
const BARE = flag("bare");
const REJECT_SUBMIT = flag("reject-submit");

/** A 64x64 gradient, encoded by the SAME encoder the product uses, so /view returns real PNG bytes. */
const IMAGE_BYTES = ((): Uint8Array => {
  const w = 64, h = 64, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * 4) & 0xFF;
      rgba[i + 1] = (y * 4) & 0xFF;
      rgba[i + 2] = 160;
      rgba[i + 3] = 255;
    }
  }
  return encodePng({ width: w, height: h, rgba });
})();

const CATALOG: Record<string, unknown> = BARE
  ? { KSampler: { input: { required: { seed: ["INT", { default: 0 }] } } }, SomeCustomNode: { input: { required: {} } } }
  : {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl_base.safetensors", "flux1-dev.safetensors"], {}] } } },
    UNETLoader: { input: { required: { unet_name: [["wan_video_14b.safetensors"], {}] } } },
    VAELoader: { input: { required: { vae_name: [["sdxl_vae.safetensors"], {}] } } },
    KSampler: { input: { required: { seed: ["INT", { default: 0 }], steps: ["INT", { default: 20 }] } } },
    CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }] } } },
    EmptyLatentImage: { input: { required: { width: ["INT", { default: 1024 }], height: ["INT", { default: 1024 }] } } },
    VAEDecode: { input: { required: {} } },
    SaveImage: { input: { required: { filename_prefix: ["STRING", { default: "ComfyUI" }] } } },
    LoadImage: { input: { required: { image: [["example.png"], { image_upload: true }] } } },
    ...(NO_VIDEO ? {} : { VHS_VideoCombine: { input: { required: { frame_rate: ["INT", { default: 8 }] } } } }),
  };

interface Queued { promptId: string; finishAt: number; filename: string }
const queue = new Map<string, Queued>();
const uploads: string[] = [];
let seq = 0;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (REQUIRE_TOKEN && req.headers.get("authorization") !== `Bearer ${REQUIRE_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }

    if (p === "/object_info") return json(CATALOG);

    if (p === "/upload/image" && req.method === "POST") {
      const form = await req.formData().catch(() => null);
      const file = form?.get("image");
      const name = file instanceof File && file.name ? file.name : `upload_${++seq}.png`;
      uploads.push(name);
      console.log(`[fake-comfy] upload -> ${name}`);
      return json({ name, subfolder: "", type: "input" });
    }

    if (p === "/prompt" && req.method === "POST") {
      const body = await req.json().catch(() => null) as { prompt?: unknown } | null;
      if (!body || typeof body.prompt !== "object" || !body.prompt) return json({ error: "prompt is required" }, 400);
      if (REJECT_SUBMIT) return json({ error: "invalid prompt", node_errors: { "3": { errors: [{ message: "no such input" }] } } }, 200);
      const promptId = `p_${++seq}_${Date.now().toString(36)}`;
      queue.set(promptId, { promptId, finishAt: Date.now() + DELAY_MS, filename: `LUCID_${String(seq).padStart(5, "0")}_.png` });
      console.log(`[fake-comfy] queued ${promptId} (${Object.keys(body.prompt).length} nodes), finishing in ${DELAY_MS}ms`);
      return json({ prompt_id: promptId, number: seq, node_errors: {} });
    }

    if (p.startsWith("/history/")) {
      const id = decodeURIComponent(p.slice("/history/".length));
      const q = queue.get(id);
      // The real server lists ONLY finished prompts, so absence means "still running".
      if (!q || Date.now() < q.finishAt) return json({});
      return json({ [id]: { outputs: { "9": { images: [{ filename: q.filename, subfolder: "", type: "output" }] } } } });
    }

    if (p === "/view") {
      const filename = url.searchParams.get("filename") ?? "";
      if (!filename) return json({ error: "filename is required" }, 400);
      return new Response(IMAGE_BYTES, { headers: { "content-type": "image/png" } });
    }

    return json({ error: "not found", path: p }, 404);
  },
});

console.log(`[fake-comfy] ComfyUI-shaped fixture on http://127.0.0.1:${server.port}`);
console.log(`[fake-comfy] catalog: ${Object.keys(CATALOG).length} nodes${BARE ? " (bare: no output node)" : NO_VIDEO ? " (no video node)" : ""}${REQUIRE_TOKEN ? ", token required" : ""}${REJECT_SUBMIT ? ", /prompt rejects" : ""}`);
