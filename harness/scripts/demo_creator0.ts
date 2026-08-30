// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// harness/scripts/demo_creator0.ts - CREATOR-0 (ADR-0279..0284): the runnable proof.
//
// Seven checks, no Electron, no packaging, no network:
//   1. two flavors that can genuinely coexist (identity, ports, scheme, artifacts)
//   2. Creator Mode is offered ONLY in a Creator build, and its security posture equals Agent's
//   3. Creator standing guidance is tail-only and appears only in Creator build + Creator mode
//   4. the integration registry tells the truth about every provider (including Suno)
//   5. endpoint declarations are fail-closed and never carry a secret
//   6. telemetry is honest: unknown is never zero, and a burst never refuses a job
//   7. the local track library works end to end with NO provider API at all

import {
  AGENT_FLAVOR, CREATOR_FLAVOR, normalizeUiMode, resolveBuildFlavor, uiModePosture,
} from "../../desktop/build_flavor.ts";
import { creatorModePreamble } from "../../desktop/creator_preamble.ts";
import { buildUserTurnPreamble } from "../../desktop/preamble.ts";
import {
  CREATOR_INTEGRATIONS, foldProviderStatus, validateCreatorEndpoint, type CreatorEndpointDef,
} from "../../desktop/creator_registry.ts";
import {
  creatorAdmission, hotMsFor, parseNvidiaSmi, perCoreBusy, pushCreatorSample, sampleLocalGpu,
  type CreatorSample, type GpuTelemetry,
} from "../../desktop/creator_monitor.ts";
import {
  addTrack, foldLibrary, libraryAudioDir, libraryLedger, libraryStats, lineageOf, trackAudio, updateTrack,
  type LibraryIo,
} from "../../desktop/creator_library.ts";
import { pressureRailHtml, creatorFlyoutHtml } from "../../desktop/renderer/creator_monitor.ts";
import { creatorIntegrationsHtml, creatorLibraryHtml } from "../../desktop/renderer/creator_studio.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`   ${ok ? "ok" : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

console.log("1) two LUCID flavors that can run side by side");
check("distinct app identity, product name, and installer stem",
  AGENT_FLAVOR.appId !== CREATOR_FLAVOR.appId && AGENT_FLAVOR.productName !== CREATOR_FLAVOR.productName && AGENT_FLAVOR.artifactStem !== CREATOR_FLAVOR.artifactStem);
check("native ports never collide: Agent 5319, Creator 5320",
  AGENT_FLAVOR.defaultPort === 5319 && CREATOR_FLAVOR.defaultPort === 5320);
check("the binding auxiliaries are split too (relay + managed whisper)",
  AGENT_FLAVOR.defaultRelayPort !== CREATOR_FLAVOR.defaultRelayPort && AGENT_FLAVOR.defaultWhisperPort !== CREATOR_FLAVOR.defaultWhisperPort);
check("Creator claims lucid-creator and never steals lucid://",
  CREATOR_FLAVOR.authProtocol === "lucid-creator" && AGENT_FLAVOR.authProtocol === "lucid");
check("an unknown flavor string resolves to the STANDARD build",
  resolveBuildFlavor({ LUCID_BUILD_FLAVOR: "creatorr" }) === "agent" && resolveBuildFlavor({}, "creator") === "creator");

console.log("2) Creator Mode is build-gated, and it is NOT a permission change");
check("a standard build folds a creator request to agent", normalizeUiMode("creator", false) === "agent");
check("a Creator build accepts it", normalizeUiMode("creator", true) === "creator");
check("Creator posture is byte-identical to Agent",
  JSON.stringify(uiModePosture("creator")) === JSON.stringify(uiModePosture("agent")));
check("Ask still forwards every tool permission", uiModePosture("ask").permissionMode === "ask");
check("Plan is still omp's read-only planner", uiModePosture("plan").ompMode === "plan");

console.log("3) Creator standing guidance lives in the TAIL, and only when both conditions hold");
const creatorTail = creatorModePreamble({ creatorBuild: true, active: true });
check("present in a Creator build in Creator mode", creatorTail.length > 200);
check("absent in Creator build, Agent mode", creatorModePreamble({ creatorBuild: true, active: false }) === "");
check("absent in a standard build", creatorModePreamble({ creatorBuild: false, active: true }) === "");
const built = buildUserTurnPreamble({ persona: null, skill: null, profile: "", creatorMode: creatorTail, spokenReply: "<spoken-reply>ear</spoken-reply>", memoryRecall: null, memoryRecallDelivered: false });
check("it sits before the spoken-reply block in the user turn",
  built.preamble.indexOf("Creator build and Creator UI mode") < built.preamble.indexOf("<spoken-reply>"));
check("it restates Agent security semantics rather than relaxing them",
  creatorTail.includes("Preserve Agent security semantics") && creatorTail.includes("NEVER weaken, bypass, silence, or reinterpret a gate"));

console.log("4) the integration registry tells the truth, provider by provider");
check("seven providers, one entry each", CREATOR_INTEGRATIONS.length === 7);
const suno = CREATOR_INTEGRATIONS.find((s) => s.id === "suno")!;
const sunoMusic = suno.capabilities.find((c) => c.id === "music")!;
check("Suno generation is bring-your-own-endpoint (no public self-serve API in 2026)",
  sunoMusic.status === "unverified-endpoint", sunoMusic.detail.slice(0, 60));
const sunoStatus = foldProviderStatus(suno, { endpoints: [], secretPresent: false });
check("but Suno's LOCAL half is usable with no endpoint and no key",
  sunoStatus.usable.includes("library-manage") && sunoStatus.usable.includes("remix") && !sunoStatus.usable.includes("music"));
const eleven = CREATOR_INTEGRATIONS.find((s) => s.id === "elevenlabs")!;
check("ElevenLabs Studio project editing is labeled vendor-app-only, not an API we claim",
  eleven.capabilities.find((c) => c.id === "library-manage")!.status === "product-ui-only");
check("ElevenLabs timestamps ARE documented, so the follow-along editor has a real spine",
  eleven.capabilities.find((c) => c.id === "alignment")!.status === "available");
check("three.js needs no endpoint, no key, no install",
  foldProviderStatus(CREATOR_INTEGRATIONS.find((s) => s.id === "threejs")!, { endpoints: [], secretPresent: false }).state === "built-in");
check("a probe can never invent a capability the catalog does not list",
  !foldProviderStatus(eleven, { endpoints: [], secretPresent: true, discovered: ["engine-build"] }).usable.includes("engine-build"));

console.log("5) endpoint declarations are fail-closed and secret-free");
const good: CreatorEndpointDef = { id: "comfy-local", providerId: "comfyui", label: "Workstation ComfyUI", baseUrl: "http://127.0.0.1:8188", zone: "local", vaultRef: "comfyui_token", enabled: true };
check("a well-formed declaration is accepted", validateCreatorEndpoint(good).ok);
check("credentials in the URL are refused",
  !validateCreatorEndpoint({ ...good, baseUrl: "https://u:p@comfy.internal:8188" }).ok);
check("a shell string is never an executable",
  !validateCreatorEndpoint({ id: "b", providerId: "blender", label: "Blender", command: "blender && rm -rf /", zone: "local", enabled: true }).ok);
check("a pasted secret is caught and named",
  validateCreatorEndpoint({ ...good, label: "sk-abcdefghijklmnopqrst" }).errors.join(" ").includes("store it in the vault"));

console.log("6) telemetry is honest, and admission needs EVIDENCE");
const noGpu: GpuTelemetry = { available: false, source: "none", devices: [], note: "no collector" };
check("a missing nvidia-smi is 'no evidence', not 0%",
  sampleLocalGpu(() => { throw new Error("ENOENT"); }, "win32").available === false);
check("an unsupported counter stays null on real hardware output",
  parseNvidiaSmi("0, Quadro P400, [N/A], 2048, 512, [N/A], Not Supported, [N/A]")[0]!.busyPct === null);
check("per-core detail survives, so one pegged core is visible",
  perCoreBusy([{ times: { idle: 100, user: 0 } }, { times: { idle: 100, user: 0 } }], [{ times: { idle: 100, user: 100 } }, { times: { idle: 200, user: 0 } }]).map((c) => c.busyPct).join(",") === "100,0");
let hist: CreatorSample[] = [];
for (let i = 0; i <= 4; i++) hist = pushCreatorSample(hist, { at: i * 3000, cpuPct: 97, memPct: 30, gpuPct: 96, vramPct: 40 });
check("a 12s burst at 97% never refuses a job", creatorAdmission(hist, { label: "a render" }, noGpu).ok);
for (let i = 5; i <= 14; i++) hist = pushCreatorSample(hist, { at: i * 3000, cpuPct: 97, memPct: 30, gpuPct: 96, vramPct: 40 });
const refused = creatorAdmission(hist, { label: "a diffusion batch" }, noGpu);
check("thirty unbroken seconds does, naming the percent and the duration",
  !refused.ok && refused.reason.includes("97%") && refused.reason.includes("42s"), refused.reason);
const blinded = pushCreatorSample(hist, { at: 15 * 3000, cpuPct: null, memPct: 30, gpuPct: null, vramPct: null });
check("a blind sample BREAKS the streak (a gap can never read as load)", hotMsFor(blinded, "cpuPct") === 0);
const vram: GpuTelemetry = { available: true, source: "nvidia-smi", note: "", devices: [{ index: 0, name: "GB10", vendor: "nvidia", busyPct: 3, memTotalMB: 8192, memUsedMB: 0, memPct: 0, tempC: null, powerW: null, powerCapW: null }] };
const short = creatorAdmission([{ at: 1, cpuPct: 4, memPct: 20, gpuPct: 2, vramPct: 0 }], { label: "a 40 GB model", vramMB: 40960 }, vram);
check("a KNOWN VRAM shortfall refuses with both numbers, even on an idle GPU",
  !short.ok && short.reason.includes("40 GB") && short.reason.includes("8 GB"), short.reason);
const gpuBlindAdmission = creatorAdmission([], { label: "a video render", gpu: true }, noGpu);
check("no GPU evidence admits the job but never claims an all-clear",
  gpuBlindAdmission.ok && gpuBlindAdmission.gpuEvidenceMissing);
const railHtml = pressureRailHtml({
  targets: [{ id: "local", label: "This machine", kind: "local", sampledAt: 1, ageMs: 1, freshness: "fresh", cpu: { model: "CPU", cores: 8, speedMHz: 4000, busyPct: 97, perCore: [] }, mem: { totalMB: 16384, freeMB: 512, usedPct: 97 }, gpu: noGpu, procs: [], error: "" }],
  history: [], admission: refused, policy: { pressurePct: 90, warmPct: 70, sustainMs: 30_000 },
});
check("the rail paints two odometers and shows the refusal",
  (railHtml.match(/data-cod-chip=/g) ?? []).length === 2 && railHtml.includes("cod-refusal"));
check("a GPU with no counters reads blind, 'no signal', and '--' - never a healthy dial",
  railHtml.includes("cod-blind") && railHtml.includes("no signal") && railHtml.includes('aria-label="GPU pressure --"'));
check("the flyout refuses to call missing evidence an all-clear",
  creatorFlyoutHtml({ targets: [], history: [], admission: gpuBlindAdmission, policy: { pressurePct: 90, warmPct: 70, sustainMs: 30_000 } }).includes("not a measured all-clear"));

console.log("7) the local track library works with NO provider API at all");
const files: Record<string, string> = { "/dl/Neon Skyline.mp3": "take-one-bytes", "/dl/Neon Skyline v2.mp3": "take-two-bytes", "/dl/notes.txt": "not audio" };
let seq = 0;
const io: LibraryIo = {
  ensureDir: () => {},
  readText: (p) => files[p] ?? "",
  appendLine: (p, line) => { files[p] = (files[p] ?? "") + line + "\n"; },
  copyIn: (src, dest) => { files[dest] = files[src]!; return files[src]!.length; },
  readBase64: (p) => Buffer.from(files[p] ?? "", "utf8").toString("base64"),
  removeFile: (p) => { delete files[p]; },
  exists: (p) => p in files,
  now: () => 1_700_000_000_000 + (++seq) * 1000,
  id: () => `trk${seq}`,
};
const BASE = "/creator";
const first = addTrack(io, BASE, { sourcePath: "/dl/Neon Skyline.mp3", origin: "suno", prompt: "synthwave, 100 bpm", tags: ["Synthwave", "synthwave", "demo"] });
check("a Suno download imports with its prompt and normalized tags",
  first.ok && first.track!.origin === "suno" && first.track!.tags.join(",") === "synthwave,demo");
check("a non-audio file is refused", !addTrack(io, BASE, { sourcePath: "/dl/notes.txt" }).ok);
const remix = addTrack(io, BASE, { sourcePath: "/dl/Neon Skyline v2.mp3", origin: "suno", title: "Neon Skyline (remix)", kind: "remix", parentId: first.track!.id });
check("a remix records its parent", remix.ok && remix.track!.parentId === first.track!.id);
updateTrack(io, BASE, first.track!.id, { review: "chorus too loud", rating: 4 });
const tracks = foldLibrary(io.readText(libraryLedger(BASE)));
check("review and rating persist through the append-only ledger",
  tracks.find((t) => t.id === first.track!.id)?.review === "chorus too loud");
check("lineage reads oldest first", lineageOf(tracks, remix.track!.id).map((t) => t.kind).join(",") === "original,remix");
const audio = trackAudio(io, BASE, first.track!.id);
check("playback returns real bytes plus a mime",
  audio.ok && Buffer.from(audio.audioB64!, "base64").toString("utf8") === "take-one-bytes" && audio.mime === "audio/mpeg");
check("a torn ledger tail costs one record, never the library",
  foldLibrary(io.readText(libraryLedger(BASE)) + '{"op":"add","at":1,"trac\n').length === tracks.length);
const stats = libraryStats(tracks);
check("stats count tracks, remixes, and reviews", stats.tracks === 2 && stats.remixes === 1 && stats.reviewed === 1);
const libHtml = creatorLibraryHtml({ providers: [], tracks: tracks.map((t) => ({ ...t })), stats });
check("every track offers listen, review, remix, re-prompt, and remove",
  ["data-track-play", "data-track-review", "data-track-remix", "data-track-reprompt", "data-track-remove"].every((a) => libHtml.includes(a)));
check("the audio bytes live under the Creator library root", `${libraryAudioDir(BASE)}/${first.track!.file}` in files);
check("the Studio renders the registry with its honesty labels",
  creatorIntegrationsHtml([sunoStatus]).includes("cst-cap-unverified-endpoint"));

console.log(failures === 0
  ? "\ndemo_creator0 OK - a second LUCID flavor on its own port and identity, Creator Mode gated to that build with Agent security semantics, an honest integration registry (Suno generation is bring-your-own-endpoint, ElevenLabs Studio editing is vendor-app-only), evidence-based CPU/GPU admission where unknown is never idle, and a local track library that listens, reviews, remixes, and re-prompts with no provider API at all."
  : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
