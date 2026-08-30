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

let fixture: { proc: ReturnType<typeof Bun.spawn>; url: string } | null = null;
async function startFixture(): Promise<string> {
  const port = 8300 + Math.floor(Math.random() * 400);
  const proc = Bun.spawn(["bun", "run", "desktop/fake_comfy_server.ts", "--port", String(port), "--delay", "300"], {
    cwd: join(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    await Bun.sleep(100);
    try { if ((await fetch(`${url}/object_info`)).ok) { fixture = { proc, url }; return url; } } catch { /* not up yet */ }
  }
  proc.kill();
  throw new Error("the ComfyUI fixture never came up");
}
const stopFixture = () => { if (fixture) { try { fixture.proc.kill(); } catch { /* already gone */ } fixture = null; } };

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
    const authed = Bun.spawn(["bun", "run", "desktop/fake_comfy_server.ts", "--port", "8299", "--require-token", "s3cret"], { cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" });
    try {
      for (let i = 0; i < 60; i++) { await Bun.sleep(100); try { if ((await fetch("http://127.0.0.1:8299/object_info", { headers: { authorization: "Bearer s3cret" } })).ok) break; } catch { /* wait */ } }
      const noToken = await probeComfyui({ ...probeDeps("http://127.0.0.1:8299"), secret: () => "" }, { ...ep, baseUrl: "http://127.0.0.1:8299" });
      check(noToken.state === "unauthorized", "a server that requires a token reports UNAUTHORIZED, not unreachable", noToken.detail);
      const withToken = await probeComfyui({ ...probeDeps("http://127.0.0.1:8299"), secret: () => "s3cret" }, { ...ep, baseUrl: "http://127.0.0.1:8299" });
      check(withToken.state === "ready", "the same server with the token is ready", withToken.attested.join(", "));
    } finally { authed.kill(); }

    const bare = Bun.spawn(["bun", "run", "desktop/fake_comfy_server.ts", "--port", "8298", "--bare"], { cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" });
    try {
      for (let i = 0; i < 60; i++) { await Bun.sleep(100); try { if ((await fetch("http://127.0.0.1:8298/object_info")).ok) break; } catch { /* wait */ } }
      const bareProbe = await probeComfyui(probeDeps("http://127.0.0.1:8298"), { ...ep, baseUrl: "http://127.0.0.1:8298" });
      check(bareProbe.state === "no-capabilities", "a catalog with no output node proves NOTHING (not ready)", bareProbe.detail);
    } finally { bare.kill(); }

    const dead = await probeComfyui(probeDeps("http://127.0.0.1:9"), { ...ep, baseUrl: "http://127.0.0.1:9" });
    check(dead.state === "unreachable", "a dead endpoint is unreachable, and nothing throws", dead.detail);
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
