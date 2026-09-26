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
//   GET  /view?filename=...  the produced bytes: PNG, or the WEBM/GLB stub when the name ends .webm/.glb
//   GET  /ws?clientId=...    the progress websocket (real ComfyUI's live channel), see the frame table below
//
// Flags let a verifier exercise the unhappy paths too. Every flag is ADDITIVE: with none of them set, every
// route answers exactly what it answered before the websocket existed.
//   --port N          bind port (default 8188)
//   --delay MS        how long a "render" takes before /history lists it (default 400); also paces /ws
//   --no-video        omit the video node, so attestation must NOT claim `video`
//   --bare            publish a catalog with no output node at all (attestation: nothing proven)
//   --require-token T reject requests without `Authorization: Bearer T` (the unauthorized path). The guard
//                     runs BEFORE routing, so an unauthorized /ws upgrade is refused with 401 as well.
//   --reject-submit   answer /prompt with node_errors (the rejected-workflow path)
//   --video-output    the finished prompt's history ALSO carries a `videos` entry on node "11", and /view
//                     serves the WEBM stub for that filename as `video/webm`
//   --3d-output       the finished prompt's history ALSO carries a `model_file` entry on node "12" (a .glb),
//                     and /view serves the GLB stub for that filename as `model/gltf-binary`
//   --ws-silent       accept the /ws upgrade and then send NOTHING, ever (a client's timeout path)
//   --ws-noise        prepend a noise burst to every prompt's frame sequence: two frames carrying a FOREIGN
//                     prompt_id, one malformed text frame, one truncated binary frame (a client's
//                     ignore-and-do-not-throw path). The real sequence still follows, intact.
//   --lying-mime      EVERY /view response serves the PNG bytes while CLAIMING `content-type: video/mp4`,
//                     so a pipeline's magic-byte check can be proven to refuse a server that lies
//   --ws-error        the prompt FAILS mid-stream: at t = delay the socket gets one `execution_error` in
//                     place of the `executed` frames, and NOTHING after it - no terminal
//                     `executing:node=null`. A client that waits for an end signal by frame TYPE therefore
//                     waits forever, which is the bug this flag exists to catch: a decoder must terminate
//                     on the error frame itself. The HTTP path is deliberately UNCHANGED, so this exercises
//                     the socket's failure path only.
//
// The /ws frame sequence, per submitted prompt, paced across --delay MS (step = delay/5):
//   on upgrade      { type: "status", data: { status: { exec_info: { queue_remaining: 0 } }, sid } }
//   t = 0           { type: "status", data: { status: { exec_info: { queue_remaining: 1 } }, sid } }
//                   [ --ws-noise burst lands here ]
//                   { type: "execution_start", data: { prompt_id } }
//                   { type: "executing",       data: { node: "3", display_node: "3", prompt_id } }
//   t = 1..4 step   { type: "progress", data: { value: 5|10|15|20, max: 20, prompt_id, node: "3" } }
//   t = 2 step      BINARY preview: 4 big-endian bytes eventType=1, 4 big-endian bytes format=2 (PNG),
//                   then the PNG bytes /view already serves
//   t = delay       one { type: "executed", data: { node, display_node, prompt_id, output } } per OUTPUT
//                   node: "9" images, plus "11" videos with --video-output, plus "12" model_file with
//                   --3d-output. The same node ids and refs /history reports.
//                   { type: "executing", data: { node: null, prompt_id } }  <- end of prompt, nothing after
//   with --ws-error { type: "execution_error", data: { prompt_id, node_id: "3", exception_type,
//                   exception_message } } REPLACES both of the frames above, and nothing follows it.
// Frames go to the socket whose clientId matches the /prompt body's `client_id`; a body with no client_id,
// or a socket that connected with no clientId, broadcasts.

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
const VIDEO_OUTPUT = flag("video-output");
const MODEL_OUTPUT = flag("3d-output");
const WS_SILENT = flag("ws-silent");
const WS_NOISE = flag("ws-noise");
const WS_ERROR = flag("ws-error");
const LYING_MIME = flag("lying-mime");

/** The failure --ws-error reports. A fixed sentence rather than a random one: a verifier asserts the exact
 *  text survives decoding, and an error whose wording drifts every run cannot be asserted at all. */
const WS_ERROR_MESSAGE = "CUDA out of memory: tried to allocate 2.00 GiB";

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

/** A HEADER-VALID STUB, not a playable file: 256 bytes whose first four are the EBML magic `1A 45 DF A3`,
 *  then deterministic filler. It exists so a magic-byte check can pass on real WEBM framing bytes and a
 *  byte-count assertion has something stable to assert. No demuxer will ever get a frame out of it. */
const WEBM_BYTES = ((): Uint8Array => {
  const out = new Uint8Array(256);
  out[0] = 0x1A; out[1] = 0x45; out[2] = 0xDF; out[3] = 0xA3;
  for (let i = 4; i < out.length; i++) out[i] = (i * 7) & 0xFF;
  return out;
})();

/** A HEADER-VALID STUB, not a loadable scene: the 12-byte glTF binary header (magic `glTF`, version 2,
 *  total length) followed by one JSON chunk holding `{"asset":{"version":"2.0"}}` padded to 4-byte
 *  alignment. 48 bytes total. It carries no buffers, no meshes, and no scene: a loader will reject it. */
const GLB_BYTES = ((): Uint8Array => {
  const jsonText = `{"asset":{"version":"2.0"}}`;
  const raw = new TextEncoder().encode(jsonText);
  const padded = new Uint8Array(Math.ceil(raw.length / 4) * 4).fill(0x20);
  padded.set(raw, 0);
  const out = new Uint8Array(12 + 8 + padded.length);
  const dv = new DataView(out.buffer);
  out[0] = 0x67; out[1] = 0x6C; out[2] = 0x54; out[3] = 0x46; // "glTF"
  dv.setUint32(4, 2, true);                                   // version 2, little-endian (the GLB spec)
  dv.setUint32(8, out.length, true);                          // total length
  dv.setUint32(12, padded.length, true);                      // chunk 0 byte length
  dv.setUint32(16, 0x4E4F534A, true);                         // chunk 0 type "JSON"
  out.set(padded, 20);
  return out;
})();

/** The real binary preview frame: `>I` event type then `>I` format, then the image bytes. Event type 1 is
 *  PREVIEW_IMAGE and format 2 is PNG, exactly as ComfyUI's server packs it. */
const PREVIEW_FRAME = ((): Uint8Array => {
  const out = new Uint8Array(8 + IMAGE_BYTES.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1, false); // big-endian event type: 1 = PREVIEW_IMAGE
  dv.setUint32(4, 2, false); // big-endian format:     2 = PNG
  out.set(IMAGE_BYTES, 8);
  return out;
})();

/** --ws-noise payloads. A foreign prompt's frames (including its END signal, which a client keyed only on
 *  frame type would wrongly accept), text that is not JSON at all, and a binary frame shorter than the
 *  8-byte header. None of these may make a client throw, and none may end the client's own prompt. */
const NOISE_PROMPT_ID = "p_someone_elses_prompt";
const NOISE_MALFORMED_TEXT = `{"type":"progress","data":{`;
const NOISE_TRUNCATED_BINARY = new Uint8Array([0x00, 0x00, 0x00]);

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

interface Queued { promptId: string; finishAt: number; filename: string; videoName: string; modelName: string }
const queue = new Map<string, Queued>();
const uploads: string[] = [];
let seq = 0;

/** Minimal structural view of Bun's ServerWebSocket, the same shape desktop/collab/relay_server.ts uses. */
interface SockData { clientId: string }
interface WS {
  data: SockData;
  send(data: string | Uint8Array): number;
}
const sockets = new Set<WS>();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The output nodes of a finished prompt. /history and the `executed` frames report the SAME refs, because
 *  the real server does. Without --video-output and --3d-output this is node "9" alone, byte for byte what
 *  the fixture has always reported. */
const outputNodes = (q: Queued): Array<{ node: string; output: Record<string, unknown> }> => {
  const nodes: Array<{ node: string; output: Record<string, unknown> }> = [
    { node: "9", output: { images: [{ filename: q.filename, subfolder: "", type: "output" }] } },
  ];
  if (VIDEO_OUTPUT) nodes.push({ node: "11", output: { videos: [{ filename: q.videoName, subfolder: "", type: "output", format: "video/webm" }] } });
  if (MODEL_OUTPUT) nodes.push({ node: "12", output: { model_file: [{ filename: q.modelName, subfolder: "", type: "output", format: "model/gltf-binary" }] } });
  return nodes;
};

/** What /view answers for a name. --lying-mime overrides every case: PNG bytes under a video/mp4 label. */
const viewBody = (filename: string): { bytes: Uint8Array; mime: string } => {
  if (LYING_MIME) return { bytes: IMAGE_BYTES, mime: "video/mp4" };
  if (filename.endsWith(".webm")) return { bytes: WEBM_BYTES, mime: "video/webm" };
  if (filename.endsWith(".glb")) return { bytes: GLB_BYTES, mime: "model/gltf-binary" };
  return { bytes: IMAGE_BYTES, mime: "image/png" };
};

/** Deliver to the prompt's own client when it named one, else to every open socket (the real server keys on
 *  the sid it handed out; a fixture client that skipped clientId still deserves to see its frames). */
const sendTo = (clientId: string, payload: string | Uint8Array): void => {
  if (WS_SILENT) return;
  for (const ws of sockets) {
    if (clientId && ws.data.clientId && ws.data.clientId !== clientId) continue;
    try { ws.send(payload); } catch { /* socket already gone */ }
  }
};

const statusFrame = (clientId: string, queueRemaining: number): string =>
  JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: queueRemaining } }, sid: clientId } });

/** The whole per-prompt sequence, paced across --delay so a test can run it in tens of milliseconds. */
function emitPromptFrames(q: Queued, clientId: string): void {
  if (WS_SILENT) return;
  const step = Math.max(1, Math.floor(DELAY_MS / 5));
  const text = (o: unknown) => sendTo(clientId, JSON.stringify(o));

  setTimeout(() => {
    sendTo(clientId, statusFrame(clientId, 1));
    // The POSITION of this burst is the point, not just its presence: the foreign `executing:node=null`
    // lands BEFORE our own execution_start, so a client that treats that frame as terminal without
    // matching prompt_id gives up before the real run starts. That failure is loud and instantly
    // diagnosable instead of a subtle truncation at the end. Never move this burst after the sequence.
    if (WS_NOISE) {
      text({ type: "progress", data: { value: 1, max: 1, prompt_id: NOISE_PROMPT_ID, node: "1" } });
      text({ type: "executing", data: { node: null, prompt_id: NOISE_PROMPT_ID } });
      sendTo(clientId, NOISE_MALFORMED_TEXT);
      sendTo(clientId, NOISE_TRUNCATED_BINARY);
    }
    text({ type: "execution_start", data: { prompt_id: q.promptId } });
    text({ type: "executing", data: { node: "3", display_node: "3", prompt_id: q.promptId } });
  }, 0);

  const MAX_STEPS = 20;
  for (const [i, value] of [5, 10, 15, 20].entries()) {
    setTimeout(() => {
      text({ type: "progress", data: { value, max: MAX_STEPS, prompt_id: q.promptId, node: "3" } });
      if (i === 1) sendTo(clientId, PREVIEW_FRAME);
    }, step * (i + 1));
  }

  setTimeout(() => {
    // --ws-error: the run FAILS here, and the socket says so ONCE. No `executed` frames, and deliberately
    // no terminal `executing:node=null` after it - a client that ends a run on frame type alone would hang
    // forever waiting for a signal that is never coming, and that hang is precisely what this flag proves
    // a decoder must not do. Terminating on the error frame itself is the only correct behaviour.
    if (WS_ERROR) {
      text({ type: "execution_error", data: { prompt_id: q.promptId, node_id: "3", exception_type: "RuntimeError", exception_message: WS_ERROR_MESSAGE } });
      return;
    }
    for (const n of outputNodes(q)) {
      text({ type: "executed", data: { node: n.node, display_node: n.node, prompt_id: q.promptId, output: n.output } });
    }
    text({ type: "executing", data: { node: null, prompt_id: q.promptId } });
    // Never before the last progress frame, even at --delay 1, where step*4 would outrun DELAY_MS.
  }, Math.max(DELAY_MS, step * 4 + 1));
}

const server = Bun.serve<SockData>({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (REQUIRE_TOKEN && req.headers.get("authorization") !== `Bearer ${REQUIRE_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }

    // The progress channel. The token guard above already ran, so an unauthorized upgrade never reaches here.
    if (p === "/ws") {
      const clientId = url.searchParams.get("clientId") ?? url.searchParams.get("client_id") ?? "";
      const ok = srv.upgrade(req, { data: { clientId } });
      return ok ? undefined : json({ error: "expected a websocket upgrade" }, 426);
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
      // Narrowed, never cast: this is raw remote input. The accept/refuse rule is unchanged - a missing or
      // non-object `prompt` is refused, anything object-shaped (including an array) is queued.
      const body: unknown = await req.json().catch(() => null);
      const hasBody = !!body && typeof body === "object";
      const graph: unknown = hasBody && "prompt" in body ? body.prompt : undefined;
      if (!graph || typeof graph !== "object") return json({ error: "prompt is required" }, 400);
      if (REJECT_SUBMIT) return json({ error: "invalid prompt", node_errors: { "3": { errors: [{ message: "no such input" }] } } }, 200);
      const wanted: unknown = hasBody && "client_id" in body ? body.client_id : undefined;
      const promptId = `p_${++seq}_${Date.now().toString(36)}`;
      const stem = `LUCID_${String(seq).padStart(5, "0")}_`;
      const q: Queued = { promptId, finishAt: Date.now() + DELAY_MS, filename: `${stem}.png`, videoName: `${stem}.webm`, modelName: `${stem}.glb` };
      queue.set(promptId, q);
      console.log(`[fake-comfy] queued ${promptId} (${Object.keys(graph).length} nodes), finishing in ${DELAY_MS}ms`);
      emitPromptFrames(q, typeof wanted === "string" ? wanted : "");
      return json({ prompt_id: promptId, number: seq, node_errors: {} });
    }

    if (p.startsWith("/history/")) {
      const id = decodeURIComponent(p.slice("/history/".length));
      const q = queue.get(id);
      // The real server lists ONLY finished prompts, so absence means "still running".
      if (!q || Date.now() < q.finishAt) return json({});
      const outputs: Record<string, unknown> = {};
      for (const n of outputNodes(q)) outputs[n.node] = n.output;
      return json({ [id]: { outputs } });
    }

    if (p === "/view") {
      const filename = url.searchParams.get("filename") ?? "";
      if (!filename) return json({ error: "filename is required" }, 400);
      const body = viewBody(filename);
      return new Response(body.bytes, { headers: { "content-type": body.mime } });
    }

    return json({ error: "not found", path: p }, 404);
  },
  websocket: {
    open(ws: WS) {
      sockets.add(ws);
      console.log(`[fake-comfy] ws open (clientId ${ws.data.clientId || "none"})${WS_SILENT ? ", silent" : ""}`);
      if (WS_SILENT) return;
      // Straight to THIS socket: a connect greeting is never another client's business.
      try { ws.send(statusFrame(ws.data.clientId, 0)); } catch { /* socket already gone */ }
    },
    // The real server ignores whatever a client sends on this channel, and so does the fixture.
    message() { /* ignored, exactly like ComfyUI */ },
    close(ws: WS) { sockets.delete(ws); },
  },
});

const wsNote = [
  VIDEO_OUTPUT ? "video output" : "", MODEL_OUTPUT ? "3d output" : "", WS_SILENT ? "ws silent" : "",
  WS_NOISE ? "ws noise" : "", WS_ERROR ? "ws error" : "", LYING_MIME ? "LYING mime" : "",
].filter(Boolean).join(", ");
console.log(`[fake-comfy] ComfyUI-shaped fixture on http://127.0.0.1:${server.port}`);
console.log(`[fake-comfy] catalog: ${Object.keys(CATALOG).length} nodes${BARE ? " (bare: no output node)" : NO_VIDEO ? " (no video node)" : ""}${REQUIRE_TOKEN ? ", token required" : ""}${REJECT_SUBMIT ? ", /prompt rejects" : ""}`);
console.log(`[fake-comfy] ws://127.0.0.1:${server.port}/ws?clientId=<id>${wsNote ? ` (${wsNote})` : ""}`);
