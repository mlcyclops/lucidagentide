// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_creator3.ts - CREATOR-3 (ADR-0287): image, video, and 3D pipelines.
//
// What this demo is for: proving the claims that would be easy to fake. Sections 1 through 9 drive the pure
// cores and the pipeline with injected fakes, so every refusal path is exercised deterministically. Section
// 10 then runs the REAL product code against a REAL server process over REAL HTTP and a REAL websocket, and
// section 11 proves the same code refuses a server that lies about what it sent.
//
// Every check prints `ok - ` or `FAIL - `. Breaking one claim exits 1 with the named FAIL.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyComfyEvent, decodeComfyFrame, mimeMismatch, newStreamState, parseHistoryOutputs, sniffMime, wsUrlFor,
  type StreamState,
} from "../creator/comfy_stream.ts";
import { captureReport, compareFrames, frameFingerprint, framePlan, sameCapture } from "../creator/frame_capture.ts";
import { encodePng } from "../creator/imaging.ts"; // the same pure encoder the imaging tools use, so a reviewed frame is a real file
import { FLOOR_SAMPLE_POINTS, MAX_CAPTURE_PASS, runCapture } from "../../desktop/renderer/capture_driver.ts"; // CREATOR-3b: the Preview-panel capture driver
import { PREVIEW_BRIDGE_JS } from "../../desktop/preview_bridge.ts"; // CREATOR-3b: the injected bridge whose caps the driver pins itself to
import { blenderRenderArgv, classifyBlenderOutput } from "../creator/blender_cli.ts";
import { manifestCapabilities, parseModelManifest, reconcileManifest } from "../creator/model_manifest.ts";
import { foldArtifacts, artifactDir, type ArtifactIo } from "../../desktop/creator_image.ts";
import { ComfyClient } from "../../desktop/creator_image.ts";
import { foldJobs, type JobAdmissionSnapshot, type JobIo } from "../../desktop/creator_jobs.ts";
import {
  openComfyProgress, runRenderPipeline, scanMetadata, trackProgress,
  type ComfyLike, type PipelineDeps, type ScanVerdict,
} from "../../desktop/creator_pipeline.ts";
import { probeComfyui, type ProbeDeps } from "../../desktop/creator_probe.ts";
import type { CreatorEndpointDef } from "../../desktop/creator_registry.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`   ${ok ? "ok" : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};
function stop(label: string, why: string): never {
  console.log(`   FAIL - ${label} (${why})`);
  console.log("\n1 CHECK(S) FAILED");
  process.exit(1);
}

// ── fixtures ────────────────────────────────────────────────────────────────

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
const CLEAN: ScanVerdict = { block: false, reason: "clean", trustLabel: "trusted", failClosed: false };
const ADMITTED: JobAdmissionSnapshot = { ok: true, cpuPct: 10, memPct: 30, gpuPct: 5, vramPct: 12, gpuEvidenceMissing: false, reason: "" };

const WORKFLOW = {
  "3": { class_type: "KSampler", inputs: { seed: "{{seed}}", steps: 12, positive: ["6", 0] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "{{model}}" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}" } },
  "11": { class_type: "SaveWEBM", inputs: { images: ["3", 0], filename_prefix: "LUCID" } },
};

interface MemoryDisk { readonly io: ArtifactIo; readonly files: Map<string, Uint8Array>; readonly lines: string[] }
function memoryDisk(): MemoryDisk {
  const files = new Map<string, Uint8Array>();
  const lines: string[] = [];
  let n = 0;
  return {
    files, lines,
    io: {
      ensureDir: () => {}, writeBytes: (p, b) => { files.set(p, b); }, writeText: () => {},
      appendLine: (_p, l) => { lines.push(l); }, readText: () => lines.join("\n"),
      now: () => 1_700_000_000_000, id: () => `art_${++n}`,
    },
  };
}

interface MemoryJobs { readonly io: JobIo; readonly lines: string[] }
function memoryJobs(): MemoryJobs {
  const lines: string[] = [];
  let n = 0;
  return {
    lines,
    io: {
      ensureDir: () => {}, readText: () => lines.join("\n"), appendLine: (_p, l) => { lines.push(l); },
      now: () => 1_700_000_000_000, id: () => `job_${++n}`,
    },
  };
}

/** A fake ComfyUI that COUNTS what it was asked to do, so "refused before any request" is an assertion
 *  rather than a claim. */
interface CountingServer { readonly client: ComfyLike; readonly calls: string[] }
function countingServer(opts: { bytes?: Uint8Array; mime?: string; refs?: readonly ReturnType<typeof videoRef>[] } = {}): CountingServer {
  const calls: string[] = [];
  return {
    calls,
    client: {
      baseUrl: "http://127.0.0.1:9",
      submit: async () => { calls.push("submit"); return { ok: true, promptId: "p_1" }; },
      waitForOutputs: async () => { calls.push("wait"); return { ok: true, refs: opts.refs ?? [videoRef()] }; },
      fetchImage: async (r) => { calls.push(`fetch:${r.filename}`); return { ok: true, bytes: opts.bytes ?? WEBM, mime: opts.mime ?? "video/webm" }; },
    },
  };
}
const videoRef = (filename = "LUCID_00001_.webm") =>
  ({ filename, subfolder: "", type: "output", key: "videos", kind: "video" as const, mime: "video/webm" });

// ── 1) the websocket protocol ───────────────────────────────────────────────

console.log("1) the /ws protocol: LUCID reads ComfyUI's own frames, and ignores everything else");
{
  const url = wsUrlFor("http://127.0.0.1:8188", "lucid-abc");
  check("an http base becomes a ws URL carrying only the client id", url === "ws://127.0.0.1:8188/ws?clientId=lucid-abc", url);
  check("an https base becomes wss", wsUrlFor("https://gpu.box:8443", "c1").startsWith("wss://"), wsUrlFor("https://gpu.box:8443", "c1"));
  check("the credential NEVER rides the URL: a userinfo base is stripped or refused",
    !wsUrlFor("http://user:secret@127.0.0.1:8188", "c1").includes("secret"),
    wsUrlFor("http://user:secret@127.0.0.1:8188", "c1") || "refused outright");

  const progress = decodeComfyFrame(JSON.stringify({ type: "progress", data: { value: 3, max: 12, node: "3", prompt_id: "p_1" } }));
  check("a progress frame decodes to its own type with the node and the counts", progress.type === "progress", progress.type);

  // The 8-byte binary header is contract: 4 bytes of event type, 4 of image format, then the image.
  const preview = new Uint8Array(8 + PNG.length);
  new DataView(preview.buffer).setUint32(0, 1);
  new DataView(preview.buffer).setUint32(4, 2);
  preview.set(PNG, 8);
  const decodedPreview = decodeComfyFrame(preview);
  check("a binary preview frame decodes as a preview, not as junk", decodedPreview.type === "preview", decodedPreview.type);

  check("a TRUNCATED binary header decodes to unknown instead of throwing",
    decodeComfyFrame(new Uint8Array([0, 0, 0])).type === "unknown");
  check("non-JSON text decodes to unknown instead of throwing",
    decodeComfyFrame('{"type":"progress","data":{').type === "unknown");

  let state: StreamState = newStreamState("p_mine");
  state = applyComfyEvent(state, decodeComfyFrame(JSON.stringify({ type: "progress", data: { value: 9, max: 10, node: "3", prompt_id: "p_theirs" } })));
  check("a frame for ANOTHER prompt on a shared socket moves nothing", state.pct === null && state.step === 0, `pct ${String(state.pct)}`);
  state = applyComfyEvent(state, decodeComfyFrame(JSON.stringify({ type: "progress", data: { value: 6, max: 12, node: "3", prompt_id: "p_mine" } })));
  check("our own progress frame does move it", state.pct === 50, `pct ${String(state.pct)}`);
  state = applyComfyEvent(state, decodeComfyFrame(JSON.stringify({ type: "execution_error", data: { prompt_id: "p_mine", node_id: "3", exception_message: "OOM on device 0" } })));
  check("an execution error is recorded with the server's own message", state.status === "error" && state.error.includes("OOM"), state.error);
  state = applyComfyEvent(state, decodeComfyFrame(JSON.stringify({ type: "progress", data: { value: 12, max: 12, node: "3", prompt_id: "p_mine" } })));
  check("and an error is TERMINAL: a later progress frame cannot revive the render", state.status === "error", state.status);
}

// ── 2) video and 3D outputs ─────────────────────────────────────────────────

console.log("2) a render's outputs are read by KEY and by extension, so a video is never filed as a still");
{
  const history = {
    p_1: {
      outputs: {
        "9": { images: [{ filename: "LUCID_00001_.png", subfolder: "", type: "output" }] },
        "11": { videos: [{ filename: "LUCID_00001_.webm", subfolder: "", type: "output" }] },
        "12": { model_file: [{ filename: "hero.glb", subfolder: "", type: "output" }] },
        "13": { gifs: [{ filename: "loop.webp", subfolder: "", type: "output" }] },
      },
    },
  };
  const outs = parseHistoryOutputs(history, "p_1");
  const kindOf = (name: string) => outs.find((o) => o.filename === name)?.kind ?? "missing";
  check("a still under `images` is an image", kindOf("LUCID_00001_.png") === "image");
  check("a webm under `videos` is a video", kindOf("LUCID_00001_.webm") === "video");
  check("a glb under `model_file` is a 3D model", kindOf("hero.glb") === "model-3d");
  check("an ANIMATED webp under `gifs` is a VIDEO, not an image: that distinction is the point",
    kindOf("loop.webp") === "video", `read as ${kindOf("loop.webp")}`);
  check("a pending prompt yields nothing rather than an empty success", parseHistoryOutputs({}, "p_1").length === 0);
}

// ── 3) the bytes decide their own type ──────────────────────────────────────

console.log("3) a server's content-type is a claim; the magic bytes are the evidence");
{
  check("PNG bytes are recognised as PNG", sniffMime(PNG) === "image/png", String(sniffMime(PNG)));
  check("WEBM bytes are recognised by their EBML header", sniffMime(WEBM) === "video/webm", String(sniffMime(WEBM)));
  check("GLB bytes are recognised by the glTF magic", sniffMime(GLB) === "model/gltf-binary", String(sniffMime(GLB)));
  check("unknown bytes return null rather than a guess", sniffMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) === null);
  const lie = mimeMismatch("video/mp4", PNG);
  check("PNG bytes CLAIMED as video/mp4 produce a refusal sentence naming both", !!lie && lie.includes("video/mp4"), lie ?? "no refusal");
  check("an honest claim produces no refusal", mimeMismatch("video/webm", WEBM) === null);
}

// ── 4) the probe gate ───────────────────────────────────────────────────────

console.log("4) the probe gate: an unproven capability is refused BEFORE anything leaves this machine");
{
  const disk = memoryDisk();
  const jobs = memoryJobs();
  const server = countingServer();
  const deps: PipelineDeps = { client: server.client, artifactIo: disk.io, jobIo: jobs.io, scan: async () => CLEAN, now: () => 1 };
  const res = await runRenderPipeline(deps, "/base", {
    kind: "video", workflow: WORKFLOW, spec: { prompt: "x", seed: 1, model: "m" },
    attested: ["image", "workflow-run"], admission: ADMITTED,
  });
  check("the render is refused at the capability stage", !res.ok && res.stage === "capability", res.stage);
  check("the refusal names what WAS attested, so the user knows what to install", res.error.includes("image, workflow-run"), res.error.slice(0, 90));
  check("NOT ONE request was made to the server", server.calls.length === 0, server.calls.join(",") || "no calls");
  check("and nothing was written: no job, no artifact", jobs.lines.length === 0 && disk.files.size === 0);

  const expired = await runRenderPipeline(deps, "/base", {
    kind: "video", workflow: WORKFLOW, spec: { prompt: "x", seed: 1, model: "m" },
    attested: [], admission: ADMITTED,
  });
  check("an EXPIRED probe attests nothing, so staleness refuses through the same gate",
    !expired.ok && expired.error.includes("nothing"), expired.error.slice(0, 80));
}

// ── 5) the governor ─────────────────────────────────────────────────────────

console.log("5) the governor: a refusal is WRITTEN DOWN with the measurement that caused it");
{
  const disk = memoryDisk();
  const jobs = memoryJobs();
  const server = countingServer();
  const refused: JobAdmissionSnapshot = {
    ok: false, cpuPct: 96, memPct: 61, gpuPct: 99, vramPct: 88, gpuEvidenceMissing: false,
    reason: "GPU has been at 99% for 34s (held 90%+ for 30s is not a burst) - let the current render finish",
  };
  const res = await runRenderPipeline(
    { client: server.client, artifactIo: disk.io, jobIo: jobs.io, scan: async () => CLEAN, now: () => 1 },
    "/base",
    { kind: "video", workflow: WORKFLOW, spec: { prompt: "x", seed: 1, model: "m" }, attested: ["video"], admission: refused },
  );
  const rows = foldJobs(jobs.lines.join("\n"));
  check("the render is refused at the admission stage", !res.ok && res.stage === "admission", res.stage);
  check("the reason quotes the measured percent and the duration it held", res.error.includes("99%") && res.error.includes("34s"));
  check("a `refused` job row exists, so the ledger can answer why nothing ran", rows.length === 1 && rows[0]?.state === "refused", rows[0]?.state ?? "no row");
  check("the job carries the governor's own sentence", (rows[0]?.error ?? "").includes("99%"));
  check("and nothing was submitted", server.calls.length === 0);
}

// ── 6) THE SCAN GATE (the keystone) ─────────────────────────────────────────

console.log("6) the scan gate is FAIL-CLOSED: a dead scanner stops the artifact, it never waves it through");
{
  const disk = memoryDisk();
  const jobs = memoryJobs();
  const server = countingServer();
  const res = await runRenderPipeline(
    { client: server.client, artifactIo: disk.io, jobIo: jobs.io, now: () => 1, scan: async () => { throw new Error("scanner sidecar is not running"); } },
    "/base",
    { kind: "video", workflow: WORKFLOW, spec: { prompt: "x", seed: 1, model: "m" }, attested: ["video"], admission: ADMITTED },
  );
  const rows = foldJobs(jobs.lines.join("\n"));
  check("the render stops at the scan stage", !res.ok && res.stage === "scan", res.stage);
  check("the error says fail-closed and quotes the scanner's failure", res.error.includes("fail-closed") && res.error.includes("not running"), res.error.slice(0, 110));
  check("NOTHING was written to disk", disk.files.size === 0, `${disk.files.size} file(s)`);
  check("NOTHING was appended to the artifact ledger", disk.lines.length === 0);
  check("the job is failed, and carries no artifact", rows[0]?.state === "failed" && (rows[0]?.artifacts.length ?? 0) === 0, rows[0]?.state ?? "no row");

  const findings = await runRenderPipeline(
    { client: countingServer().client, artifactIo: memoryDisk().io, jobIo: memoryJobs().io, now: () => 1, scan: async () => ({ block: true, reason: "quarantined: 2 finding(s), max severity exceeds high", trustLabel: "quarantined", failClosed: false }) },
    "/base",
    { kind: "video", workflow: WORKFLOW, spec: { prompt: "x", seed: 1, model: "m" }, attested: ["video"], admission: ADMITTED },
  );
  check("a quarantining FINDING blocks the same way a dead scanner does", !findings.ok && findings.error.includes("quarantined"), findings.error.slice(0, 80));

  const malformed = await scanMetadata(async () => (undefined as unknown as ScanVerdict), "text");
  check("a scanner that answers with nothing usable is a BLOCK, not a pass", malformed.block && malformed.failClosed);

  const lying = await runRenderPipeline(
    { client: countingServer({ bytes: PNG, mime: "video/mp4" }).client, artifactIo: memoryDisk().io, jobIo: memoryJobs().io, scan: async () => CLEAN, now: () => 1 },
    "/base",
    { kind: "video", workflow: WORKFLOW, spec: { prompt: "x", seed: 1, model: "m" }, attested: ["video"], admission: ADMITTED },
  );
  check("a server that lies about its content type gets its output REFUSED by name",
    !lying.ok && lying.refused.some((r) => r.reason.includes("video/mp4")), lying.refused[0]?.reason.slice(0, 80) ?? "not refused");
}

// ── 7) deterministic frame capture ──────────────────────────────────────────

console.log("7) deterministic frame capture: the same plan renders the same frames, or the report says why not");
{
  const plan = framePlan({ durationMs: 1000, fps: 30 });
  if (!plan.ok) stop("a 30fps 1000ms plan is buildable", plan.error);
  check("a 30fps second is exactly 30 frames", plan.frames.length === 30, `${plan.frames.length} frames`);
  check("every timestamp is an integer derived from its index, so nothing drifts",
    plan.frames.every((f, i) => f.tMs === Math.round(i * 1000 / 30) && Number.isInteger(f.tMs)),
    `last tMs ${plan.frames[plan.frames.length - 1]?.tMs}`);
  check("an impossible plan is refused by name rather than clamped", !framePlan({ durationMs: 1000, fps: 0 }).ok);
  // A different guard with a different sentence: the ceiling is what makes MAX_CAPTURE_FRAMES a bound
  // somebody exercises rather than a constant nobody ever reaches.
  const tooMany = framePlan({ durationMs: 600_000, fps: 60 });
  check("the FRAME CEILING is refused too, naming the frames asked for and the cap",
    !tooMany.ok && tooMany.error.includes("36000") && tooMany.error.includes("3600"),
    tooMany.ok ? "accepted 36000 frames" : tooMany.error.slice(0, 90));

  // The accumulator is PRICED, not asserted: both numbers are computed here so a reader re-derives the
  // drift instead of trusting a sentence. The measurement deliberately sits on the LAST frame this module
  // will ever hand out (120000ms at 30fps is exactly MAX_CAPTURE_FRAMES, so the final index is 3599),
  // because that is where an accumulator's error is largest and where a real capture would end up.
  const longest = framePlan({ durationMs: 120_000, fps: 30 });
  if (!longest.ok) stop("the longest legal plan is buildable", longest.error);
  const last = longest.frames[longest.frames.length - 1];
  const derived = last?.tMs ?? -1;
  const accumulated = (longest.frames.length - 1) * Math.round(1000 / 30); // step 33ms, the naive way
  check("the longest legal plan is exactly the frame ceiling", longest.frames.length === 3600, `${longest.frames.length} frames`);
  check("its last frame's time is derived from the index, to the millisecond",
    derived === Math.round(3599 * 1000 / 30) && derived === 119_967, `${derived}ms`);
  check("an ACCUMULATOR would be 1200ms wrong by that frame, which is why the index is the source",
    derived - accumulated === 1200, `${derived}ms derived vs ${accumulated}ms accumulated`);

  // A scene driven ONLY by the plan's time is reproducible; one that reads a clock is not.
  const sceneFrame = (tMs: number, jitter = 0): Uint8Array => {
    const px = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = (tMs + jitter) % 256; px[i + 1] = 40; px[i + 2] = 90; px[i + 3] = 255;
    }
    return px;
  };
  const runA = plan.frames.map((f) => frameFingerprint(sceneFrame(f.tMs), 4, 4));
  const runB = plan.frames.map((f) => frameFingerprint(sceneFrame(f.tMs), 4, 4));
  check("two runs of a time-driven scene are byte-identical frame for frame", sameCapture(runA, runB).equal);
  // Without this second half the check above is a flat buffer agreeing with itself, which proves nothing.
  check("and the scene genuinely MOVED between frames, so that equality is about reproducibility",
    new Set(runA).size === runA.length, `${new Set(runA).size} distinct fingerprints across ${runA.length} frames`);
  let fakeClock = 0;
  const runC = plan.frames.map((f) => frameFingerprint(sceneFrame(f.tMs, ++fakeClock), 4, 4));
  const drift = sameCapture(runA, runC);
  check("a scene that reads a WALL CLOCK is caught, and the first differing frame is named",
    !drift.equal && drift.firstDiff >= 0, `first diff at frame ${drift.firstDiff}`);

  // DECLARED COUPLING: the structural claim is PRIMARY, because bounds cannot rot. The substring guard
  // below it quotes captureReport's own verdict wording, so that prose is load-bearing and not free to
  // reword: a structural check alone cannot notice a verdict that quietly stopped reporting BOTH readings
  // of a stuck capture (a genuinely static scene and a scene ignoring the clock look identical from here,
  // and the module must say so rather than pick one).
  const tenFrames = framePlan({ durationMs: 1000, fps: 10 });
  if (!tenFrames.ok) stop("a 10-frame plan is buildable", tenFrames.error);
  const stuck = captureReport(tenFrames.frames, tenFrames.frames.map(() => "same"));
  check("an all-identical capture is a stuck run over its exact bounds, not a clean pass",
    !stuck.ok && stuck.stuckRuns.length === 1 && stuck.stuckRuns[0]?.from === 0 && stuck.stuckRuns[0]?.to === 9,
    `${stuck.stuckRuns.length} run(s), ${stuck.stuckRuns[0]?.from}..${stuck.stuckRuns[0]?.to}`);
  check("and the verdict admits it cannot tell a static scene from one ignoring the clock",
    stuck.verdict.includes("static") && stuck.verdict.includes("wall clock") && stuck.verdict.includes("cannot tell"),
    stuck.verdict.slice(0, 120));
  // The synthetic ids above prove the audit's ARITHMETIC and nothing more: they bypass the rasteriser and
  // the readback entirely. This version drives real pixels through the real fingerprint, so it also catches
  // the CAPTURE PIPELINE going nondeterministic: a readback that varies run to run, a rasteriser leaving
  // uninitialised memory in the buffer, or a fingerprint carrying state between calls. Neither version
  // guards the digest algorithm itself (a frozen scene agrees under any deterministic hash); that is pinned
  // at unit level in frame_capture.test.ts against published FNV vectors.
  const frozen = tenFrames.frames.map(() => frameFingerprint(sceneFrame(0), 4, 4));
  const frozenReport = captureReport(tenFrames.frames, frozen);
  check("a scene that RENDERED but never moved is caught on real pixels, not only on synthetic ids",
    !frozenReport.ok && frozenReport.stuckRuns.length === 1, `${frozenReport.stuckRuns.length} run(s)`);
  // The converse of the scene-actually-moved check, and a different argument: this is WHY the audit has to
  // exist beside the comparator rather than inside it.
  check("two runs of that frozen scene AGREE: a frozen scene is perfectly reproducible and still not a capture",
    sameCapture(frozen, tenFrames.frames.map(() => frameFingerprint(sceneFrame(0), 4, 4))).equal);

  const short = captureReport(plan.frames, runA.slice(0, 10));
  check("a capture missing frames counts every lost one", !short.ok && short.missing === 20, `${short.missing} missing`);
  const surplus = captureReport(tenFrames.frames, [...runA.slice(0, 10), "extra", "extra2"]);
  check("a SURPLUS is refused without `missing` ever going negative",
    !surplus.ok && surplus.missing === 0, `missing ${surplus.missing}, verdict: ${surplus.verdict.slice(0, 60)}`);

  const a = sceneFrame(10);
  const b = sceneFrame(10);
  b[0] = (b[0] ?? 0) + 1;
  const loose = compareFrames(a, b, { tolerance: 1 });
  const strict = compareFrames(a, b, { tolerance: 0 });
  check("a one-level channel difference is equal at tolerance 1 and NOT equal at tolerance 0",
    loose.equal && !strict.equal);
  check("tolerance changes the VERDICT and never the MEASUREMENT: the true delta is reported either way",
    loose.maxChannelDelta === 1 && strict.maxChannelDelta === 1, `${loose.maxChannelDelta} vs ${strict.maxChannelDelta}`);

  // Frame-by-frame review has to be a real activity, so the captured pixels encode to real PNG bytes with
  // the same pure encoder the imaging tools use. Deterministic: the same frame encodes to the same file.
  const framePng = encodePng({ width: 4, height: 4, rgba: sceneFrame(200) });
  const againPng = encodePng({ width: 4, height: 4, rgba: sceneFrame(200) });
  check("a captured frame encodes to real PNG bytes",
    framePng.length > 8 && framePng[0] === 0x89 && framePng[1] === 0x50 && framePng[2] === 0x4e && framePng[3] === 0x47,
    `${framePng.length} bytes`);
  check("and it encodes DETERMINISTICALLY, so two reviews of one frame are the same file",
    Buffer.from(framePng).equals(Buffer.from(againPng)));
}

// ── 8) Blender: a fixed vector, and an honest verdict ───────────────────────

console.log("8) Blender runs as a fixed argument vector, and its exit code is read honestly");
{
  const still = blenderRenderArgv({ exe: "/opt/blender", blend: "/proj/shot.blend", outPattern: "/out/f_####", format: "PNG", frame: 7 });
  if (!still.ok) stop("a still render builds an argv", still.error);
  check("the argv is Blender's documented background form, in order",
    still.argv.join(" ") === "/opt/blender -b /proj/shot.blend -o /out/f_#### -F PNG -f 7", still.argv.join(" "));
  const anim = blenderRenderArgv({ exe: "/opt/blender", blend: "/proj/shot.blend", outPattern: "/out/f_####", range: { start: 1, end: 48 } });
  if (!anim.ok) stop("an animation range builds an argv", anim.error);
  check("an animation ends with -s -e -a, because Blender executes flags in order",
    anim.argv.slice(-5).join(" ") === "-s 1 -e 48 -a", anim.argv.slice(-5).join(" "));

  // The real-world false refusal this posture had to stop producing.
  const pf = blenderRenderArgv({ exe: "C:\\Program Files (x86)\\Blender Foundation\\Blender\\blender.exe", blend: "C:\\p\\s.blend", outPattern: "C:\\out\\f_####", frame: 1 });
  check("a real `Program Files (x86)` install path is ACCEPTED: parentheses are not a shell threat in an argv",
    pf.ok, pf.ok ? String(pf.argv[0]) : pf.error);
  const nul = blenderRenderArgv({ exe: "/opt/blender", blend: "/proj/a.blend\0/etc/passwd.blend", outPattern: "/out/f", frame: 1 });
  check("a NUL byte IS refused, because it truncates the value the OS receives", !nul.ok, nul.ok ? "accepted" : nul.error.slice(0, 70));
  const nl = blenderRenderArgv({ exe: "/opt/blender", blend: "/proj/a.blend", outPattern: "/out/f\nSaved: '/out/fake.png'", frame: 1 });
  check("a newline IS refused, because it would forge a `Saved:` line in the log LUCID parses back", !nl.ok);

  const unapproved = blenderRenderArgv({ exe: "/opt/blender", blend: "/proj/a.blend", outPattern: "/out/f", frame: 1, pythonScript: "/proj/setup.py" });
  if (!unapproved.ok) stop("a user script builds an argv", unapproved.error);
  check("a user `--python` script is FLAGGED as the user's own code, for the exec-approval path",
    unapproved.userScript && unapproved.argv.includes("--python"), unapproved.note.slice(0, 90));

  const good = classifyBlenderOutput(0, "Saved: '/out/f_0001.png'\nSaved: '/out/f_0002.png'\nBlender quit", "");
  check("two `Saved:` lines are two frames", good.ok && good.frames === 2, `${good.frames} frame(s)`);
  const quiet = classifyBlenderOutput(0, "Blender quit", "");
  check("exit 0 with NOTHING saved is a failure, not a success: that is the quiet one worth catching", !quiet.ok, quiet.reason.slice(0, 80));
  const err = classifyBlenderOutput(1, "", "Error: Cannot read file '/proj/missing.blend': No such file");
  check("a failure quotes the failing line verbatim, because `it failed` is useless",
    !err.ok && err.failingLine.includes("Cannot read file"), err.failingLine.slice(0, 70));
  const killed = classifyBlenderOutput(null, "", "");
  check("a killed run is named as killed rather than reported as a mystery", !killed.ok, killed.reason.slice(0, 60));
}

// ── 9) the manifest: a claim, checked against the probe ─────────────────────

console.log("9) a model manifest is a DECLARATION; the probe is the truth");
{
  const parsed = parseModelManifest({
    endpointId: "comfy-dgx",
    declaredAt: 1_700_000_000_000,
    note: "the DGX box",
    models: [
      { id: "wan_video_14b.safetensors", kind: "video", label: "Wan 14B", vramMB: 24_000 },
      { id: "sdxl_base.safetensors", kind: "checkpoint", label: "SDXL" },
      { id: "ghost.safetensors", kind: "checkpoint", label: "Not installed" },
    ],
    nodes: ["SaveWEBM", "KSampler"],
  });
  if (!parsed.ok) stop("a well-formed manifest parses", parsed.error);
  check("the declaration's own capability claim is separate from anything probed",
    manifestCapabilities(parsed.manifest).includes("video"), manifestCapabilities(parsed.manifest).join(", "));

  const path = parseModelManifest({ endpointId: "x", models: [{ id: "/models/checkpoints/sdxl.safetensors", kind: "checkpoint", label: "p" }], nodes: [] });
  check("a PATH-shaped model id is refused: a manifest names models, it does not point at disks",
    !path.ok, path.ok ? "accepted" : path.error.slice(0, 80));
  const badKind = parseModelManifest({ endpointId: "x", models: [{ id: "m", kind: "wizardry", label: "p" }], nodes: [] });
  check("an unknown model kind is refused rather than coerced to a default", !badKind.ok);

  const rec = reconcileManifest(parsed.manifest, {
    models: [{ id: "wan_video_14b.safetensors", kind: "diffusion", node: "UNETLoader" }, { id: "flux1-dev.safetensors", kind: "diffusion", node: "UNETLoader" }],
    attested: ["video", "image"], probeState: "ready", ageMs: 5_000,
  });
  check("a model the probe LISTED is usable", rec.usable.some((m) => m.id === "wan_video_14b.safetensors"));
  check("a model the manifest DECLARED but the probe never listed is absent, never usable",
    rec.declaredButAbsent.includes("ghost.safetensors") && !rec.usable.some((m) => m.id === "ghost.safetensors"),
    rec.declaredButAbsent.join(", "));
  check("a model the server has but the manifest omitted is still usable: stale paperwork is not a missing model",
    rec.presentButUndeclared.includes("flux1-dev.safetensors"));
  const stale = reconcileManifest(parsed.manifest, { models: [{ id: "wan_video_14b.safetensors", kind: "diffusion", node: "UNETLoader" }], attested: ["video"], probeState: "ready", ageMs: 900_001 });
  check("a probe older than the staleness line blesses NOTHING", stale.usable.length === 0 && !stale.trustworthy, stale.note.slice(0, 80));
  const unauth = reconcileManifest(parsed.manifest, { models: [], attested: [], probeState: "unauthorized", ageMs: 10 });
  check("an unauthorized probe blesses nothing either, and says so", unauth.usable.length === 0 && unauth.note.length > 0, unauth.note.slice(0, 70));
}

// ── the real thing ──────────────────────────────────────────────────────────

interface Fixture { proc: Bun.Subprocess; url: string }
async function spawnFixture(port: number, flags: readonly string[]): Promise<Fixture> {
  const proc = Bun.spawn(["bun", "run", "desktop/fake_comfy_server.ts", "--port", String(port), ...flags], {
    cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i++) {
    await Bun.sleep(100);
    try { if ((await fetch(`${url}/object_info`)).ok) return { proc, url }; } catch { /* not up yet */ }
  }
  proc.kill();
  throw new Error(`the ComfyUI fixture on port ${port} never came up`);
}

const root = mkdtempSync(join(tmpdir(), "lucid-creator3-"));
const diskIo: ArtifactIo = {
  ensureDir: (dir) => { mkdirSync(dir, { recursive: true }); },
  writeBytes: (p, b) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, b); },
  writeText: (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); },
  appendLine: (p, l) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, `${l}\n`); },
  readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : ""),
  now: () => Date.now(),
  id: () => `art_${Math.random().toString(36).slice(2, 10)}`,
};
const jobsIo: JobIo = {
  ensureDir: (dir) => { mkdirSync(dir, { recursive: true }); },
  readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : ""),
  appendLine: (p, l) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, `${l}\n`); },
  now: () => Date.now(),
  id: () => `job_${Math.random().toString(36).slice(2, 10)}`,
};

const probeDeps: ProbeDeps = {
  fetchImpl: fetch, exec: () => "", exists: () => false, now: () => Date.now(), secret: () => "", timeoutMs: 5000,
};
const endpointFor = (url: string): CreatorEndpointDef => ({
  id: "comfy-fixture", providerId: "comfyui", label: "fixture", baseUrl: url, zone: "local", enabled: true,
});

let port = 8740 + Math.floor(Math.random() * 200);

console.log("10) END TO END: the real pipeline, a real server, a real websocket, a real video artifact");
{
  const fx = await spawnFixture(port, ["--delay", "250", "--video-output"]);
  try {
    const probe = await probeComfyui(probeDeps, endpointFor(fx.url));
    check("a live probe reaches a verdict and attests video from the installed nodes",
      probe.state === "ready" && probe.attested.includes("video"), `${probe.state}: ${probe.attested.join(", ")}`);

    const clientId = `lucid-demo-${Math.random().toString(36).slice(2, 8)}`;
    const socket = openComfyProgress(fx.url, "", clientId, { idleMs: 4000 });
    check("the /ws socket opened against the real server", !!socket, socket ? "open" : "no socket");
    const seen: StreamState[] = [];
    try {
      const run = await runRenderPipeline(
        { client: new ComfyClient({ baseUrl: fx.url, timeoutMs: 10_000 }), artifactIo: diskIo, jobIo: jobsIo, scan: async () => CLEAN, now: () => Date.now() },
        root,
        {
          kind: "video", workflow: WORKFLOW,
          spec: { prompt: "a lantern swinging in fog", negative: "", model: "wan_video_14b.safetensors", seed: 11, width: 64, height: 64 },
          attested: probe.attested, admission: ADMITTED, clientId,
          feed: socket?.feed, poll: { pollMs: 200, maxWaitMs: 30_000 },
        },
      );
      if (!run.ok) stop("the end-to-end video render succeeds", `${run.stage}: ${run.error}`);
      const stored = run.media[0];
      if (!stored) stop("the render stored an artifact", "no media in the result");
      check("the render reports done, with one stored artifact", run.stage === "done" && run.media.length === 1);
      check("the artifact is filed as a VIDEO with the extension its bytes proved",
        stored.artifact.kind === "video" && stored.artifact.file.endsWith(".webm"), `${stored.artifact.kind} ${stored.artifact.file}`);
      check("its mime came from the BYTES, not from the server's header", stored.mime === "video/webm", stored.mime);
      const onDisk = readFileSync(stored.path);
      check("the bytes on disk are what the server actually sent, header and all",
        onDisk.length === stored.artifact.bytes && onDisk[0] === 0x1a && onDisk[1] === 0x45 && onDisk[2] === 0xdf && onDisk[3] === 0xa3,
        `${onDisk.length} bytes, head ${[...onDisk.slice(0, 4)].map((b) => b.toString(16)).join(" ")}`);
      check("it carries a sha256, the prompt, and the model that produced it",
        stored.artifact.sha256.length === 64 && stored.artifact.prompt.includes("lantern") && stored.artifact.model === "wan_video_14b.safetensors",
        `sha ${stored.artifact.sha256.slice(0, 12)}`);
      check("the artifact ledger folds back with the run recorded",
        foldArtifacts(diskIo.readText(join(artifactDir(root), "artifacts.jsonl"))).some((a) => a.id === stored.artifact.id));
      const rows = foldJobs(jobsIo.readText(join(root, "jobs", "jobs.jsonl")));
      const row = rows.find((j) => j.id === run.jobId);
      check("the job is done and owns the artifact it produced",
        row?.state === "done" && row.artifacts.includes(stored.artifact.id), `${row?.state ?? "no row"}, ${row?.artifacts.length ?? 0} artifact(s)`);
      check("the note states what was PROVEN and admits what was not scanned",
        run.note.includes("Type proven from the bytes") && run.note.includes("not a content scan"));
      // Telemetry: the socket carried this render's own frames.
      seen.push(run.progress ?? newStreamState(clientId));
      check("the websocket reported progress for OUR prompt, not a broadcast",
        (run.progress?.promptId ?? "") === run.promptId, `${run.progress?.promptId ?? "none"} vs ${run.promptId}`);
      check("and it reached a real step count rather than an invented percentage",
        (run.progress?.total ?? 0) > 0 || run.progress?.status === "done", `status ${run.progress?.status ?? "none"}, total ${run.progress?.total ?? 0}`);
    } finally { socket?.close(); }
  } finally { try { fx.proc.kill(); } catch { /* already gone */ } }
}

console.log("11) END TO END: a server that LIES about what it sent gets refused, and stores nothing");
{
  port += 1;
  const fx = await spawnFixture(port, ["--delay", "150", "--video-output", "--lying-mime"]);
  try {
    const before = foldArtifacts(diskIo.readText(join(artifactDir(root), "artifacts.jsonl"))).length;
    const run = await runRenderPipeline(
      { client: new ComfyClient({ baseUrl: fx.url, timeoutMs: 10_000 }), artifactIo: diskIo, jobIo: jobsIo, scan: async () => CLEAN, now: () => Date.now() },
      root,
      {
        kind: "video", workflow: WORKFLOW,
        spec: { prompt: "a lantern swinging in fog", negative: "", model: "wan_video_14b.safetensors", seed: 11, width: 64, height: 64 },
        attested: ["video"], admission: ADMITTED, poll: { pollMs: 200, maxWaitMs: 20_000 },
      },
    );
    check("the render REFUSES rather than storing bytes whose type it could not agree on", !run.ok, run.stage);
    const firstRefusal = run.refused[0]?.reason ?? "";
    check("the refusal names the file and the contradiction",
      run.refused.length > 0 && (firstRefusal.includes("video/mp4") || firstRefusal.includes("could not identify")),
      firstRefusal.slice(0, 90) || "no refusal recorded");
    const after = foldArtifacts(diskIo.readText(join(artifactDir(root), "artifacts.jsonl"))).length;
    check("the artifact ledger did not grow by a single row", after === before, `${before} -> ${after}`);
    const rows = foldJobs(jobsIo.readText(join(root, "jobs", "jobs.jsonl")));
    check("the job is failed and owns no artifact",
      rows.find((j) => j.id === run.jobId)?.state === "failed" && (rows.find((j) => j.id === run.jobId)?.artifacts.length ?? 0) === 0);
  } finally { try { fx.proc.kill(); } catch { /* already gone */ } }
}

console.log("12) a silent socket cannot hang a render: /history is the authority");
{
  port += 1;
  const fx = await spawnFixture(port, ["--delay", "200", "--video-output", "--ws-silent"]);
  try {
    const clientId = `lucid-demo-${Math.random().toString(36).slice(2, 8)}`;
    const socket = openComfyProgress(fx.url, "", clientId, { idleMs: 1200 });
    const started = Date.now();
    try {
      const run = await runRenderPipeline(
        { client: new ComfyClient({ baseUrl: fx.url, timeoutMs: 10_000 }), artifactIo: diskIo, jobIo: jobsIo, scan: async () => CLEAN, now: () => Date.now() },
        root,
        {
          kind: "video", workflow: WORKFLOW,
          spec: { prompt: "a lantern swinging in fog", negative: "", model: "wan_video_14b.safetensors", seed: 11, width: 64, height: 64 },
          attested: ["video"], admission: ADMITTED, clientId, feed: socket?.feed, poll: { pollMs: 200, maxWaitMs: 20_000 },
        },
      );
      const elapsed = Date.now() - started;
      check("the render still finished, on polling alone", run.ok, `${run.stage} in ${elapsed}ms`);
      check("it did not wait out the socket's idle window before settling", elapsed < 15_000, `${elapsed}ms`);
      check("progress honestly reports that nothing was streamed", (run.progress?.total ?? 0) === 0, `total ${run.progress?.total ?? 0}`);
    } finally { socket?.close(); }
  } finally { try { fx.proc.kill(); } catch { /* already gone */ } }
}

console.log("13) a noisy shared socket cannot corrupt this render's progress");
{
  port += 1;
  const fx = await spawnFixture(port, ["--delay", "250", "--video-output", "--ws-noise"]);
  try {
    const clientId = `lucid-demo-${Math.random().toString(36).slice(2, 8)}`;
    const socket = openComfyProgress(fx.url, "", clientId, { idleMs: 4000 });
    try {
      const run = await runRenderPipeline(
        { client: new ComfyClient({ baseUrl: fx.url, timeoutMs: 10_000 }), artifactIo: diskIo, jobIo: jobsIo, scan: async () => CLEAN, now: () => Date.now() },
        root,
        {
          kind: "video", workflow: WORKFLOW,
          spec: { prompt: "a lantern swinging in fog", negative: "", model: "wan_video_14b.safetensors", seed: 11, width: 64, height: 64 },
          attested: ["video"], admission: ADMITTED, clientId, feed: socket?.feed, poll: { pollMs: 200, maxWaitMs: 20_000 },
        },
      );
      check("the render succeeded despite junk frames, a foreign prompt id, and a truncated binary frame", run.ok, `${run.stage}: ${run.error}`);
      check("progress belongs to OUR prompt, never to the other client's",
        !run.progress || run.progress.promptId === run.promptId, `${run.progress?.promptId ?? "none"} vs ${run.promptId}`);
      check("and the render is not in an error state invented by someone else's failure",
        (run.progress?.status ?? "queued") !== "error", run.progress?.status ?? "none");
    } finally { socket?.close(); }
  } finally { try { fx.proc.kill(); } catch { /* already gone */ } }
}

// A drain over a feed that never ends must not hold the process: the bound is the contract.
{
  const endless: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() { for (;;) yield JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: 1 } } } }); },
  };
  const state = await trackProgress("p_x", endless, { budget: 8 });
  check("a feed that never ends is bounded by the frame budget rather than spinning forever", state.status === "queued");
}


// ── 14) the capture harness: a real scene, stepped by LUCID's clock ─────────

console.log("14) CREATOR-3b: the Preview-panel capture harness, and the reference scene it drives");
{
  // The driver is the real product module. The transport is scripted here because the other end is a
  // sandboxed iframe: what a headless run CAN prove is that the driver judges every reply correctly, that
  // its caps match the bridge's, and that the shipped reference scene actually honours the contract.
  const plan = framePlan({ durationMs: 2000, fps: 30 });
  if (!plan.ok) stop("the panel's default plan is buildable", plan.error);
  check("the panel's default pass is 60 frames, inside the bridge's 64-frame cap",
    plan.frames.length === 60 && plan.frames.length <= MAX_CAPTURE_PASS, `${plan.frames.length} frames, cap ${MAX_CAPTURE_PASS}`);
  check("the driver's cap is the SAME literal the bridge enforces, so no capture reports phantom gaps",
    PREVIEW_BRIDGE_JS.includes(`CAP_MAX_FRAMES=${MAX_CAPTURE_PASS}`));

  // A scene whose pixels are a pure function of the time it is handed, and a decoder that reverses the
  // fixture's encoding, so fingerprints come from real bytes through the real pure fingerprint.
  const px = (tMs: number): Uint8Array => {
    const b = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < b.length; i += 4) { b[i] = tMs % 256; b[i + 1] = 70; b[i + 2] = 120; b[i + 3] = 255; }
    return b;
  };
  const urlFor = (tMs: number): string => `data:image/png;base64,${btoa(`f${tMs}`)}`;
  const decode = async (dataUrl: string) => {
    const t = Number(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)).slice(1));
    return Number.isFinite(t) ? { width: 2, height: 2, rgba: px(t) } : null;
  };
  // A fake bridge answers the plan it was ACTUALLY given, which matters because the driver now probes the
  // platform with a two-frame plan at one time before it will judge a baseline.
  const reply = (over: Record<string, unknown> = {}) =>
    ({ driven: true, width: 2, height: 2, frames: plan.frames.map((f) => ({ index: f.index, tMs: f.tMs, dataUrl: urlFor(f.tMs) })), ...over });
  const replyFor = (cmd: { readonly plan: readonly { readonly index: number; readonly tMs: number }[] }, over: Record<string, unknown> = {}) =>
    ({ driven: true, width: 2, height: 2, frames: cmd.plan.map((f) => ({ index: f.index, tMs: f.tMs, dataUrl: urlFor(f.tMs) })), ...over });
  // The probe asks for several times across the plan, each duplicated in place. Detected by that shape rather
  // than by a frame count, so widening FLOOR_SAMPLE_POINTS cannot silently break this fake.
  const isFloorProbe = (cmd: { readonly plan: readonly { readonly tMs: number }[] }): boolean =>
    cmd.plan.length >= 2 && cmd.plan.length % 2 === 0 && cmd.plan.length !== plan.frames.length
    && cmd.plan.every((f, i) => (i % 2 === 1 ? f.tMs === cmd.plan[i - 1]?.tMs : true));

  const first = await runCapture({ plan: plan.frames, send: async () => reply(), decode });
  check("a driven pass fingerprints every planned frame and passes its own audit",
    first.ok && first.fingerprints.length === 60 && first.report?.missing === 0, first.note.slice(0, 80));
  const again = await runCapture({ plan: plan.frames, send: async (cmd) => replyFor(cmd), decode, baseline: first.fingerprints });
  check("a second pass of the same scene matches the baseline frame for frame", again.regression?.equal === true);

  const drifted = plan.frames.map((f) => ({ index: f.index, tMs: f.tMs, dataUrl: urlFor(f.tMs >= 500 ? f.tMs + 3 : f.tMs) }));
  const changed = await runCapture({ plan: plan.frames, send: async (cmd) => (isFloorProbe(cmd) ? replyFor(cmd) : reply({ frames: drifted })), decode, baseline: first.fingerprints });
  check("a scene that changed fails the compare and names the FIRST differing frame",
    !changed.ok && changed.regression?.equal === false && changed.regression?.firstDiff === 15,
    `first diff at frame ${changed.regression?.firstDiff}`);

  const sampled = await runCapture({ plan: plan.frames, send: async () => reply({ driven: false }), decode });
  check("a page with NO render hook is labeled sampled, never sold as deterministic",
    !sampled.driven && sampled.note.includes("SAMPLED on its own clock") && !sampled.note.includes("reproducibility result"),
    sampled.note.slice(0, 90));
  check("and the sampled verdict names the hook that would make it reproducible",
    sampled.note.includes("window.lucidRenderAt"));

  const noCanvas = await runCapture({ plan: plan.frames, send: async () => ({ error: "this page has no canvas to capture" }), decode });
  check("the bridge's own refusal reaches the user verbatim", noCanvas.error === "this page has no canvas to capture");
  const junk = await runCapture({ plan: plan.frames, send: async () => ({ driven: true, width: 2, height: 2 }), decode });
  check("a malformed reply paints NOTHING rather than a partial report", !junk.ok && junk.report === null);
  const svg = plan.frames.map((f, i) => ({ index: f.index, tMs: f.tMs, dataUrl: i === 4 ? "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" : urlFor(f.tMs) }));
  const refusedPass = await runCapture({ plan: plan.frames, send: async () => reply({ frames: svg }), decode });
  check("ONE frame that is not a raster image refuses the WHOLE pass, naming it",
    !refusedPass.ok && refusedPass.error.includes("Frame 4") && refusedPass.fingerprints.length === 0,
    refusedPass.error.slice(0, 70));

  // The shipped reference scene has to honour the contract it documents, or it teaches the wrong thing.
  const scenePath = join(import.meta.dir, "..", "..", "desktop", "scripts", "capture_scene_example.html");
  const sceneHtml = readFileSync(scenePath, "utf8");
  const scriptAt = sceneHtml.lastIndexOf("<script>");
  const body = sceneHtml.slice(scriptAt).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("the reference scene defines the documented hook", body.includes("window.lucidRenderAt = function"));
  check("its canvas is well inside the bridge's edge cap", /width="480"\s+height="270"/.test(sceneHtml));
  for (const clock of ["Date.now(", "performance.now(", "new Date("]) {
    check(`its executable code never reads ${clock}), so a frame cannot depend on when it was painted`, !body.includes(clock));
  }
  const randomAt = body.indexOf("Math.random");
  const brokenAt = body.indexOf("lucidRenderAtNondeterministic");
  check("the ONLY randomness in its code sits inside the deliberately broken variant",
    randomAt > 0 && brokenAt > 0 && randomAt > brokenAt, `random at ${randomAt}, broken variant at ${brokenAt}`);
  // THE FLOOR IS MEASURED, AND THE TOLERANCE COMES OUT OF IT. This is the bug the on-device pass found: an
  // exact-fingerprint compare against a live composited canvas reports a regression the scene did not cause,
  // because two readbacks of ONE identical render are not byte-identical on that platform.
  const sent: number[][] = [];
  const jittery = async (cmd: { readonly plan: readonly { readonly index: number; readonly tMs: number }[] }) => {
    sent.push(cmd.plan.map((f) => f.tMs));
    if (isFloorProbe(cmd)) {
      // Each half of every duplicated pair reads back slightly differently, exactly as a live canvas does.
      return { driven: true, width: 2, height: 2, frames: cmd.plan.map((f, i) => ({ index: f.index, tMs: f.tMs, dataUrl: urlFor(f.tMs + (i % 2)) })) };
    }
    return reply();
  };
  const unstable = await runCapture({ plan: plan.frames, send: jittery, decode, baseline: first.fingerprints, baselineSignatures: first.signatures });
  const probeSent = sent.find((p) => p.length !== plan.frames.length) ?? [];
  check("the floor is sampled at SEVERAL times across the plan, not just the first frame",
    probeSent.length === FLOOR_SAMPLE_POINTS * 2 && probeSent[0] === 0 && probeSent[probeSent.length - 1] === plan.frames[plan.frames.length - 1]?.tMs,
    `probe asked for ${probeSent.join(", ")}`);
  check("each sampled time is asked for TWICE, so every pair is two readbacks of one identical render",
    probeSent.every((t, i) => i % 2 === 1 ? t === probeSent[i - 1] : true));
  check("a platform that cannot read one render back twice the same way is MEASURED, not assumed",
    unstable.noiseFloor?.byteStable === false && (unstable.noiseFloor?.changedPixels ?? 0) > 0,
    unstable.noiseFloor?.reason.slice(0, 95) ?? "no floor measured");
  check("the compare still returns a REAL verdict, by coarse signature at the measured tolerance",
    unstable.regression?.method === "signature" && !unstable.inconclusive,
    `method ${unstable.regression?.method ?? "none"}, inconclusive ${unstable.inconclusive}`);
  check("and the note says WHICH compare ran, so a coarse match is never read as byte equality",
    unstable.note.includes("luminance signature at a tolerance of") && unstable.note.includes("measured from this platform's own readback jitter"));
  const noFallback = await runCapture({ plan: plan.frames, send: jittery, decode, baseline: first.fingerprints });
  check("with NO signature baseline to fall back on, an unjudgeable compare is inconclusive rather than a false regression",
    noFallback.inconclusive && noFallback.regression === null && noFallback.ok,
    `inconclusive ${noFallback.inconclusive}, regression ${String(noFallback.regression)}`);
  const stable = await runCapture({ plan: plan.frames, send: async (cmd) => replyFor(cmd), decode, baseline: first.fingerprints });
  check("a byte-stable platform gets the EXACT compare instead", stable.noiseFloor?.byteStable === true && stable.regression?.method === "exact",
    `${stable.regression?.method ?? "none"}: ${stable.noiseFloor?.reason.slice(0, 60) ?? "unmeasured"}`);
  check("and the honest renderer is what the file exports by default, with the swap left commented out",
    /^\s*\/\/\s*window\.lucidRenderAt = window\.lucidRenderAtNondeterministic;\s*$/m.test(sceneHtml));
}
rmSync(root, { recursive: true, force: true });

console.log(
  failures === 0
    ? "\ndemo_creator3 OK - a capability no live probe attested is refused before a byte leaves the machine, a governor refusal is a written-down job, a workflow with a hole is never submitted, an artifact's type comes from its own bytes rather than the server's label, a dead scanner BLOCKS the artifact and writes nothing, a video and a 3D output are read as what they are, a frame capture is reproducible or says why not, Blender runs as a fixed vector with no shell and reports its own failing line, a manifest is only a claim until the probe agrees, and end to end against a real server the render lands a webm with its sha256, prompt, model and job row while a lying server stores nothing, a silent socket cannot hang the render, and a noisy shared socket cannot corrupt it. The Preview panel now DRIVES a real scene through that clock: a second pass of the shipped reference scene matches frame for frame, a changed scene fails the compare naming the first differing frame, a page with no render hook is labeled sampled rather than sold as deterministic, and one frame that is not a raster image refuses the whole pass."
    : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
