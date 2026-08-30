// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/verify_creator_comfy.ts - CREATOR-1/IMG verification you can run against a REAL server.
//
// Two modes, same code path as the product:
//
//   FIXTURE (default)  boots desktop/fake_comfy_server.ts and drives the whole chain end to end:
//                      probe -> capability attestation -> upload a mixed input -> substitute the workflow
//                      -> submit -> poll /history -> read the image back -> store it as an artifact.
//                      Needs no ComfyUI, no GPU, and no network.
//
//   REAL (--url)       points the same code at your own ComfyUI (a workstation, or a DGX Spark over the
//                      VPN). It ALWAYS probes and reports what that install actually proves. It submits a
//                      graph ONLY when you hand it your own template with --workflow <file>, because LUCID
//                      does not invent workflows - not in the product, and not in its own verifier.
//
// Usage:
//   bun run harness/scripts/verify_creator_comfy.ts
//   bun run harness/scripts/verify_creator_comfy.ts --url http://127.0.0.1:8188
//   bun run harness/scripts/verify_creator_comfy.ts --url http://127.0.0.1:8188 --workflow ./my-graph.json \
//     --model sdxl_base.safetensors --prompt "neon alley at night" --token <bearer>
//
// Exit code 0 = every check that COULD run passed. Skipped checks are reported as skipped, never as passes.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodePng } from "../creator/imaging.ts";
import { probeComfyui, type ProbeDeps } from "../../desktop/creator_probe.ts";
import {
  ComfyClient, applyWorkflowTemplate, artifactDir, foldArtifacts, parseObjectInfoModels, storeArtifact,
  type ArtifactIo, type CompositionInput,
} from "../../desktop/creator_image.ts";
import type { CreatorEndpointDef } from "../../desktop/creator_registry.ts";

const arg = (name: string, fallback = ""): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
};

const REAL_URL = arg("url");
const WORKFLOW_FILE = arg("workflow");
const TOKEN = arg("token");
const WANT_MODEL = arg("model");
const PROMPT = arg("prompt", "a quiet neon alley after rain, cinematic");

let failures = 0;
let skipped = 0;
const pass = (label: string, detail = "") => console.log(`   ok      - ${label}${detail ? ` (${detail})` : ""}`);
const fail = (label: string, detail = "") => { console.log(`   FAIL    - ${label}${detail ? ` (${detail})` : ""}`); failures++; };
const skip = (label: string, why: string) => { console.log(`   skipped - ${label} (${why})`); skipped++; };
const check = (ok: boolean, label: string, detail = "") => (ok ? pass(label, detail) : fail(label, detail));

// ── the fixture, when no real URL was given ─────────────────────────────────

/** A booted fixture and the base URL it answers on. Named rather than inferred from the spawn helper,
 *  because every section that starts one owns a process it is responsible for killing, and that ownership
 *  should be visible in the type rather than buried in an inference. */
interface Fixture { proc: Bun.Subprocess; url: string }

/** Boot a fixture with an explicit port and flag set, and wait until its catalog answers. Callers kill what
 *  they start in a `finally`: a verifier that leaks a server poisons the next run's ports, and the ports
 *  below are fixed so a leak is diagnosable rather than intermittent. */
async function spawnFixture(port: number, flags: string[], readyHeaders: Record<string, string> = {}): Promise<Fixture> {
  const proc = Bun.spawn(["bun", "run", "desktop/fake_comfy_server.ts", "--port", String(port), ...flags], {
    cwd: join(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    await Bun.sleep(100);
    try { if ((await fetch(`${url}/object_info`, { headers: readyHeaders })).ok) return { proc, url }; } catch { /* not up yet */ }
  }
  proc.kill();
  throw new Error(`the ComfyUI fixture on port ${port} never came up`);
}

let fixture: Fixture | null = null;
async function startFixture(): Promise<string> {
  fixture = await spawnFixture(8300 + Math.floor(Math.random() * 400), ["--delay", "300"]);
  return fixture.url;
}
const stopFixture = () => { if (fixture) { try { fixture.proc.kill(); } catch { /* already gone */ } fixture = null; } };

// ── the progress websocket (CREATOR-3) ──────────────────────────────────────

/** Bun accepts an options bag carrying request headers on the CLIENT WebSocket; the DOM lib's signature
 *  does not describe it. Named once here rather than cast at each call site, because the token section
 *  cannot be written without it: the fixture's guard reads `Authorization`, not a query parameter. */
type WsFactory = new (url: string, opts?: { headers?: Record<string, string> }) => WebSocket;
const WsWithHeaders = WebSocket as unknown as WsFactory;

/** One frame as it arrived, labelled the way desktop/fake_comfy_server.ts's own header documents the
 *  sequence, so a failed order assertion prints something a human can compare against that table line by
 *  line. Binary frames keep their bytes: the preview frame's 8-byte header is contract, not decoration. */
interface WireFrame { label: string; promptId: string | null; bytes: Uint8Array | null; data: Record<string, unknown> | null }

/** The outcome of driving one prompt over the socket. `opened` is a RESULT, never a precondition: a refused
 *  upgrade is the thing section 10 asserts, so it must not throw. */
interface WsRun { opened: boolean; frames: WireFrame[]; promptId: string }

const frameLabel = (msg: { type?: unknown; data?: Record<string, unknown> }): string => {
  const d = msg.data ?? {};
  switch (msg.type) {
    case "progress": return `progress:${d.value}/${d.max}@${d.node}`;
    case "executing": return `executing:${d.node === null || d.node === undefined ? "null" : String(d.node)}`;
    case "executed": return `executed:${String(d.node)}`;
    case "execution_error": return `execution_error:${String(d.node_id)}`;
    default: return String(msg.type ?? "?");
  }
};

/** Open /ws, optionally run one prompt, and collect every frame until the prompt's OWN terminal
 *  `executing:node=null` or the deadline. The grace window after that terminal is deliberate: "nothing is
 *  sent after the end signal" has to be something this helper OBSERVES, not something it assumes by
 *  closing the socket the instant the frame lands. */
async function runWsPrompt(base: string, opts: { token?: string; graph?: unknown; waitMs: number; listenOnly?: boolean }): Promise<WsRun> {
  const clientId = `verify_${Date.now().toString(36)}`;
  const headers = opts.token ? { authorization: `Bearer ${opts.token}` } : undefined;
  const ws = new WsWithHeaders(`${base.replace(/^http/, "ws")}/ws?clientId=${clientId}`, headers ? { headers } : undefined);
  ws.binaryType = "arraybuffer";

  const frames: WireFrame[] = [];
  let opened = false;
  let promptId = "";

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already closing */ }
      resolve();
    };
    // Bun.sleep rather than a cleared timer: this script ends in an explicit process.exit, so a pending
    // sleep cannot outlive the run, and there is no timer handle to thread through the closure.
    void Bun.sleep(opts.waitMs).then(finish);
    ws.onerror = () => finish();
    ws.onclose = () => finish();
    ws.onopen = () => {
      opened = true;
      if (opts.listenOnly) return;
      void fetch(`${base}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
        body: JSON.stringify({ prompt: opts.graph, client_id: clientId }),
      })
        .then((r) => r.json())
        .then((b) => {
          // `json()` yields unknown: narrow it here rather than annotating the callback, which would be a
          // claim about a remote body's shape that the type system cannot back.
          const id = (b as { prompt_id?: unknown } | null)?.prompt_id;
          promptId = typeof id === "string" ? id : "";
        })
        .catch(() => { /* the section asserts on the frames, not on this fetch */ });
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        let msg: { type?: unknown; data?: Record<string, unknown> } | null = null;
        try { msg = JSON.parse(ev.data) as { type?: unknown; data?: Record<string, unknown> }; }
        catch { frames.push({ label: "MALFORMED", promptId: null, bytes: null, data: null }); return; }
        const pid = typeof msg.data?.prompt_id === "string" ? msg.data.prompt_id : null;
        frames.push({ label: frameLabel(msg), promptId: pid, bytes: null, data: msg.data ?? null });
        // A run ends on its OWN terminal frame, and `execution_error` is one of them. A collector that
        // waited for executing:node=null would hang on --ws-error for the whole deadline, which is the
        // same bug section 11 proves a decoder must not have.
        const terminal = (msg.type === "executing" && msg.data?.node === null) || msg.type === "execution_error";
        if (terminal && pid === promptId) void Bun.sleep(150).then(finish);
        return;
      }
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      frames.push({ label: bytes.length < 8 ? `TRUNC${bytes.length}` : "BIN", promptId: null, bytes, data: null });
    };
  });

  return { opened, frames, promptId };
}

/** Poll /history until the prompt appears, the way the product's own waiter does. Returns null on timeout
 *  rather than throwing, so a section can report "the HTTP path never finished" as a failed check. */
async function waitForHistory(base: string, promptId: string, waitMs: number): Promise<Record<string, { outputs?: Record<string, Record<string, unknown>> }> | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const body = await fetch(`${base}/history/${promptId}`).then((r) => r.json()).catch(() => null);
    if (body && typeof body === "object" && (body as Record<string, unknown>)[promptId]) {
      return body as Record<string, { outputs?: Record<string, Record<string, unknown>> }>;
    }
    await Bun.sleep(100);
  }
  return null;
}

// ── a real artifact store in a temp dir, so storage is exercised for real ───

const workDir = mkdtempSync(join(tmpdir(), "lucid-creator-verify-"));
const artifactIo: ArtifactIo = {
  ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
  writeBytes: (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); },
  writeText: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
  appendLine: (path, line) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, line + "\n"); },
  readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } },
  now: () => Date.now(),
  id: () => `art_verify_${Date.now().toString(36)}`,
};

const probeDeps = (base: string): ProbeDeps => ({
  fetchImpl: fetch,
  exec: () => "",
  exists: existsSync,
  now: () => Date.now(),
  secret: () => TOKEN,
  timeoutMs: 15_000,
});

/** The fixture's own graph, in ComfyUI API format, with LUCID's placeholders where values belong. */
const FIXTURE_WORKFLOW = {
  "3": { class_type: "KSampler", inputs: { seed: "{{seed}}", steps: 20, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "{{model}}" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: "{{width}}", height: "{{height}}", batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "{{negative}}", clip: ["4", 1] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "LUCID", images: ["8", 0] } },
  "10": { class_type: "LoadImage", inputs: { image: "{{image:style}}" } },
};

async function main(): Promise<void> {
  const mode = REAL_URL ? "REAL" : "FIXTURE";
  const base = REAL_URL || (await startFixture());
  console.log(`\nLUCID Creator verification - ${mode} mode against ${base}`);
  console.log(`artifacts land in ${artifactDir(workDir)}\n`);

  const ep: CreatorEndpointDef = {
    id: "verify-comfy", providerId: "comfyui", label: "verification target",
    baseUrl: base, zone: REAL_URL ? "internal" : "local", enabled: true,
  };
  const client = new ComfyClient({ baseUrl: base, token: TOKEN, timeoutMs: 20_000 });

  // 1. PROBE - the capability answer, exactly as the product computes it.
  console.log("1) probe: what does this install actually prove?");
  const probe = await probeComfyui(probeDeps(base), ep);
  check(probe.state === "ready" || probe.state === "no-capabilities", "the probe reached a definite verdict", `${probe.state}: ${probe.detail}`);
  if (probe.state !== "ready") {
    fail("this server proves at least one usable capability", probe.detail);
    console.log(`\n   The probe verdict above is the truthful answer for THAT server. Fix the server or the`);
    console.log(`   endpoint declaration, then re-run. LUCID will not claim capability it cannot prove.\n`);
  } else {
    pass("capabilities attested from the installed node set", probe.attested.join(", "));
  }
  const models = await client.probeModels();
  check(models.ok, "the model dropdown read this server's own loaders", models.models.length ? `${models.models.length}: ${models.models.slice(0, 4).map((m) => m.id).join(", ")}${models.models.length > 4 ? ", ..." : ""}` : models.note);
  const chosen = WANT_MODEL || models.models[0]?.id || "";
  if (WANT_MODEL) {
    check(models.models.some((m) => m.id === WANT_MODEL), `--model ${WANT_MODEL} exists on this server`, WANT_MODEL);
  }

  // 2. HONESTY - a template that is missing a value must refuse, before anything is submitted.
  console.log("\n2) honesty: an unfilled placeholder refuses instead of guessing");
  const short = applyWorkflowTemplate(FIXTURE_WORKFLOW, { prompt: PROMPT });
  check(short.unresolved.length > 0, "a spec missing model/seed/size/input is reported as unresolved", short.unresolved.join(", "));
  const raw = await fetch(`${base}/object_info`, { headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {} }).then((r) => r.json()).catch(() => null);
  const published = parseObjectInfoModels(raw);
  check(published.length === models.models.length, "the dropdown matches the server's raw /object_info (no invention, no loss)", `${published.length} published, ${models.models.length} offered`);

  // 3. END TO END - only with a template we are allowed to submit.
  console.log("\n3) end to end: upload a mixed input, submit, poll, read back, store");
  let template: unknown = null;
  if (WORKFLOW_FILE) {
    try { template = JSON.parse(readFileSync(WORKFLOW_FILE, "utf8")); pass(`loaded your workflow template from ${WORKFLOW_FILE}`); }
    catch (e) { fail(`could not read --workflow ${WORKFLOW_FILE}`, e instanceof Error ? e.message : ""); }
  } else if (!REAL_URL) {
    template = FIXTURE_WORKFLOW;
    pass("using the fixture's own workflow template");
  } else {
    skip("submit a workflow", "no --workflow given: LUCID never invents a graph for someone else's server");
  }

  if (template) {
    // A tiny PNG stands in for a mixed input image, encoded by the product's own encoder.
    const inputPng = encodePng({ width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).fill(120) });
    const up = await client.uploadImage("lucid-verify-style.png", inputPng, "image/png");
    check(up.ok, "an input image uploaded and came back with a filename", up.filename ?? up.error ?? "");
    const inputs: CompositionInput[] = up.ok && up.filename ? [{ role: "style", filename: up.filename }] : [];

    const applied = applyWorkflowTemplate(template, { prompt: PROMPT, negative: "blurry, watermark", model: chosen, seed: 12345, width: 1024, height: 1024, inputs });
    if (applied.unresolved.length) {
      fail("every placeholder in the template resolved", `still missing: ${applied.unresolved.join(", ")}`);
    } else {
      pass("every placeholder resolved", `${applied.substitutions} substitutions`);
      const sub = await client.submit(applied.workflow);
      check(sub.ok, "the server accepted the graph", sub.promptId ?? sub.error ?? "");
      if (sub.ok && sub.promptId) {
        const t0 = Date.now();
        const done = await client.waitForImages(sub.promptId, { pollMs: 500, maxWaitMs: REAL_URL ? 600_000 : 15_000 });
        check(done.ok, "the render finished and reported image outputs", done.ok ? `${done.refs!.length} image(s) in ${Math.round((Date.now() - t0) / 100) / 10}s` : done.error ?? "");
        for (const ref of done.refs ?? []) {
          const img = await client.fetchImage(ref);
          if (!img.ok || !img.bytes) { fail(`read back ${ref.filename}`, img.error ?? ""); continue; }
          const isPng = img.bytes[0] === 0x89 && img.bytes[1] === 0x50 && img.bytes[2] === 0x4E && img.bytes[3] === 0x47;
          check(isPng || (img.mime ?? "").startsWith("image/"), `read back ${ref.filename} as real image bytes`, `${img.bytes.length} bytes, ${img.mime}`);
          const stored = storeArtifact(artifactIo, workDir, {
            kind: "image", bytes: img.bytes, mime: img.mime ?? "image/png", width: 0, height: 0,
            source: `comfyui ${base}`, prompt: PROMPT, model: chosen,
          });
          check(stored.ok, "stored as an artifact with provenance", stored.ok ? `sha256 ${stored.artifact!.sha256.slice(0, 12)}, prompt + model recorded` : stored.error ?? "");
          if (stored.ok && stored.path) {
            const onDisk = statSync(stored.path).size;
            check(onDisk === img.bytes.length, "the artifact on disk is byte-for-byte what the server sent", `${onDisk} bytes`);
          }
        }
        const ledger = foldArtifacts(artifactIo.readText(join(artifactDir(workDir), "artifacts.jsonl")));
        check(ledger.length > 0, "the artifact ledger folds back with the run recorded", `${ledger.length} row(s)`);
      }
    }
  }

  // 4. Failure paths, fixture only (never provoke someone's real server).
  console.log("\n4) failure paths");
  if (REAL_URL) {
    skip("unauthorized + rejected-workflow paths", "fixture only: a verifier does not provoke your real server");
  } else {
    const authed = await spawnFixture(8299, ["--require-token", "s3cret"], { authorization: "Bearer s3cret" });
    try {
      const noToken = await probeComfyui({ ...probeDeps("http://127.0.0.1:8299"), secret: () => "" }, { ...ep, baseUrl: "http://127.0.0.1:8299" });
      check(noToken.state === "unauthorized", "a server that requires a token reports UNAUTHORIZED, not unreachable", noToken.detail);
      const withToken = await probeComfyui({ ...probeDeps("http://127.0.0.1:8299"), secret: () => "s3cret" }, { ...ep, baseUrl: "http://127.0.0.1:8299" });
      check(withToken.state === "ready", "the same server with the token is ready", withToken.attested.join(", "));
    } finally { authed.proc.kill(); }

    const bare = await spawnFixture(8298, ["--bare"]);
    try {
      const bareProbe = await probeComfyui(probeDeps("http://127.0.0.1:8298"), { ...ep, baseUrl: "http://127.0.0.1:8298" });
      check(bareProbe.state === "no-capabilities", "a catalog with no output node proves NOTHING (not ready)", bareProbe.detail);
    } finally { bare.proc.kill(); }

    const dead = await probeComfyui(probeDeps("http://127.0.0.1:9"), { ...ep, baseUrl: "http://127.0.0.1:9" });
    check(dead.state === "unreachable", "a dead endpoint is unreachable, and nothing throws", dead.detail);
  }

  // 5..10. THE PROGRESS WEBSOCKET AND THE MEDIA OUTPUTS (CREATOR-3). Fixture only, for section 4's reason:
  // these drive a server into states nobody should provoke on someone else's real ComfyUI. Each section
  // kills what it starts in a `finally`, and the ports are fixed and distinct so a leaked server names
  // itself on the next run instead of failing intermittently somewhere else.
  //
  // Section 11 exists because execution_error is the one path where a WRONG answer is silent: a decoder
  // that mis-shapes it leaves the stream running forever instead of failing, which no pure test catches,
  // since a pure test only ever feeds a decoder the frame it already agrees on.
  if (REAL_URL) {
    console.log("\n5) websocket, media outputs, and a lying server");
    skip("websocket, media-output, and lying-server paths", "fixture only: a verifier does not provoke your real server");
  } else {
    const wsGraph = applyWorkflowTemplate(FIXTURE_WORKFLOW, {
      prompt: PROMPT, negative: "blurry, watermark", model: "sdxl_base.safetensors", seed: 7, width: 64, height: 64,
      inputs: [{ role: "style", filename: "lucid-verify-style.png" }],
    }).workflow;

    /** The frames one prompt produces, in the order desktop/fake_comfy_server.ts's header documents. The
     *  binary preview is NOT pinned into this string: it is emitted on the same pacing tick as a progress
     *  frame, so fixing their relative order would assert a scheduling detail the fixture never promised.
     *  Its position is checked separately, as a range. */
    const DOCUMENTED_PROMPT_FRAMES = "execution_start executing:3 progress:5/20@3 progress:10/20@3 progress:15/20@3 progress:20/20@3 executed:9 executing:null";
    const DOCUMENTED_TEXT = `status status ${DOCUMENTED_PROMPT_FRAMES}`;
    const hex = (b: Uint8Array, n: number): string => [...b.slice(0, n)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
    const isPngHead = (b: Uint8Array, at = 0): boolean => b[at] === 0x89 && b[at + 1] === 0x50 && b[at + 2] === 0x4e && b[at + 3] === 0x47;

    console.log("\n5) websocket: the documented frame sequence, and the pre-websocket routes unchanged");
    const plain = await spawnFixture(8290, ["--delay", "250"]);
    try {
      const run = await runWsPrompt(plain.url, { graph: wsGraph, waitMs: 8_000 });
      check(run.opened, "the /ws upgrade is accepted with a clientId");
      const labels = run.frames.map((f) => f.label);
      const text = labels.filter((l) => l !== "BIN");
      check(text[0] === "status", "the socket is greeted with a status frame before anything is queued", text[0] ?? "nothing arrived");
      check(text.join(" ") === DOCUMENTED_TEXT, "the text frames match the sequence the fixture documents", labels.join(" "));

      const bins = run.frames.filter((f) => f.label === "BIN");
      check(bins.length === 1, "exactly one binary preview frame arrives", `${bins.length}`);
      const binAt = labels.indexOf("BIN");
      check(binAt > labels.indexOf("progress:5/20@3") && binAt < labels.indexOf("progress:15/20@3"),
        "the preview lands mid-render, between the first and third progress frames", `index ${binAt} of ${labels.length}`);

      const head = bins[0]?.bytes ?? new Uint8Array();
      const be = (o: number): number => (((head[o] ?? 0) << 24) | ((head[o + 1] ?? 0) << 16) | ((head[o + 2] ?? 0) << 8) | (head[o + 3] ?? 0)) >>> 0;
      check(head.length > 8 && be(0) === 1, "the preview frame's first 4 big-endian bytes are event type 1 (PREVIEW_IMAGE)", head.length > 8 ? String(be(0)) : "no payload");
      check(head.length > 8 && be(4) === 2, "the next 4 big-endian bytes are format 2 (PNG)", head.length > 8 ? String(be(4)) : "no payload");
      check(isPngHead(head, 8), "the payload after the 8-byte header is PNG", `${head.length} bytes total, ${head.length - 8} payload, head ${hex(head, 12)}`);
      check(labels[labels.length - 1] === "executing:null", "nothing is sent after executing:node=null", `terminal at ${labels.length} of ${labels.length}`);

      const hist = await waitForHistory(plain.url, run.promptId, 5_000);
      const outputs = hist?.[run.promptId]?.outputs ?? {};
      const images = outputs["9"]?.images;
      check(Array.isArray(images) && images.length > 0, "history still reports images on node 9", Object.keys(outputs).join(", ") || "no outputs");
      check(!outputs["11"] && !outputs["12"], "and reports NO video or model node without those flags", Object.keys(outputs).join(", ") || "none");

      const pngName = Array.isArray(images) && images[0] && typeof (images[0] as Record<string, unknown>).filename === "string"
        ? String((images[0] as Record<string, unknown>).filename) : "";
      const view = await fetch(`${plain.url}/view?filename=${pngName}`);
      const viewBytes = new Uint8Array(await view.arrayBuffer());
      check(view.headers.get("content-type") === "image/png" && isPngHead(viewBytes),
        "/view still serves PNG bytes as image/png", `${viewBytes.length} bytes, ${view.headers.get("content-type")}, head ${hex(viewBytes, 8)}`);
    } finally { plain.proc.kill(); }

    console.log("\n6) --video-output --3d-output: history entries, executed frames, and honest content types");
    const media = await spawnFixture(8291, ["--delay", "250", "--video-output", "--3d-output"]);
    try {
      const run = await runWsPrompt(media.url, { graph: wsGraph, waitMs: 8_000 });
      const executed = run.frames.filter((f) => f.label.startsWith("executed:")).map((f) => f.label);
      check(executed.join(" ") === "executed:9 executed:11 executed:12",
        "one executed frame per output node, images then video then model", executed.join(" ") || "none");

      const hist = await waitForHistory(media.url, run.promptId, 5_000);
      const outputs = hist?.[run.promptId]?.outputs ?? {};
      const nameOf = (node: string, key: string): string => {
        const list = outputs[node]?.[key];
        const first = Array.isArray(list) ? list[0] as Record<string, unknown> | undefined : undefined;
        return typeof first?.filename === "string" ? first.filename : "";
      };
      const webm = nameOf("11", "videos");
      const glb = nameOf("12", "model_file");
      check(nameOf("9", "images").endsWith(".png"), "the images entry on node 9 is unchanged", nameOf("9", "images") || "missing");
      check(webm.endsWith(".webm"), "node 11 carries a videos entry naming a .webm", webm || "missing");
      check(glb.endsWith(".glb"), "node 12 carries a model_file entry naming a .glb", glb || "missing");

      const vres = await fetch(`${media.url}/view?filename=${webm}`);
      const vb = new Uint8Array(await vres.arrayBuffer());
      check(vres.headers.get("content-type") === "video/webm" && vb[0] === 0x1a && vb[1] === 0x45 && vb[2] === 0xdf && vb[3] === 0xa3,
        "/view serves EBML-magic bytes for the .webm as video/webm", `${vb.length} bytes, ${vres.headers.get("content-type")}, head ${hex(vb, 8)}`);

      const mres = await fetch(`${media.url}/view?filename=${glb}`);
      const mb = new Uint8Array(await mres.arrayBuffer());
      const le = (o: number): number => (((mb[o] ?? 0) | ((mb[o + 1] ?? 0) << 8) | ((mb[o + 2] ?? 0) << 16) | ((mb[o + 3] ?? 0) << 24)) >>> 0);
      check(mres.headers.get("content-type") === "model/gltf-binary" && mb[0] === 0x67 && mb[1] === 0x6c && mb[2] === 0x54 && mb[3] === 0x46,
        "/view serves glTF-magic bytes for the .glb as model/gltf-binary", `${mb.length} bytes, ${mres.headers.get("content-type")}, head ${hex(mb, 12)}`);
      check(le(4) === 2, "the GLB declares glTF version 2", String(le(4)));
      check(le(8) === mb.length, "the GLB header's declared length equals the bytes served", `${le(8)} declared, ${mb.length} served`);
      // This stub is structurally valid to a strict HEADER parser - 12-byte header plus one padded JSON
      // chunk carrying {"asset":{"version":"2.0"}} - and that is exactly as deep as these assertions go. It
      // has no buffers, no meshes and no scene, so anything that tries to instantiate geometry from it MUST
      // fail. That is the stub working, not the fixture being broken; do not "fix" it by loading it.
      check(le(16) === 0x4e4f534a, "the first chunk is a JSON chunk (glTF chunk type 'JSON')", `0x${le(16).toString(16)}`);
      check(12 + 8 + le(12) === mb.length, "the JSON chunk length accounts for every byte after the header", `${le(12)} chunk + 20 header bytes = ${12 + 8 + le(12)}`);
    } finally { media.proc.kill(); }

    console.log("\n7) --ws-silent: the socket opens and then says nothing at all");
    const silent = await spawnFixture(8292, ["--delay", "250", "--ws-silent"]);
    try {
      const run = await runWsPrompt(silent.url, { graph: wsGraph, waitMs: 2_500 });
      check(run.opened, "the upgrade is still accepted");
      check(run.frames.length === 0, "zero frames arrive, so a client's timeout path is reachable", `${run.frames.length} frame(s)`);
      check(!!(await waitForHistory(silent.url, run.promptId, 5_000)),
        "the HTTP path still finishes the prompt while the socket is mute", run.promptId || "no prompt id");
    } finally { silent.proc.kill(); }

    console.log("\n8) --ws-noise: junk a client must ignore, with the real sequence still intact");
    const noisy = await spawnFixture(8293, ["--delay", "250", "--ws-noise"]);
    try {
      const run = await runWsPrompt(noisy.url, { graph: wsGraph, waitMs: 8_000 });
      const labels = run.frames.map((f) => f.label);
      const foreign = run.frames.filter((f) => f.promptId !== null && f.promptId !== run.promptId);
      check(foreign.length === 2, "two frames carry a FOREIGN prompt_id, including its end signal", foreign.map((f) => f.label).join(" ") || "none");
      check(labels.includes("MALFORMED"), "one text frame is not JSON at all", `${labels.filter((l) => l === "MALFORMED").length} malformed`);
      check(labels.some((l) => l.startsWith("TRUNC")), "one binary frame is shorter than the 8-byte header", labels.find((l) => l.startsWith("TRUNC")) ?? "none");

      // THE POSITION IS THE POINT, not the presence. The foreign end signal lands BEFORE our own
      // execution_start, so a client keyed on frame TYPE instead of prompt_id dies loudly at the start of
      // the run rather than quietly at the end. If this check ever fails because the burst moved after the
      // real sequence, the fixture has stopped catching prompt_id-blind clients and is no longer a test.
      const foreignEnd = labels.indexOf("executing:null");
      const ourStart = labels.indexOf("execution_start");
      check(foreignEnd >= 0 && ourStart >= 0 && foreignEnd < ourStart,
        "a foreign executing:node=null arrives BEFORE our execution_start, so a prompt_id-blind client dies loudly at the start rather than quietly at the end",
        `foreign end at index ${foreignEnd}, our start at index ${ourStart}`);

      const ours = run.frames.filter((f) => f.promptId === run.promptId).map((f) => f.label);
      check(ours.join(" ") === DOCUMENTED_PROMPT_FRAMES, "our own sequence survives the noise unchanged", ours.join(" ") || "none");
      console.log(`   note    - full wire order: ${labels.join(" ")}`);
    } finally { noisy.proc.kill(); }

    console.log("\n9) --lying-mime: a server that claims video/mp4 and sends PNG");
    const liar = await spawnFixture(8294, ["--delay", "250", "--lying-mime"]);
    try {
      const res = await fetch(`${liar.url}/view?filename=LUCID_00001_.png`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      check(res.headers.get("content-type") === "video/mp4", "the content-type CLAIMS video/mp4", res.headers.get("content-type") ?? "none");
      check(isPngHead(bytes), "the bytes are actually PNG, so a magic-byte check must refuse this server rather than trust its label",
        `${bytes.length} bytes, head ${hex(bytes, 8)}`);
    } finally { liar.proc.kill(); }

    console.log("\n10) --require-token: the guard covers the websocket upgrade too");
    const guarded = await spawnFixture(8295, ["--delay", "250", "--require-token", "s3cret"], { authorization: "Bearer s3cret" });
    try {
      const refused = await runWsPrompt(guarded.url, { waitMs: 2_000, listenOnly: true });
      check(!refused.opened, "an upgrade with no bearer token is refused", refused.opened ? "it opened anyway" : "refused");
      const allowed = await runWsPrompt(guarded.url, { token: "s3cret", waitMs: 2_000, listenOnly: true });
      check(allowed.opened, "the same upgrade with the bearer token is accepted");
      check(allowed.frames[0]?.label === "status", "and it is greeted normally", allowed.frames[0]?.label ?? "nothing arrived");
    } finally { guarded.proc.kill(); }

    console.log("\n11) --ws-error: the run fails mid-stream, and the socket says so exactly once");
    const failing = await spawnFixture(8296, ["--delay", "250", "--ws-error"]);
    try {
      const run = await runWsPrompt(failing.url, { graph: wsGraph, waitMs: 8_000 });
      const labels = run.frames.map((f) => f.label);
      const err = run.frames.find((f) => f.label.startsWith("execution_error:"));
      check(!!err, "an execution_error frame arrives", labels.join(" ") || "nothing arrived");
      check(err?.promptId === run.promptId, "it carries OUR prompt_id, so it cannot be mistaken for another run's failure", err?.promptId ?? "none");
      check(String(err?.data?.exception_type ?? "") === "RuntimeError", "it names the exception type", String(err?.data?.exception_type ?? "missing"));
      // The expected text is duplicated here rather than imported. The fixture is a separate process, and a
      // check that read the sentence from the thing it is checking could never notice that sentence change.
      check(String(err?.data?.exception_message ?? "") === "CUDA out of memory: tried to allocate 2.00 GiB",
        "and carries the exact failure text a decoder has to surface", String(err?.data?.exception_message ?? "missing"));
      check(!labels.some((l) => l.startsWith("executed:")), "NO executed frame is sent for a run that failed",
        labels.filter((l) => l.startsWith("executed:")).join(" ") || "none");
      // The load-bearing check. Nothing follows the error, so a decoder that ends a run on frame TYPE waits
      // for a signal that never comes and reports the stream as still running. Terminating on the error
      // itself is the only correct behaviour, and this check is what fails if the fixture ever starts
      // sending a courtesy terminal frame and quietly hides that class of bug again.
      check(!labels.includes("executing:null"),
        "and NO terminal executing:node=null follows, so a decoder that ends on frame type alone would hang forever", labels.join(" "));
      check(labels[labels.length - 1] === "execution_error:3", "the error is the last frame on the wire", labels[labels.length - 1] ?? "nothing arrived");
      // The trap this shape sets for the UI, pinned here so it is enforced rather than remembered. The last
      // progress before the failure is 20/20, so anything folding this stream sits at 100% AT THE MOMENT IT
      // FAILED - progress is monotonic within a node and the error path preserves the last known position
      // rather than resetting it, because discarding it would be inventing a fact. A pane that paints
      // "done" on pct === 100 therefore reports a successful render for a run that ran out of VRAM. Render
      // on STATUS, never on pct. If this check ever fails, the wire changed and that trap moved with it.
      const progress = labels.filter((l) => l.startsWith("progress:"));
      check(progress[progress.length - 1] === "progress:20/20@3",
        "the last progress before the failure is 20/20, so a consumer sits at 100% at the moment it failed: a pane MUST key on status, never on pct",
        progress[progress.length - 1] ?? "no progress frames");
    } finally { failing.proc.kill(); }
  }

  console.log(`\n${failures === 0 ? "VERIFICATION PASSED" : `${failures} CHECK(S) FAILED`}${skipped ? ` (${skipped} skipped)` : ""}`);
  if (failures === 0 && !REAL_URL) {
    console.log("The full Creator image path works on this machine with no ComfyUI installed.");
    console.log("Re-run with --url <your server> --workflow <your graph.json> to verify your real backend.");
  }
}

try {
  await main();
} catch (e) {
  fail("the verification run itself", e instanceof Error ? e.message : String(e));
} finally {
  stopFixture();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* temp dir */ }
}
process.exit(failures === 0 ? 0 : 1);
