// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_creator1.ts - CREATOR-1 (ADR-0292): the runnable proof.
//
// Four sections, no network, no GPU:
//   1. probes prove capability instead of assuming it (and a probe that proves nothing says so)
//   2. a probe is what turns registry `configured` into a truthful `ready`, and it EXPIRES
//   3. the job ledger is a real state machine: legal transitions only, settled means settled
//   4. admission is recorded per job - a refusal is written down with the measured reason, and a
//      cancel is a REQUEST until the runner confirms
//
// The theme: after CREATOR-0 the Studio could say "configured". After CREATOR-1 it can only say "ready"
// when something actually answered, and every run leaves an auditable row behind.

import {
  PROBE_STALE_MS, ProbeCache, attestComfyCapabilities, attestElevenCapabilities, probeBuiltIn, probeComfyui,
  probeElevenlabs, probeExecutable, probeFreshness, probeHttpService, probeProvider, type ProbeDeps,
} from "../../desktop/creator_probe.ts";
import { CREATOR_INTEGRATIONS, foldProviderStatus, type CreatorEndpointDef } from "../../desktop/creator_registry.ts";
import {
  canTransition, createJob, finishJob, foldJobs, jobDurationMs, jobStats, jobsLedger, listJobs,
  recordJobArtifact, requestJobCancel, startJob, type JobAdmissionSnapshot, type JobIo,
} from "../../desktop/creator_jobs.ts";
import { creatorJobsHtml, creatorIntegrationsHtml } from "../../desktop/renderer/creator_studio.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`   ${ok ? "ok" : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ep = (over: Partial<CreatorEndpointDef> = {}): CreatorEndpointDef => ({
  id: "comfy-local", providerId: "comfyui", label: "Workstation ComfyUI",
  baseUrl: "http://127.0.0.1:8188", zone: "local", enabled: true, ...over,
});
function deps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  let t = 1_000_000;
  return { fetchImpl: async () => jsonRes({}), exec: () => "", exists: () => true, now: () => (t += 10), secret: () => "", timeoutMs: 500, ...over };
}
function fakeIo(): JobIo & { ledger(): string } {
  let seq = 0, clock = 1_700_000_000_000;
  const raw: Record<string, string> = {};
  return {
    ledger: () => raw[jobsLedger("/creator")] ?? "",
    ensureDir: () => {},
    readText: (p) => raw[p] ?? "",
    appendLine: (p, line) => { raw[p] = (raw[p] ?? "") + line + "\n"; },
    now: () => (clock += 1000),
    id: () => `job${++seq}`,
  };
}

console.log("1) a probe PROVES capability; it never assumes it");
check("ComfyUI capability comes from the installed node set",
  attestComfyCapabilities({ KSampler: {}, SaveImage: {}, VHS_VideoCombine: {} }).includes("video")
  && !attestComfyCapabilities({ KSampler: {}, SaveImage: {} }).includes("video"));
const comfyReady = await probeComfyui(deps({ fetchImpl: async () => jsonRes({ KSampler: {}, SaveImage: {}, LoadImage: {} }) }), ep());
check("a reachable install reports its node count and what it proved",
  comfyReady.state === "ready" && comfyReady.attested.includes("image"), comfyReady.detail);
const comfyBare = await probeComfyui(deps({ fetchImpl: async () => jsonRes({ SomeCustomNode: {} }) }), ep());
check("a server with no output node is 'nothing proven', not ready", comfyBare.state === "no-capabilities");
check("401 is unauthorized and a dead socket is unreachable - neither throws",
  (await probeComfyui(deps({ fetchImpl: async () => jsonRes({}, 401) }), ep())).state === "unauthorized"
  && (await probeComfyui(deps({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), ep())).state === "unreachable");
check("ElevenLabs attests from documented model flags, and TTS implies streaming + alignment",
  attestElevenCapabilities([{ can_do_text_to_speech: true, can_do_voice_conversion: true }]).sort().join() === "alignment,dubbing,streaming-audio,tts");
const elevenNoKey = await probeElevenlabs(deps());
check("no key is SKIPPED - a probe never invents a credential", elevenNoKey.state === "skipped");
let sawHeader: string | null = null;
const elevenKeyed = await probeElevenlabs(deps({
  secret: () => "xi-secret-value",
  fetchImpl: async (url, init) => {
    sawHeader = new Headers(init?.headers).get("xi-api-key");
    return url.includes("xi-secret-value") ? jsonRes({}, 400) : jsonRes([{ can_do_text_to_speech: true }]);
  },
}));
check("the key rides a HEADER, never the URL, and never the detail line",
  elevenKeyed.state === "ready" && sawHeader === "xi-secret-value" && !elevenKeyed.detail.includes("xi-secret-value"));
const suno = await probeHttpService(deps({ fetchImpl: async () => jsonRes({}) }), "suno", ep({ providerId: "suno", baseUrl: "https://partner.example" }));
check("a Suno partner endpoint that answers is READY with NO capability claimed",
  suno.state === "ready" && suno.attested.length === 0, suno.detail);
check("a missing executable is 'not on disk', and a tool that refuses --version is still installed",
  probeExecutable(deps({ exists: () => false }), "blender", ep({ providerId: "blender", baseUrl: undefined, command: "/usr/bin/blender" }), { attested: ["render-still"] }).state === "not-installed"
  && probeExecutable(deps({ exec: () => { throw new Error("exit 1"); } }), "unreal", ep({ providerId: "unreal", baseUrl: undefined, command: "/opt/UE/UnrealEditor-Cmd" }), { versionArgs: ["-version"], attested: ["engine-build"] }).state === "ready");
check("three.js is ready by construction (no endpoint, no credential, no network)",
  probeBuiltIn(deps(), "threejs", ["scene-preview"]).state === "ready");
check("a provider with no declaration is skipped honestly, naming what still works",
  (await probeProvider(deps(), "suno", [])).detail.includes("local library works without one"));

console.log("2) a probe is what upgrades `configured` to `ready`, and it expires");
const comfySpec = CREATOR_INTEGRATIONS.find((s) => s.id === "comfyui")!;
check("an endpoint plus a credential is only CONFIGURED",
  foldProviderStatus(comfySpec, { endpoints: [ep()], secretPresent: true }).state === "configured");
const proven = foldProviderStatus(comfySpec, { endpoints: [ep()], secretPresent: true, discovered: ["image", "workflow-run"] });
check("a probe that proved something makes it READY", proven.state === "ready");
check("ONLY what the probe attested is usable - the catalog is not a promise about THIS install",
  proven.usable.includes("image") && !proven.usable.includes("video"));
const cache = new ProbeCache();
cache.set(comfyReady);
check("the cache hands over attested capabilities while the answer is fresh",
  (cache.discovered("comfyui", comfyReady.at + 1000) ?? []).includes("image"));
check("an EXPIRED answer is dropped, so a stale probe cannot keep a provider looking ready",
  cache.discovered("comfyui", comfyReady.at + PROBE_STALE_MS) === undefined);
cache.set({ ...comfyReady, state: "unreachable", attested: [] });
check("a failed probe hands over nothing", cache.discovered("comfyui", comfyReady.at + 100) === undefined);
check("freshness is three distinct states",
  probeFreshness(1000, 1500) === "fresh" && probeFreshness(1000, 201_000) === "stale" && probeFreshness(1000, 1000 + PROBE_STALE_MS) === "expired");
check("the Studio row shows the probe verdict, its age, and offers a re-probe",
  (() => {
    const html = creatorIntegrationsHtml([proven], [comfyReady], comfyReady.at + 5000);
    return html.includes("proven") && html.includes("5s ago") && html.includes('data-creator-probe="comfyui"');
  })());

console.log("3) the job ledger is a real state machine");
check("legal transitions only: a job cannot finish without running, and settled is final",
  canTransition("queued", "running") && canTransition("running", "done")
  && !canTransition("queued", "done") && !canTransition("done", "running") && !canTransition("failed", "done"));
const io = fakeIo();
const admitted: JobAdmissionSnapshot = { ok: true, cpuPct: 22, memPct: 40, gpuPct: 15, vramPct: 30, gpuEvidenceMissing: false, reason: "" };
const job = createJob(io, "/creator", { kind: "image", label: "neon alley", provider: "comfyui", admission: admitted });
startJob(io, "/creator", job.id, admitted);
recordJobArtifact(io, "/creator", job.id, "art_1");
recordJobArtifact(io, "/creator", job.id, "art_2");
finishJob(io, "/creator", job.id, "done");
const settled = listJobs(io, "/creator")[0]!;
check("a job runs, records its artifacts, and settles with a duration",
  settled.state === "done" && settled.artifacts.length === 2 && (jobDurationMs(settled, 0) ?? 0) > 0);
check("a late runner cannot overwrite a settled outcome", finishJob(io, "/creator", job.id, "failed", "too late") === false);
check("a torn tail or an unknown op costs ONE record, never the ledger",
  foldJobs(io.ledger() + '{"op":"create","at":1,"id":"x","jo\n{"op":"frobnicate","at":2,"id":"y"}\ngarbage\n').length === 1);
check("an illegal transition inside the ledger is skipped on fold, not applied", (() => {
  const io2 = fakeIo();
  const j = createJob(io2, "/creator", { kind: "gif", label: "walk" });
  io2.appendLine(jobsLedger("/creator"), JSON.stringify({ op: "start", at: 2, id: j.id }));
  io2.appendLine(jobsLedger("/creator"), JSON.stringify({ op: "finish", at: 3, id: j.id, state: "done" }));
  io2.appendLine(jobsLedger("/creator"), JSON.stringify({ op: "finish", at: 4, id: j.id, state: "failed", error: "late" }));
  const folded = foldJobs(io2.ledger())[0]!;
  return folded.state === "done" && folded.error === "";
})());

console.log("4) admission is recorded, and a cancel is a REQUEST until the runner confirms");
const refusedAdmission: JobAdmissionSnapshot = { ok: false, cpuPct: 97, memPct: 94, gpuPct: null, vramPct: null, gpuEvidenceMissing: true, reason: "system memory has been at 94% for 42s" };
const refusedJob = createJob(io, "/creator", { kind: "render", label: "a diffusion batch", admission: refusedAdmission });
check("a REFUSED admission is written down as a job, with the measured reason",
  refusedJob.state === "refused" && refusedJob.error.includes("94% for 42s"), refusedJob.error);
check("a refused job cannot be started", startJob(io, "/creator", refusedJob.id) === false);
check("the admission snapshot survives, so 'why did this run' is answerable later",
  listJobs(io, "/creator").find((j) => j.id === job.id)?.admission?.cpuPct === 22);
const slow = createJob(io, "/creator", { kind: "image", label: "slow render" });
startJob(io, "/creator", slow.id);
requestJobCancel(io, "/creator", slow.id);
const mid = listJobs(io, "/creator").find((j) => j.id === slow.id)!;
check("a stop request is recorded but the job is STILL running (claiming otherwise would be a lie)",
  mid.cancelRequested && mid.state === "running");
finishJob(io, "/creator", slow.id, "cancelled");
check("it settles as cancelled only when the runner confirms",
  listJobs(io, "/creator").find((j) => j.id === slow.id)!.state === "cancelled");
check("stopping an already-settled job is refused with the reason",
  (requestJobCancel(io, "/creator", slow.id).error ?? "").includes("already cancelled"));
const stats = jobStats(listJobs(io, "/creator"));
check("stats separate active work from settled outcomes",
  stats.total === 3 && stats.done === 1 && stats.refused === 1 && stats.active === 0, JSON.stringify(stats));
check("the job strip shows the governor's measurement and a Stop only while it can be stopped", (() => {
  const running = creatorJobsHtml([{ ...mid, admission: admitted }], stats, mid.startedAt! + 3400);
  const done = creatorJobsHtml([{ ...settled, admission: admitted }], stats);
  return running.includes("3.4s") && running.includes("admitted at cpu 22%") && !done.includes("data-job-cancel");
})());

console.log(failures === 0
  ? "\ndemo_creator1 OK - a Creator provider is only READY once something answered: ComfyUI capability comes from its installed nodes, ElevenLabs from its documented model flags, a user-run service proves reachability and admits it proves nothing more, a desktop app proves it is on disk, and an expired probe stops counting. Every run is a ledger row with the CPU/memory/GPU the governor measured, a refusal is recorded with its reason instead of vanishing, and a cancel is a request until the runner confirms."
  : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
