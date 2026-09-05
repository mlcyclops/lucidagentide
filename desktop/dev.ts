// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/dev.ts
//
// Dev/preview server for the desktop renderer. Serves the static renderer,
// bundles renderer/app.ts → /app.js on the fly (Bun.build, browser target), and
// exposes the same live /api/security + /api/memory used by the web dashboard.
// Electron loads this exact renderer; this server makes it runnable + screenshot-
// able in a plain browser (the bridge falls back to simulated chat there).
//
//   bun run desktop:web        # http://localhost:5319

import { join, dirname, basename } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { buildEngineeringUpdate, renderEngineeringBrief, buildPodcastScript, renderScript, type PodcastBackend, type BriefRole } from "../harness/brief/engineering_update.ts";
import { buildComplianceRows, renderPoamCsv, renderCkl } from "../harness/brief/compliance.ts"; // P-REPORT.6/.8: POA&M + CKL
import { renderTurnEvalReport, evalMetricsForTurn, type ObservedTool, type ObservedTurn } from "../harness/brief/eval_report.ts"; // P-CHAT.C (ADR-0190): settled-turn Model-Evaluation report
import { recordEvalMetrics, EVAL_METRICS_LOG_PATH } from "./eval_metrics_log.ts"; // P-EVAL.3 (ADR-0187): persist per-run eval metrics
import { LATENCY_LOG_PATH } from "./latency_log.ts"; // P-EVAL.2: the latency JSONL ledger
import { ingestEvalMetrics, readEvalMetricsRows } from "../harness/memory/eval_metrics_ingest.ts"; // P-EVAL.3 Part B: cross-run rollup
import { ingestLatency, readLatencyCalls } from "../harness/memory/latency_ingest.ts"; // P-EVAL.2: persisted latency
import { renderEvalMetricsRollupMarkdown } from "../harness/brief/eval_metrics_report.ts"; // P-EVAL.3 Part B
import { rollupLatency, renderLatencyRollupMarkdown } from "../harness/brief/evals.ts"; // P-EVAL.1 latency rollup
import { mkdtempSync, rmSync } from "node:fs"; // P-EVAL.3 Part B: throwaway rollup DB
import { appendFileSync, copyFileSync } from "node:fs"; // CREATOR-0 (ADR-0281): the append-only track ledger
import { execFileSync } from "node:child_process"; // CREATOR-0 (ADR-0283): the fixed-argv GPU query
import { tmpdir, totalmem, cpus, freemem } from "node:os";
import { buildChangeGraph, buildSchemaChanges, renderAnnexes } from "../harness/brief/change_graph.ts"; // P-REPORT.8: report annexes
import { renderRepoActivityAnnex } from "../harness/brief/repo_activity.ts"; // P-REPORT.9: cross-repo activity annex
import { addReportRepo, collectRepoActivity, ghAvailable, listReportRepos, type RepoSelection } from "./repo_collect.ts"; // P-REPORT.9 (ADR-0162)
import { loadChatBg, saveChatBg, type ChatBg } from "./chat_bg.ts"; // P-APPEAR.1: personalized chat background
import { ingestCodeGraph, loadCodeGraph } from "./code_graph.ts"; // P-KG-CODE.1: workspace code graph
import { ingestSymbolGraph, loadSymbolGraph } from "./symbol_graph.ts"; // P-KG-SYM.1: AST symbol graph
import { assessSystem, sampleSystem, topProcesses, type ProcGroup, type ProfileIo, type SystemSnapshot, type SystemVerdict } from "./system_profile.ts"; // P-SYSRES.1: resource guard
import { flavorInfo, buildInfoView, normalizeUiMode, resolveBuildFlavor, type UiMode } from "./build_flavor.ts"; // CREATOR-0 (ADR-0279)
import { APP_VERSION } from "./version.ts"; // CREATOR-0: /api/build-info reports the single-sourced version
import {
  CREATOR_PRESSURE_PCT, CREATOR_SUSTAIN_MS, CREATOR_WARM_PCT, creatorAdmission, freshnessOf, gpuFromDcgm,
  pushCreatorSample, sampleCreatorCpu, sampleLocalGpu, sampleOf, telemetryFromAgentJson, validateRemoteTarget,
  type CreatorResourcesData, type CreatorSample, type TargetTelemetry,
} from "./creator_monitor.ts"; // CREATOR-0 (ADR-0283): normalized CPU/GPU telemetry + job admission
import { CREATOR_PROVIDER_IDS, creatorRegistryStatus, type CreatorCapabilityId, type CreatorEndpointDef, type CreatorProviderId, type CreatorProviderStatus } from "./creator_registry.ts"; // CREATOR-0 (ADR-0282)
import { addTrack, foldLibrary, libraryLedger, libraryStats, removeTrack, trackAudio, updateTrack, type CreatorTrack, type LibraryIo, type LibraryStats, type TrackOrigin } from "./creator_library.ts"; // CREATOR-0 (ADR-0281)
import {
  ComfyClient, applyWorkflowTemplate, artifactDir, artifactLedger, buildGif, buildSpriteSheet, decodePngDataUrl,
  decodeWireFrames, foldArtifacts, storeArtifact, type ArtifactIo, type ArtifactKind, type CompositionInput,
  type CreatorArtifact,
} from "./creator_image.ts"; // CREATOR-IMG (ADR-0291): generation, mixing, sheets, GIFs, memes
import { decodeTimelineDoc, openEditor, saveEdit, type EditorIo } from "./creator_editor.ts"; // CREATOR-2 (ADR-0286): the follow-along audio editor
import { decodeMixGraph, mixerTracks, renderAndSaveMix } from "./creator_mixer.ts"; // CREATOR-5 (ADR-0289): the mixer
import { openComfyProgress, runRenderPipeline, type PipelineDeps, type ScanVerdict } from "./creator_pipeline.ts"; // CREATOR-3 (ADR-0287): the video/3D pipeline + its /ws telemetry
import { blenderJobNeed, runBlenderRender, type SpawnLike } from "./creator_blender.ts"; // CREATOR-3: Blender background renders
import { manifestCapabilities, parseModelManifest, reconcileManifest } from "../harness/creator/model_manifest.ts"; // CREATOR-3: declared models, reconciled against the probe
import type { MediaKind } from "../harness/creator/comfy_stream.ts"; // CREATOR-3: the closed media kinds
import { scanAndDecide } from "../harness/security/gate.ts"; // CREATOR-3: the fail-closed gate every artifact's metadata passes
import { ProbeCache, probeProvider, type ProbeDeps, type ProbeResult } from "./creator_probe.ts"; // CREATOR-1 (ADR-0292): capability probes
import {
  createJob, finishJob, jobStats, listJobs, recordJobArtifact, requestJobCancel, startJob,
  type CreatorJobKind, type JobAdmissionSnapshot, type JobIo,
} from "./creator_jobs.ts"; // CREATOR-1 (ADR-0292): the durable job ledger
import { saveSpecFile, loadSpecFile, listSpecFiles, deleteSpecFile, saveSpecTrust, loadSpecTrust, listSpecHistory, loadSpecRevision } from "../harness/agent/file_store.ts"; // P-AGENT.2b/.9/.17: spec persistence + trust sidecar + revisions
import { validateSpec } from "../harness/agent/spec.ts"; // P-AGENT.1: fail-closed Agent Spec validation
import { buildAgent } from "../harness/agent/compiler.ts"; // P-AGENT.3: spec -> AgentBundle
import { exportBundle, writeExportPackage, EXPORT_TARGETS, type ExportTarget } from "../harness/agent/export.ts"; // P-AGENT.6: enterprise export
import { exportPortableAgent, parsePortableAgentJson, setupInstructions } from "../harness/agent/portable.ts"; // P-AGENT.9: shareable .lucid-agent JSON
import { specToN8n, n8nToSpec, isN8nWorkflowJson } from "../harness/agent/n8n.ts"; // P-AGENT.10: n8n interop
import { connectorStatus, runConnector } from "./addon_seam.ts"; // P-AGENT.10: enterprise add-on seam
import { importSpec } from "../harness/agent/import_gate.ts"; // P-AGENT.5/.9: fail-closed imported spec scan + trust label
import { ScannerClient } from "../harness/security/scanner_client.ts";
import { startAgentRun, approveAgentRun } from "./agent_run.ts"; // P-AGENT.4-live/.11a: gated runs + enforced approval halts
import { listTraces, loadTrace } from "../harness/agent/trace.ts"; // P-AGENT.13: run traces
import { probeEnabledServers } from "./mcp_probe.ts"; // P-AGENT.12: MCP tool discovery for the Builder catalog
import { archiveBrief, deleteBrief, listBriefs, readBrief, restoreBrief, saveBrief } from "./report_store.ts";
import { OpenAiCompatibleTtsBackend } from "../harness/brief/tts_backend.ts";
import { ElevenLabsTtsBackend, ElevenLabsSttBackend, elevenLabsSpeak, listElevenVoices } from "../harness/voice/elevenlabs.ts";
import { TTS_PROVIDERS, normalizeTtsProvider, resolveVoice, ttsEngineStatus, voicesForProvider, type TtsProviderInfo } from "../harness/voice/catalog.ts"; // P-VOICE.2 (ADR-0247)
import { OpenAiCompatibleSttBackend, WhisperCppSttBackend, sttTransportFailed } from "../harness/voice/transcription.ts";
import { installWhisper, removeWhisperModel, shouldAutostartWhisper, startWhisper, stopWhisper, whisperStatus as whisperRuntimeStatus, type WhisperRuntimeDeps } from "./whisper_runtime.ts"; // P-STT.2b: managed offline Whisper
import { downloadWhisperModel, resolveWhisperBin } from "./whisper_manager.ts";
import { whisperServeUrl, type WhisperTier } from "./whisper_install.ts";
import { devSnapshot, securitySnapshot } from "../tools/web/data.ts";
import { sandboxStatus } from "./sandbox_status.ts"; // P-SANDBOX.5 (ADR-0169)
import { ensureNetdiagWatch, startNetdiagWatch, stopNetdiagWatch, netdiagView } from "./netdiag.ts";
import { clearAllOauthCredentials, clearDisabledCredential, credentialSnapshot, disconnectCredential, landedFreshCredential } from "./auth_vault.ts";
import { approveBlock, dismissBlock, liveBlocks } from "./security_log.ts";
import { ackArtifact, ackFindings, ackView } from "./security_ack.ts"; // P-SECACK.1 (ADR-0170)
import { deleteSteps, readTurnSteps, syncStepTurns } from "./session_steps.ts"; // P-RESUME.1 (ADR-0171)
import { probeRateLimits } from "./ratelimit_probe.ts";
import { OBS_DB_PATH, codeActivity, memorySnapshot, rateLimits, sessionPathById, usageLedger } from "../tools/memory_data.ts";
import { backend, fleetLaneArgv, interjectChildEnv } from "./acp_backend.ts";
import { FleetLaneManager } from "./fleet_lanes.ts"; // P-FLEET.L1: local lanes + the fleet grid
import { addInterject, drainInterjects, pendingInterjectCount } from "./interject_store.ts"; // P-INTERJECT.1 + P-PWA-FLEET.1: mid-turn operator notes
import { browserProcesses, setBrowserProcessSource, type ProcessView } from "./process_view.ts"; // P-INTERJECT.1: the /api/processes shape + wave-2 browser seam
import { completeBrowserCommand, drainBrowserCommands, enqueueBrowserCommand, failAllBrowserCommands, getBrowserStatus, lastBrowserActivityAt, latestBrowserShot, setBrowserStatus, setLatestBrowserShot, waitBrowserResult } from "./browser_control.ts"; // P-BROWSER.1 (wave 2): agent-browser mailbox + status
import { parseKeyCombo } from "./browser_keys.ts"; // P-BROWSER.2: shared combo parse, so a typo fails fast at the route
import { appendLaneLedger, listTimeline } from "./timeline.ts"; // P-FLEET.L5: lane-session ledger + the reviewable timeline
import { clearIngestSessions, deleteSession, listSessions, sessionMessages } from "./sessions.ts";
import { providerAuth } from "./auth_status.ts";
import { cloneRepo, removeRecentWorkspace, setWorkspace, workspaceInfo } from "./workspace.ts";
import { egressAllowAllManaged, egressDecision, egressPosture } from "./egress_policy.ts"; // P-PREVIEW.3b + P-NETWL.5
import { loadWhitelist, removeEntry, saveWhitelist, setPosture, upsertEntry, type WhitelistEntry } from "./network_whitelist.ts"; // P-NETWL.2/.5: whitelist CRUD + posture
import { readPreviewFile, toFsPath } from "./preview_file.ts";
import { getState as trainerState, submitAnswer as trainerAnswer, getGames as trainerGames, setRole as trainerSetRole, useDemoPack as trainerUseDemoPack } from "./trainer_session.ts"; // P-TRAINER.7/.8 (ADR-0255) // P-PREVIEW.4: read a local file's content for the preview
import { PREVIEW_FRAME_CSP } from "./preview_resolve.ts"; // P-PREVIEW.4b: per-frame CSP for the served preview doc
import { parseImageDataUrl } from "./renderer/image_data_url.ts"; // P-IMG.1 (ADR-0208): strict image gate
import { previewImageHtml } from "./renderer/chat_images.ts"; // P-IMG.1 (ADR-0208): image → preview wrapper
// P-PREVIEW.4c: fold a multi-file app's relative assets inline.
// P-PREVIEW.12: findBlockedRefs / blockedRefsMessage / injectBlockedRefsBanner make the frame CSP's
// refusal of REMOTE refs legible to both the user (an in-frame banner) and the agent (the tool result),
// instead of a silently blank page. previewTextDocument renders the non-markup kinds (markdown, json,
// csv, txt, log, ...) as a readable document so a model can finally show a report it just wrote.
import { blockedRefsMessage, findBlockedRefs, injectBlockedRefsBanner, inlinePreviewAssets, previewTextDocument } from "./preview_inline.ts";
import { injectPreviewBridge } from "./preview_bridge.ts"; // P-PREVIEW.6b (ADR-0153): read-only DOM-inspect bridge
import { InspectRelay } from "./preview_inspect_relay.ts"; // P-PREVIEW.6b: agent preview_inspect ↔ renderer relay
import { parseFigmaFileKey, collectTopFrames, figmaBoardHtml, FIGMA_API, type BoardFrame } from "./figma_client.ts"; // P-FIGMA.1 (ADR-0154)
import { designDocPath, DESIGN_DOC_NAME } from "./design_doc.ts"; // P-FIGMA.2 / P-DESIGN.1 (ADR-0154)
import { engineDesktopDir } from "./engine_launch.ts"; // P-WINBOOT.2 (ADR-0260): compiled-engine base-dir resolution
import { listLocalProviders, upsertLocalProvider, removeLocalProvider, setLocalProviderEnabled } from "./settings_store.ts";
import { providerModelsUrl, type LocalProviderDef } from "./local_providers.ts";
import { listRemoteAgents, upsertRemoteAgent, removeRemoteAgent, setRemoteAgentEnabled } from "../harness/mcp/registry.ts";
import { applyEnv, attribution, chinaModelsAcknowledged, chosenModel, govconCui, govconCuiChosen, listMcpServers, load as loadSettings, removeMcpServer, roleChosen, save as saveSettings, setAsksage, setChosenModel, setAttributionSkip, setChinaModelsAcknowledged, setCodeGraphAgent, setDeveloperMode, setGovconCui, setKey, setMcpServerEnabled, setPersonalAiExtract, setProfile, setRateLimitProbe, setThemeId, setThirdPartyProvidersAcknowledged, setTourSeen, setUserRole, setVoiceSettings, themeId, thirdPartyProvidersAcknowledged, tourSeen, upsertMcpServer, USER_ROLES, userRole, voiceSettings, type UserRole } from "./settings_store.ts";
// CREATOR-0: Creator endpoint + remote-target declarations, and the personalization root the build-info
// route reports (both flavors resolve it through the same seam).
import { listCreatorEndpoints, listCreatorTargets, personalBaseDir, removeCreatorEndpoint, removeCreatorTarget, upsertCreatorEndpoint, upsertCreatorTarget, type CreatorRemoteTargetDef } from "./settings_store.ts";

// ADR-0088/0089: the /api/settings payload — profile + attribution + the cosmetic role/tour state.
// `role` is null until the user has EXPLICITLY chosen one (so the renderer can fire the first-run role
// picker); once chosen it's the concrete role. tourSeen guards the first-run walkthrough replay.
// P-THEME.1: `theme` rides here too - it is the same class of state (cosmetic, policy-free, per-user).
// "" means never chosen, which the renderer folds to the OS light/dark preference.
function settingsData() {
  const s = loadSettings();
  return { username: s.username ?? "", email: s.email ?? "", attribution: attribution(), role: roleChosen() ? userRole() : null, tourSeen: tourSeen(), govconCui: govconCuiChosen() ? govconCui() : null, theme: themeId() };
}

// P-STT.2b: the real WhisperRuntimeDeps for the managed offline-Whisper lifecycle - os specs, the model dir,
// the streamed downloader + integrity gate, spawn/health, and STT wiring. The single running server handle
// lives in whisper_runtime.ts. Bundling the whisper-server binary in the installer is the remaining packaging
// step; until then it resolves LUCID_WHISPER_BIN / a binary on PATH.
// P-REMOTE.12: ONE transcription path for the local mic (/api/transcribe) AND remote-guest voice clips.
// Provider from settings: elevenlabs (cloud Scribe) or offline whisper. whisper.cpp serves /inference
// (verified live); faster-whisper / any OpenAI-compatible server serves /v1/audio/transcriptions - try
// the whisper.cpp shape first, then the OpenAI shape ONLY on a real transport failure (never on silence,
// which would mislabel a healthy server - see sttTransportFailed).
async function transcribeClip(audio: Uint8Array, mimeType?: string, language?: string): Promise<{ text: string; note: string }> {
  const v = voiceSettings();
  const topts = { mimeType, language };
  if (v.sttProvider === "elevenlabs") {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return { text: "", note: "Add your ElevenLabs API key (Settings \u2192 Voice), or switch STT to offline Whisper." };
    const er = await new ElevenLabsSttBackend({ apiKey: key }).transcribe(audio, topts);
    return { text: er.text, note: er.note ?? "" };
  }
  let r = await new WhisperCppSttBackend({ baseUrl: v.sttUrl }).transcribe(audio, topts);
  if (sttTransportFailed(r)) r = await new OpenAiCompatibleSttBackend({ baseUrl: v.sttUrl, apiKey: process.env.OPENAI_API_KEY, model: process.env.LUCID_STT_MODEL || "whisper-1" }).transcribe(audio, topts);
  return { text: r.text, note: r.note ?? "" };
}

function whisperModelDir(): string { return join(homedir(), ".omp", "whisper"); }
function whisperDeps(): WhisperRuntimeDeps {
  const dir = whisperModelDir();
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return {
    specs: () => ({ arch: process.arch, platform: process.platform, totalRamGB: totalmem() / 1e9, cpuCores: cpus().length, accel: process.platform === "darwin" ? "metal" : "cpu" }),
    modelDir: dir,
    listModels: () => { try { return readdirSync(dir); } catch { return []; } },
    resolveBin: () => resolveWhisperBin({ env: process.env, exists: existsSync, which: (n) => Bun.which(n), resourcesPath: process.env.LUCID_RESOURCES, platform: process.platform }),
    download: (model, dest, onProgress) => downloadWhisperModel(model, dest, {
      fetch: globalThis.fetch,
      writeStream: async (path, body, onBytes) => { const w = Bun.file(path).writer(); const rd = body.getReader(); let tot = 0; for (;;) { const { done, value } = await rd.read(); if (done) break; if (value) { w.write(value); tot += value.length; onBytes(value.length); } } await w.end(); return tot; },
      readHead: async (path, n) => new Uint8Array(await Bun.file(path).slice(0, n).arrayBuffer()),
      rename: async (a, b) => renameSync(a, b),
      remove: async (path) => { try { rmSync(path); } catch { /* best-effort */ } },
    }, onProgress),
    // P-STT.2c: the bundled server loads its whisper/ggml libs from its OWN directory. macOS gets an
    // @loader_path rpath at staging and Windows searches the exe's dir automatically; Linux ELF only does
    // that if the build set $ORIGIN, so prepend the binary's dir to LD_LIBRARY_PATH to make it certain.
    spawn: (bin, args) => {
      const libDir = dirname(bin);
      const env = process.platform === "linux"
        ? { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ? `${libDir}:${process.env.LD_LIBRARY_PATH}` : libDir }
        : process.env;
      const proc = Bun.spawn([bin, ...args], { stdout: "ignore", stderr: "ignore", env });
      return { pid: proc.pid ?? 0, kill: () => { try { proc.kill(); } catch { /* gone */ } } };
    },
    health: async (port) => { try { const res = await fetch(`${whisperServeUrl(port)}/`, { signal: AbortSignal.timeout(2000) }); return res.ok || res.status === 404; } catch { return false; } },
    setSttUrl: (url) => { setVoiceSettings({ sttProvider: "whisper", sttUrl: url }); },
    sleep: (ms) => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, ms); return promise; },
    // P-STT.6 (ADR-0267): deletion + on-disk size for the installed-models list in the Voice card.
    removeModel: (f) => { try { rmSync(join(dir, f)); return true; } catch { return false; } },
    modelSizeMB: (f) => { try { return statSync(join(dir, f)).size / (1024 * 1024); } catch { return null; } },
    // P-STT.5: kill whatever LISTENs on the managed port (an orphan whisper-server from a previous run).
    // whisper.cpp binds SO_REUSEPORT, so a duplicate would otherwise co-bind and silently split requests
    // across two model loads. Best-effort: the caller re-probes health and adopts any survivor.
    reapPort: async (port) => {
      try {
        if (process.platform === "win32") {
          const out = Bun.spawnSync(["netstat", "-ano", "-p", "TCP"]).stdout.toString();
          for (const line of out.split("\n")) {
            const m = /TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
            if (m && Number(m[1]) === port) Bun.spawnSync(["taskkill", "/PID", m[2]!, "/F"]);
          }
        } else {
          const out = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]).stdout.toString();
          for (const line of out.split("\n")) {
            const pid = Number(line.trim());
            if (pid > 0 && pid !== process.pid) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
          }
        }
      } catch { /* best-effort; the caller re-probes health */ }
    },
  };
}
import { authorizeRelayBind, collabServeAllowed, emailDomainAllowed, managedAsksageOnly, managedConfig, managedLocks, skipAllowed } from "./managed_config.ts";
import { startRelayServer, type RelayHandle } from "./collab/relay_server.ts"; // P-COLLAB.7 (ADR-0193): the optional embedded relay
import { localBindAddresses } from "./collab/net_addrs.ts"; // P-COLLAB.14 (ADR-0199): LAN/VPN bind options
import { asksageConfig, listDatasets, listPersonas, monthlyTokens, scanPersona, wrapPersona } from "./asksage.ts";
import { inspectSkill, listSkills, removeSkill, rescanSkill } from "./skills_data.ts"
import { intelNews } from "./intel_news.ts"; // P-TRIV.3 (ADR-0176): the executive Trivia Wire's news feed
import { seedTrivia } from "./trivia_seed.ts"; // P-TRIV.4 (ADR-0191): AI re-seed the Trivia Wire (scanned, tool-free)
import { detectElectronApp, electronLaunchPlan } from "./preview_electron.ts"; // P-PREVIEW.7 (ADR-0179)
import { listSubagentRuns } from "./subagent_activity.ts"; // P-TASK.5 (ADR-0180): live delegation-card activity
import { emitSecurityEvent } from "./audit_export.ts"; // P-PREVIEW.7: audit the user-initiated external launch
import { spawn as spawnChild } from "node:child_process";
import { installRegistrySkill, type RegistrySkillArtifact } from "./skills_registry.ts"
import { CollabManager } from "./collab/manager.ts"; // P-COLLAB.3 (ADR-0192): the live-share host lifecycle
import { CollabSocket } from "./collab/relay_client.ts";
import { RelayTokenCache } from "./collab/relay_token_cache.ts"; // P-REMOTE.2c: renderer-pushed relay auth token
import { CollabGuest } from "./collab/guest.ts"; // P-COLLAB.10 (ADR-0196): watch a shared session read-only
import { parseShareLink } from "./collab/link.ts";
import { importRoomKey } from "./collab/crypto.ts";
import type { CollabOptions, SttSource } from "./collab/frames.ts"; // P-COLLAB.14 (ADR-0228): edit-guest model+folder picks; P-REMOTE.14: voice provenance
import { laneEventToChatEvent } from "./collab/lane_event_adapter.ts"; // P-PWA-FOCUS.1: lane engine event -> guest-facing ChatEvent (pure)
import { MAX_FAVS, offeredModels } from "./renderer/model_favorites.ts"; // P-REMOTE.11b (ADR-0238): favorites-filtered guest picker (pure, DOM-free)
import { accessCounts, buildShareAwareness, type ShareCounts } from "./collab/share_awareness.ts"; // P-PREVIEW-PWA.3 (ADR-0240): agent share-awareness preamble
import { recordCollabShareStarted, recordCollabShareStopped, recordCollabGuestJoined, recordCollabGuestLeft, recordCollabAudit } from "./collab/collab_audit.ts"; // P-COLLAB.18 (ADR-0204)
import { authorizeRelayConnect } from "./managed_config.ts";
import { collabRelayConfig, setCollabRelay, collabP2PConfig, setCollabP2P } from "./settings_store.ts";
import { asksageOnly, sessionMode, setSessionMode } from "./settings_store.ts"; // ADR-0219: per-session CUI/Search mode; ADR-0217: the AskSage lockdown flag
import { embeddingsConfig, setEmbeddingsConfig } from "./settings_store.ts"; // ADR-0221: BYO-embeddings config

// ADR-0221: the desktop's Embedder — an ApiEmbedder built from the stored config + the vault secret injected as
// LUCID_EMBEDDINGS_KEY by main, or null when semantic search is off/incomplete (retrieval stays lexical).
function desktopEmbedder() { return resolveApiEmbedder(embeddingsConfig() ?? undefined, process.env.LUCID_EMBEDDINGS_KEY); }

// ADR-0221: (re)build a KG's SEMANTIC vector index from its COMPILED PAGES — the canonical, always-available
// corpus (so incremental ingest AND the explicit "re-index" action stay consistent). Idempotent: clears the
// dataset then re-embeds every page via the scan-gated ingestText (a page that fails the re-scan is dropped,
// never embedded). Returns page/chunk counts. Callers pass a resolved embedder.
async function syncVectorIndex(kgId: string, kgName: string, embedder: Embedder): Promise<{ pages: number; stored: number }> {
  const vstore = await knowledgeVectorStore(kgId);
  const datasetId = await vectorDatasetFor(vstore, kgName || "Knowledge", embedder);
  await vstore.clearChunks(datasetId);
  const pages = await (await kbStore(kgId)).listPages();
  let stored = 0;
  for (const pg of pages) {
    const res = await ingestText({
      store: vstore, scanner: kbScanner(), embedder, datasetId,
      sourcePath: `page:${pg.slug}`, text: `${pg.title}\n\n${pg.body_md}`,
      onBlock: (blk) => recordBlock({ tool: "kb_embed", severity: "high", findings: String(blk.findings), reason: `KB embed blocked: ${blk.reason}` }),
    });
    stored += res.stored;
  }
  return { pages: pages.length, stored };
}
import { hostname as osHostname } from "node:os";
import { analyzeWork, codifyCandidate, gatherWorkDigest, type SkillCandidate, type StudioWindow } from "./skill_studio.ts"
import { buildSkillArtifact, PublishDispatcher, publishersFor } from "./skill_publish.ts";
import { kbScanner, kbStore, listKgs, activeKgId, createKg, renameKg, setActiveKg, knowledgeVectorStore, vectorDatasetFor } from "./kb_store.ts"
import { readKbSources } from "./kb_sources.ts"
import { ingestSourcesIntoKg } from "../harness/kb/batch_ingest.ts"
import { exportKgPack, importKgPack, installPackFromUrl } from "./kb_pack.ts"
import { startKbIngest, kbIngestJobStatus, cancelKbIngest } from "./kb_ingest_job.ts"
import { ingestDocument } from "../harness/kb/ingest.ts"
import { retrieveKnowledge, type RetrieveMode, type RetrieveArgs } from "../harness/kb/retrieve.ts"
import { ingestText } from "../harness/knowledge/ingest.ts" // ADR-0221: vector (semantic) ingest, scan-gated
import { resolveApiEmbedder } from "../harness/knowledge/embed_config.ts" // ADR-0221
import { probeEmbeddings } from "../harness/knowledge/api_embedder.ts" // ADR-0221: "Test endpoint" probe
import type { Embedder } from "../harness/knowledge/embedder.ts"
import { recordBlock } from "./security_log.ts"
import { importSkill } from "./skills_import.ts";
import { createUserCommand, deleteUserCommand, listUserCommands } from "./user_commands.ts"; // P-CMD.1
import { archiveGoalReport, deleteGoalReport, listResumableLoops, listGoalReports, readGoalReport, restoreGoalReport } from "./goal_memory.ts";
import { createAutomation, deleteAutomation, listAutomations, normalizeCadence, updateAutomation } from "./automations.ts";
import { currentWorkspace } from "./workspace.ts";
import { profileWorkspace, scaffoldAgentsFramework } from "./workspace_setup.ts"; // P-WSSETUP: .agents framework offer

// P-WSSETUP: remember that this workspace was already offered setup (agents-init or an explicit
// dismissal), keyed by the exact folder path. Bounded to the 50 most recently asked folders so
// the map can never grow without limit.
function markWorkspaceSetupAsked(path: string): void {
  const s = loadSettings();
  const m = { ...(s.workspaceSetupAsked ?? {}) };
  m[path] = Date.now();
  const keep = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 50);
  s.workspaceSetupAsked = Object.fromEntries(keep);
  saveSettings(s);
}
import { recordSkillActivated } from "./skills_log.ts";
import { recentTurns } from "./turns_log.ts";
import { headroomStatus, setHeadroomEnabled, startHeadroom } from "./headroom.ts";
import { addReportToKg, agentRecall, agentRetain, destroyCui, enablePersonal, estimateChatExport, exportCuiArchive, exportHistory, exportVault, forgetFact, importChatExport, lockCui, lockPersonal, migrateCuiIntoStore, personalGraph, personalStatus, relateEntities, setScope, setupCui, setupPersonal, unlockCui, unlockPersonal, unrelateEntities } from "./personal.ts";
import { EXPLAIN_SYSTEM, explainCommand, explainUserPrompt } from "./explain_command.ts";
import type { PersonalScope } from "../harness/personal/store.ts";
import { readEditorFile, saveEditorFile } from "./editor.ts";
import { cancelImport, importJobStatus, startImport } from "./import_job.ts";
import type { CompleteFn } from "../harness/personal/distiller.ts";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";
import { listDir } from "./fs_browse.ts";
import { pickFolderNative } from "./native_dialog.ts"; // P-FS.2 (ADR-0265): real OS folder dialog for the browser build
import { DIAL_TYPES, type LoopDial } from "./exec_policy.ts";
import { audit } from "./audit_export.ts";
import { isRiskTier, managedWorkspaceRoots } from "./managed_config.ts";
import { isAllowedRequest, reqShape, tokenValid } from "./origin_guard.ts";

/** Sanitize an untrusted /api/goal `dial` payload into a LoopDial — only known command types + valid
 *  risk tiers survive; everything else is dropped (the backend clamps it by the managed ceiling anyway). */
function parseLoopDial(raw: unknown): LoopDial | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: LoopDial = {};
  for (const t of DIAL_TYPES) {
    const v = (raw as Record<string, unknown>)[t];
    if (isRiskTier(v)) out[t] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
import { pathWithin } from "./path_guard.ts";
import { createHash, randomBytes } from "node:crypto";
import { buildRecall } from "../harness/memory/recall.ts";
import { Db } from "../harness/memory/db.ts";
import type { ImportVendor } from "../harness/personal/import_adapters.ts";
import type { CuiDesignation } from "../harness/export/vault_export.ts";

applyEnv(); // make stored API keys available to a spawned omp acp
if (loadSettings().headroomEnabled) startHeadroom(); // resume the opt-in compression proxy

// P-COLLAB.3 (ADR-0192): the one live-share host for this backend. Real deps: a CollabSocket over the
// authorized relay (self-hosted default; public opt-in), the current session's metadata for the welcome
// header, and the wall clock. resolveRelay() returns null when no relay is authorized → start() fails closed.
// P-COLLAB.7 (ADR-0193): the OPTIONAL embedded relay this device hosts ("be the relay" toggle). One per
// backend; off until the user turns it on. Every start is governance-gated (fail-closed): a managed
// allowServe:false or a bind outside the absolute allowlist is refused BEFORE any listener opens.
let collabRelay: RelayHandle | null = null;
const DEFAULT_RELAY_PORT = Number(process.env.LUCID_RELAY_PORT) > 0 ? Number(process.env.LUCID_RELAY_PORT) : 8790;

function relayServeStatus() {
  const mc = managedConfig().config;
  return {
    running: !!collabRelay,
    hostname: collabRelay?.hostname,
    port: collabRelay?.port,
    // The address a guest points at (only reachable per the bind: loopback = same machine / a tunnel).
    wsBase: collabRelay ? `ws://${collabRelay.hostname}:${collabRelay.port}` : undefined,
    rooms: collabRelay?.roomCount() ?? 0,
    // P-COLLAB.14: this machine's bindable addresses (loopback / LAN / VPN) for the toggle to offer, so a peer
    // on your network can reach the relay directly. Each is still bind-authorized fail-closed on serve.
    addresses: localBindAddresses(),
    // Governance the toggle must honor: locked ⇒ disable the control; allowServe:false ⇒ can't turn on.
    managed: { locked: managedLocks(mc).collab, allowServe: collabServeAllowed(mc), org: mc?.orgName ?? null },
  };
}

/** Start (or restart) the embedded relay on host:port, fail-closed against managed policy. */
function serveRelay(host: string, port: number): { ok: boolean; error?: string } {
  const mc = managedConfig().config;
  if (!collabServeAllowed(mc)) return { ok: false, error: `hosting a relay is disabled by ${mc?.orgName ?? "your organization"}` };
  const authz = authorizeRelayBind(host, port, mc);
  if (!authz.ok) return { ok: false, error: authz.reason };
  try { collabRelay?.stop(); } catch { /* already gone */ }
  try {
    collabRelay = startRelayServer({ port, hostname: host, authorizeBind: (h, p) => authorizeRelayBind(h, p, mc) });
    return { ok: true };
  } catch (e) { collabRelay = null; return { ok: false, error: clientError(e, "could not start the relay server") }; }
}

function stopRelay(): void { try { collabRelay?.stop(); } catch { /* already gone */ } collabRelay = null; }
// Best-effort: never leave the inbound listener open past the process (the OS reclaims the port anyway).
process.on("exit", () => { try { collabRelay?.stop(); } catch { /* already gone */ } });
// P-STT.5: never orphan the managed whisper-server. Electron stops this child with SIGTERM (main.ts
// dev?.kill()), and a DEFAULT SIGTERM terminates without running "exit" handlers - which is exactly how
// two whisper-server pids ended up co-bound to port 9111 (SO_REUSEPORT). Handle the signals explicitly:
// kill the child (stopWhisper's proc.kill() is synchronous), then re-exit, which also fires "exit" above.
process.on("exit", () => { void stopWhisper(); });
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => { void stopWhisper(); process.exit(0); });
}
// P-STT.6: in the INSTALLED app (main.ts threads LUCID_RESOURCES only when app.isPackaged, and that build
// bundles whisper-server), autostart the managed offline Whisper so dictation works out of the box - no
// trip to Settings. The gate (shouldAutostartWhisper, unit-tested) skips dev runs, non-whisper STT, a
// user-pointed REMOTE sttUrl, incapable hardware, and an already-running/adopted server. First launch
// downloads the default tiny model (~78MB); fire-and-forget so the HTTP server never waits on it.
if (process.env.LUCID_RESOURCES) {
  void (async () => {
    try {
      const d = whisperDeps();
      const v = voiceSettings();
      if (!shouldAutostartWhisper(whisperRuntimeStatus(d), v, true)) return;
      const r = await startWhisper(d, {});
      console.log(r.ok ? `[whisper] autostarted${r.tier ? ` (${r.tier})` : " (adopted a running server)"}` : `[whisper] autostart did not run: ${r.reason}`);
    } catch (e) { console.warn("[whisper] autostart failed:", e); }
  })();
}

/** The relay a new share will use: THIS device's embedded relay when running (no third party), else the
 *  configured external relay (self-hosted default / public opt-in), else null (start fails closed). */
function effectiveRelay(): { wsBase: string; httpBase: string; label: string; source: string; pwaBase?: string; gated?: boolean } | null {
  // P-REMOTE.2b (ADR-0226/0227): a PROVISIONED hosted build sets LUCID_REMOTE_PWA_BASE (MAIN -> dev-child env,
  // the same channel as the other provisioned config) to the phone PWA origin (e.g.
  // https://lucid-agent.web.app/remote). When set, invite BROWSER links point at the PWA so a phone can open
  // them. Unset (the OSS default: embedded / self-hosted / public relay) -> legacy relay-host browser links.
  const envPwaBase = process.env.LUCID_REMOTE_PWA_BASE?.trim() || undefined;
  const gatedEnv = process.env.LUCID_RELAY_GATED?.trim();
  if (collabRelay) {
    const origin = `${collabRelay.hostname}:${collabRelay.port}`;
    return { wsBase: `ws://${origin}`, httpBase: `http://${origin}`, label: "this device (embedded relay)", source: "embedded", pwaBase: envPwaBase, gated: false };
  }
  const r = collabRelayConfig();
  if (!r) return null;
  // P-REMOTE.2b/.2c: the first-party HOSTED rendezvous (Cloud Run behind the LB) runs RELAY_AUTH=firebase and
  // pairs with the hosted phone PWA. Recognize it BY HOST so ANY install pointed at it (a) AUTHENTICATES
  // (gated -> the host presents a token, else the gated relay silently drops it and no room is created) and
  // (b) mints PHONE-openable PWA invite links that CARRY the write token for EDIT shares (the relay-host
  // fallback link is view-only, which is why an edit share showed the phone as view). All WITHOUT a
  // per-machine LUCID_RELAY_GATED / LUCID_REMOTE_PWA_BASE env var (that dance was lost on every restart).
  const hosted = /^wss?:\/\/relay\.aiworkshopapps\.com(?:[:/]|$)/i.test(r.wsBase);
  const pwaBase = envPwaBase ?? (hosted ? "https://lucid-agent.web.app/remote" : undefined);
  const gated = gatedEnv ? (gatedEnv === "1" || gatedEnv.toLowerCase() === "true") : (!!pwaBase || hosted);
  return { wsBase: r.wsBase, httpBase: r.httpBase, label: r.label, source: r.source, pwaBase, gated };
}

// P-COLLAB.10 (ADR-0196): the one shared session this backend is WATCHING as a guest (Phase 1: one at a time).
let collabGuest: { guest: CollabGuest; sock: CollabSocket } | null = null;
function collabDisplayName(): string { const s = loadSettings(); return (s.username ?? "").trim() || osHostname(); }
function leaveCollabGuest(): void { try { collabGuest?.guest.leave("you left the session"); } catch { /* already gone */ } collabGuest = null; }

// P-COLLAB.13 (ADR-0198): an EDIT guest's prompt/abort lands here; the HOST renderer polls this inbox and
// runs it through its OWN composer (so omp's scan gate + exec/egress approvals fire, and the turn taps back to
// collab). Consume-on-read. The prompt text is a remote guest's input - clamp its length defensively.
let pendingGuestPrompt: { text: string; from: string; images?: string[]; sttSource?: SttSource } | null = null;
let guestAbortRequested = false;
// P-COLLAB.14 (ADR-0228): a connected EDIT guest's model / already-used-folder pick, consumed-on-read by the
// host renderer's guest-inbox poll and applied through its OWN picker path (applyConfig / applyWorkspace).
let pendingGuestModel: { value: string; from: string } | null = null;
let pendingGuestWorkspace: { path: string; from: string } | null = null;
// OPAQUE id -> absolute workspace path, host-LOCAL only: a guest picks by id and never sends (or learns) a
// filesystem path. Rebuilt on every buildCollabOptions() (share start + refreshOptions).
let collabWsById: Record<string, string> = {};

// P-REMOTE.14: the SHORT provenance marker appended to a guest turn's author label. `from` is the ONE string
// that survives the whole staging path (this inbox -> the host renderer -> POST /api/chat -> tapUserTurn ->
// UserTurnFrame.from), so putting the marker there shows the provenance in the shared transcript AND the
// audited turn with NO protocol change and no UserTurnFrame consumer touched. `sttSource` also rides the
// inbox record as an adjacent field, for any consumer that wants the raw value instead of the label.
// Only the NOTABLE cases are marked. "host" is the default and safe path (the desktop's own offline
// whisper), so labelling it would put "(voice: desktop)" on every hold-to-talk turn and make the author
// column noise; absence of a marker already means "transcribed here".
const STT_MARKER: Record<SttSource, string> = {
  "device-local": " (voice: on-device)",
  "device-cloud": " (voice: vendor cloud)",
  host: "",
};
/** Build a staged guest turn's author label, keeping the whole string inside the 48-char clamp /api/chat
 *  applies to `from` - so the marker is never the part that gets truncated away. */
function guestTurnLabel(name: string, src?: SttSource): string {
  const marker = src ? STT_MARKER[src] : "";
  if (!marker) return name;
  return `${name.slice(0, Math.max(1, 48 - marker.length))}${marker}`;
}

/** P-COLLAB.14: a stable, path-revealing-nothing id for a workspace (short SHA-256 of the absolute path). */
function collabWorkspaceId(path: string): string { return createHash("sha256").update(path).digest("base64url").slice(0, 16); }

/** P-COLLAB.14: the model + already-used-folder allowlists offered to EDIT guests. Models come from omp's
 *  live `model` config option (value+name only); folders from the workspace history (current + recent), each
 *  keyed by an OPAQUE id the host resolves back to a path. Metadata only - never a credential or a path. */
// P-REMOTE.11b (ADR-0238): the host renderer's favorite model values, pushed with /api/collab/start (favorites
// live in renderer localStorage - this backend cannot read them). Guests are offered just these + the current.
let collabFavModels: string[] = [];

function buildCollabOptions(): CollabOptions {
  // backend.configOptions is omp's `any[]` config catalog (same access style as acp_backend.accessibleModels).
  const opt = backend.configOptions.find((c: { id?: string }) => c?.id === "model");
  const rawModels: { value?: unknown; name?: unknown }[] = Array.isArray(opt?.options) ? opt.options : [];
  const all = rawModels
    .map((o) => ({ value: String(o?.value ?? ""), name: String(o?.name ?? o?.value ?? "") }))
    .filter((m) => m.value);
  const activeModel = backend.activeModelName() || (loadSettings().lastModel ?? "");
  const models = offeredModels(all, collabFavModels, activeModel); // P-REMOTE.11b: favorites + current only
  const ws = workspaceInfo();
  const folders = [{ path: ws.current, name: ws.name, isGit: ws.isGit }, ...ws.recent];
  const byId: Record<string, string> = {};
  const workspaces = folders.map((f) => {
    const id = collabWorkspaceId(f.path);
    byId[id] = f.path;
    return { id, name: f.name, isGit: f.isGit };
  });
  collabWsById = byId;
  return { models, activeModel, workspaces, activeWorkspaceId: collabWorkspaceId(ws.current) };
}

// P-REMOTE.2c (ADR-0226/0227): the renderer pushes a fresh Firebase ID token here (POST /api/collab/token);
// the host + watch-guest sockets read it via authToken. Empty until pushed -> anonymous connect (unchanged
// for non-gated relays; a gated relay refuses, never a silent unauthenticated session).
const relayTokenCache = new RelayTokenCache();

const collabManager = new CollabManager({
  resolveRelay: () => effectiveRelay(),
  sessionInfo: () => {
    const s = loadSettings();
    return {
      sessionId: backend.currentSessionId() ?? "local",
      title: "LUCID session",
      model: backend.activeModelName() || (s.lastModel ?? "model"),
      hostName: (s.username ?? "").trim() || osHostname(),
    };
  },
  // P-REMOTE.2c: present the renderer-pushed Firebase ID token ONLY when the relay is GATED (RELAY_AUTH). For
  // an anonymous relay (embedded / self-hosted / public - the default), authToken stays UNSET so the socket
  // connects anonymously exactly as before (a token frame to an un-gated relay would hang on a missing
  // auth-ok). Gated + empty cache -> null -> the relay refuses, never a silent unauthenticated session.
  makeTransport: ({ wsUrl, key }) => new CollabSocket({
    wsUrl, role: "host", key,
    ...(effectiveRelay()?.gated ? { authToken: () => relayTokenCache.get() } : {}),
  }),
  now: () => Date.now(),
  onGuestPrompt: (text, guest, images, audio, sttSource) => {
    // P-REMOTE.14: `src` is the provenance recorded WITH the turn: the guest's validated claim, or "host"
    // once the desktop's own offline transcription actually produced text (whatever the phone claimed).
    const stage = (finalText: string, src?: SttSource): void => {
      if (!finalText.trim() && !(Array.isArray(images) && images.length)) return;
      pendingGuestPrompt = { text: finalText.slice(0, 20_000), from: guestTurnLabel(guest.name, src), ...(Array.isArray(images) && images.length ? { images: images.slice(0, 6).map(String) } : {}), ...(src ? { sttSource: src } : {}) };
    };
    if (!audio) { stage(String(text), sttSource); return; }
    // P-REMOTE.12: a push-to-talk clip (already host-validated in CollabHost). Transcribe on the SAME
    // path as the local mic, fold the transcript into the guest text, and stage it like any typed
    // prompt - the fail-closed scan gate sees it identically. Fire-and-forget: a slow STT must never
    // block the relay pump; a silent/failed clip stages nothing (the guest keeps their local echo).
    void (async () => {
      try {
        const bytes = new Uint8Array(Buffer.from(audio.b64, "base64"));
        const r = await transcribeClip(bytes, audio.mime);
        stage([String(text).trim(), r.text.trim()].filter(Boolean).join(" "), r.text.trim() ? "host" : sttSource);
      } catch { stage(String(text), sttSource); }
    })();
  },
  onGuestAbort: () => { guestAbortRequested = true; },
  // P-REMOTE.14: the CUI + lockdown stance a phone needs to decide whether IT may transcribe (and the host's
  // fail-closed backstop against cloud-transcribed text). Read FRESH on every call, never cached, so flipping
  // a session's mode or the AskSage lock lands on the very next state push. `lockdown` mirrors
  // acp_backend's asksageLocked() (the user's lock OR the org-managed one); sessionMode() already defaults
  // an unknown session to "cui" fail-closed.
  posture: () => ({ cui: sessionMode(backend.currentSessionId() ?? "") === "cui", lockdown: asksageOnly() || managedAsksageOnly() }),
  // P-COLLAB.14 (ADR-0228): offer EDIT guests the model + already-used-folder allowlists, and honor their
  // picks. The host has already re-validated the value/id against the allowlist (fail-closed); here we just
  // stage it for the host renderer to apply through its OWN picker path (its UI + omp reconcile identically).
  collabOptions: buildCollabOptions,
  onGuestSetModel: (value, guest) => { pendingGuestModel = { value: String(value).slice(0, 200), from: guest.name }; },
  onGuestSetWorkspace: (id, guest) => { const path = collabWsById[String(id)]; if (path) pendingGuestWorkspace = { path, from: guest.name }; },
  // P-PWA-FLEET.1: EDIT-guest fleet controls + mid-turn interjection. Edit rights + frame shapes were
  // re-validated in CollabHost (mirrors set-model); the lane manager re-validates the laneId itself
  // (an unknown lane is refused there, fail-closed). Guests follow progress via the fleet-status
  // broadcast below, so the prompt sink only watches for the busy refusal.
  onGuestFleetPrompt: (laneId, text) => {
    const clipped = String(text).slice(0, 20_000);
    // Queue-if-busy: run the turn NOW when the lane is idle; a mid-turn lane stages it on the existing
    // P-FLEET.L3 queue instead (drained FIFO when the lane goes idle), so the guest's prompt never drops.
    let busy = false;
    void fleet
      .prompt(laneId, clipped, (e) => { if (e.type === "error" && e.message.includes("busy")) busy = true; })
      .then(() => { if (busy) fleet.enqueue(laneId, clipped); })
      .catch(() => { /* non-fatal: the lane records its own error state */ });
  },
  onGuestFleetStop: (laneId) => { fleet.stop(laneId); },
  onGuestFleetAnswer: (laneId, allow, scope) => { fleet.answer(laneId, allow, scope); },
  // Target is "master" or a laneId; the store trims/caps the note (8 per target, 4000 chars). Delivery
  // to the omp child lands OUTSIDE untrusted-content delimiters, marked operator-origin (AGENTS.md #5).
  onGuestInterject: (target, text) => { addInterject(String(target).slice(0, 64), String(text)); },
  // P-PWA-FOCUS.1: catch-up for a guest that taps a lane - the host answers its `watch` with the lane's
  // conversation so far, so the phone opens a populated transcript instead of an empty pane awaiting the
  // next token. The lane manager already returns a COPY; the explicit per-turn map is the deliberate part.
  // LaneTurnRecord and CollabTranscriptTurn are structurally compatible TODAY, so passing the array
  // straight through would typecheck - and would silently ship any future ENGINE-only field (cwd, model,
  // internal ids) to a remote guest the moment someone widens LaneTurnRecord. Naming role+text here is
  // what stops that: a new engine field cannot ride along, it has to be added on purpose.
  laneTranscript: (laneId) => fleet.laneTranscript(laneId).map((t) => ({ role: t.role, text: t.text })),
  // P-COLLAB.18 (ADR-0204): host-authoritative audit — a guest joined/left the RELAY share. Metadata only.
  onParticipant: (kind, guest) => {
    const meta = { transport: "relay" as const, access: guest.access, roomId: collabManager.status().roomId, guest: guest.name };
    if (kind === "join") recordCollabGuestJoined(meta); else recordCollabGuestLeft(meta);
  },
});

// P-PWA-FLEET.1: the fleet-status + process-list broadcasters. While a share is ACTIVE, poll the lane
// manager every 5s, map lane views to the guest-safe shape (cwd -> BASENAME: the frames.ts "no file
// paths" invariant), and tap a ChatEvent into the share ONLY when the payload changed (hash diff - an
// unchanged fleet sends nothing). The participant count rides in the stamp so a newly joined guest gets
// a fresh snapshot on the next tick without waiting for a real lane change; an all-lanes-gone tick sends
// one final empty snapshot so the phone clears its FLEET section. The process list follows the same
// discipline, reusing the /api/processes builder DIRECTLY (never a loopback fetch).
let lastFleetStamp = "";
let lastFleetSent = "[]";
let lastProcStamp = "";
let lastProcSent = "[]";
setInterval(() => {
  if (!collabManager.active) { lastFleetStamp = ""; lastFleetSent = "[]"; lastProcStamp = ""; lastProcSent = "[]"; return; }
  void (async () => {
    const count = collabManager.status().participantCount;
    try {
      const lanes = (await fleet.status()).lanes.map((l) => ({
        id: l.id, name: l.name, status: l.status as string, cwd: basename(l.cwd), turns: l.turns,
        lastActivityAt: l.lastActivityAt,
        ...(l.pendingApproval ? { pendingApproval: { summary: l.pendingApproval.summary, kind: l.pendingApproval.kind } } : {}),
      }));
      const body = JSON.stringify(lanes);
      const stamp = `${body}#${count}`;
      if (stamp !== lastFleetStamp && (lanes.length > 0 || lastFleetSent !== "[]")) {
        collabManager.tapEvent({ type: "fleet-status", lanes });
        lastFleetSent = body;
      }
      lastFleetStamp = stamp;
    } catch { /* non-fatal: a failed poll never breaks the share */ }
    try {
      const processes = await buildProcessViews();
      const body = JSON.stringify(processes);
      const stamp = `${body}#${count}`;
      if (stamp !== lastProcStamp && (processes.length > 0 || lastProcSent !== "[]")) {
        collabManager.tapEvent({ type: "process-list", processes });
        lastProcSent = body;
      }
      lastProcStamp = stamp;
    } catch { /* non-fatal */ }
  })();
}, 5000);

// 30s memo for /api/code-activity — each rebuild spawns `git log` per workspace (ADR-0030 P-CODE.1).
let codeActivityCache: { at: number; data: ReturnType<typeof codeActivity> } | null = null;
// P-PERF.3: the dashboard poll hammers these obs-DB reads (~every 4s). Each can take SECONDS as the DB grows,
// and they run on the server's single event loop — so overlapping polls pile up and stall model streaming
// (the "replies slow coming back" symptom). Memoize with SINGLE-FLIGHT (concurrent polls share one in-flight
// query, never overlap) + a short TTL so rapid polls are cheap and the loop stays free for the model stream.
const SNAP_TTL_MS = 8000; // > the ~4s dashboard poll, so the steady poll is served from cache (the DuckDB read runs at most ~every 8s). Live gate blocks are merged FRESH from liveBlocks() at request time, so nothing urgent is delayed by this cache.
let secSnapMemo: { at: number; p: ReturnType<typeof securitySnapshot> } | null = null;
function securitySnapshotMemo(): ReturnType<typeof securitySnapshot> {
  const t = Date.now();
  if (!secSnapMemo || t - secSnapMemo.at > SNAP_TTL_MS) secSnapMemo = { at: t, p: securitySnapshot() };
  return secSnapMemo.p; // concurrent callers await the SAME query
}
let usageMemo: { at: number; data: ReturnType<typeof usageLedger> } | null = null;
function usageLedgerMemo(): ReturnType<typeof usageLedger> {
  const t = Date.now();
  if (!usageMemo || t - usageMemo.at > SNAP_TTL_MS) usageMemo = { at: t, data: usageLedger() };
  return usageMemo.data;
}
const memMemo = new Map<string, { at: number; p: ReturnType<typeof memorySnapshot> }>();
function memorySnapshotMemo(path: string | undefined): ReturnType<typeof memorySnapshot> {
  const key = path ?? "", t = Date.now();
  const hit = memMemo.get(key);
  if (hit && t - hit.at <= SNAP_TTL_MS) return hit.p;
  const p = memorySnapshot(path);
  memMemo.set(key, { at: t, p });
  if (memMemo.size > 8) for (const [k, v] of [...memMemo]) if (t - v.at > 10_000) memMemo.delete(k); // keep it tiny
  return p;
}

// 5s memo for /api/system — the process listing spawns one fixed-argv command (ADR-0182 P-SYSRES.1).
let sysResCache: { at: number; data: { snap: SystemSnapshot; verdict: SystemVerdict; procs: ProcGroup[] } } | null = null;

// ---- CREATOR-0: the Creator control-plane helpers (ADR-0281/0282/0283) ----
// Every route below is Creator-build gated; these helpers are plumbing over the pure cores
// (creator_monitor / creator_registry / creator_library) so the routes stay thin.

const PROFILE_IO: ProfileIo = {
  // node's CpuInfo.times is a fixed-key struct; ProfileIo takes an index signature so tests can inject
  // fixtures. Structurally identical, so the cast only bridges what inference cannot unify (same as
  // system_profile's own REAL_IO).
  cpus: () => cpus() as unknown as { model: string; speed: number; times: Record<string, number> }[],
  totalmem,
  freemem,
  sleep: (ms) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  },
};

/** The one GPU command, run with a FIXED argv and a hard timeout. Never a shell. */
const gpuExec = (argv: readonly string[]): string =>
  execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 });

const libraryIo: LibraryIo = {
  ensureDir: (dir) => { try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ } },
  readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } },
  appendLine: (path, line) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, line + "\n", { mode: 0o600 }); },
  copyIn: (src, dest) => { copyFileSync(src, dest); return statSync(dest).size; },
  readBase64: (path) => readFileSync(path).toString("base64"),
  removeFile: (path) => { try { rmSync(path, { force: true }); } catch { /* the ledger is the truth */ } },
  exists: (path) => existsSync(path),
  now: () => Date.now(),
  id: () => `trk_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`,
};

interface CreatorLibraryData { tracks: CreatorTrack[]; stats: LibraryStats }
function creatorLibraryData(): CreatorLibraryData {
  const tracks = foldLibrary(libraryIo.readText(libraryLedger(CREATOR_DIR)));
  return { tracks, stats: libraryStats(tracks) };
}

/** Env var per provider that HOLDS its secret at runtime. Settings never carry a secret VALUE. */
const CREATOR_SECRET_ENV: Record<string, string> = {
  elevenlabs: "ELEVENLABS_API_KEY",
  suno: "LUCID_SUNO_TOKEN",
  comfyui: "LUCID_COMFY_TOKEN",
};

interface CreatorRegistryData extends CreatorLibraryData {
  providers: CreatorProviderStatus[];
  /** CREATOR-1: the last probe per provider, so the UI can show what was proven and how fresh it is. */
  probes: ProbeResult[];
}
// CREATOR-1 (ADR-0292): the last probe per provider. In memory by design - a capability answer goes stale
// the moment a node is installed or a VPN drops, so it is never persisted as if it were fact.
const probeCache = new ProbeCache();

function creatorSecretFor(id: CreatorProviderId): string {
  const env = CREATOR_SECRET_ENV[id];
  if (env && (process.env[env] ?? "").trim()) return process.env[env]!.trim();
  const ref = listCreatorEndpoints().find((e) => e.enabled && e.providerId === id && !!e.vaultRef)?.vaultRef;
  if (!ref) return "";
  const name = `LUCID_CREATOR_TARGET_${ref.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
  return (process.env[name] ?? "").trim();
}

const probeDeps: ProbeDeps = {
  fetchImpl: fetch,
  exec: (argv) => execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 6000, windowsHide: true, maxBuffer: 512 * 1024 }),
  exists: (path) => existsSync(path),
  now: () => Date.now(),
  secret: creatorSecretFor,
  timeoutMs: 8000,
};

function creatorRegistryData(): CreatorRegistryData {
  const all = listCreatorEndpoints();
  const now = Date.now();
  const byProvider: Partial<Record<CreatorProviderId, { endpoints: CreatorEndpointDef[]; secretPresent: boolean; discovered?: readonly CreatorCapabilityId[] }>> = {};
  for (const id of CREATOR_PROVIDER_IDS) {
    const mine = all.filter((e) => e.providerId === id);
    const env = CREATOR_SECRET_ENV[id];
    // Honest "a credential is registered": either the engine env carries it, or the user stored one in the
    // vault and the declaration references it by NAME. Nothing here reads a secret value.
    const secretPresent = !!(env && (process.env[env] ?? "").trim()) || mine.some((e) => e.enabled && !!e.vaultRef);
    // CREATOR-1: `ready` now requires a LIVE probe that attested something. An expired answer is dropped.
    byProvider[id] = { endpoints: mine, secretPresent, discovered: probeCache.discovered(id, now) };
  }
  return { providers: creatorRegistryStatus(byProvider), probes: probeCache.all(), ...creatorLibraryData() };
}

// ---- CREATOR-1: jobs ----

const jobIo: JobIo = {
  ensureDir: (dir) => { try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ } },
  readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } },
  appendLine: (path, line) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, line + "\n", { mode: 0o600 }); },
  now: () => Date.now(),
  id: () => `job_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
};

const creatorJobsData = () => { const jobs = listJobs(jobIo, CREATOR_DIR); return { jobs, stats: jobStats(jobs) }; };

/** CREATOR-3: MEASURE ONLY, write no job. The pipeline routes own their own job row (they attach artifacts
 *  to it), so they take the governor's snapshot and record the job themselves. One measurement path, two
 *  callers: `admitCreatorJob` below is this plus a job. */
async function creatorAdmissionSnapshot(label: string, need: { gpu?: boolean; vramMB?: number } = {}): Promise<JobAdmissionSnapshot> {
  const res = await creatorResources(false);
  const local = res.targets.find((t) => t.kind === "local");
  const verdict = creatorAdmission(res.history, { label, ...need }, local?.gpu ?? { available: false, source: "none", devices: [], note: "" });
  return {
    ok: verdict.ok, cpuPct: verdict.cpuPct, memPct: verdict.memPct, gpuPct: verdict.gpuPct, vramPct: verdict.vramPct,
    gpuEvidenceMissing: verdict.gpuEvidenceMissing, reason: verdict.reason,
  };
}

/** CREATOR-3: the fail-closed seam the render pipeline scans artifact metadata through. Same sidecar, same
 *  law as every other import path: a dead or slow scanner returns a BLOCKING decision, never a pass. */
const creatorScan = (text: string): Promise<ScanVerdict> => scanAndDecide(agentScanner(), text);

/** CREATOR-3: Blender runs as a fixed argument VECTOR through `Bun.spawn`. There is no shell here, and that
 *  is load-bearing rather than incidental: `ARGV_UNSAFE_CHARS` in blender_cli.ts only refuses what cannot
 *  ride an argv slot (NUL, newlines, control characters) precisely because nothing re-parses these strings.
 *  Reintroduce a shell and that guard becomes too weak; creator_blender.test.ts fails if anyone tries. */
const blenderSpawn: SpawnLike = async (argv, opts) => {
  const proc = Bun.spawn([...argv], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* already exited */ } }, opts.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
};

/** Ask the governor, then record the answer as a job. A refusal becomes a `refused` job carrying the measured
 *  reason, so the user sees WHY nothing happened instead of a silent no-op. */
async function admitCreatorJob(kind: CreatorJobKind, label: string, provider: string, need: { gpu?: boolean; vramMB?: number } = {}):
  Promise<{ ok: boolean; jobId: string; reason: string }> {
  const snapshot = await creatorAdmissionSnapshot(label, need);
  const job = createJob(jobIo, CREATOR_DIR, { kind, label, provider, admission: snapshot });
  if (!snapshot.ok) return { ok: false, jobId: job.id, reason: snapshot.reason };
  startJob(jobIo, CREATOR_DIR, job.id, snapshot);
  return { ok: true, jobId: job.id, reason: "" };
}

// The pressure window lives in memory: it is presentation + admission evidence, never an audit log.
let creatorHistory: CreatorSample[] = [];
let creatorResCache: { at: number; data: CreatorResourcesData } | null = null;
let creatorProcsCache: { at: number; procs: ProcGroup[] } | null = null;

function errorTarget(t: { id: string; label: string }, at: number, reason: string): TargetTelemetry {
  return {
    id: t.id, label: t.label, kind: "remote", sampledAt: at, ageMs: 0, freshness: "blind",
    cpu: null, mem: null, gpu: { available: false, source: "none", devices: [], note: reason }, procs: [], error: reason,
  };
}

/** Read one remote target. A token rides an Authorization HEADER (never the URL) and never reaches an
 *  error string. Any failure is an honest blind target, not a fabricated reading. */
async function remoteTargetTelemetry(t: CreatorRemoteTargetDef): Promise<TargetTelemetry> {
  const at = Date.now();
  const headers: Record<string, string> = { accept: t.kind === "dcgm-exporter" ? "text/plain" : "application/json" };
  const token = t.vaultRef ? (process.env[`LUCID_CREATOR_TARGET_${t.vaultRef.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`] ?? "").trim() : "";
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(t.url, { headers, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return errorTarget(t, at, `that host answered ${res.status}`);
    if (t.kind === "dcgm-exporter") {
      const gpu = gpuFromDcgm(await res.text());
      return { id: t.id, label: t.label, kind: "remote", sampledAt: at, ageMs: 0, freshness: "fresh", cpu: null, mem: null, gpu, procs: [], error: "" };
    }
    return telemetryFromAgentJson(await res.json(), t, at);
  } catch {
    return errorTarget(t, at, "no answer from that host");
  }
}

async function creatorResources(fresh: boolean): Promise<CreatorResourcesData> {
  const now = Date.now();
  if (!fresh && creatorResCache && now - creatorResCache.at < 3000) return agedResources(creatorResCache.data, now);
  const { cpu, mem } = await sampleCreatorCpu(PROFILE_IO);
  const gpu = sampleLocalGpu(gpuExec);
  // The process list spawns a command, so it moves on a slower clock than the cheap CPU/GPU sample.
  if (fresh || !creatorProcsCache || now - creatorProcsCache.at > 15_000) creatorProcsCache = { at: now, procs: topProcesses() };
  const local: TargetTelemetry = {
    id: "local", label: "This machine", kind: "local", sampledAt: now, ageMs: 0, freshness: "fresh",
    cpu, mem, gpu, procs: creatorProcsCache.procs, error: "",
  };
  const remotes = await Promise.all(listCreatorTargets().filter((t) => t.enabled).map(remoteTargetTelemetry));
  creatorHistory = pushCreatorSample(creatorHistory, sampleOf(local));
  const data: CreatorResourcesData = {
    targets: [local, ...remotes],
    history: creatorHistory,
    admission: creatorAdmission(creatorHistory, { label: "a Creator job" }, gpu),
    policy: { pressurePct: CREATOR_PRESSURE_PCT, warmPct: CREATOR_WARM_PCT, sustainMs: CREATOR_SUSTAIN_MS },
  };
  creatorResCache = { at: now, data };
  return data;
}

// ---- CREATOR-IMG (ADR-0291): generation + artifact plumbing ----

const artifactIo: ArtifactIo = {
  ensureDir: (dir) => { try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ } },
  writeBytes: (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes, { mode: 0o600 }); },
  writeText: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, { mode: 0o600 }); },
  appendLine: (path, line) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, line + "\n", { mode: 0o600 }); },
  readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } },
  now: () => Date.now(),
  id: () => `art_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`,
};

const creatorArtifacts = (): CreatorArtifact[] => foldArtifacts(artifactIo.readText(artifactLedger(CREATOR_DIR)));

// CREATOR-2 (ADR-0286): the editor renders a timeline in MEMORY and then hands it to the library's own
// addTrack, which imports from a path - so it needs the one capability LibraryIo lacks. Same byte writer
// the artifact store uses; nothing else about the library's IO changes.
const editorIo: EditorIo = { ...libraryIo, writeBytes: artifactIo.writeBytes };

/** The enabled ComfyUI declaration, or null. Its `workflow` field is the user's own exported graph. */
function comfyEndpoint(): CreatorEndpointDef | null {
  return listCreatorEndpoints().find((e) => e.enabled && e.providerId === "comfyui" && !!e.baseUrl) ?? null;
}
/** The credential for one Creator endpoint, by NAME: a declaration stores a vault REF, and the value only
 *  ever arrives through the environment the vault populated. Never inlined, never logged, never in a URL. */
function creatorEndpointToken(ep: CreatorEndpointDef): string {
  const envName = ep.vaultRef ? `LUCID_CREATOR_TARGET_${ep.vaultRef.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}` : "";
  return (envName ? process.env[envName] : "") || process.env.LUCID_COMFY_TOKEN || "";
}

function comfyClient(ep: CreatorEndpointDef): ComfyClient {
  return new ComfyClient({ baseUrl: ep.baseUrl!, token: creatorEndpointToken(ep), timeoutMs: 20_000 });
}

interface GenerateReply { ok: boolean; error?: string; data?: { artifacts: CreatorArtifact[]; produced: CreatorArtifact[] } }

/** Generate through the user's OWN workflow template: upload mixed inputs, substitute, submit, wait, import.
 *  Refuses with the precise missing piece rather than guessing a graph. */
async function generateCreatorImage(b: Record<string, unknown>): Promise<GenerateReply> {
  const ep = comfyEndpoint();
  if (!ep) return { ok: false, error: "No ComfyUI endpoint is configured. Add one in Creator Studio first." };
  const templateRaw = typeof b.workflow === "string" && b.workflow.trim() ? b.workflow : ep.workflow;
  if (!templateRaw || !templateRaw.trim()) {
    return { ok: false, error: "No workflow template is saved for this endpoint. Export your graph from ComfyUI with Save (API Format) and paste it into the endpoint, using {{prompt}}, {{model}}, {{seed}} and {{image:role}} where LUCID should fill values in." };
  }
  let template: unknown;
  try { template = JSON.parse(templateRaw); }
  catch { return { ok: false, error: "That workflow template is not valid JSON." }; }
  const client = comfyClient(ep);
  const prompt = typeof b.prompt === "string" ? b.prompt.slice(0, 4000) : "";
  const model = typeof b.model === "string" ? b.model : "";
  // Mixed inputs: each carries a ROLE, so the template binds them by name rather than by position.
  const inputs: CompositionInput[] = [];
  const rawInputs = Array.isArray(b.inputs) ? b.inputs.slice(0, 6) : [];
  for (const [i, item] of rawInputs.entries()) {
    if (!item || typeof item !== "object") continue;
    const rec: Record<string, unknown> = item;
    const role = typeof rec.role === "string" && rec.role.trim() ? rec.role.trim().slice(0, 40) : `input${i + 1}`;
    const decoded = decodePngDataUrl(rec.dataUrl);
    if (!decoded.ok) return { ok: false, error: `Input "${role}": ${decoded.error}` };
    const up = await client.uploadImage(`lucid-${role.replace(/[^a-zA-Z0-9_-]/g, "-")}-${Date.now()}.png`, decoded.bytes, decoded.mime);
    if (!up.ok || !up.filename) return { ok: false, error: `Input "${role}" could not be uploaded: ${up.error ?? "unknown reason"}.` };
    inputs.push({ role, filename: up.filename });
  }
  const applied = applyWorkflowTemplate(template, {
    prompt,
    negative: typeof b.negative === "string" ? b.negative.slice(0, 2000) : "",
    model,
    seed: typeof b.seed === "number" ? b.seed : Math.floor(Math.random() * 2 ** 31),
    width: typeof b.width === "number" ? b.width : undefined,
    height: typeof b.height === "number" ? b.height : undefined,
    inputs,
  });
  if (applied.unresolved.length) {
    return { ok: false, error: `The workflow still needs: ${applied.unresolved.join(", ")}. Fill those fields (or remove the placeholders) before generating.` };
  }
  const sub = await client.submit(applied.workflow);
  if (!sub.ok || !sub.promptId) return { ok: false, error: `ComfyUI did not accept the workflow: ${sub.error ?? "unknown reason"}.` };
  const done = await client.waitForImages(sub.promptId, { pollMs: 1200, maxWaitMs: 240_000 });
  if (!done.ok || !done.refs) return { ok: false, error: done.error };
  const produced: CreatorArtifact[] = [];
  for (const ref of done.refs.slice(0, 8)) {
    const img = await client.fetchImage(ref);
    if (!img.ok || !img.bytes) continue;
    const stored = storeArtifact(artifactIo, CREATOR_DIR, {
      kind: "image", bytes: img.bytes, mime: img.mime ?? "image/png",
      width: typeof b.width === "number" ? b.width : 0, height: typeof b.height === "number" ? b.height : 0,
      source: `comfyui ${client.baseUrl}`, prompt, model,
    });
    if (stored.ok && stored.artifact) produced.push(stored.artifact);
  }
  if (!produced.length) return { ok: false, error: "That render finished but no image could be read back from the server." };
  return { ok: true, data: { produced, artifacts: creatorArtifacts() } };
}

/** Re-age a memoized payload so a cached reading can never present itself as brand new. */
function agedResources(data: CreatorResourcesData, now: number): CreatorResourcesData {
  return {
    ...data,
    targets: data.targets.map((t) => ({ ...t, ageMs: Math.max(0, now - t.sampledAt), freshness: t.error ? "blind" : freshnessOf(t.sampledAt, now) })),
  };
}

function ompBin(): string {
  // Honor the omp the Electron main process resolved (bundled shim / app-managed install) FIRST — exactly
  // like acp_backend.ts. Without this, the OAuth broker + logout here resolved a DIFFERENT omp (a stale
  // ~/.bun global, or none), so "Connect via OAuth" produced no sign-in URL even though the model list —
  // which runs through acp_backend's LUCID_OMP_BIN-aware resolver — worked fine. They must use the SAME omp.
  const fromMain = process.env.LUCID_OMP_BIN;
  if (fromMain && existsSync(fromMain)) return fromMain;
  for (const c of [join(homedir(), ".bun", "bin", "omp.exe"), join(homedir(), ".bun", "bin", "omp")]) if (existsSync(c)) return c;
  return "omp";
}

// P-WINBOOT.2 (ADR-0260): the engine's on-disk base. In the `bun build --compile` engine binary,
// import.meta.dir is a VIRTUAL bunfs path, so engineDesktopDir derives the real <repo>/desktop from
// process.execPath (the on-disk binary at <repo>/bin/lucid-engine); a dev run uses import.meta.dir as-is.
const DESKTOP_DIR = engineDesktopDir(import.meta.dir, process.execPath, existsSync);
const REPO_DIR = join(DESKTOP_DIR, "..");
const ROOT = join(DESKTOP_DIR, "renderer");
// CREATOR-0 (ADR-0279): the engine serves on its FLAVOR's native port (Agent 5319, Creator 5320) unless
// PORT overrides it, so both products can run side by side with no launcher gymnastics.
const BUILD = flavorInfo(resolveBuildFlavor(process.env));
const PORT = Number(process.env.PORT ?? BUILD.defaultPort);
// CREATOR-0: the Creator data root (library ledger, artifacts). Falls back beside the settings file so a
// browser-only dev run still works without Electron having threaded LUCID_CREATOR_DIR.
const CREATOR_DIR = process.env.LUCID_CREATOR_DIR || join(process.env.LUCID_DATA_ROOT || join(homedir(), ".omp"), "creator");
// ADR-0024: per-launch capability token. Minted once per server process, injected into the served
// HTML (only a same-origin document can read it), and required on every sensitive /api call. A new
// random value each launch means a token never outlives the process that issued it.
// P-BROWSER.1 (wave 2): when the Electron main spawned us it minted the token itself and passed it
// down as LUCID_MAIN_TOKEN - adopting it means main's agent-browser poll loop can authenticate its
// /api/browser/commands + /api/browser/result calls with the standard x-lucid-token header (there is
// no other channel from this child back up to its parent). Still one random value per launch; a
// standalone `bun run desktop/dev.ts` has no main and mints its own exactly as before.
const TOKEN = process.env.LUCID_MAIN_TOKEN || randomBytes(32).toString("hex");
// Routes the OMP CHILD (or the Electron main) calls directly. They cannot set an `x-lucid-token` header,
// so each inherits a ready URL with `?t=<TOKEN>` and these paths additionally accept the query token.
// Everything else stays header-only. Hoisted to module scope (was a 17-clause `||` chain rebuilt on every
// request) so adding a self-report route is a one-line edit and costs no per-request allocation.
const QUERY_TOKEN_ROUTES: ReadonlySet<string> = new Set([
  "/api/preview/serve", "/api/preview/shot", "/api/preview/open", "/api/preview/inspect", "/api/preview/act",
  "/api/kb/retrieve",        // ADR-0220: the knowledge_search tool grounds on the local compiled KB
  "/api/fleet/status",       // P-FLEET.L1: the master's fleet_status tool
  "/api/interject/pending",  // P-INTERJECT.1: the child drains operator notes addressed to it
  "/api/tool/meta",          // P-EVAL.4 (ADR-0318): the tool_meta extension reports real tool names
  "/api/kg/recall", "/api/kg/retain", // P-KG.3: the memory_recall / memory_retain tools
  "/api/browser/open", "/api/browser/capture", "/api/browser/scroll", "/api/browser/close",
  "/api/browser/shot", "/api/browser/click", "/api/browser/type", "/api/browser/drag", "/api/browser/keys",
]);
// P-FLEET.L1/L2/L4/L5: the local lane manager - N gated headless LUCID agents on this machine under the
// sustained-pressure guard. Lanes default to the MASTER session's current model unless the user picks
// another. Every spawned/recovered session is NAMED in the durable lane-session ledger (P-FLEET.L5), so
// the timeline can label its on-disk history and a stopped lane stays reviewable across engine restarts.
// P-INTERJECT.1: each lane's spawn env overlay stamps LUCID_INTERJECT_TARGET=<laneId> so the lane's
// interject_extension drains only the notes addressed to it (the master child gets target "master").
const fleet = new FleetLaneManager({ argv: fleetLaneArgv, masterModel: () => backend.activeModelName(), recordLaneSession: appendLaneLedger, env: (laneId) => interjectChildEnv(laneId), interject: (laneId, text) => { addInterject(laneId, text); } });
// P-FLEET.L6: NEW lanes inherit the persisted full-auto default. The risk-ack gate lives in the
// /api/fleet/auto route; by the time this flag is true, the user already accepted the warning once.
fleet.setAutoDefault(!!loadSettings().fleetAutoApprove);
// P-HEALTH.1: the harness watches its OWN sessions so a stalled long run never needs an app restart. The
// master session and every lane climb the same ladder (quiet, then the canned status probe, then a
// cancel-and-resume in place). The ticker is coarse on purpose: the thresholds are minutes, and a tick
// that finds nothing wrong does no IO at all. Both calls are fail-quiet - a watchdog that can throw into
// the event loop is a worse bug than the stall it watches for.
backend.startHealthWatch();
setInterval(() => { void fleet.healthTick().catch(() => {}); }, 30_000).unref?.();
// P-PWA-FOCUS.1: the lane-to-guest tap. ONE persistent observer, registered here at module scope right
// after the lane manager exists (this file is evaluated once per engine process, and this statement sits
// outside every route handler and every poll tick) - so it is installed exactly once and covers all lanes
// present AND future, unlike a per-spawn sink that would need re-attaching. It is deliberately NOT next to
// the collab broadcaster above: `fleet` is still in its const TDZ up there, and observe() is an immediate
// call, not a closure like the deps and the 5s poll.
// The laneWatched() guard comes FIRST on purpose: a fleet grinding through turns with no phone attached
// must do ZERO per-event work - no translation, no allocation, no frame - so the guard has to precede the
// adapter, not follow it. It is false whenever the share is inactive, so the common case is one map lookup.
fleet.observe((laneId, e) => {
  if (!collabManager.laneWatched(laneId)) return; // nobody is looking at this lane
  const ev = laneEventToChatEvent(e);
  if (!ev) return; // deliberately untranslatable (permission/status already ride the lane card)
  collabManager.tapEvent(ev, laneId); // scoped: only the guests watching THIS lane
});

// P-INTERJECT.1: the unified Processes list - everything "running" in this app right now, assembled
// from the live sources this server already holds. One builder, two consumers: GET /api/processes
// and the collab process-list broadcast (P-PWA-FLEET.1). Every source is fail-quiet: a broken one
// drops its entries, never the whole list.
async function buildProcessViews(): Promise<ProcessView[]> {
  const processes: ProcessView[] = [];
  try {
    const mt = backend.midTurn();
    if (mt.busy) processes.push({ id: "master-turn", kind: "master-turn", label: "Master chat turn", status: "running", startedAt: mt.startedAt, lastActivityAt: null, detail: backend.activeModelName() });
  } catch { /* backend not up yet - no master entry */ }
  try {
    for (const lane of (await fleet.status()).lanes) {
      if (lane.status === "stopped") continue;
      processes.push({ id: `lane:${lane.id}`, kind: "lane", label: lane.name, status: lane.status, startedAt: lane.createdAt, lastActivityAt: lane.lastActivityAt, detail: basename(lane.cwd) });
    }
  } catch { /* fleet status failed - no lane entries */ }
  try {
    const job = importJobStatus();
    if (job?.state === "running") processes.push({ id: `import:${job.jobId}`, kind: "import", label: "Chat-history import", status: job.cancelRequestedAt ? "stopping" : "running", startedAt: job.startedAt, lastActivityAt: job.updatedAt, detail: `${job.messages}/${job.totalMessages} messages` });
  } catch { /* no import entry */ }
  processes.push(...browserProcesses()); // [] until wave 2 registers browser sessions
  return processes;
}
// P-FLEET.L3: the P-VISION.1 image filter for lane prompts and the staged queue - identical discipline to
// /api/chat (well-formed {data, mimeType} blocks only, capped at 6; anything torn is dropped, not trusted).
function laneImages(raw: unknown): { data: string; mimeType: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { data: string; mimeType: string }[] = [];
  for (const im of raw) {
    if (out.length >= 6) break;
    if (im && typeof im === "object" && "data" in im && "mimeType" in im && typeof im.data === "string" && typeof im.mimeType === "string") {
      out.push({ data: im.data, mimeType: im.mimeType });
    }
  }
  return out;
}
// Lanes are child processes: an engine shutdown must never orphan a worker turn (deny open asks, cancel,
// kill). "exit" is the last-resort sync path; SIGINT/SIGTERM cover a clean stop.
process.on("exit", () => { try { fleet.stopAll(); } catch { /* dying anyway */ } });
process.on("SIGINT", () => { try { fleet.stopAll(); } catch { /* dying */ } process.exit(0); });
process.on("SIGTERM", () => { try { fleet.stopAll(); } catch { /* dying */ } process.exit(0); });
// P-PREVIEW.3a-shot (ADR-0096): latest PNG of the rendered preview, pushed by the renderer after each render
// (Electron capturePage → /api/preview/shot-cache) and read by the agent's preview_screenshot tool. In-memory.
let latestPreviewShot: string | null = null;
// P-BROWSER.1 (wave 2): the live agent-browser session feeds the unified Processes list (the popover
// renders a Close action for kind "browser" rows). Label/detail come straight from the status store;
// `browserKilledByUser` flips when main reports a user-X close, so later commands fail with the honest
// "browser closed by user" instead of a generic timeout, until a fresh browser_open succeeds.
let browserKilledByUser = false;
let browserCmdSeq = 0;
setBrowserProcessSource(() => {
  const s = getBrowserStatus();
  if (!s.active) return [];
  return [{ id: "browser", kind: "browser", label: `Agent browser: ${s.title || s.url}`, status: "open", startedAt: s.startedAt, lastActivityAt: lastBrowserActivityAt() || s.startedAt, detail: s.url }];
});
// P-PREVIEW.6b (ADR-0153): relay for the agent's read-only DOM inspect of the sandboxed preview.
const inspectRelay = new InspectRelay();
const CT: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
// Text-ish types take a charset; binary (images/fonts) must not (a bogus "image/png; charset" suffix).
const isTextCT = (ct: string) => /^(text\/|application\/(javascript|json)|image\/svg)/.test(ct);

// ADR-0009 Phase A — hand the cross-session recall block to the backend for first-user-turn
// injection (never the frozen prefix; invariant #5/#6). READ-ONLY: the omp gate child is the
// single writer of agent_obs.duckdb, so we open read-only and omit the sessionId — no
// fact_sessions write, hence no two-process DuckDB write contention. Best-effort: a recall
// failure clears recall (setRecall(null)) and never breaks chat.
async function refreshRecall(): Promise<void> {
  try {
    if (!existsSync(OBS_DB_PATH)) { backend.setRecall(null); return; }
    const db = await Db.openReadOnly(OBS_DB_PATH);
    try {
      const { block } = await buildRecall(db, { limit: 20 });
      backend.setRecall(block);
    } finally {
      db.close();
    }
  } catch {
    backend.setRecall(null);
  }
}

// Render a build failure AS the script body so the page shows the real error instead of nothing.
function bundleError(msg: string): { js: string; ok: boolean } {
  return { ok: false, js: `document.body.innerHTML='<pre style="color:#ef5f5f;padding:20px;font:13px monospace;white-space:pre-wrap">'+${JSON.stringify(msg)}+'</pre>';` };
}
// P-AVATAR.2a, retained through the P-MASCOT pivot (ADR-0251): the renderer bundles with code
// splitting, so any dynamic import in app.ts lands in a lazy hashed "./chunk-*.js" instead of bloating
// the entry (three.js used this before its removal; the capability stays for future heavy features).
// Every chunk is kept in memory and served at its emitted name - the browser resolves the entry's
// relative chunk imports against /app.js, i.e. /chunk-*.js. With no dynamic imports, output is a
// single entry and the chunk route simply never fires.
let appChunks = new Map<string, string>();
async function bundleApp(): Promise<{ js: string; ok: boolean }> {
  // P-WINBOOT.2 (ADR-0260): a packaged build ships a prebuilt renderer bundle (build-renderer), so the
  // engine never Bun.build()s renderer TypeScript from the (possibly protected) install dir at runtime -
  // the last path by which Bun would touch .ts on the install disk. Dev has no prebuilt bundle -> build live.
  const prebuilt = join(ROOT, "app.bundle.js");
  if (existsSync(prebuilt)) {
    try { return { ok: true, js: await Bun.file(prebuilt).text() }; }
    catch (e) { console.error("[bundleApp] prebuilt bundle unreadable, rebuilding:", e); }
  }
  try {
    const out = await Bun.build({ entrypoints: [join(ROOT, "app.ts")], target: "browser", sourcemap: "inline", splitting: true });
    if (!out.success) return bundleError(out.logs.map((l) => String(l)).join("\n"));
    let entry = "";
    const chunks = new Map<string, string>();
    for (const o of out.outputs) {
      const text = await o.text();
      if (o.kind === "entry-point") entry = text;
      else chunks.set("/" + o.path.replace(/^\.\//, ""), text);
    }
    appChunks = chunks;
    return { ok: true, js: entry };
  } catch (e) {
    // A THROW from Bun.build (e.g. an unresolved import in a packaged build where a renderer dep
    // wasn't bundled) must NOT fall through to the generic JSON error handler — that ships as
    // <script>{"ok":false,...}</script>, an invalid-JS blob that leaves the window a silent dark
    // shell (the katex-missing dark-screen bug). Surface the error MESSAGE in the page; the full
    // stack stays in the server log (CodeQL js/stack-trace-exposure — never ship stack frames).
    console.error("[bundleApp] renderer build failed:", e);
    return bundleError(`Renderer build failed:\n${e instanceof Error ? e.message : String(e)}`);
  }
}

const json = (data: unknown) =>
  new Response(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// P-SEC.1 (ADR-0209): a caught exception's message/stack must never flow into a client response
// (CWE-209/497 — CodeQL js/stack-trace-exposure). This control plane is loopback-only (ADR-0022 H1), so the
// real-world exposure is low, but we keep the boundary clean: log the FULL error server-side (dev console)
// and return a curated message that derives ONLY from `generic`, never from `e`. Every `catch` that surfaces
// ── P-VOICE.2 (ADR-0247): which TTS engines can actually speak right now ──────────────────────────────
// The picker used to list every engine unconditionally, so choosing ChatGPT/OpenAI with only a subscription
// sign-in offered thirteen voices and then failed on every reply. Readiness is computed here, once, and both
// the picker and /api/tts/speak render the SAME reason - a failure can never contradict the menu.
const LOCAL_TTS_URL = (): string => process.env.LUCID_TTS_URL || "http://localhost:8880";
// Is a self-hosted Kokoro actually listening? ANY HTTP answer counts - even a 404 proves something is bound.
// Cached for a few seconds because the picker probes on every open, and a refused connection costs a syscall
// round-trip we do not want in the menu's critical path.
let localTtsProbe = { at: 0, up: false };
async function localTtsUp(): Promise<boolean> {
  const now = Date.now();
  if (now - localTtsProbe.at < 5000) return localTtsProbe.up;
  let up = false;
  try { await fetch(LOCAL_TTS_URL(), { signal: AbortSignal.timeout(700) }); up = true; }
  catch { up = false; } // connection refused / DNS / timeout - nothing is serving there
  localTtsProbe = { at: now, up };
  return up;
}
/** Every TTS engine with its LIVE readiness + the specific reason it can't speak. */
async function ttsEngines(): Promise<(TtsProviderInfo & { ready: boolean; reason: string })[]> {
  const localUp = await localTtsUp();
  const auth = providerAuth(); // one SQLite read, not one per engine
  const rows = [...auth.majors, ...auth.others];
  const localUrl = LOCAL_TTS_URL();
  return TTS_PROVIDERS.map((e) => ({
    ...e,
    ...ttsEngineStatus(e.id, {
      keySet: !!(e.keyEnv && process.env[e.keyEnv]),
      // The OpenAI engine's OAuth row is the CHAT sign-in ("openai"); ttsEngineStatus uses it to explain why
      // being signed in still isn't enough for the platform speech API.
      oauthActive: !!rows.find((r) => r.id === (e.id === "openai-tts" ? "openai" : e.id))?.oauthActive,
      localUp,
      localUrl,
    }),
  }));
}

// A caught exception must never reach the client verbatim (CWE-209/497). Log it, return a curated message.
function clientError(e: unknown, generic: string): string {
  console.error(`[dev] ${generic}:`, e);
  return generic;
}

// Typed read of a POST JSON body. Bun types `req.json()` as `unknown`; this helper is the single
// place that cast lives, so each handler below names the exact shape it expects and stays strict.
// Fields the handler funnels through String()/typeof guards are left `unknown` (the guard narrows them).
async function readBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

// P-KGPACK.2 (ADR-0205): the named-KG picker's wire shape - every KG (id/name/read-only/source) + the
// active id, plus an optional `error` a mutation attaches instead of nulling the list.
function kgListView(error?: string) {
  return {
    kgs: listKgs().map((k) => ({ kg_id: k.kg_id, name: k.name, read_only: k.read_only, source_kind: k.source_kind })),
    activeId: activeKgId(),
    ...(error ? { error } : {}),
  };
}

// P-AGENT.9: lazy scanner sidecar for imported agent files. Shared across imports; FAIL-CLOSED by design —
// if the sidecar is dead or slow, importSpec quarantines the spec (ScanUnavailableError becomes a blocking
// decision), it never passes unscanned.
let _agentScanner: ScannerClient | null = null;
function agentScanner(): ScannerClient {
  if (!_agentScanner) {
    _agentScanner = new ScannerClient({ timeoutMs: 8000 });
    _agentScanner.start();
  }
  return _agentScanner;
}

// P-AGENT.9/.10/.17: the ONE gated import path — every external spec (share file, n8n workflow, template)
// runs the P-AGENT.5 scanner gate and persists WITH its trust label; nothing external skips the gate.
interface GatedImportReply {
  ok: boolean;
  error?: string;
  data: Record<string, unknown>;
}
async function gatedAgentImport(specJson: string, notes: string[]): Promise<GatedImportReply> {
  try {
    const r = await importSpec(agentScanner(), specJson, "import");
    if (!r.ok || !r.spec) {
      const msg = r.errors.join("; ") || r.reason;
      return { ok: false, error: msg, data: { error: msg } };
    }
    saveSpecFile(currentWorkspace(), r.spec);
    saveSpecTrust(currentWorkspace(), r.spec.spec_id, { trustLabel: r.trustLabel, reason: r.reason });
    return { ok: true, data: { spec: r.spec, trustLabel: r.trustLabel, canRun: r.canRun, reason: r.reason, findings: r.findings.length, setup: setupInstructions(r.spec), notes } };
  } catch (e) {
    const msg = clientError(e, "could not import the agent");
    return { ok: false, error: msg, data: { error: msg } };
  }
}

// P-AGENT.17: the in-repo starter-template gallery. Only digest-valid portable files are listed; a
// corrupted/tampered template simply disappears from the gallery (fail-soft for the UI, fail-closed for use).
const TEMPLATES_DIR = join(REPO_DIR, "templates", "agents");
interface AgentTemplateSummary {
  file: string;
  name: string;
  description: string;
  steps: number;
  tools: string[];
}
function listAgentTemplates(): AgentTemplateSummary[] {
  let files: string[];
  try {
    files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".lucid-agent.json"));
  } catch {
    return [];
  }
  const out: AgentTemplateSummary[] = [];
  for (const f of files.sort()) {
    try {
      const parsed = parsePortableAgentJson(readFileSync(join(TEMPLATES_DIR, f), "utf8"));
      if (!parsed.ok || !parsed.spec) continue;
      out.push({ file: f, name: parsed.spec.name, description: parsed.spec.description ?? "", steps: parsed.spec.nodes.length, tools: parsed.spec.tools });
    } catch {
      /* unreadable template → not listed */
    }
  }
  return out;
}

// P-REPORT.8: gather the git change inputs (numstat + name-status) for the report annexes. Default range
// is the recent cycle (up to the last 10 commits); on a shallow/single-commit repo it falls back to the
// working tree. Fail-soft: any git error → empty strings (the annex then reports "no changes detected").
function gitOut(repo: string, args: string[]): string {
  try {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "ignore", timeout: 8000 });
    return r.exitCode === 0 ? r.stdout.toString() : "";
  } catch { return ""; }
}
function gitChangeInputs(repo: string): { numstat: string; nameStatus: string; range: string } {
  const cnt = Number(gitOut(repo, ["rev-list", "--count", "HEAD"]).trim());
  const range = Number.isFinite(cnt) && cnt > 1 ? `HEAD~${Math.min(10, cnt - 1)}..HEAD` : "";
  const args = range ? [range] : [];
  return { numstat: gitOut(repo, ["diff", "--numstat", ...args]), nameStatus: gitOut(repo, ["diff", "--name-status", ...args]), range: range ? `the last ${Math.min(10, cnt - 1)} commits` : "the working tree" };
}

// OAuth via omp's `auth-broker login` — it opens the provider, runs a LOCAL callback server
// (e.g. :1455) for the redirect, exchanges the code, stores the token, then exits. It MUST stay
// alive AND have BOTH pipes drained until the callback lands — otherwise a full stdout/stderr pipe
// blocks it and the callback server goes down (browser → "localhost refused to connect"). We keep
// a reference (no GC), drain both streams in the background, and resolve once we see the auth URL.
// Map keyed by oauthId — lets us look up a running broker to send a device code to its stdin
// (xAI, GitHub, etc. use device-authorization flows where the user copies a code from the browser).
const oauthBrokers = new Map<string, ReturnType<typeof Bun.spawn>>();
// GitHub Copilot's broker (ADR-0210) begins with an `onPrompt` for the GitHub Enterprise domain (blank =
// github.com) and BLOCKS on stdin before it ever prints the device URL. So for github-copilot we must feed
// that first line up front, or the login hangs at the prompt and no URL surfaces. `promptAnswer` is that
// line (the GHE domain, or "" for github.com); it's written to stdin immediately after spawn.
function startOauthBroker(oauthId: string, promptAnswer?: string): Promise<{ started: boolean; url: string; output: string }> {
  // Snapshot the vault BEFORE the broker runs, so the exit handler below can tell whether a genuinely
  // fresh token landed rather than trusting the broker's exit code. Read-only; absent row => not present.
  const beforeCred = credentialSnapshot(oauthId);
  let proc: ReturnType<typeof Bun.spawn>;
  try { proc = Bun.spawn([ompBin(), "auth-broker", "login", oauthId], { stdout: "pipe", stderr: "pipe", stdin: "pipe" }); }
  // stdin: "pipe" (NOT "ignore") — the broker reads stdin as a fallback for pasting the auth code.
  // "ignore" closes stdin immediately → broker sees EOF → shuts down its callback server
  // before the browser redirect arrives. "pipe" keeps it open; for device-flow providers (xAI)
  // we also WRITE the user-pasted code to it via sendOauthCode().
  // js/stack-trace-exposure: log the real spawn error server-side; hand the client a generic message
  // so an internal exception/stack never reaches the renderer (this object is returned via json()).
  catch (e) { console.error(`[oauth] broker spawn failed for ${oauthId}:`, e); return Promise.resolve({ started: false, url: "", output: "could not start login" }); }
  oauthBrokers.set(oauthId, proc);
  // Answer the broker's leading prompt (Copilot's enterprise-domain question) so the device URL can appear.
  if (promptAnswer !== undefined) {
    const sink = proc.stdin;
    if (sink && typeof sink !== "number") { try { sink.write(new TextEncoder().encode(promptAnswer.trim() + "\n")); } catch { /* broker may have exited */ } }
  }
  proc.exited.finally(() => { if (oauthBrokers.get(oauthId) === proc) oauthBrokers.delete(oauthId); });
  // On a SUCCESSFUL login the credential lands in omp's vault, but the already-running omp child built
  // its model list at spawn and won't see it. Respawn so the new provider's models surface (mirrors what
  // adding an API key does). The front-end re-fetches /api/config after the badge flips.
  //
  // We deliberately do NOT gate this on the broker's exit code. The broker runs a local callback server,
  // and it can exit non-zero (or be torn down noisily, or linger) AFTER it has already written a valid
  // token. In that case the badge flips green - it reads the vault directly - while omp is never
  // respawned, which presents to the user as "the browser said I'm signed in, but the picker has no
  // models" and only clears on a full app restart. The vault is the ground truth, so compare a
  // before/after snapshot instead: a first row, a replaced row, a rewritten blob or a bumped
  // `updated_at` all mean a fresh token landed. This also keeps a FAILED login from resurrecting a
  // credential the user logged out of, which a blind clear-and-restart would.
  proc.exited.then(() => {
    if (!landedFreshCredential(beforeCred, credentialSnapshot(oauthId))) {
      if (loadSettings().developerMode) console.log(`[oauth] ${oauthId} login left no new credential - not respawning omp`);
      return;
    }
    // omp's login writes the fresh token but may leave a stale `disabled_cause` from a prior logout,
    // so the just-fetched credential stays ignored. Clear that one flag (token blob untouched) so the
    // login actually "sticks", THEN respawn omp to pick up the now-active provider.
    const r = clearDisabledCredential(oauthId);
    if (r.cleared) console.log(`[oauth] re-enabled ${oauthId} after login (cleared stale disabled flag)`);
    console.log(`[oauth] ${oauthId} credential landed - respawning omp so its models surface`);
    backend.restart();
  }).catch(() => { /* ignore */ });
  return new Promise((resolve) => {
    const dec = new TextDecoder();
    let out = "", err = "", done = false, ended = 0;
    const finish = (url: string) => {
      if (done) return; done = true;
      if (!url && loadSettings().developerMode) {
        // No sign-in URL surfaced — the exact failure that leaves "Connect via OAuth" with a toast but no
        // browser. Log what we DID see so it's diagnosable (which omp, and its output on each stream).
        console.error(`[oauth] no URL from broker for ${oauthId} via ${ompBin()} — stdout=${JSON.stringify(out.slice(0, 200))} stderr=${JSON.stringify(err.slice(0, 200))}`);
      }
      resolve({ started: true, url, output: (out || err).slice(0, 600) });
    };
    // Match a COMPLETE url (followed by whitespace) so a chunk boundary mid-URL can't resolve a truncated
    // link; scan BOTH streams — omp prints the URL to stdout today, but tolerate a future move to stderr.
    const scan = () => { const m = (out + "\n" + err).match(/(https?:\/\/\S+?)(?=\s)/); if (m) finish(m[1]); };
    // Drain stdout + stderr fully (never stop) so the broker can't block on a full pipe; grab the URL when it appears.
    (async () => {
      try { for await (const c of proc.stdout as ReadableStream<Uint8Array>) { out += dec.decode(c); scan(); } } catch { /* stream ended */ }
      if (++ended === 2) finish(""); // both streams hit EOF without a URL
    })();
    (async () => {
      try { for await (const c of proc.stderr as ReadableStream<Uint8Array>) { err += dec.decode(c); scan(); } } catch { /* ended */ }
      if (++ended === 2) finish("");
    })();
    setTimeout(() => finish(""), 60_000); // 60s — OTP/MFA flows need time (phone unlock, SMS delay)
  });
}
/** Send a device-authorization code to a running broker's stdin (xAI "Grok Build", GitHub device flow, etc.).
 *  The broker prints "Paste the authorization code (or full redirect URL)::" and reads a line from stdin. */
function sendOauthCode(oauthId: string, code: string): { sent: boolean; reason?: string } {
  const proc = oauthBrokers.get(oauthId);
  if (!proc) return { sent: false, reason: "no broker running for " + oauthId };
  const sink = proc.stdin; // Bun types this number | FileSink | undefined; the broker spawns with stdin:"pipe" → FileSink
  if (!sink || typeof sink === "number") return { sent: false, reason: "broker stdin is not writable" };
  try { sink.write(new TextEncoder().encode(code.trim() + "\n")); return { sent: true }; }
  // js/stack-trace-exposure: log detail server-side, return a generic reason to the client (goes via json()).
  catch (e) { console.error(`[oauth] send code failed for ${oauthId}:`, e); return { sent: false, reason: "could not send code" }; }
}

// Stream NDJSON ChatEvents to the browser with a HEARTBEAT. A long maker tool call (e.g. a broad
// codebase search during a /goal loop) can run for >60s emitting nothing; without a keepalive the
// socket goes idle, Bun's `idleTimeout` closes it, and every later event — tool chips AND the final
// answer — is lost while the turn keeps working server-side (it writes the file, the UI stays frozen
// on the last event it saw). A `{type:"ping"}` every 15s keeps the connection alive; the client
// (bridge.ts) drops pings. On a real browser disconnect we log once (developer mode) and keep going.
function ndjsonStream(label: string, run: (emit: (e: unknown) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let writeFailed = false;
      let lastSend = Date.now();
      const emit = (e: unknown) => {
        try { controller.enqueue(enc.encode(JSON.stringify(e) + "\n")); lastSend = Date.now(); }
        catch { if (!writeFailed && loadSettings().developerMode) { writeFailed = true; console.error(`[TURN_DIAG] ${label} stream write failed (browser disconnected) — server turn continues`); } }
      };
      const hb = setInterval(() => { if (Date.now() - lastSend >= 15_000) emit({ type: "ping" }); }, 15_000);
      try { await run(emit); }
      finally { clearInterval(hb); try { controller.close(); } catch { /* already closed */ } }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // H1 (ADR-0022): loopback only — this control plane handles keys/passphrases.
  // ADR-0305 invariant: the window only renders the nonce-verified LOOPBACK engine; this bind is load-bearing.
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    // H2 (ADR-0022): reject anything a web page or DNS-rebind could forge against
    // the fixed local port (foreign Host/Origin, or a non-JSON state-changing body).
    if (!isAllowedRequest(reqShape(req), PORT)) return new Response("forbidden", { status: 403 });
    // ADR-0024: the sensitive /api surface additionally requires the per-launch token (carried by
    // the renderer from the injected HTML). /api/health is exempt — main.ts polls it before the
    // page (and thus the token) exists, and it returns no data. Static assets/HTML aren't /api/*.
    // P-PREVIEW.4b (ADR-0096): `/api/preview/serve` is loaded via an <iframe src> (so the previewed app's
    // OWN CSP applies instead of the renderer's strict inherited one). An iframe `src` GET cannot send a
    // custom header, so this ONE endpoint also accepts the per-launch token as a `?t=` query param — same
    // token, still behind the loopback (H1) + Origin/Host/CSRF (H2) gate above. Every other /api needs the header.
    if (p.startsWith("/api/") && p !== "/api/health") {
      // `/api/preview/serve` (iframe src) and `/api/preview/shot` (fetched by the omp subprocess, which
      // inherits a ready URL incl. the token via LUCID_PREVIEW_SHOT_URL) can't set a header, so they also
      // accept the per-launch token as a `?t=` query param — same token, still behind the H1/H2 gate above.
      // ADR-0220: /api/kb/retrieve is also called by the omp subprocess's `knowledge_search` tool (via the
      // token'd LUCID_KB_RETRIEVE_URL it inherits), which can't set a header — accept the `?t=` token for it too.
      // P-FLEET.L1: /api/fleet/status is also fetched by the omp subprocess's fleet_status tool (via the
      // token'd LUCID_FLEET_STATUS_URL it inherits), which can't set a header - accept the ?t= token too.
      // P-INTERJECT.1: /api/interject/pending is drained by the omp child's interject_extension (via the
      // token'd LUCID_INTERJECT_URL it inherits), which can't set a header - accept the ?t= token too.
      // P-BROWSER.1 (wave 2): /api/browser/{open,capture,scroll,close,shot} are called by the omp child's
      // browser_* tools (via the token'd LUCID_BROWSER_URL it inherits), same ?t= convention. The two
      // main-process endpoints (/commands, /result) and the status push stay header-only: main MINTED the
      // token (LUCID_MAIN_TOKEN) and sends it as x-lucid-token on every poll.
      const queryTokenOk = QUERY_TOKEN_ROUTES.has(p);
      const tok = queryTokenOk ? (req.headers.get("x-lucid-token") ?? url.searchParams.get("t")) : req.headers.get("x-lucid-token");
      if (!tokenValid(tok, TOKEN)) return new Response("forbidden", { status: 403 });
    }
    try {
      if (p === "/app.js") {
        const { js } = await bundleApp();
        return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      }
      // P-AVATAR.2a: split chunks (lazy three.js). A miss after a server restart rebuilds once - the
      // entry the browser holds references the chunk names of ITS build, and bundleApp repopulates them.
      if (/^\/chunk-[\w-]+\.js$/.test(p)) {
        if (!appChunks.has(p)) await bundleApp();
        const chunk = appChunks.get(p);
        if (chunk) return new Response(chunk, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
        return new Response("// stale chunk - reload", { status: 404, headers: { "content-type": "text/javascript" } });
      }
      // P-IDE.4 (ADR-0029): serve the vendored Monaco editor (AMD min build) from node_modules so it's
      // local/airgap-clean without committing ~16MB. The read-only viewer runs Monaco on the main thread
      // (no language-service worker). This route reads from THIS server's dir (resources/repo/desktop in
      // a packaged build), so the bundle MUST keep desktop/node_modules/monaco-editor/min — the repo
      // extraResources filter re-includes it past the desktop/node_modules exclusion (electron-builder
      // applies filters in order). The app.asar `files` copy is unreachable from here. Without the
      // re-include this 404s in the installed app (the editor never loads) while working in dev.
      // P-IDE.6: serve a SAME-ORIGIN worker bootstrap so Monaco's language-service workers run under
      // the strict `worker-src 'self'` CSP. Monaco's own getWorker wraps the language worker in a blob:
      // URL (which the CSP — and a locked-down browser — block). This is the same idea, but same-origin:
      // set MonacoEnvironment.baseUrl inside the worker, then importScripts the real (self-contained,
      // classic) language worker. `script-src 'self'` permits the same-origin importScripts.
      if (p === "/vendor/monaco-worker.js") {
        const label = url.searchParams.get("label") ?? "";
        const key = label === "typescript" || label === "javascript" ? "ts"
          : label === "json" ? "json"
          : label === "css" || label === "scss" || label === "less" ? "css"
          : label === "html" || label === "handlebars" || label === "razor" ? "html"
          : "editor";
        let asset = "";
        try {
          const dir = join(DESKTOP_DIR, "node_modules", "monaco-editor", "min", "vs", "assets");
          const re = new RegExp(`^${key}\\.worker-.*\\.js$`);
          for (const f of readdirSync(dir)) if (re.test(f)) { asset = `assets/${f}`; break; }
        } catch { /* no assets dir */ }
        const body = asset
          ? `self.MonacoEnvironment={baseUrl:self.location.origin+"/vendor/monaco/"};importScripts(self.location.origin+"/vendor/monaco/${asset}");`
          : "/* monaco worker asset not found */";
        return new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      }
      if (p.startsWith("/vendor/monaco/")) {
        const base = join(DESKTOP_DIR, "node_modules", "monaco-editor", "min", "vs");
        const target = join(base, p.slice("/vendor/monaco/".length));
        if (!pathWithin(base, target)) return new Response("forbidden", { status: 403 }); // no path traversal
        const f = Bun.file(target);
        if (await f.exists()) {
          const ext = target.slice(target.lastIndexOf("."));
          return new Response(f, { headers: { "content-type": (CT[ext] ?? "application/octet-stream") + "; charset=utf-8", "cache-control": "max-age=86400" } });
        }
        return new Response("not found", { status: 404 });
      }
      // Security snapshot + the GUI-owned LIVE gate blocks (ADR-0019 C). Live blocks are merged
      // in even when the DuckDB snapshot is null, so a fresh machine still shows quarantines.
      if (p === "/api/security") {
        const snap = await securitySnapshotMemo(); // memoized + single-flight (P-PERF.3); live/sandbox/acks stay fresh (in-memory, cheap)
        return json({ ok: true, data: { ...(snap ?? {}), live: liveBlocks(), sandbox: sandboxStatus(), acks: ackView() } });
      }
      // Audited fail-closed override: release one quarantined call (ADR-0019 C).
      if (p === "/api/security/approve" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); return json({ ok: true, data: approveBlock(String(b.id ?? "")) }); }
      if (p === "/api/security/dismiss" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); return json({ ok: true, data: dismissBlock(String(b.id ?? "")) }); }
      // P-SECACK.1 (ADR-0170): mark DB-backed security rows reviewed. GUI-owned ack ledger ONLY -
      // the provenance DB is never written and nothing is released; rows just leave the active view.
      if (p === "/api/security/ack" && req.method === "POST") {
        const b = await readBody<{ ids?: unknown; findings?: unknown }>(req);
        const ids = Array.isArray(b.ids) ? b.ids.map((x) => String(x)).filter((x) => x.trim()) : [];
        for (const id of ids) ackArtifact(id);
        let findingsSeen: number | null = null;
        if (b.findings === true) {
          // Server-side total - the watermark comes from what the DB says NOW, never a stale client count.
          const snap = await securitySnapshot();
          findingsSeen = ackFindings((snap?.findings ?? []).reduce((a, r) => a + Number(r.n ?? 0), 0));
        }
        return json({ ok: true, data: { acked: ids.length, findingsSeen } });
      }
      // Anchor the snapshot to the ACTIVE chat session (its on-disk transcript) so the Context window
      // + Prompt-cache gauges reflect the live conversation; fall back to findSession's cwd match only
      // when there's no active session yet (fresh launch).
      if (p === "/api/memory") return json({ ok: true, data: await memorySnapshotMemo(sessionPathById(backend.currentSessionId())) }); // P-PERF.3 memo
      // P-MCP.1 (ADR-0020): MCP server registry. The hub does auth + config assembly only; omp owns
      // the MCP transport (configs ride session/new.mcpServers). Changes respawn omp to apply. The
      // list NEVER returns raw tokens (masked status only — like provider keys).
      if (p === "/api/mcp") {
        if (req.method === "POST") {
          const b = await readBody<{ id?: string; name?: unknown; transport?: unknown; url?: unknown; token?: unknown; enabled?: boolean }>(req);
          const e = upsertMcpServer({ id: b.id, name: String(b.name ?? ""), transport: b.transport === "sse" ? "sse" : "http", url: String(b.url ?? ""), token: b.token != null ? String(b.token) : undefined, enabled: b.enabled });
          backend.restart(); // omp re-reads mcpServers on the next session
          return json({ ok: true, data: { id: e.id, name: e.name, transport: e.transport, url: e.url, enabled: e.enabled, hasToken: !!e.token } });
        }
        return json({ ok: true, data: listMcpServers().map((e) => ({ id: e.id, name: e.name, transport: e.transport, url: e.url, enabled: e.enabled, hasToken: !!e.token, tokenLast4: e.token ? e.token.slice(-4) : undefined })) });
      }
      if (p === "/api/mcp/remove" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); removeMcpServer(String(b.id ?? "")); backend.restart(); return json({ ok: true }); }
      if (p === "/api/mcp/toggle" && req.method === "POST") { const b = await readBody<{ id?: unknown; enabled?: unknown }>(req); setMcpServerEnabled(String(b.id ?? ""), !!b.enabled); backend.restart(); return json({ ok: true }); }
      // P-AGENTFW.2 (ADR-0149): remote ACP agent (hermes/openclaw) connections the firewall proxies to. The
      // registry stores command/args (NOT secrets — prefer --token-file); a change respawns omp so enabled
      // connections attach as `agentfw-*` MCP servers on the next session.
      if (p === "/api/agents") {
        if (req.method === "POST") {
          const b = await readBody<{ id?: string; name?: unknown; kind?: unknown; command?: unknown; args?: unknown; cwd?: unknown; remoteUrl?: unknown; permissionPolicy?: unknown; enabled?: boolean }>(req);
          const kind = b.kind === "hermes" || b.kind === "openclaw" ? b.kind : "acp";
          const args = Array.isArray(b.args) ? b.args.map((a) => String(a)) : typeof b.args === "string" ? b.args.split(/\s+/).filter(Boolean) : [];
          const e = upsertRemoteAgent({ id: b.id, name: String(b.name ?? ""), kind, command: String(b.command ?? ""), args, cwd: b.cwd != null ? String(b.cwd) : undefined, remoteUrl: b.remoteUrl != null ? String(b.remoteUrl) : undefined, permissionPolicy: b.permissionPolicy === "allow" ? "allow" : "deny", enabled: b.enabled });
          backend.restart();
          return json({ ok: true, data: { id: e.id, name: e.name, kind: e.kind, command: e.command, args: e.args, remoteUrl: e.remoteUrl, permissionPolicy: e.permissionPolicy ?? "deny", enabled: e.enabled } });
        }
        return json({ ok: true, data: listRemoteAgents().map((e) => ({ id: e.id, name: e.name, kind: e.kind, command: e.command, args: e.args, remoteUrl: e.remoteUrl, permissionPolicy: e.permissionPolicy ?? "deny", enabled: e.enabled })) });
      }
      if (p === "/api/agents/remove" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); removeRemoteAgent(String(b.id ?? "")); backend.restart(); return json({ ok: true }); }
      if (p === "/api/agents/toggle" && req.method === "POST") { const b = await readBody<{ id?: unknown; enabled?: unknown }>(req); setRemoteAgentEnabled(String(b.id ?? ""), !!b.enabled); backend.restart(); return json({ ok: true }); }
      // P-NETWL.2 (ADR-0106): the curated network whitelist CRUD the Settings UI drives. The stored config is
      // NON-secret (domain/IP patterns + zone/scope + an opaque vaultRef); the actual secret lives in the
      // OS-encrypted credential vault (main-process safeStorage), never here. egressDecision reads this file to
      // auto-allow. upsertEntry sanitizes (a malformed entry is dropped → data:null signals rejection).
      if (p === "/api/whitelist") {
        if (req.method === "POST") {
          const b = await readBody<Partial<WhitelistEntry>>(req);
          const id = typeof b.id === "string" && b.id ? b.id : `wl_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
          // A project-scoped entry (e.g. an Agent Builder connection the user approved) binds to THIS workspace.
          const project = b.scope === "project" && !b.project ? currentWorkspace() : b.project;
          const store = upsertEntry(loadWhitelist(), { ...b, id, project } as WhitelistEntry);
          saveWhitelist(store);
          return json({ ok: true, data: store.entries.find((e) => e.id === id) ?? null });
        }
        return json({ ok: true, data: loadWhitelist().entries }); // entries carry no secret, only an opaque vaultRef
      }
      if (p === "/api/whitelist/remove" && req.method === "POST") { const b = await readBody<{ id?: unknown }>(req); saveWhitelist(removeEntry(loadWhitelist(), String(b.id ?? ""))); return json({ ok: true }); }
      // P-NETWL.5 (ADR-0108): the egress posture (allow-all + web-search toggles). GET returns the EFFECTIVE
      // posture (clamped by any managed policy) + `managedLocked` so the UI can lock the toggle for enterprises.
      if (p === "/api/whitelist/posture") {
        if (req.method === "POST") {
          const b = await readBody<{ allowAll?: unknown; allowWebSearch?: unknown }>(req);
          const patch: { allowAll?: boolean; allowWebSearch?: boolean } = {};
          if (typeof b.allowAll === "boolean") patch.allowAll = b.allowAll;
          if (typeof b.allowWebSearch === "boolean") patch.allowWebSearch = b.allowWebSearch;
          saveWhitelist(setPosture(loadWhitelist(), patch)); // stored raw; the effective value is clamped on read
          return json({ ok: true, data: { ...egressPosture(), managedLocked: egressAllowAllManaged() } });
        }
        return json({ ok: true, data: { ...egressPosture(), managedLocked: egressAllowAllManaged() } });
      }
      // ADR-0009 Phase D: developer-mode logging view. GET is gated server-side on developerMode
      // (returns null when off); POST {enabled} flips the mode. Read-only, metadata-only.
      if (p === "/api/dev") {
        if (req.method === "POST") {
          const b = await readBody<{ enabled?: unknown }>(req);
          const next = !!b.enabled;
          const changed = loadSettings().developerMode !== next;
          const data = setDeveloperMode(next);
          // P-ASKSAGE.1 (ADR-0059): the omp child reads LUCID_ASKSAGE_DEBUG only at spawn. Respawn on a
          // real change so toggling developer mode takes effect immediately (no app restart) — the fresh
          // omp picks up / drops the debug env. Same pattern as an API-key change (backend.restart()).
          if (changed) backend.restart();
          // Run the loopback/OAuth-callback watcher only while developer mode is on (it polls the OS).
          if (next) startNetdiagWatch(); else stopNetdiagWatch();
          return json({ ok: true, data });
        }
        if (!loadSettings().developerMode) return json({ ok: true, data: { enabled: false, snapshot: null, blocks: { quarantined: [], approved: [], total: 0 }, turns: [], asksage: [], gate: [], netdiag: null } });
        ensureNetdiagWatch(); // self-heal: live by the time the Logs panel (or boot-time loadDev) reads it
        return json({ ok: true, data: { enabled: true, snapshot: await devSnapshot(), blocks: liveBlocks(), turns: recentTurns(), asksage: backend.asksageDiagnostics(), gate: backend.gateDiagnostics(), audit: { events: audit.recent(60), sinks: audit.sinkStatuses() }, netdiag: netdiagView() } });
      }
      // Light, fast re-read of the provider rate-limit budget (omp's agent.db).
      // Used by the front-end's manual refresh + 5-minute auto-poll.
      if (p === "/api/budget") return json({ ok: true, data: rateLimits() });
      // P10.3: live rate-limit probe for API-KEY providers (opt-in). GET returns probed limits
      // (cached 5 min; [] when off); POST {enabled} flips the opt-in.
      if (p === "/api/ratelimits") {
        if (req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); return json({ ok: true, data: setRateLimitProbe(!!b.enabled) }); }
        return json({ ok: true, data: { enabled: !!loadSettings().rateLimitProbe, limits: await probeRateLimits(url.searchParams.get("force") === "1") } });
      }
      // P10.2: cross-model usage & cost ledger (per-model totals + estimated cache savings).
      if (p === "/api/usage") return json({ ok: true, data: usageLedgerMemo() }); // P-PERF.3 memo
      // ADR-0030 P-CODE.1: per-workspace git diffstat for the current month (repo
      // activity, not AI authorship). Read-only, metadata-only, fail-closed per workspace.
      // Cached 30s — each call spawns `git log` per workspace, so don't re-run it on
      // every dashboard poll. `?force=1` bypasses the cache (manual refresh).
      if (p === "/api/code-activity") {
        const now = Date.now();
        if (!codeActivityCache || now - codeActivityCache.at > 30_000 || url.searchParams.get("force") === "1")
          codeActivityCache = { at: now, data: codeActivity() };
        return json({ ok: true, data: codeActivityCache.data });
      }
      // P-PORTGUARD.1 (ADR-0305): echo the per-launch nonce main minted for THIS child. Main only
      // trusts a health answer carrying it, so a squatter on the port can never win the window. The
      // nonce gates nothing else, so echoing it leaks nothing (unlike LUCID_MAIN_TOKEN: NEVER here).
      if (p === "/api/health") return json({ ok: true, nonce: process.env.LUCID_ENGINE_NONCE ?? null });
      // P-ENT.2 (ADR-0069): the unified security-event stream (metadata-only, OCSF-ready) + per-sink
      // delivery status, for the in-app dashboard. Read-only; the file sink is the SIEM export source.
      if (p === "/api/audit") return json({ ok: true, data: { events: audit.recent(100), sinks: audit.sinkStatuses() } });
      // P-BRIEF.3 (ADR-0072): generate the Executive Engineering Update from the repo's own logs. Pure +
      // air-gap (reads DECISIONS.md/PROGRESS.md from the repo root); returns the written brief + the
      // two-host podcast script. Audio synthesis (a TTS backend) is a later slice; this is the brief.
      if (p === "/api/brief") {
        // P-REPORT.1 (ADR-0116): `?role=` tailors which sections lead + the framing; `?save=1` persists the
        // brief to the report store (so the Reports panel lists it). The goal-modal preview omits save.
        // P-REPORT.9 (ADR-0162): a POST body `{ role, save, repos, window }` additionally aggregates recent
        // commits + PRs across the SELECTED repos (fetched read-only) into a Cross-repo activity annex.
        const body = req.method === "POST" ? await readBody<{ role?: unknown; save?: unknown; repos?: unknown; window?: unknown }>(req) : {};
        const roleRaw = url.searchParams.get("role") ?? (body.role != null ? String(body.role) : null);
        const role: BriefRole | undefined = roleRaw === "developer" || roleRaw === "security" || roleRaw === "manager" || roleRaw === "executive" ? roleRaw : undefined;
        const repo = REPO_DIR;
        const rd = (f: string) => { try { return existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : ""; } catch { return ""; } };
        const u = buildEngineeringUpdate({ label: "LucidAgentIDE", progressMd: rd("PROGRESS.md"), decisionsMd: rd("DECISIONS.md") });
        const counts = { shipped: u.recentlyShipped.length, loadBearing: u.loadBearingDependencies.length, techDebt: u.techDebt.length, decisions: u.upcomingDecisions.length, risks: u.risks.length };
        let brief = renderEngineeringBrief(u, role);
        // P-REPORT.8: technical audiences (developer/security) get the change-annotated dependency graph +
        // schema-change annexes appended (page-broken in print). Non-technical roles skip them.
        if (role === "developer" || role === "security") {
          const gi = gitChangeInputs(repo);
          brief += "\n\n" + renderAnnexes(buildChangeGraph(gi.numstat, gi.nameStatus, gi.range), buildSchemaChanges(gi.numstat, gi.nameStatus));
        }
        // P-REPORT.9: cross-repo activity annex, only when repos were selected (POST). Fetch is read-only;
        // the annex is appended for ALL roles (it's the whole point of selecting extra repos).
        const rawRepos = Array.isArray(body.repos) ? (body.repos as unknown[]) : [];
        const sel: RepoSelection[] = rawRepos
          .map((r) => (r && typeof r === "object" ? r as Record<string, unknown> : {}))
          .filter((r) => typeof r.path === "string" && r.path)
          .map((r) => ({ path: String(r.path), fetch: r.fetch !== false, prs: r.prs === true }));
        if (sel.length) {
          const window = Number(body.window) || 10;
          const activities = await collectRepoActivity(sel, { fetch: true, prs: false, window });
          brief += "\n\n" + renderRepoActivityAnnex(activities);
        }
        const doSave = url.searchParams.get("save") === "1" || body.save === true;
        const savedRel = doSave ? saveBrief(Date.now().toString(36), role ?? "executive", brief) : null;
        return json({ ok: true, data: { brief, scriptText: renderScript(buildPodcastScript(u, role)), counts, role: role ?? "", savedRel } });
      }
      // P-REPORT.9 (ADR-0162): the candidate repos for a report (workspace ∪ recents ∪ report-only tracked)
      // + whether `gh` is authenticated (drives the PR toggle). Read-only; safe to poll.
      if (p === "/api/report/repos") return json({ ok: true, data: { repos: await listReportRepos(), ghAuth: await ghAvailable() } });
      // Add a report-target repo by local path or clone URL. Does NOT change the active workspace.
      if (p === "/api/report/repos/add" && req.method === "POST") {
        const b = await readBody<{ path?: unknown; url?: unknown }>(req);
        const r = await addReportRepo({ path: b.path != null ? String(b.path) : undefined, url: b.url != null ? String(b.url) : undefined });
        return json({ ok: r.ok, data: { repos: await listReportRepos(), ghAuth: await ghAvailable(), error: r.error } });
      }
      // P-REPORT.8: STIG Viewer .ckl export of the security control crosswalk (native XML checklist).
      if (p === "/api/brief/ckl") {
        const repo = REPO_DIR;
        const rd = (f: string) => { try { return existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : ""; } catch { return ""; } };
        const u = buildEngineeringUpdate({ label: "LucidAgentIDE", progressMd: rd("PROGRESS.md"), decisionsMd: rd("DECISIONS.md") });
        const ckl = renderCkl(u, "LucidAgentIDE");
        return json({ ok: true, data: { ckl, rows: buildComplianceRows(u).length, filename: "lucidagentide-crosswalk.ckl" } });
      }
      // P-REPORT.6: POA&M export - the security control crosswalk as an eMASS-aligned POA&M CSV.
      if (p === "/api/brief/poam") {
        const repo = REPO_DIR;
        const rd = (f: string) => { try { return existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : ""; } catch { return ""; } };
        const u = buildEngineeringUpdate({ label: "LucidAgentIDE", progressMd: rd("PROGRESS.md"), decisionsMd: rd("DECISIONS.md") });
        const csv = renderPoamCsv(u, "LucidAgentIDE");
        const rows = buildComplianceRows(u).length;
        return json({ ok: true, data: { csv, rows, filename: "lucidagentide-poam.csv" } });
      }
      // P-CHAT.C (ADR-0190): generate a Model-Evaluation engineering report for a just-settled chat turn.
      // The renderer POSTs what it OBSERVED that turn (tool calls + per-file diffstats + tokens/cost/
      // failures); we map it to evals.ts's RunRecord + render the reused Model-Evaluation markdown
      // (harness/brief/eval_report.ts), then SAVE it to the brief store so it lists in the Reports panel
      // (kind=brief, role=evals) and the settled turn's "Open in Reports" link opens it. Fields are coerced
      // defensively - a lossy/hostile payload can never yield a negative LOC or a NaN metric (pure guard).
      if (p === "/api/eval/report" && req.method === "POST") {
        const b = await readBody<Partial<ObservedTurn>>(req);
        const tools: ObservedTool[] = Array.isArray(b.tools)
          ? b.tools.filter((x): x is ObservedTool => !!x && typeof (x as ObservedTool).name === "string").map((x) => ({
              name: String(x.name),
              path: x.path != null ? String(x.path) : undefined,
              add: x.add != null ? Number(x.add) : undefined,
              del: x.del != null ? Number(x.del) : undefined,
            }))
          : [];
        const failures = Array.isArray(b.failures)
          ? b.failures.filter((f): f is NonNullable<ObservedTurn["failures"]>[number] => !!f && typeof f.tool === "string").map((f) => ({ tool: String(f.tool), reason: String(f.reason ?? ""), cmd: f.cmd != null ? String(f.cmd) : undefined }))
          : [];
        const turn: ObservedTurn = {
          runId: typeof b.runId === "string" && b.runId ? b.runId : String(Date.now()),
          model: typeof b.model === "string" && b.model ? b.model : "model",
          ctxTokens: Number(b.ctxTokens) || 0,
          outputTokens: Number(b.outputTokens) || 0,
          totalTokens: Number(b.totalTokens) || 0,
          costUsd: Number(b.costUsd) || 0,
          tools, failures,
          subagents: b.subagents != null ? Number(b.subagents) : undefined,
          when: typeof b.when === "string" ? b.when : undefined,
        };
        const { title, markdown } = renderTurnEvalReport(turn);
        // P-EVAL.3 (ADR-0187): persist this run's metrics to the append-only sink; the single writer ingests
        // them into eval_metrics for the cross-run rollup. Guarded + fail-open inside recordEvalMetrics.
        recordEvalMetrics(evalMetricsForTurn(turn), Date.now());
        const id = String(Date.now());
        const rel = saveBrief(id, "evals", markdown);
        return json({ ok: !!rel, data: { kind: "brief", id, rel, title }, error: rel ? undefined : "could not save report" });
      }
      // P-EVAL.3 Part B (ADR-0187): the CROSS-RUN Model-Evaluation rollup. The per-run metrics + API-latency
      // ledgers are GUI-owned append-only JSONL (the GUI can't co-write agent_obs.duckdb), so on demand we
      // ingest them into a THROWAWAY DuckDB the GUI owns (no write-lock contention), query via the same
      // readers, aggregate per model (means over runs-with-signal, honest null-not-zero) + roll latency into
      // per-model p50/p95, render the combined ASCII markdown the P-REPORT.4 viewer bar-ifies, and save it as
      // an `evals` brief (so it lists + opens in Reports). An empty ledger -> a friendly report, never an error.
      if (p === "/api/eval/rollup" && req.method === "POST") {
        const scratch = mkdtempSync(join(tmpdir(), "lucid-evalrollup-"));
        const db = await Db.open(join(scratch, "rollup.duckdb"));
        try {
          if (existsSync(EVAL_METRICS_LOG_PATH)) await ingestEvalMetrics(db, EVAL_METRICS_LOG_PATH);
          if (existsSync(LATENCY_LOG_PATH)) await ingestLatency(db, LATENCY_LOG_PATH);
          const rows = await readEvalMetricsRows(db);
          let markdown = renderEvalMetricsRollupMarkdown(rows);
          const calls = await readLatencyCalls(db); // ok-only by default
          if (calls.length) {
            const roll = rollupLatency(calls, { period: "weekly", periodStart: Date.now(), metric: "ttft" });
            if (roll.models.length) markdown += "\n\n" + renderLatencyRollupMarkdown(roll);
          }
          const id = String(Date.now());
          const rel = saveBrief(id, "evals", markdown);
          return json({ ok: !!rel, data: { kind: "brief", id, rel, title: "Model Evaluation Rollup" }, error: rel ? undefined : "could not save report" });
        } finally { db.close(); rmSync(scratch, { recursive: true, force: true }); }
      }
      // P-REPORT.1 (ADR-0116): the unified Reports list - per-workspace loop AARs + repo-wide saved briefs,
      // most-recent first. GET `/api/report?kind=aar|brief&rel=` reads one (confined to its store).
      if (p === "/api/reports") {
        const archived = url.searchParams.get("archived") === "1"; // P-REPORT.2: the archive view
        const aars = listGoalReports(currentWorkspace(), 50, archived).map((r) => ({ kind: "aar" as const, id: r.id, title: r.goal, outcome: r.outcome, role: "", updatedAt: r.updatedAt, rel: r.rel }));
        const briefs = listBriefs(50, archived).map((b) => ({ kind: "brief" as const, id: b.id, title: b.title, outcome: "", role: b.role, updatedAt: b.updatedAt, rel: b.rel }));
        return json({ ok: true, data: [...aars, ...briefs].sort((a, b) => b.updatedAt - a.updatedAt) });
      }
      if (p === "/api/report") {
        const kind = url.searchParams.get("kind"); const rel = url.searchParams.get("rel") ?? "";
        const archived = url.searchParams.get("archived") === "1";
        const md = kind === "brief" ? readBrief(rel, archived) : readGoalReport(currentWorkspace(), rel);
        return md != null ? json({ ok: true, data: { kind, rel, markdown: md } }) : json({ ok: false, error: "report not found" });
      }
      // P-REPORT.2 (ADR-0117): two-stage lifecycle. `archive` = soft-delete (active → Archive); `restore` =
      // Archive → active; `delete` = PERMANENT and only ever operates on an archived item (the second delete).
      if (p === "/api/report/archive" && req.method === "POST") {
        const b = await readBody<{ kind?: unknown; rel?: unknown }>(req); const rel = String(b.rel ?? "");
        const ok = b.kind === "brief" ? archiveBrief(rel) : archiveGoalReport(currentWorkspace(), rel);
        return json({ ok: true, data: { archived: ok } });
      }
      if (p === "/api/report/restore" && req.method === "POST") {
        const b = await readBody<{ kind?: unknown; rel?: unknown }>(req); const rel = String(b.rel ?? "");
        const ok = b.kind === "brief" ? restoreBrief(rel) : restoreGoalReport(currentWorkspace(), rel);
        return json({ ok: true, data: { restored: ok } });
      }
      if (p === "/api/report/delete" && req.method === "POST") {
        const b = await readBody<{ kind?: unknown; rel?: unknown }>(req); const rel = String(b.rel ?? "");
        const ok = b.kind === "brief" ? deleteBrief(rel) : deleteGoalReport(currentWorkspace(), rel);
        return json({ ok, data: { deleted: ok }, error: ok ? undefined : "only archived reports can be permanently deleted" });
      }
      // P-REPORT.3 (ADR-0117): push a report into the personalization KG as ONE trusted node, in the chosen
      // compartment. `scope` must be an unlocked compartment (the store enforces cui isolation, fail-closed).
      if (p === "/api/report/to-kg" && req.method === "POST") {
        const b = await readBody<{ kind?: unknown; rel?: unknown; scope?: unknown; archived?: unknown }>(req);
        const kind = b.kind === "brief" ? "brief" : "aar", rel = String(b.rel ?? "");
        const scope: PersonalScope = b.scope === "work" || b.scope === "cui" ? b.scope : "personal";
        const md = kind === "brief" ? readBrief(rel, !!b.archived) : readGoalReport(currentWorkspace(), rel);
        if (md == null) return json({ ok: false, error: "report not found" });
        const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? (kind === "brief" ? "Engineering Update" : "After-Action Report");
        const r = addReportToKg(scope, title, md);
        return json({ ok: r.ok, data: r, error: r.error });
      }
      // P-KG-CODE.1: the workspace CODE graph (file → import dependency graph). GET = status + the stored
      // graph (nodes/edges) if already ingested; POST = ingest/re-sync the cwd and return the fresh graph.
      if (p === "/api/codegraph") {
        const root = currentWorkspace();
        // P-KG-SYM.1: `level` = file (import graph) | symbol (AST call/reference graph).
        const bodyLevel = req.method === "POST" ? (await readBody<{ level?: unknown }>(req)).level : url.searchParams.get("level");
        const level = bodyLevel === "symbol" ? "symbol" : "file";
        if (req.method === "POST") {
          if (level === "symbol") { const g = ingestSymbolGraph(root); return json({ ok: true, data: { level, ingested: true, root, fileCount: g.fileCount, symbolCount: g.symbolCount, edgeCount: g.edgeCount, updatedAt: g.updatedAt, nodes: g.nodes, edges: g.edges } }); }
          const g = ingestCodeGraph(root); return json({ ok: true, data: { level, ingested: true, root, fileCount: g.fileCount, symbolCount: 0, edgeCount: g.edgeCount, updatedAt: g.updatedAt, nodes: g.nodes, edges: g.edges } });
        }
        const g = level === "symbol" ? loadSymbolGraph(root) : loadCodeGraph(root);
        const symCount = level === "symbol" ? ((g as { symbolCount?: number } | null)?.symbolCount ?? 0) : 0;
        return json({ ok: true, data: { level, ingested: !!g, root, fileCount: g?.fileCount ?? 0, symbolCount: symCount, edgeCount: g?.edgeCount ?? 0, updatedAt: g?.updatedAt ?? 0, nodes: g?.nodes ?? [], edges: g?.edges ?? [] } });
      }
      // P-KG-SYM.1: expose the code graph to the agent (adds the `codegraph_query` omp tool). POST restarts
      // the backend so the extension loads/unloads; GET reports the current setting.
      if (p === "/api/codegraph/agent") {
        if (req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); setCodeGraphAgent(!!b.enabled); backend.restart(); return json({ ok: true, data: { enabled: !!b.enabled } }); }
        return json({ ok: true, data: { enabled: !!loadSettings().codeGraphAgent } });
      }
      // P-AGENT.2b (ADR-0133): Agent Builder spec persistence as workspace files (.omp/agents/). GET = list
      // all specs (or one via ?id=); POST body {spec} = validate-then-save FAIL-CLOSED (an invalid spec is
      // refused, never written). The engine writes workspace files here because it holds agent_obs.duckdb
      // READ-ONLY (omp's gate child is the DB writer) — so authored specs live with the workspace.
      if (p === "/api/agent") {
        const root = currentWorkspace();
        if (req.method === "POST") {
          const b = await readBody<{ spec?: unknown }>(req);
          const v = validateSpec(b.spec);
          if (!v.ok) return json({ ok: false, error: v.errors.join("; "), data: { errors: v.errors } });
          try {
            saveSpecFile(root, v.spec!);
            return json({ ok: true, data: { saved: true, spec_id: v.spec!.spec_id } });
          } catch (e) {
            return json({ ok: false, error: clientError(e, "could not save the agent spec") });
          }
        }
        const id = url.searchParams.get("id");
        if (id) return json({ ok: true, data: { spec: loadSpecFile(root, id) } });
        return json({ ok: true, data: { specs: listSpecFiles(root) } });
      }
      if (p === "/api/agent/delete" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        const deleted = typeof b.id === "string" ? deleteSpecFile(currentWorkspace(), b.id) : false;
        return json({ ok: true, data: { deleted } });
      }
      // P-LOCAL.3 (ADR-0135): Local Providers CRUD. Declarations only — the API key lives in the OS-encrypted
      // vault (stored via the credStore IPC in the desktop app), never through this route. upsert validates
      // fail-closed (an invalid provider is refused, never persisted).
      if (p === "/api/local-providers") {
        if (req.method === "POST") {
          const b = await readBody<{ provider?: unknown }>(req);
          try {
            const saved = upsertLocalProvider(b.provider as LocalProviderDef);
            return json({ ok: true, data: { saved: true, id: saved.id } });
          } catch (e) {
            const msg = clientError(e, "could not save the provider");
            return json({ ok: false, error: msg, data: { errors: [msg] } });
          }
        }
        return json({ ok: true, data: { providers: listLocalProviders() } });
      }
      if (p === "/api/local-providers/delete" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        if (typeof b.id === "string") removeLocalProvider(b.id);
        return json({ ok: true, data: { deleted: true } });
      }
      if (p === "/api/local-providers/enable" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; enabled?: unknown }>(req);
        if (typeof b.id === "string") setLocalProviderEnabled(b.id, !!b.enabled);
        return json({ ok: true, data: { ok: true } });
      }
      // P-LOCAL.3 polish: reachability/TLS probe. Hits the OpenAI-compatible /models endpoint with a short
      // timeout and NO key (the vault secret never leaves main) — any HTTP response (even 401/403) proves the
      // host is reachable + the TLS handshake succeeded; a network/TLS/timeout error means it's not.
      // P-FIGMA.1 (ADR-0154): import a Figma file's frames as inlined PNGs into a local design-board HTML,
      // loaded through the normal preview pipeline. The PAT is used SERVER-side only (from the request on the
      // first import, or LUCID_FIGMA_TOKEN injected from the vault by main); it never returns to renderer/agent.
      if (p === "/api/figma/import" && req.method === "POST") {
        const fail = (error: string) => json({ ok: false, error, data: { error } }); // error rides in data (post() unwraps .data)
        const b = await readBody<{ fileUrl?: unknown; pat?: unknown }>(req);
        const pat = typeof b.pat === "string" && b.pat.trim() ? b.pat.trim() : (process.env.LUCID_FIGMA_TOKEN ?? "");
        if (!pat) return fail("Enter a Figma personal access token.");
        const key = parseFigmaFileKey(String(b.fileUrl ?? ""));
        if (!key) return fail("That doesn't look like a Figma file URL or key.");
        try {
          const hdr = { headers: { "X-Figma-Token": pat } };
          const fileRes = await fetch(`${FIGMA_API}/files/${key}?depth=2`, { ...hdr, signal: AbortSignal.timeout(20000) });
          if (fileRes.status === 403) return fail("Figma rejected the token (403) — check the PAT and that it can read this file.");
          if (fileRes.status === 404) return fail("Figma file not found (404) — check the file URL/key.");
          if (!fileRes.ok) return fail(`Figma API error ${fileRes.status}.`);
          const file = (await fileRes.json()) as { name?: string; document?: unknown };
          const fileName = String(file?.name ?? "Figma file").slice(0, 200); // bound the network-derived title we persist
          const frames = collectTopFrames(file?.document as never);
          let board: BoardFrame[] = [];
          if (frames.length) {
            const ids = frames.map((f) => f.id).join(",");
            const imgRes = await fetch(`${FIGMA_API}/images/${key}?ids=${encodeURIComponent(ids)}&format=png&scale=2`, { ...hdr, signal: AbortSignal.timeout(25000) });
            // external API reply: narrow the images map with a guard instead of trusting the shape
            let imgMap: Record<string, string | null> = {};
            if (imgRes.ok) {
              const parsed: unknown = await imgRes.json();
              if (parsed && typeof parsed === "object" && "images" in parsed && parsed.images && typeof parsed.images === "object") {
                imgMap = parsed.images as Record<string, string | null>; // Figma /images contract: id → url | null
              }
            }
            const MAX_IMG_BYTES = 8 * 1024 * 1024; // cap per-frame render we inline + persist to disk
            board = await Promise.all(frames.map(async (f) => {
              const src = imgMap[f.id];
              let dataUrl = "";
              // The render URL comes from Figma's API response (network-controlled / untrusted, CodeQL
              // js/http-to-file-access): fetch it ONLY when it's an https URL (no file://, http://localhost,
              // or other SSRF targets) and BOUND the bytes we inline + write to the local board file.
              if (typeof src === "string" && /^https:\/\//i.test(src)) {
                try {
                  const r = await fetch(src, { signal: AbortSignal.timeout(20000) });
                  const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
                  if (buf && buf.length > 0 && buf.length <= MAX_IMG_BYTES) dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
                } catch { /* leaves a placeholder */ }
              }
              return { name: f.name, page: f.page, dataUrl };
            }));
          }
          const dir = join(currentWorkspace(), ".omp", "figma");
          mkdirSync(dir, { recursive: true });
          const outPath = join(dir, `${key}.html`);
          writeFileSync(outPath, figmaBoardHtml(fileName, board), "utf8");
          // P-FIGMA.2: tell the UI whether this project already has a DESIGN.md, to drive the guided next step.
          const hasDesign = existsSync(designDocPath(currentWorkspace()));
          return json({ ok: true, data: { path: outPath, fileName, frames: board.length, hasDesign } });
        } catch (e) {
          return fail(clientError(e, "Couldn't import the Figma file — check the file URL/key and that your token can read it."));
        }
      }
      // P-FIGMA.2 / P-DESIGN.1 (ADR-0154): read the workspace DESIGN.md so the renderer can pop it out in the
      // Monaco IDE for the user to review/edit. Content only — the agent honors it via the preamble (P-DESIGN.1).
      if (p === "/api/design") {
        const dp = designDocPath(currentWorkspace());
        const exists = existsSync(dp);
        let content = "";
        if (exists) { try { content = readFileSync(dp, "utf8"); } catch { /* leave empty */ } }
        return json({ ok: true, data: { exists, path: dp, name: DESIGN_DOC_NAME, content } });
      }
      if (p === "/api/local-providers/test" && req.method === "POST") {
        const b = await readBody<{ baseUrl?: unknown }>(req);
        const target = typeof b.baseUrl === "string" ? providerModelsUrl(b.baseUrl) : null;
        if (!target) return json({ ok: true, data: { reachable: false, error: "invalid base URL" } });
        try {
          const r = await fetch(target, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(4500) });
          return json({ ok: true, data: { reachable: true, status: r.status, authed: r.status === 401 || r.status === 403 } });
        } catch (e) {
          return json({ ok: true, data: { reachable: false, error: clientError(e, "not reachable — check the URL and that the endpoint is up") } });
        }
      }
      // P-AGENT.6: enterprise export — compile the spec + write a portable, tamper-evident bundle (with a
      // SHA-256 content digest) for a deploy target under .omp/agent-exports/<spec_id>/<target>/. Fail-closed:
      // an invalid spec is refused before anything is compiled or written.
      if (p === "/api/agent/export" && req.method === "POST") {
        const b = await readBody<{ spec?: unknown; target?: unknown }>(req);
        const v = validateSpec(b.spec);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; ") });
        const target: ExportTarget = (EXPORT_TARGETS as readonly string[]).includes(b.target as string) ? (b.target as ExportTarget) : "electron";
        try {
          const pkg = exportBundle(buildAgent(v.spec!), target);
          const dir = join(currentWorkspace(), ".omp", "agent-exports", v.spec!.spec_id, target);
          const written = writeExportPackage(pkg, dir);
          return json({ ok: true, data: { dir, target, digest: pkg.manifest.digest, files: written.length } });
        } catch (e) {
          return json({ ok: false, error: clientError(e, "could not export the agent bundle") });
        }
      }
      // P-AGENT.9: SHARE — write a portable .lucid-agent.json (spec + setup guidance + spec digest; NEVER
      // credential values) under .omp/agent-shares/ and return the JSON so the renderer can offer a download.
      if (p === "/api/agent/share" && req.method === "POST") {
        const b = await readBody<{ spec?: unknown }>(req);
        const v = validateSpec(b.spec);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; "), data: { error: v.errors.join("; ") } });
        try {
          const file = exportPortableAgent(v.spec!);
          const dir = join(currentWorkspace(), ".omp", "agent-shares");
          mkdirSync(dir, { recursive: true });
          const base = v.spec!.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "agent";
          const fileName = `${base}.lucid-agent.json`;
          const text = `${JSON.stringify(file, null, 2)}\n`;
          writeFileSync(join(dir, fileName), text);
          writeFileSync(join(dir, `${base}.SETUP.md`), file.setup_md);
          return json({ ok: true, data: { path: join(dir, fileName), fileName, json: text, setup: file.setup_md, digest: file.spec_digest } });
        } catch (e) {
          const msg = clientError(e, "could not write the agent share");
          return json({ ok: false, error: msg, data: { error: msg } });
        }
      }
      // P-AGENT.9/.10: IMPORT — accepts BOTH share formats: a portable .lucid-agent.json (digest-checked)
      // and a raw n8n workflow JSON (translated; an embedded LUCID block wins for lossless round-trip). Either
      // way the result runs the P-AGENT.5 quarantine gate (scanner sidecar, FAIL-CLOSED: scan unavailable =>
      // quarantined, never "safe") and persists WITH its trust label; non-trusted can't run until approved.
      if (p === "/api/agent/import" && req.method === "POST") {
        const b = await readBody<{ raw?: unknown }>(req);
        const raw = typeof b.raw === "string" ? b.raw : "";
        let specJson: string | null = null;
        let importNotes: string[] = [];
        const portable = parsePortableAgentJson(raw);
        if (portable.ok && portable.spec) {
          specJson = JSON.stringify(portable.spec);
        } else {
          try {
            const parsedRaw: unknown = JSON.parse(raw);
            if (isN8nWorkflowJson(parsedRaw)) {
              const conv = n8nToSpec(parsedRaw);
              importNotes = conv.notes;
              if (conv.embeddedPortableJson) {
                const embedded = parsePortableAgentJson(conv.embeddedPortableJson);
                if (!embedded.ok || !embedded.spec) { const msg = `embedded LUCID agent is invalid: ${embedded.errors.join("; ")}`; return json({ ok: false, error: msg, data: { error: msg } }); }
                specJson = JSON.stringify(embedded.spec);
              } else if (conv.spec) {
                specJson = JSON.stringify(conv.spec);
              }
            }
          } catch { /* not JSON at all — falls through to the honest error below */ }
        }
        if (!specJson) { const msg = portable.errors.join("; ") || "not a portable LUCID agent or an n8n workflow"; return json({ ok: false, error: msg, data: { error: msg } }); }
        return json(await gatedAgentImport(specJson, importNotes));
      }
      // P-AGENT.17: revision history — snapshots written on every save; restore re-saves an old revision as
      // the CURRENT spec (itself snapshotted, so restores are undoable). The trust sidecar is untouched:
      // trust applies to the spec identity, and restoring an untrusted import keeps it untrusted.
      if (p === "/api/agent/history") {
        const id = url.searchParams.get("id") ?? "";
        return json({ ok: true, data: { revisions: listSpecHistory(currentWorkspace(), id) } });
      }
      if (p === "/api/agent/history/restore" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; ts?: unknown }>(req);
        const id = typeof b.id === "string" ? b.id : "";
        const rev = loadSpecRevision(currentWorkspace(), id, Number(b.ts));
        if (!rev) return json({ ok: false, error: "unknown or corrupted revision", data: { error: "unknown or corrupted revision" } });
        const restored = { ...rev, updated_at: Date.now() };
        saveSpecFile(currentWorkspace(), restored);
        return json({ ok: true, data: { spec: restored } });
      }
      // P-AGENT.17: the starter-template gallery — curated .lucid-agent.json files shipped in-repo. \"Use\"
      // routes through the STANDARD import path (scanner gate + trust + approval); curated ≠ exempt.
      if (p === "/api/agent/templates") {
        return json({ ok: true, data: { templates: listAgentTemplates() } });
      }
      if (p === "/api/agent/template-use" && req.method === "POST") {
        const b = await readBody<{ file?: unknown }>(req);
        const file = typeof b.file === "string" ? b.file : "";
        const tpl = listAgentTemplates().find((t) => t.file === file);
        if (!tpl) return json({ ok: false, error: "unknown template", data: { error: "unknown template" } });
        const parsed = parsePortableAgentJson(readFileSync(join(TEMPLATES_DIR, tpl.file), "utf8"));
        if (!parsed.ok || !parsed.spec) return json({ ok: false, error: parsed.errors.join("; "), data: { error: parsed.errors.join("; ") } });
        // fresh identity per use — two users of the same template edit independent agents
        const spec = { ...parsed.spec, spec_id: `agent_${crypto.randomUUID()}`, created_at: Date.now(), updated_at: Date.now() };
        return json(await gatedAgentImport(JSON.stringify(spec), [`created from template ${tpl.file}`]));
      }
      // P-AGENT.10: EXPORT FOR n8n — lower the spec into an importable n8n workflow scaffold (real wait
      // nodes for approvals; provenance sticky embeds the portable agent for lossless round-trip). Written
      // under .omp/agent-shares/ and returned for download. Never carries credential values.
      if (p === "/api/agent/n8n-export" && req.method === "POST") {
        const b = await readBody<{ spec?: unknown }>(req);
        const v = validateSpec(b.spec);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; "), data: { error: v.errors.join("; ") } });
        try {
          const portable = `${JSON.stringify(exportPortableAgent(v.spec!), null, 2)}\n`;
          const wf = specToN8n(v.spec!, portable);
          const dir = join(currentWorkspace(), ".omp", "agent-shares");
          mkdirSync(dir, { recursive: true });
          const base = v.spec!.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "agent";
          const fileName = `${base}.n8n.json`;
          const text = `${JSON.stringify(wf, null, 2)}\n`;
          writeFileSync(join(dir, fileName), text);
          const push = connectorStatus("n8n");
          return json({ ok: true, data: { path: join(dir, fileName), fileName, json: text, pushAvailable: push.installed, pushNote: push.note } });
        } catch (e) {
          const msg = clientError(e, "could not write the n8n workflow");
          return json({ ok: false, error: msg, data: { error: msg } });
        }
      }
      // P-AGENT.10: PUSH to a private hosted n8n — the CONNECTOR lives in the enterprise add-on
      // (lucidagentIDEaddon/connectors/n8n); this public seam exports the artifact and dispatches it. With
      // no add-on installed the reply is an honest "not installed" note, never a fake success.
      if (p === "/api/agent/n8n-push" && req.method === "POST") {
        const b = await readBody<{ spec?: unknown }>(req);
        const v = validateSpec(b.spec);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; "), data: { error: v.errors.join("; ") } });
        try {
          const portable = `${JSON.stringify(exportPortableAgent(v.spec!), null, 2)}\n`;
          const wf = specToN8n(v.spec!, portable);
          const dir = join(currentWorkspace(), ".omp", "agent-shares");
          mkdirSync(dir, { recursive: true });
          const base = v.spec!.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "agent";
          const file = join(dir, `${base}.n8n.json`);
          writeFileSync(file, `${JSON.stringify(wf, null, 2)}\n`);
          const r = runConnector("n8n", "push", file);
          return json({ ok: r.ok, data: { ok: r.ok, detail: r.detail, url: r.url ?? "" }, error: r.ok ? undefined : r.detail });
        } catch (e) {
          const msg = clientError(e, "could not push to n8n");
          return json({ ok: false, error: msg, data: { error: msg } });
        }
      }
      // P-AGENT.9: APPROVE — the explicit human-review step for an imported agent. untrusted/suspicious can
      // be promoted to trusted after review; a QUARANTINED spec stays blocked (fix the content + re-import).
      if (p === "/api/agent/trust" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        const id = typeof b.id === "string" ? b.id : "";
        if (!loadSpecFile(currentWorkspace(), id)) return json({ ok: false, error: "unknown agent id", data: { error: "unknown agent id" } });
        const cur = loadSpecTrust(currentWorkspace(), id);
        if (cur.trustLabel === "quarantined") {
          const msg = "this agent is quarantined (flagged content) — it cannot be approved; fix the source and re-import";
          return json({ ok: false, error: msg, data: { error: msg } });
        }
        saveSpecTrust(currentWorkspace(), id, { trustLabel: "trusted", reason: "approved by the user after review", reviewed_at: Date.now() });
        return json({ ok: true, data: { trustLabel: "trusted" } });
      }
      // P-AGENT.4-live: run a built agent one-shot through omp (gate + generated allow-list + compiled prompt).
      // Fail-closed: an invalid or non-runnable-trust spec is refused before anything spawns. Returns the
      // agent's final text (or a refusal/error). model defaults to a fast model for cheap runs.
      if (p === "/api/agent/run" && req.method === "POST") {
        const b = await readBody<{ spec?: unknown; prompt?: unknown; model?: unknown }>(req);
        const v = validateSpec(b.spec);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; ") });
        const prompt = typeof b.prompt === "string" ? b.prompt : "";
        const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : "haiku";
        // P-AGENT.9: run under the STORED trust label — an imported, not-yet-approved spec is refused here.
        // P-AGENT.11a: a spec with approval nodes runs SEGMENTED — it halts at each boundary and returns
        // `paused`; the human resumes via /api/agent/run/approve. The halt is enforced by the SegmentedRun
        // machine (the post-approval prompt does not exist until approve), not by model compliance.
        const trust = loadSpecTrust(currentWorkspace(), v.spec!.spec_id);
        // ADR-0218: honor AskSage lockdown on the Builder "Run" too - clamp to a gov model, or REFUSE (never
        // route a built-agent run to a direct provider) when lockdown is on but no gov model is available.
        const lockRes = backend.resolveAgentRunModel(model);
        if (!lockRes.ok) return json({ ok: false, data: { output: "", error: "", blocked: true, reason: lockRes.error ?? "AskSage lockdown", paused: null, runId: "" } });
        const r = await startAgentRun({ spec: v.spec!, prompt, model: lockRes.model || model, workspace: currentWorkspace(), trustLabel: trust.trustLabel });
        return json({ ok: r.ok, data: { output: r.output ?? "", error: r.error ?? "", blocked: !!r.blocked, reason: r.reason ?? "", paused: r.paused ?? null, runId: r.runId ?? "" } });
      }
      // P-AGENT.13: run traces — file-backed provenance under .omp/agent-runs/traces/ (the desktop holds
      // agent_obs.duckdb read-only, so files are the v1 store; see ADR-0141 delta note).
      // P-AGENT.12: the DYNAMIC half of the Builder's tool catalog: tools discovered from the user's
      // ENABLED MCP servers, under the exact `mcp__<server>_<tool>` names omp registers at runtime (so the
      // compiled allow-list matches). Fail-soft: unreachable servers report an error and the picker just
      // shows the built-ins; a probe can never break the Builder.
      if (p === "/api/agent/tools") {
        const results = await probeEnabledServers(listMcpServers());
        return json({
          ok: true,
          data: {
            tools: results.flatMap((r) => r.tools),
            servers: results.map((r) => ({ server: r.server, ok: r.ok, count: r.tools.length, error: r.error ?? "" })),
          },
        });
      }
      if (p === "/api/agent/traces") {
        const spec = url.searchParams.get("spec") ?? "";
        return json({ ok: true, data: { traces: listTraces(currentWorkspace(), spec || undefined) } });
      }
      if (p === "/api/agent/trace") {
        const id = url.searchParams.get("id") ?? "";
        return json({ ok: true, data: { trace: loadTrace(currentWorkspace(), id) } });
      }
      // P-AGENT.11a: resolve a parked approval checkpoint. Deny is terminal; unknown/expired ids refuse.
      if (p === "/api/agent/run/approve" && req.method === "POST") {
        const b = await readBody<{ runId?: unknown; approve?: unknown; reason?: unknown }>(req);
        const runId = typeof b.runId === "string" ? b.runId : "";
        const r = approveAgentRun(runId, b.approve === true, typeof b.reason === "string" ? b.reason : undefined);
        return json({ ok: r.ok, data: { output: r.output ?? "", error: r.error ?? "", blocked: !!r.blocked, reason: r.reason ?? "", paused: r.paused ?? null, runId: r.runId ?? "" } });
      }
      // P-APPEAR.1: the personalized chat-interface background (image + display mode). Its own file, so
      // the hot settings load() never parses the image data URL.
      if (p === "/api/chat-bg") {
        if (req.method === "POST") { const b = await readBody<Partial<ChatBg>>(req); const r = saveChatBg(b); return json({ ok: r.ok, data: r.ok ? r.data : null, error: r.error }); }
        return json({ ok: true, data: loadChatBg() });
      }
      // P-EXEC.3: "TLDR" - explain an intimidating command in plain terms via a cheap keyed model.
      if (p === "/api/explain" && req.method === "POST") {
        const b = await readBody<{ command?: unknown }>(req);
        const cmd = String(b.command ?? "");
        let r = await explainCommand(cmd); // direct keyed path first (cheapest, no session spawn)
        // P-EXEC.3 fix: OAuth-only users have NO direct API key - don't dead-end them. Route the SAME
        // inert-DATA prompt through the omp session (which holds the OAuth/key auth) with a cheap accessible
        // model. Uses the dedicated util connection, so it never clobbers the live chat turn.
        if (!r.ok && /Add an Anthropic/.test(r.error ?? "")) {
          const trimmed = cmd.trim();
          if (trimmed && trimmed.length <= 8000) {
            try {
              const model = backend.checkerModelInfo().recommended || undefined; // cheapest accessible (OAuth-safe)
              const text = (await backend.complete(EXPLAIN_SYSTEM, explainUserPrompt(trimmed), { model, idleMs: 20_000 })).trim();
              r = text
                ? { ok: true, text, model: model ? model.replace(/^[^/]*\//, "") : undefined }
                : { ok: false, error: "Could not explain right now. Make sure a provider is connected in Settings, then try again." };
            } catch { r = { ok: false, error: "Could not explain right now. Make sure a provider is connected in Settings, then try again." }; }
          }
        }
        return json({ ok: r.ok, data: r, error: r.error });
      }
      // P-BRIEF.4 (ADR-0113) + P-VOICE.1 (ADR-0115): SYNTHESIZE the podcast to WAV via a TTS backend,
      // returned base64 for the renderer to play + download. Providers:
      //   local-tts  → self-hosted Kokoro (air-gap; no key; LUCID_TTS_URL, default :8880)
      //   openai-tts → ChatGPT/OpenAI TTS (needs OPENAI_API_KEY)
      //   elevenlabs → ElevenLabs (needs ELEVENLABS_API_KEY; two-host uses the user's favorite voices)
      // Fail-safe: a missing key is an actionable note; a synth failure returns the note (never a 500).
      if (p === "/api/brief/audio" && req.method === "POST") {
        const b = await readBody<{ provider?: unknown; voiceId?: unknown }>(req);
        const provider = b.provider === "local-tts" ? "local-tts" : b.provider === "elevenlabs" ? "elevenlabs" : "openai-tts";
        const pickedVoice = typeof b.voiceId === "string" && b.voiceId ? b.voiceId : "";
        const repo = REPO_DIR;
        const rd = (f: string) => { try { return existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : ""; } catch { return ""; } };
        const script = buildPodcastScript(buildEngineeringUpdate({ label: "LucidAgentIDE", progressMd: rd("PROGRESS.md"), decisionsMd: rd("DECISIONS.md") }));
        let backend: PodcastBackend;
        if (provider === "local-tts") {
          backend = new OpenAiCompatibleTtsBackend({ baseUrl: process.env.LUCID_TTS_URL || "http://localhost:8880", model: process.env.LUCID_TTS_MODEL || "kokoro", voices: { Host: "af_heart", Engineer: "am_onyx", default: "af_heart" } });
        } else if (provider === "elevenlabs") {
          const key = process.env.ELEVENLABS_API_KEY;
          if (!key) return json({ ok: true, data: { note: "Add your ElevenLabs API key (Settings → Voice) to use ElevenLabs TTS.", audioB64: null, mime: "audio/wav", turns: 0 } });
          const v = voiceSettings();
          const host = pickedVoice || v.ttsVoice || v.ttsVoiceFavorites[0]; // the picker's choice wins for this run
          const engineer = v.ttsVoiceFavorites.find((id) => id !== host) || host;
          backend = new ElevenLabsTtsBackend({ apiKey: key, voices: { ...(host ? { Host: host } : {}), ...(engineer ? { Engineer: engineer } : {}), ...(host ? { default: host } : {}) } });
        } else {
          const key = process.env.OPENAI_API_KEY;
          if (!key) return json({ ok: true, data: { note: "Add your OpenAI API key (Providers → OpenAI) to use ChatGPT TTS, or choose Local TTS (Kokoro) / ElevenLabs.", audioB64: null, mime: "audio/wav", turns: 0 } });
          backend = new OpenAiCompatibleTtsBackend({ baseUrl: process.env.OPENAI_TTS_URL || "https://api.openai.com", apiKey: key, model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voices: { Host: "nova", Engineer: "onyx", default: "alloy" } });
        }
        const result = await backend.synthesize(script);
        const audioB64 = result.audio ? Buffer.from(result.audio).toString("base64") : null;
        return json({ ok: !!audioB64, data: { note: result.note, audioB64, mime: "audio/wav", turns: script.turns.length }, error: audioB64 ? undefined : result.note });
      }
      // P-VOICE.1 (ADR-0115): voice config (STT engine + TTS voice/favorites). GET reads; POST patches.
      if (p === "/api/voice-settings") {
        if (req.method === "POST") { const b = await readBody<Record<string, unknown>>(req); return json({ ok: true, data: setVoiceSettings(b as never) }); }
        return json({ ok: true, data: voiceSettings() });
      }
      // P-VOICE.1 + P-VOICE.2 (ADR-0247): list the selectable voices for ONE engine, so the picker works for
      // every engine rather than only ElevenLabs. OpenAI and Kokoro publish a FIXED voice set with no list
      // endpoint, so those come from the static catalog; ElevenLabs is per-account and fetched live.
      // `?provider=` previews another engine's voices without committing the setting.
      if (p === "/api/voices") {
        const v = voiceSettings();
        const provider = normalizeTtsProvider(url.searchParams.get("provider") || v.ttsProvider);
        const selected = resolveVoice(provider, provider === v.ttsProvider ? v.ttsVoice : "");
        const engines = await ttsEngines();
        const base = { provider, engines, favorites: v.ttsVoiceFavorites, selected, autoSpeak: v.ttsAutoSpeak, conversation: v.ttsConversation };
        if (provider !== "elevenlabs") return json({ ok: true, data: { ...base, voices: voicesForProvider(provider) } });
        const key = process.env.ELEVENLABS_API_KEY;
        if (!key) return json({ ok: true, data: { ...base, voices: [], note: "Add your ElevenLabs API key (Settings → Voice) to list voices." } });
        try { return json({ ok: true, data: { ...base, voices: await listElevenVoices({ apiKey: key }) } }); }
        catch (e) { return json({ ok: true, data: { ...base, voices: [], note: clientError(e, "Could not list voices — check the provider key/URL.") } }); }
      }
      // P-VOICE.1: transcribe recorded mic audio \u2192 text. Provider from settings: elevenlabs (cloud Scribe)
      // or whisper (offline OpenAI-compatible server). The transcript is ordinary user input (scanned on send).
      if (p === "/api/transcribe" && req.method === "POST") {
        const b = await readBody<{ audioB64?: unknown; mime?: unknown; language?: unknown }>(req);
        const audio = typeof b.audioB64 === "string" && b.audioB64 ? new Uint8Array(Buffer.from(b.audioB64, "base64")) : new Uint8Array();
        const r = await transcribeClip(audio, typeof b.mime === "string" ? b.mime : undefined, typeof b.language === "string" ? b.language : undefined);
        return json({ ok: true, data: r });
      }
      // P-STT.2b: the no-code managed offline-Whisper lifecycle (hardware-gated install / start / stop / status).
      if (p === "/api/whisper/status") return json({ ok: true, data: whisperRuntimeStatus(whisperDeps()) });
      if (p === "/api/whisper/install" && req.method === "POST") {
        const wb = await readBody<{ tier?: unknown }>(req);
        const rr = await installWhisper(whisperDeps(), typeof wb.tier === "string" ? (wb.tier as WhisperTier) : undefined, () => {});
        return json({ ok: rr.ok, data: rr, error: rr.reason });
      }
      if (p === "/api/whisper/start" && req.method === "POST") {
        const wb = await readBody<{ tier?: unknown }>(req);
        const rr = await startWhisper(whisperDeps(), { tier: typeof wb.tier === "string" ? (wb.tier as WhisperTier) : undefined });
        return json({ ok: rr.ok, data: rr, error: rr.reason });
      }
      if (p === "/api/whisper/stop" && req.method === "POST") { const rr = await stopWhisper(whisperDeps()); return json({ ok: rr.ok, data: rr }); }
      // P-STT.6 (ADR-0267): delete a downloaded model's weights (reclaim disk; the only path for the
      // no-longer-offered medium/large tiers). Fail-closed on the running tier - stop the server first.
      if (p === "/api/whisper/remove" && req.method === "POST") {
        const wb = await readBody<{ tier?: unknown }>(req);
        const rr = removeWhisperModel(whisperDeps(), (typeof wb.tier === "string" ? wb.tier : "") as WhisperTier);
        return json({ ok: rr.ok, data: rr, error: rr.reason });
      }
      // P-VOICE.1 + P-VOICE.2: read arbitrary text aloud (assistant replies, an AAR summary), selected voice.
      if (p === "/api/tts/speak" && req.method === "POST") {
        const b = await readBody<{ text?: unknown; voiceId?: unknown; provider?: unknown }>(req);
        const text = String(b.text ?? "").slice(0, 8000);
        if (!text.trim()) return json({ ok: true, data: { audioB64: null, mime: "audio/mpeg", note: "nothing to speak" } });
        const v = voiceSettings();
        const provider = typeof b.provider === "string" && b.provider ? normalizeTtsProvider(b.provider) : v.ttsProvider;
        try {
          // P-VOICE.2: the SAME readiness reason the picker shows, so a failure never contradicts the menu
          // (notably: an OpenAI OAuth sign-in cannot reach the speech API - only a platform key can).
          const status = (await ttsEngines()).find((e) => e.id === provider);
          if (status && !status.ready) return json({ ok: true, data: { audioB64: null, mime: "audio/mpeg", note: status.reason } });
          if (provider === "elevenlabs") {
            const key = process.env.ELEVENLABS_API_KEY!;
            const voiceId = (typeof b.voiceId === "string" && b.voiceId) || v.ttsVoice || v.ttsVoiceFavorites[0];
            const out = await elevenLabsSpeak(text, { apiKey: key, voiceId, format: "mp3" });
            return json({ ok: true, data: { audioB64: Buffer.from(out.audio).toString("base64"), mime: out.mime, note: "" } });
          }
          const kokoro = provider === "local-tts";
          const key = kokoro ? undefined : process.env.OPENAI_API_KEY; // presence guaranteed by the readiness check above
          // P-VOICE.2: honour the SELECTED voice (this was pinned to alloy/af_heart, which made the picker a
          // no-op for these engines). resolveVoice falls back to the engine default when the stored id
          // belongs to a different engine, so a mid-session provider switch can't 400 the request.
          const voice = resolveVoice(provider, (typeof b.voiceId === "string" && b.voiceId) || v.ttsVoice);
          const backend = new OpenAiCompatibleTtsBackend({ baseUrl: kokoro ? (process.env.LUCID_TTS_URL || "http://localhost:8880") : (process.env.OPENAI_TTS_URL || "https://api.openai.com"), apiKey: key, model: kokoro ? (process.env.LUCID_TTS_MODEL || "kokoro") : (process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"), voices: { default: voice } });
          const r = await backend.synthesize({ title: "read", turns: [{ speaker: "default", text }] });
          const audioB64 = r.audio ? Buffer.from(r.audio).toString("base64") : null;
          return json({ ok: true, data: { audioB64, mime: "audio/wav", note: audioB64 ? "" : r.note } });
        } catch (e) {
          return json({ ok: true, data: { audioB64: null, mime: "audio/mpeg", note: clientError(e, "TTS failed — check the provider key/URL.") } });
        }
      }
      // In-app folder browser (works in the browser build AND Electron). Full-tree traversal
      // (ADR-0103/P-FS.1, superseding ADR-0022 M1): the local authenticated user can browse anywhere on
      // the machine, optionally confined to an org's managed `workspaceRoots`. The endpoint stays behind
      // ADR-0022's still-intact transport gates — loopback bind (H1) + Origin/Host/CSRF + token (H2).
      if (p === "/api/fs/list") {
        return json({ ok: true, data: listDir(url.searchParams.get("path"), { allowedRoots: managedWorkspaceRoots() }) });
      }
      // P-FS.2 (ADR-0265): open the REAL OS folder dialog from the browser build. The GUI server runs on
      // the same machine as the browser (loopback bind, H1), so it shows Explorer / Finder / zenity itself
      // and returns the chosen path. `supported:false` = headless or no dialog binary; the renderer then
      // falls back to the in-app browser (ADR-0103). A CANCEL is `supported:true, path:null` and the
      // renderer must NOT re-prompt. POST: it blocks on user interaction and must never be cacheable.
      if (p === "/api/fs/pickfolder" && req.method === "POST") {
        const b = await readBody<{ title?: unknown; buttonLabel?: unknown }>(req);
        const r = await pickFolderNative({
          title: typeof b.title === "string" ? b.title : undefined,
          buttonLabel: typeof b.buttonLabel === "string" ? b.buttonLabel : undefined,
        });
        return json({ ok: true, data: r });
      }
      // P-PREVIEW.3b (ADR-0096): may a remote URL load in the preview iframe? Reuses the egress allow-list /
      // managed ceiling (ADR-0062/0094) — a remote preview reaches the internet, so it only loads for a site
      // the user already approved; anything else stays gated (the agent requests it via the normal flow).
      if (p === "/api/preview/egress-check") {
        const target = url.searchParams.get("url") ?? "";
        return json({ ok: true, data: { allow: !!target && egressDecision(target) === "allow" } });
      }
      // P-PREVIEW.4 (ADR-0096): return a LOCAL previewable file's CONTENT so the renderer can show it via
      // the iframe's `srcdoc`. Needed because the renderer is served over http and Chromium blocks a
      // `file://` iframe from an http origin — so `iframe.src = file://…` never rendered. The authenticated
      // bridge fetches this (transport gate: loopback + token), then sets srcdoc (same hardened sandbox).
      // Gated to a local .html/.htm/.svg file, existing, ≤ 5 MB. Read-only; the local user could read it anyway.
      if (p === "/api/preview/file") {
        const target = (url.searchParams.get("path") ?? "").trim();
        const r = readPreviewFile(target);
        // P-PREVIEW.12: `html` + `label` are unchanged for existing callers; `kind` + `mime` are additive
        // so a caller can tell a markdown report from an app, and `bytes` is base64 so an image can come
        // through this JSON route as well as the raw /serve one.
        return json(r.ok
          ? { ok: true, data: { html: r.html, label: r.label, kind: r.kind, mime: r.mime, ...(r.bytes ? { bytes: Buffer.from(r.bytes).toString("base64") } : {}) } }
          : { ok: false, error: r.error });
      }
      // P-PREVIEW.4b (ADR-0096): serve a local previewable file's CONTENT as an HTML document with its OWN
      // per-frame CSP (PREVIEW_FRAME_CSP), loaded by the renderer via `iframe.src`. A `srcdoc` frame inherits
      // the renderer's `script-src 'self'`, which blocked a previewed app's inline scripts (it rendered only
      // its static HTML). Served via `src`, the document carries PREVIEW_FRAME_CSP: inline JS/CSS run, but
      // `connect-src 'none'` blocks all network egress. The opaque-origin sandbox (set on the iframe) keeps
      // it off LUCID's origin. Behind the transport gate (loopback + token, here via `?t=`). Read-only.
      // P-PREVIEW.3a-shot (ADR-0096): the renderer proactively caches a PNG of the current preview here after
      // each render (capturePage is Electron-only and lives in the main process, unreachable from omp). The
      // agent's `preview_screenshot` tool then FETCHES it from /api/preview/shot below. In-memory, last-writer-wins.
      if (p === "/api/preview/shot-cache" && req.method === "POST") {
        const b = await req.json().catch(() => null) as { png?: unknown } | null;
        latestPreviewShot = typeof b?.png === "string" && b.png.startsWith("data:image/") ? b.png : latestPreviewShot;
        return json({ ok: true, data: { cached: !!latestPreviewShot } });
      }
      // P-PREVIEW.6b (ADR-0153): the agent's `preview_inspect` tool (omp subprocess) reads the live preview
      // DOM. The iframe is opaque-origin sandboxed, so this request is HELD here until the RENDERER runs the
      // query on the frame (via the postMessage bridge) and posts the result back — or an 8s timeout returns a
      // helpful "no preview open" message. Read-only by construction (the command only describes a query).
      if (p === "/api/preview/inspect") {
        // P-PREVIEW.11b (ADR-0308): glow the panel from the ROUTE the agent hit. The old title-sniffing
        // path in acp_backend cannot see a custom tool once intent tracing rewrites the ACP title, so
        // every preview pill was dark. Emitted BEFORE the await so the pill shows during the wait.
        backend.notePreviewActivity("inspect");
        const { id, promise } = inspectRelay.enqueue({ selector: url.searchParams.get("selector") ?? undefined, what: url.searchParams.get("what") ?? undefined });
        const t = setTimeout(() => inspectRelay.abandon(id, { error: "no preview is open (or it didn't respond) — open a preview first, then inspect it" }), 8000);
        const result = await promise; clearTimeout(t);
        return json({ ok: true, data: { result } });
      }
      // P-PREVIEW.6c (ADR-0153): the agent's preview_click / preview_type tools — a STRUCTURED action (a named
      // op on a CSS selector) through the same held relay + bridge. Same fail-closed timeout. No arbitrary JS.
      if (p === "/api/preview/act") {
        backend.notePreviewActivity("act"); // P-PREVIEW.11b (ADR-0308): as above, before the await
        const { id, promise } = inspectRelay.enqueue({ action: url.searchParams.get("action") ?? undefined, selector: url.searchParams.get("selector") ?? undefined, value: url.searchParams.get("value") ?? undefined });
        const t = setTimeout(() => inspectRelay.abandon(id, { error: "no preview is open (or it didn't respond) — open a preview first, then act on it" }), 8000);
        const result = await promise; clearTimeout(t);
        return json({ ok: true, data: { result } });
      }
      // The renderer pulls the next queued inspect command (poll while a preview is open) …
      if (p === "/api/preview/inspect/next") {
        return json({ ok: true, data: inspectRelay.next() ?? { none: true } });
      }
      // … runs it on the sandboxed frame via postMessage, and posts the result back (resolves the held tool call).
      if (p === "/api/preview/inspect/result" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; result?: unknown }>(req);
        const resolved = typeof b.id === "string" ? inspectRelay.resolve(b.id, b.result) : false;
        return json({ ok: true, data: { resolved } });
      }
      if (p === "/api/preview/shot") {
        // P-PREVIEW.11b (ADR-0308): only the agent's preview_screenshot tool GETs this (the renderer
        // PUSHES to /api/preview/shot-cache and polls the relay routes), so a hit here is unambiguously
        // the agent looking at its own work - safe to glow the panel on.
        backend.notePreviewActivity("screenshot");
        return json({ ok: true, data: { png: latestPreviewShot } });
      }
      // P-PREVIEW.11 (ADR-0308): the agent's `preview_open` tool reports ITSELF here, instead of the
      // desktop pattern-matching omp's ACP call title. With intent tracing on (omp injects an `i` field
      // into every tool schema), buildToolTitle returns the model's intent prose, so the
      // `"preview_open: <path>"` title the old detection keyed on never arrives - and the ACP update
      // carries no tool-name field at all. Same shape as the shot/inspect/act channels beside it: the omp
      // child inherits a ready token'd URL (LUCID_PREVIEW_OPEN_URL) and POSTs the path. backend.openPreview
      // emits into the ACTIVE turn stream, and the renderer still re-gates the path through resolvePreview
      // + readPreviewFile before anything renders, so this is a trigger, never a trust bypass.
      if (p === "/api/preview/open" && req.method === "POST") {
        const b = await readBody<{ path?: unknown }>(req);
        const target = typeof b.path === "string" ? b.path : "";
        const opened = backend.openPreview(target);
        // P-PREVIEW.12: close the feedback loop the agent never had. The frame CSP allows NO remote
        // origins, so a model's CDN <script src>, remote <img>, webfont or fetch() is refused and the
        // page renders blank or broken - previously with no signal to the user AND none to the model, so
        // it could not self-correct and would just try again. Report what was refused, in the tool's own
        // result, phrased as the fix (inline it, or vendor the asset next to the file and use a relative
        // path). HTML only: the other kinds have no remote refs to block. Best-effort, and never a gate:
        // a read failure here must not stop the panel from opening.
        let blocked = "";
        try {
          const r = readPreviewFile(target);
          if (r.ok && r.kind === "html") blocked = blockedRefsMessage(findBlockedRefs(r.html));
        } catch { /* the panel still opens; the agent simply gets no blocked-ref advice */ }
        return json({ ok: true, data: { opened, ...(blocked ? { blocked } : {}) } });
      }
      // P-EVAL.4 (ADR-0318): the omp child reports the REAL name of each tool call here. Same token'd
      // self-report shape as /api/preview/open above, and for the same structural reason: omp's ACP
      // tool_call update carries only a coarse `kind` ("other" for every custom + MCP tool) plus a title
      // that intent tracing rewrites to model prose, so the desktop cannot identify a tool from the
      // stream alone. The hook API inside omp CAN, so it posts `{ id, name, ok? }` and the backend joins
      // on toolCallId. Pure metadata: it labels chips and the engineering report's tool breakdown, and is
      // never consulted by a gate, so a dropped report costs a label and nothing more.
      if (p === "/api/tool/meta" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; name?: unknown; ok?: unknown }>(req);
        const noted = backend.noteToolMeta({
          id: typeof b.id === "string" ? b.id : "",
          name: typeof b.name === "string" ? b.name : "",
          ...(typeof b.ok === "boolean" ? { ok: b.ok } : {}),
        });
        return json({ ok: true, data: { noted } });
      }
      // ── P-BROWSER.1 (wave 2): the agent-controlled VISIBLE browser window ──────────────────────────
      // The Electron MAIN owns the real BrowserWindow (compositor-level capturePage defeats DOM-locking
      // pages; the user watches every step and closing the window is a hard kill switch). Main cannot be
      // imported from this child process, so these routes are the mailbox: agent tools enqueue + await,
      // main polls /commands (500ms) and posts /result. Mirrors the /api/preview conventions above.
      if (p === "/api/browser/open" && req.method === "POST") {
        const b = await readBody<{ url?: unknown }>(req);
        const target = String(b.url ?? "").trim();
        // http/https only - the visible window must never be steered at file:// or a custom scheme.
        if (!/^https?:\/\//i.test(target)) return json({ ok: false, error: "browser_open needs an http:// or https:// URL" });
        const id = `bcmd_${++browserCmdSeq}`;
        enqueueBrowserCommand({ id, op: "open", url: target });
        const r = await waitBrowserResult(id, 20_000);
        if (!r.ok) return json({ ok: false, error: r.error ?? "the browser window did not respond" });
        browserKilledByUser = false; // a fresh window supersedes an earlier user-X kill
        const wasActive = getBrowserStatus().active;
        setBrowserStatus({ active: true, title: r.title ?? target, url: r.url ?? target, ...(wasActive ? {} : { startedAt: Date.now(), shots: 0 }) });
        return json({ ok: true, data: { title: r.title ?? "", url: r.url ?? target } });
      }
      if (p === "/api/browser/capture" && req.method === "POST") {
        const s = getBrowserStatus();
        if (!s.active) return json({ ok: false, error: browserKilledByUser ? "browser closed by user" : "no browser window is open - call browser_open first" });
        const id = `bcmd_${++browserCmdSeq}`;
        enqueueBrowserCommand({ id, op: "capture" });
        const r = await waitBrowserResult(id, 10_000);
        if (!r.ok || !r.png) return json({ ok: false, error: r.error ?? "capture failed" });
        setLatestBrowserShot(r.png);
        setBrowserStatus({ shots: getBrowserStatus().shots + 1, ...(r.title ? { title: r.title } : {}), ...(r.url ? { url: r.url } : {}) });
        return json({ ok: true, data: { png: r.png, title: r.title ?? "" } });
      }
      if (p === "/api/browser/scroll" && req.method === "POST") {
        const s = getBrowserStatus();
        if (!s.active) return json({ ok: false, error: browserKilledByUser ? "browser closed by user" : "no browser window is open - call browser_open first" });
        const b = await readBody<{ dy?: unknown }>(req);
        const dy = Number.isFinite(Number(b.dy)) ? Math.max(-20_000, Math.min(20_000, Number(b.dy))) : 800;
        const id = `bcmd_${++browserCmdSeq}`;
        enqueueBrowserCommand({ id, op: "scroll", dy });
        const r = await waitBrowserResult(id, 10_000);
        if (!r.ok) return json({ ok: false, error: r.error ?? "scroll failed" });
        return json({ ok: true, data: { dy, title: r.title ?? "" } });
      }
      // Click + type: the window's own input path, so the page sees ordinary user interaction (a
      // synthesized DOM .click() misses handlers that read real pointer state). Coordinates are the
      // agent's snapshot space; MAIN maps them onto the live content bounds. Both are pointless without
      // an open window, and both stay cheap acks - the agent re-screenshots to see what changed.
      if (p === "/api/browser/click" && req.method === "POST") {
        const s = getBrowserStatus();
        if (!s.active) return json({ ok: false, error: browserKilledByUser ? "browser closed by user" : "no browser window is open - call browser_open first" });
        const b = await readBody<{ x?: unknown; y?: unknown; button?: unknown }>(req);
        const x = Number(b.x), y = Number(b.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return json({ ok: false, error: "browser_click needs finite x and y snapshot coordinates (0 or greater)" });
        const button = b.button === "right" ? "right" : "left";
        const id = `bcmd_${++browserCmdSeq}`;
        enqueueBrowserCommand({ id, op: "click", x, y, button });
        const r = await waitBrowserResult(id, 10_000);
        if (!r.ok) return json({ ok: false, error: r.error ?? "click failed" });
        return json({ ok: true, data: { button, title: r.title ?? "", url: r.url ?? "" } });
      }
      if (p === "/api/browser/type" && req.method === "POST") {
        const s = getBrowserStatus();
        if (!s.active) return json({ ok: false, error: browserKilledByUser ? "browser closed by user" : "no browser window is open - call browser_open first" });
        const b = await readBody<{ text?: unknown; pressEnter?: unknown }>(req);
        const text = String(b.text ?? "");
        if (!text || text.length > 2000) return json({ ok: false, error: "browser_type needs text of 1 to 2000 characters" });
        const id = `bcmd_${++browserCmdSeq}`;
        enqueueBrowserCommand({ id, op: "type", text, pressEnter: b.pressEnter === true });
        const r = await waitBrowserResult(id, 15_000);
        if (!r.ok) return json({ ok: false, error: r.error ?? "type failed" });
        return json({ ok: true, data: { typed: text.length, title: r.title ?? "" } });
      }
      // Drag needs intermediate moves between press and release: HTML5 drag-and-drop, sliders, and canvas
      // handles all watch the move stream, and a down-then-up with nothing between reads as a click.
      if (p === "/api/browser/drag" && req.method === "POST") {
        const s = getBrowserStatus();
        if (!s.active) return json({ ok: false, error: browserKilledByUser ? "browser closed by user" : "no browser window is open - call browser_open first" });
        const b = await readBody<{ x?: unknown; y?: unknown; toX?: unknown; toY?: unknown }>(req);
        const x = Number(b.x), y = Number(b.y), toX = Number(b.toX), toY = Number(b.toY);
        const finite = [x, y, toX, toY].every((n) => Number.isFinite(n) && n >= 0);
        if (!finite) return json({ ok: false, error: "browser_drag needs finite x, y, toX and toY snapshot coordinates (0 or greater)" });
        const id = `bcmd_${++browserCmdSeq}`;
        enqueueBrowserCommand({ id, op: "drag", x, y, toX, toY });
        const r = await waitBrowserResult(id, 15_000);
        if (!r.ok) return json({ ok: false, error: r.error ?? "drag failed" });
        return json({ ok: true, data: { title: r.title ?? "", url: r.url ?? "" } });
      }
      // Key combos are parsed HERE as well as in main: an unknown name comes back as a named error
      // immediately instead of costing the agent a round trip that acks and changes nothing.
      if (p === "/api/browser/keys" && req.method === "POST") {
        const s = getBrowserStatus();
        if (!s.active) return json({ ok: false, error: browserKilledByUser ? "browser closed by user" : "no browser window is open - call browser_open first" });
        const b = await readBody<{ keys?: unknown }>(req);
        const keys = String(b.keys ?? "");
        const parsed = parseKeyCombo(keys);
        if ("error" in parsed) return json({ ok: false, error: `browser_keys: ${parsed.error}` });
        const id = `bcmd_${++browserCmdSeq}`;
        enqueueBrowserCommand({ id, op: "keys", keys });
        const r = await waitBrowserResult(id, 10_000);
        if (!r.ok) return json({ ok: false, error: r.error ?? "key press failed" });
        return json({ ok: true, data: { keys, title: r.title ?? "", url: r.url ?? "" } });
      }
      // Close is idempotent and shared by three callers (agent tool, pill button, Stop-agent path):
      // an already-closed window answers ok so a stop sequence never trips over a race with the user's X.
      if (p === "/api/browser/close" && req.method === "POST") {
        if (!getBrowserStatus().active) return json({ ok: true, data: { closed: true } });
        const id = `bcmd_${++browserCmdSeq}`;
        enqueueBrowserCommand({ id, op: "close" });
        await waitBrowserResult(id, 10_000); // best-effort ack; inactive either way below
        setBrowserStatus({ active: false });
        failAllBrowserCommands("browser window closed");
        return json({ ok: true, data: { closed: true } });
      }
      if (p === "/api/browser/shot") {
        const png = latestBrowserShot();
        return png ? json({ ok: true, data: { png } }) : json({ ok: false, error: "no shot yet" });
      }
      if (p === "/api/browser/status" && req.method === "POST") {
        // Push from MAIN: title/navigation updates while the window lives, and the close notification.
        // `closedByUser` is the kill switch - queued + pending commands settle immediately with the
        // honest error (never a 10-20s timeout), and stay failing until a fresh browser_open.
        const b = await readBody<{ active?: unknown; title?: unknown; url?: unknown; closedByUser?: unknown }>(req);
        if (b.closedByUser === true) {
          browserKilledByUser = true;
          setBrowserStatus({ active: false });
          failAllBrowserCommands("browser closed by user");
        } else if (b.active === false) {
          setBrowserStatus({ active: false });
          failAllBrowserCommands("browser window closed");
        } else if (getBrowserStatus().active) {
          setBrowserStatus({ ...(typeof b.title === "string" ? { title: b.title } : {}), ...(typeof b.url === "string" ? { url: b.url } : {}) });
        }
        return json({ ok: true, data: getBrowserStatus() });
      }
      if (p === "/api/browser/status") return json({ ok: true, data: getBrowserStatus() });
      // Drained by MAIN's 500ms poll loop (x-lucid-token header; main minted the token).
      if (p === "/api/browser/commands") return json({ ok: true, data: { commands: drainBrowserCommands() } });
      if (p === "/api/browser/result" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; ok?: unknown; error?: unknown; png?: unknown; title?: unknown; url?: unknown }>(req);
        if (typeof b.id === "string" && b.id) {
          completeBrowserCommand(b.id, {
            ok: b.ok === true,
            ...(typeof b.error === "string" ? { error: b.error } : {}),
            ...(typeof b.png === "string" && b.png.startsWith("data:image/") ? { png: b.png } : {}),
            ...(typeof b.title === "string" ? { title: b.title } : {}),
            ...(typeof b.url === "string" ? { url: b.url } : {}),
          });
        }
        return json({ ok: true, data: { settled: typeof b.id === "string" && !!b.id } });
      }
      // P-PREVIEW.7 (ADR-0179): is the previewed file part of an ELECTRON app (which the sandboxed
      // frame cannot run - no Node/require)? Read-only detection for the renderer's explain-overlay.
      if (p === "/api/preview/electron-detect") {
        const det = detectElectronApp((url.searchParams.get("path") ?? "").trim());
        const plan = electronLaunchPlan(det, Bun.which("electron"));
        return json({ ok: true, data: { electron: det.electron, reasons: det.reasons, appDir: det.appDir, launchable: !!plan, via: plan?.via ?? null } });
      }
      // P-PREVIEW.7: USER-initiated external launch - runs the app as a real OS process OUTSIDE
      // LUCID (the sandbox stays sealed), audited as a first-party exec SecurityEvent. Refuses any
      // path that doesn't detect as an Electron app; a missing runtime returns the manual command.
      if (p === "/api/preview/electron-launch" && req.method === "POST") {
        const b = await readBody<{ path?: unknown }>(req);
        const det = detectElectronApp(String(b.path ?? "").trim());
        if (!det.electron) return json({ ok: true, data: { launched: false, reason: "not an Electron app (no electron dependency or start script found)" } });
        const plan = electronLaunchPlan(det, Bun.which("electron"));
        if (!plan) return json({ ok: true, data: { launched: false, reason: "no Electron runtime found - run `npx electron .` in the app folder", appDir: det.appDir } });
        try {
          const child = spawnChild(plan.cmd, plan.args, { cwd: plan.cwd, detached: true, stdio: "ignore", windowsHide: false });
          child.unref();
          emitSecurityEvent({ category: "exec", type: "preview_electron_launch", decision: "allow", severity: "info", tool: "preview", reason: `preview: user launched Electron app at ${det.appDir} (${plan.via} runtime)` });
          return json({ ok: true, data: { launched: true, via: plan.via, appDir: det.appDir } });
        } catch (e) {
          return json({ ok: true, data: { launched: false, reason: `launch failed: ${(e as Error).message}` } });
        }
      }
      if (p === "/api/preview/serve") {
        const target = (url.searchParams.get("path") ?? "").trim();
        const r = readPreviewFile(target);
        const headers: Record<string, string> = {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": PREVIEW_FRAME_CSP,
          "x-content-type-options": "nosniff",
        };
        if (r.ok) {
          // P-PREVIEW.12: BINARY kinds (image, pdf) are served as their own bytes with their real MIME.
          // Reading a PNG as UTF-8 corrupts it, so these never touch the HTML pipeline below. The frame
          // CSP still applies, and it permits no network, so a served image cannot phone home.
          if (r.bytes) return new Response(r.bytes, { headers: { ...headers, "content-type": r.mime } });
          // P-PREVIEW.12: text-ish kinds (markdown, txt, json, csv, log, yaml, xml, ...) are wrapped in a
          // minimal readable document by previewTextDocument. This is the core of the reported bug: a model
          // that wrote a markdown report or a JSON payload previously got "not an .html/.svg file" and had
          // no way to show its own work. html/svg pass through it untouched.
          let body = (r.kind === "html" || r.kind === "svg") ? r.html : previewTextDocument(r.kind, r.html, r.label);
          if (r.kind === "html") {
            // P-PREVIEW.4c (ADR-0096): fold the app's OWN relative assets (css/js/img/fonts) inline so a
            // MULTI-FILE app renders under the opaque-origin, egress-blocked frame CSP. HTML only (an .svg is
            // self-contained); best-effort, a read failure just serves the raw HTML (the CSP blocks the ref).
            try {
              body = inlinePreviewAssets(body, dirname(toFsPath(target)), {
                readText: (pp) => readFileSync(pp, "utf8"),
                readBytes: (pp) => readFileSync(pp),
              });
            } catch { /* serve raw HTML on any inlining failure */ }
            // P-PREVIEW.6b (ADR-0153): inject the read-only DOM-inspect bridge (inline JS, CSP-allowed; egress
            // still blocked by connect-src 'none'). Only for HTML: an .svg is self-contained + has no DOM to
            // inspect. It answers postMessage queries from the LUCID renderer; it never mutates or evals.
            body = injectPreviewBridge(body);
            // P-PREVIEW.12: LAST, and only for HTML. The frame CSP allows no remote origins, so a CDN
            // <script src>, a remote <img>, a webfont or a fetch() dies silently and the user sees a blank
            // page with no explanation. This banner names what was refused and what to do instead. It runs
            // after inlining, so anything successfully folded in locally is no longer reported as blocked,
            // and it is never injected into an .svg (which has no place to put it).
            body = injectBlockedRefsBanner(body);
          }
          // svg keeps its own image/svg+xml MIME: served as text/html a browser would render the markup
          // as text rather than as an image.
          return new Response(body, { headers: r.kind === "svg" ? { ...headers, "content-type": r.mime } : headers });
        }
        const safe = r.error.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
        return new Response(
          `<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px system-ui;color:#9aa;background:#0b0b10;padding:1.25rem">Can't preview this file - ${safe}.</body>`,
          { status: 200, headers },
        );
      }

      // P-TASK.5 (ADR-0180): live subagent activity for the delegation card. Reads the CURRENT
      // session's subtask transcripts (omp persists each subtask beside the parent session file) -
      // read-only, path-confined to the resolved session file, fail-quiet [] when nothing delegated.
      if (p === "/api/subagents") {
        try { return json({ ok: true, data: { runs: listSubagentRuns(sessionPathById(backend.currentSessionId())) } }); }
        catch { return json({ ok: true, data: { runs: [] } }); }
      }
      // P-SYSRES.1 (ADR-0182): system resource profile + guard verdict + top processes. Read-only
      // (fixed-argv process listing, nothing user-controlled reaches a command line), memoized 5s
      // (?fresh=1 busts it - the panel's Refresh button). FAIL-OPEN: a failed sample reads as "ok"
      // with no evidence - this is a UX load guard, never the security gate (ADR-0182).
      if (p === "/api/system") {
        const now = Date.now();
        if (url.searchParams.get("fresh") === "1" || !sysResCache || now - sysResCache.at > 5000) {
          const snap = await sampleSystem();
          sysResCache = { at: now, data: { snap, verdict: assessSystem(snap), procs: topProcesses() } };
        }
        return json({ ok: true, data: sysResCache.data });
      }
      // CREATOR-0 (ADR-0279): this build's identity - flavor, ports, data roots, and which Creator
      // surfaces exist. Token-gated like the rest of /api (it names local paths); it NEVER carries a
      // credential, a vault ref, or decrypted material.
      if (p === "/api/build-info") {
        return json({ ok: true, data: buildInfoView(BUILD, {
          version: APP_VERSION,
          port: PORT,
          dataRoot: process.env.LUCID_DATA_ROOT || "",
          settingsFile: process.env.LUCID_GUI_SETTINGS_FILE || join(homedir(), ".omp", "lucid-gui.json"),
          personalDir: personalBaseDir(),
        }) });
      }
      // CREATOR-0 (ADR-0283): normalized CPU/GPU/memory telemetry for the odometer rail. Creator builds
      // only; a standard build refuses rather than growing a surface it does not ship.
      if (p === "/api/creator/resources") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator resources are only in the Creator build." });
        return json({ ok: true, data: await creatorResources(url.searchParams.get("fresh") === "1") });
      }
      // CREATOR-0 (ADR-0282): the integration registry - every provider, its honest capability labels,
      // and whether THIS machine has an endpoint and a credential for it.
      if (p === "/api/creator/registry") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "The Creator registry is only in the Creator build." });
        return json({ ok: true, data: creatorRegistryData() });
      }
      // CREATOR-0: upsert / remove one endpoint DECLARATION. Fail-closed: an invalid declaration (shell
      // string, credential in the URL, pasted secret) is refused with its reasons and nothing is stored.
      if (p === "/api/creator/endpoint" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "The Creator registry is only in the Creator build." });
        const b = await readBody<{ remove?: unknown; endpoint?: unknown }>(req);
        if (typeof b.remove === "string" && b.remove) {
          return json({ ok: true, data: { removed: removeCreatorEndpoint(b.remove), registry: creatorRegistryData() } });
        }
        const raw = (b.endpoint ?? {}) as Partial<CreatorEndpointDef>;
        const def: CreatorEndpointDef = {
          id: String(raw.id ?? "").trim().toLowerCase(),
          providerId: (CREATOR_PROVIDER_IDS as readonly string[]).includes(String(raw.providerId)) ? String(raw.providerId) as CreatorProviderId : "comfyui",
          label: String(raw.label ?? "").trim(),
          baseUrl: raw.baseUrl ? String(raw.baseUrl).trim() : undefined,
          command: raw.command ? String(raw.command).trim() : undefined,
          args: Array.isArray(raw.args) ? raw.args.slice(0, 24).map((a) => String(a)) : undefined,
          zone: raw.zone === "internal" || raw.zone === "external" ? raw.zone : "local",
          vaultRef: raw.vaultRef ? String(raw.vaultRef).trim() : undefined,
          workflow: raw.workflow ? String(raw.workflow) : undefined,
          enabled: raw.enabled !== false,
        };
        const r = upsertCreatorEndpoint(def);
        return json({ ok: r.ok, error: r.ok ? undefined : r.errors.join("; "), data: { registry: creatorRegistryData() } });
      }
      // CREATOR-0 (ADR-0283): remote monitoring targets (a DGX Spark, a GPU VM behind the VPN).
      if (p === "/api/creator/target" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator resources are only in the Creator build." });
        const b = await readBody<{ remove?: unknown; target?: unknown }>(req);
        if (typeof b.remove === "string" && b.remove) return json({ ok: true, data: { removed: removeCreatorTarget(b.remove) } });
        const raw = (b.target ?? {}) as Record<string, unknown>;
        const def = {
          id: String(raw.id ?? "").trim().toLowerCase(),
          label: String(raw.label ?? "").trim(),
          url: String(raw.url ?? "").trim(),
          kind: raw.kind === "lucid-agent" ? "lucid-agent" as const : "dcgm-exporter" as const,
          vaultRef: raw.vaultRef ? String(raw.vaultRef).trim() : undefined,
          enabled: raw.enabled !== false,
        };
        const v = validateRemoteTarget(def);
        if (!v.ok) return json({ ok: false, error: v.errors.join("; ") });
        upsertCreatorTarget(def);
        return json({ ok: true, data: { saved: true } });
      }
      // CREATOR-0 (ADR-0281): the local track library - list, import, review, remix, re-prompt, remove.
      // Every one of these works with no provider API at all.
      if (p === "/api/creator/library") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "The Creator library is only in the Creator build." });
        if (req.method === "POST") {
          const b = await readBody<Record<string, unknown>>(req);
          const op = String(b.op ?? "");
          const id = typeof b.id === "string" ? b.id : "";
          if (op === "add" || op === "remix" || op === "reprompt") {
            const r = addTrack(libraryIo, CREATOR_DIR, {
              sourcePath: String(b.sourcePath ?? ""),
              title: typeof b.title === "string" ? b.title : undefined,
              origin: typeof b.origin === "string" ? b.origin as TrackOrigin : undefined,
              prompt: typeof b.prompt === "string" ? b.prompt : undefined,
              lyrics: typeof b.lyrics === "string" ? b.lyrics : undefined,
              tags: Array.isArray(b.tags) ? b.tags.map((t) => String(t)) : undefined,
              parentId: op === "add" ? null : id,
              kind: op === "add" ? "original" : op === "remix" ? "remix" : "reprompt",
            });
            return json({ ok: r.ok, error: r.error, data: creatorLibraryData() });
          }
          if (op === "update") {
            const r = updateTrack(libraryIo, CREATOR_DIR, id, {
              title: typeof b.title === "string" ? b.title : undefined,
              prompt: typeof b.prompt === "string" ? b.prompt : undefined,
              lyrics: typeof b.lyrics === "string" ? b.lyrics : undefined,
              tags: Array.isArray(b.tags) ? b.tags.map((t) => String(t)) : undefined,
              rating: b.rating === null ? null : typeof b.rating === "number" ? b.rating : undefined,
              review: typeof b.review === "string" ? b.review : undefined,
            });
            return json({ ok: r.ok, error: r.error, data: creatorLibraryData() });
          }
          if (op === "remove") {
            const r = removeTrack(libraryIo, CREATOR_DIR, id);
            return json({ ok: r.ok, error: r.error, data: creatorLibraryData() });
          }
          return json({ ok: false, error: "Unknown library operation." });
        }
        return json({ ok: true, data: creatorLibraryData() });
      }
      // CREATOR-1 (ADR-0292): probe one provider (or every declared one) and cache what it PROVED. This is
      // what turns registry state `configured` into a truthful `ready`.
      if (p === "/api/creator/probe" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator probes are only in the Creator build." });
        const b = await readBody<{ providerId?: unknown }>(req);
        const endpoints = listCreatorEndpoints();
        const wanted = (CREATOR_PROVIDER_IDS as readonly string[]).includes(String(b.providerId))
          ? [String(b.providerId) as CreatorProviderId]
          : [...CREATOR_PROVIDER_IDS];
        for (const id of wanted) {
          const job = createJob(jobIo, CREATOR_DIR, { kind: "probe", label: `probe ${id}`, provider: id });
          startJob(jobIo, CREATOR_DIR, job.id);
          const r = await probeProvider(probeDeps, id, endpoints);
          probeCache.set(r);
          finishJob(jobIo, CREATOR_DIR, job.id, r.state === "ready" ? "done" : "failed", r.state === "ready" ? "" : `${r.state}: ${r.detail}`);
        }
        return json({ ok: true, data: { registry: creatorRegistryData(), ...creatorJobsData() } });
      }
      // CREATOR-1: the job ledger - what ran, what it produced, what the governor measured, what failed.
      if (p === "/api/creator/jobs") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator jobs are only in the Creator build." });
        if (req.method === "POST") {
          const b = await readBody<{ cancel?: unknown }>(req);
          const r = requestJobCancel(jobIo, CREATOR_DIR, String(b.cancel ?? ""));
          return json({ ok: r.ok, error: r.error, data: creatorJobsData() });
        }
        return json({ ok: true, data: creatorJobsData() });
      }
      // CREATOR-IMG (ADR-0291): the model dropdown - a LIVE probe of the configured ComfyUI install's own
      // loaders. No hardcoded model list, and an unreachable server says so instead of offering fiction.
      if (p === "/api/creator/models") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator image tools are only in the Creator build." });
        const ep = comfyEndpoint();
        if (!ep) return json({ ok: true, data: { models: [], endpoint: "", note: "Connect a ComfyUI endpoint in Creator Studio to list its models." } });
        const probe = await comfyClient(ep).probeModels();
        return json({ ok: true, data: { models: probe.models, endpoint: ep.baseUrl ?? "", note: probe.note } });
      }
      // CREATOR-IMG: generate an image from a prompt plus mixed input images, through the USER's own workflow
      // template. Fail-closed at every step: no endpoint, no template, or an unresolved placeholder refuses
      // with the exact reason rather than submitting a half-built graph.
      if (p === "/api/creator/image" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator image tools are only in the Creator build." });
        const b = await readBody<Record<string, unknown>>(req);
        // CREATOR-1: a generation is a JOB - admitted by the governor, recorded with what it produced.
        const label = typeof b.prompt === "string" && b.prompt.trim() ? b.prompt.trim().slice(0, 80) : "image generation";
        const admit = await admitCreatorJob("image", label, "comfyui", { gpu: true });
        if (!admit.ok) return json({ ok: false, error: admit.reason, data: { ...creatorJobsData() } });
        const r = await generateCreatorImage(b);
        for (const a of r.data?.produced ?? []) recordJobArtifact(jobIo, CREATOR_DIR, admit.jobId, a.id);
        finishJob(jobIo, CREATOR_DIR, admit.jobId, r.ok ? "done" : "failed", r.error ?? "");
        return json({ ok: r.ok, error: r.error, data: r.data ? { ...r.data, ...creatorJobsData() } : { ...creatorJobsData() } });
      }
      // CREATOR-3 (ADR-0287): a VIDEO or 3D render through the user's own workflow. Every gate in one place
      // and in this order: a live probe must have ATTESTED the capability, the governor must admit the work,
      // the template must have no holes, the bytes must prove their own type, and the server-supplied
      // metadata must clear the fail-closed scanner before anything is written. The seam's result object is
      // returned WHOLE rather than hand-projected, so the pane reads the same fields the tests pin.
      if (p === "/api/creator/render" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator render pipelines are only in the Creator build." });
        const b = await readBody<Record<string, unknown>>(req);
        const kind: MediaKind = b.kind === "model-3d" ? "model-3d" : b.kind === "image" ? "image" : "video";
        const ep = comfyEndpoint();
        if (!ep) return json({ ok: false, error: "No ComfyUI endpoint is configured. Add one in Creator Studio first." });
        const templateRaw = typeof b.workflow === "string" && b.workflow.trim() ? b.workflow : ep.workflow;
        if (!templateRaw || !templateRaw.trim()) {
          return json({ ok: false, error: `No workflow template is saved for this endpoint. Export the graph that produces your ${kind} from ComfyUI with Save (API Format) and paste it into the endpoint, using {{prompt}}, {{model}} and {{seed}} where LUCID should fill values in.` });
        }
        let template: unknown;
        try { template = JSON.parse(templateRaw); }
        catch { return json({ ok: false, error: "That workflow template is not valid JSON." }); }
        const prompt = typeof b.prompt === "string" ? b.prompt.slice(0, 4000) : "";
        const label = prompt.trim() ? `${kind}: ${prompt.trim().slice(0, 70)}` : `${kind} render`;
        const deps: PipelineDeps = { client: comfyClient(ep), artifactIo, jobIo, scan: creatorScan, now: () => Date.now() };
        // The websocket is opened BEFORE the submit, so the first frames of a fast render are not missed,
        // and closed in the `finally` whatever happens: an unclosed socket would keep the drain alive past
        // the response. A server with no reachable socket simply yields no feed and polling decides.
        const clientId = `lucid-${randomBytes(8).toString("hex")}`;
        const socket = openComfyProgress(ep.baseUrl ?? "", creatorEndpointToken(ep), clientId);
        try {
        const run = await runRenderPipeline(deps, CREATOR_DIR, {
          kind,
          workflow: template,
          clientId,
          feed: socket?.feed,
          spec: {
            prompt,
            negative: typeof b.negative === "string" ? b.negative.slice(0, 2000) : "",
            model: typeof b.model === "string" ? b.model : "",
            seed: typeof b.seed === "number" ? b.seed : Math.floor(Math.random() * 2 ** 31),
            width: typeof b.width === "number" ? b.width : undefined,
            height: typeof b.height === "number" ? b.height : undefined,
          },
          // The probe cache is the ONLY source of attested capability, and it returns nothing once a probe
          // has expired, so a stale install refuses here rather than at the server.
          attested: probeCache.discovered("comfyui", Date.now()) ?? [],
          admission: await creatorAdmissionSnapshot(label, { gpu: true }),
          label,
          maxArtifacts: typeof b.maxArtifacts === "number" ? b.maxArtifacts : undefined,
          poll: { pollMs: 1200, maxWaitMs: 600_000 },
        });
        return json({ ok: run.ok, error: run.error, data: { run, artifacts: creatorArtifacts(), ...creatorJobsData() } });
        } finally { socket?.close(); }
      }
      // CREATOR-3: a Blender BACKGROUND render. Fixed argv, no shell. A user `--python` script is the user's
      // own code, so it needs `approved: true` (the exec-approval decision) before it will run: LUCID adds no
      // Python of its own (invariant 2) and never runs someone else's silently.
      if (p === "/api/creator/blender" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator render pipelines are only in the Creator build." });
        const b = await readBody<Record<string, unknown>>(req);
        const ep = listCreatorEndpoints().find((e) => e.enabled && e.providerId === "blender" && !!e.command);
        const exe = typeof b.exe === "string" && b.exe.trim() ? b.exe.trim() : (ep?.command ?? "");
        if (!exe) return json({ ok: false, error: "No Blender executable is configured. Add it in Creator Studio first." });
        const range = b.range && typeof b.range === "object"
          ? { start: Number((b.range as Record<string, unknown>).start), end: Number((b.range as Record<string, unknown>).end) }
          : undefined;
        const input = {
          exe,
          blend: String(b.blend ?? ""),
          outPattern: String(b.outPattern ?? ""),
          format: b.format as "PNG" | "JPEG" | "OPEN_EXR" | "WEBP" | undefined,
          engine: b.engine as "CYCLES" | "BLENDER_EEVEE_NEXT" | "BLENDER_WORKBENCH" | undefined,
          scene: typeof b.scene === "string" ? b.scene : undefined,
          frame: typeof b.frame === "number" ? b.frame : undefined,
          range,
          pythonScript: typeof b.pythonScript === "string" ? b.pythonScript : undefined,
          approved: b.approved === true,
          label: typeof b.label === "string" ? b.label : undefined,
          timeoutMs: typeof b.timeoutMs === "number" ? b.timeoutMs : undefined,
          cwd: typeof b.cwd === "string" ? b.cwd : undefined,
          admission: null as JobAdmissionSnapshot | null,
        };
        const need = blenderJobNeed(input);
        input.admission = await creatorAdmissionSnapshot(need.label, need);
        const run = await runBlenderRender({ spawn: blenderSpawn, jobIo, exists: (path) => existsSync(path), now: () => Date.now() }, CREATOR_DIR, input);
        return json({ ok: run.ok, error: run.error, data: { run, ...creatorJobsData() } });
      }
      // CREATOR-3: the model MANIFEST. A declaration of what a given install can do, reconciled against what
      // the probe actually reported: the probe is the truth and the manifest is only the claim, so a declared
      // model the server does not list is reported ABSENT rather than offered.
      if (p === "/api/creator/manifest" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator render pipelines are only in the Creator build." });
        const b = await readBody<{ manifest?: unknown }>(req);
        const parsed = parseModelManifest(b.manifest);
        if (!parsed.ok) return json({ ok: false, error: parsed.error });
        const ep = comfyEndpoint();
        const probe = probeCache.get("comfyui");
        const models = ep ? (await comfyClient(ep).probeModels()).models : [];
        const reconciliation = reconcileManifest(parsed.manifest, {
          models,
          attested: probe?.attested ?? [],
          probeState: probe?.state ?? "skipped",
          ageMs: probe ? Math.max(0, Date.now() - probe.at) : Number.MAX_SAFE_INTEGER,
        });
        return json({ ok: true, data: { reconciliation, claimed: manifestCapabilities(parsed.manifest), warnings: parsed.warnings } });
      }
      // CREATOR-IMG: store a renderer-encoded PNG (a meme, a markup export, a canvas composite) as an
      // artifact with its provenance. The data URL is gated: no SVG, no mislabeled bytes.
      if (p === "/api/creator/artifact" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator image tools are only in the Creator build." });
        const b = await readBody<Record<string, unknown>>(req);
        const decoded = decodePngDataUrl(b.dataUrl);
        if (!decoded.ok) return json({ ok: false, error: decoded.error });
        const kinds: Record<string, ArtifactKind> = { image: "image", sheet: "sheet", gif: "gif", meme: "meme", markup: "markup" };
        const stored = storeArtifact(artifactIo, CREATOR_DIR, {
          kind: kinds[String(b.kind ?? "image")] ?? "image",
          bytes: decoded.bytes,
          mime: decoded.mime,
          width: typeof b.width === "number" ? b.width : 0,
          height: typeof b.height === "number" ? b.height : 0,
          source: typeof b.source === "string" ? b.source : "local",
          prompt: typeof b.prompt === "string" ? b.prompt : "",
          model: typeof b.model === "string" ? b.model : "",
        });
        return json({ ok: stored.ok, error: stored.error, data: stored.ok ? { artifact: stored.artifact, artifacts: creatorArtifacts() } : null });
      }
      // CREATOR-IMG: compose frames into a sprite sheet PNG plus its manifest and a steps() CSS animation.
      // Pure TypeScript encoding - no provider, no key, no network.
      if (p === "/api/creator/sheet" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator image tools are only in the Creator build." });
        const b = await readBody<Record<string, unknown>>(req);
        const frames = decodeWireFrames(b.frames);
        if (!frames.ok) return json({ ok: false, error: frames.error });
        const admit = await admitCreatorJob("sheet", `sprite sheet - ${frames.frames.length} frames`, "local");
        if (!admit.ok) return json({ ok: false, error: admit.reason, data: { ...creatorJobsData() } });
        const r = buildSpriteSheet(artifactIo, CREATOR_DIR, frames.frames, {
          name: typeof b.name === "string" ? b.name : "sprite",
          columns: typeof b.columns === "number" ? b.columns : undefined,
          durationMs: typeof b.durationMs === "number" ? b.durationMs : undefined,
        });
        if (r.ok && r.result) recordJobArtifact(jobIo, CREATOR_DIR, admit.jobId, r.result.artifact.id);
        finishJob(jobIo, CREATOR_DIR, admit.jobId, r.ok ? "done" : "failed", r.error ?? "");
        return json({ ok: r.ok, error: r.error, data: r.ok ? { artifact: r.result!.artifact, css: r.result!.css, manifest: r.result!.manifest, artifacts: creatorArtifacts(), ...creatorJobsData() } : { ...creatorJobsData() } });
      }
      // CREATOR-IMG: encode frames into an animated GIF (GIF89a, global palette, LZW) in-process.
      if (p === "/api/creator/gif" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator image tools are only in the Creator build." });
        const b = await readBody<Record<string, unknown>>(req);
        const frames = decodeWireFrames(b.frames);
        if (!frames.ok) return json({ ok: false, error: frames.error });
        const delays = Array.isArray(b.delayMs) ? b.delayMs.filter((d): d is number => typeof d === "number") : undefined;
        const admit = await admitCreatorJob("gif", `gif - ${frames.frames.length} frames`, "local");
        if (!admit.ok) return json({ ok: false, error: admit.reason, data: { ...creatorJobsData() } });
        const r = buildGif(artifactIo, CREATOR_DIR, frames.frames, {
          delayMs: delays && delays.length ? delays : (typeof b.delayMs === "number" ? b.delayMs : 100),
          loop: typeof b.loop === "number" ? b.loop : 0,
        });
        if (r.ok && r.artifact) recordJobArtifact(jobIo, CREATOR_DIR, admit.jobId, r.artifact.id);
        finishJob(jobIo, CREATOR_DIR, admit.jobId, r.ok ? "done" : "failed", r.error ?? "");
        return json({ ok: r.ok, error: r.error, data: r.ok ? { artifact: r.artifact, artifacts: creatorArtifacts(), ...creatorJobsData() } : { ...creatorJobsData() } });
      }
      // CREATOR-IMG: the artifact list, and one artifact's bytes as a data URL (for inline display and for
      // the hand-off into the Preview panel's existing markup surface).
      if (p === "/api/creator/artifacts") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "Creator image tools are only in the Creator build." });
        const id = url.searchParams.get("id");
        if (!id) return json({ ok: true, data: { artifacts: creatorArtifacts() } });
        const art = creatorArtifacts().find((a) => a.id === id);
        if (!art) return json({ ok: false, error: "That artifact is not in the library." });
        try {
          const bytes = readFileSync(join(artifactDir(CREATOR_DIR), art.file));
          return json({ ok: true, data: { artifact: art, dataUrl: `data:${art.mime};base64,${bytes.toString("base64")}` } });
        } catch { return json({ ok: false, error: "That artifact's file is missing." }); }
      }
      // CREATOR-0: playable bytes for one track, base64 + mime like the TTS path (the renderer turns it
      // into one blob URL). Path-confined: the id resolves through the ledger, never a caller path.
      if (p === "/api/creator/track") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "The Creator library is only in the Creator build." });
        const r = trackAudio(libraryIo, CREATOR_DIR, url.searchParams.get("id") ?? "");
        return json({ ok: r.ok, error: r.error, data: r.ok ? { audioB64: r.audioB64, mime: r.mime, title: r.title } : null });
      }
      // CREATOR-2 (ADR-0286): open one track as a follow-along timeline - its audio, its waveform, the words
      // bound to it, and the PROVENANCE of that binding (carried verbatim from the aligner, never re-worded).
      // A container the editor cannot decode is refused by name; there is no transcoder to pretend with.
      if (p === "/api/creator/editor/open" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "The Creator editor is only in the Creator build." });
        const b = await readBody<{ trackId?: unknown; text?: unknown; buckets?: unknown }>(req).catch(() => null);
        if (!b) return json({ ok: false, error: "That editor request was not JSON." });
        const r = openEditor(libraryIo, CREATOR_DIR, {
          trackId: typeof b.trackId === "string" ? b.trackId : "",
          text: typeof b.text === "string" ? b.text : undefined,
          buckets: typeof b.buckets === "number" ? b.buckets : undefined,
        });
        return json({ ok: r.ok, error: r.error, session: r.session });
      }
      // CREATOR-2: save an edit. The document is gated off the wire fail-closed (one malformed word refuses
      // the body), then rendered and APPENDED as a remix - the edited track keeps its bytes and its row.
      if (p === "/api/creator/editor/save" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "The Creator editor is only in the Creator build." });
        const b = await readBody<{ trackId?: unknown; doc?: unknown; title?: unknown; prompt?: unknown }>(req).catch(() => null);
        if (!b) return json({ ok: false, error: "That editor request was not JSON." });
        const decoded = decodeTimelineDoc(b.doc);
        if (!decoded.ok) return json({ ok: false, error: decoded.error });
        const r = saveEdit(editorIo, CREATOR_DIR, {
          trackId: typeof b.trackId === "string" ? b.trackId : "",
          doc: decoded.doc,
          title: typeof b.title === "string" ? b.title : "",
          prompt: typeof b.prompt === "string" ? b.prompt : undefined,
        });
        // The result IS this route's wire shape, so it is returned whole. A hand-written field-by-field
        // projection here would be a SECOND copy of that contract living in the one file no headless test
        // can import, where a dropped or renamed field reaches the pane as a report its guard refuses on
        // every clean save, with the suite still green. Same reasoning as /api/creator/mixer/render.
        return json(r);
      }
      // CREATOR-5 (ADR-0289): the layers a mix can be built from, plus the format the mix will run at (the
      // MAJORITY WAV format in the library, because this build ships no resampler). Every WAV is listed with
      // its real sample rate and channel count, so the UI can say WHY a track is not offered instead of
      // hiding it; nulls mean the format is unknown to this build, never a guess and never 0.
      if (p === "/api/creator/mixer/tracks") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "The Creator mixer is only in the Creator build." });
        const r = mixerTracks(libraryIo, CREATOR_DIR);
        return json({ ok: r.ok, error: r.error, data: r.ok ? { tracks: r.tracks, sampleRate: r.sampleRate, channels: r.channels } : null });
      }
      // CREATOR-5: render a mix and APPEND it. The graph is untrusted input, gated field by field like a
      // timeline (one malformed clip refuses the body rather than rendering a layer short), and every source
      // it names must resolve - a mix that quietly substituted silence would be a lie the rendered file could
      // not admit. Headroom is opt-in, and the EXACT gain applied comes back in the answer.
      if (p === "/api/creator/mixer/render" && req.method === "POST") {
        if (!BUILD.creatorBuild) return json({ ok: false, error: "The Creator mixer is only in the Creator build." });
        const b = await readBody<{ graph?: unknown; title?: unknown; prompt?: unknown; primaryTrackId?: unknown; applyHeadroom?: unknown }>(req).catch(() => null);
        if (!b) return json({ ok: false, error: "That mixer request was not JSON." });
        const decoded = decodeMixGraph(b.graph);
        if (!decoded.ok) return json({ ok: false, error: decoded.error });
        const r = renderAndSaveMix(editorIo, CREATOR_DIR, {
          graph: decoded.graph,
          title: typeof b.title === "string" ? b.title : "",
          prompt: typeof b.prompt === "string" ? b.prompt : undefined,
          primaryTrackId: typeof b.primaryTrackId === "string" ? b.primaryTrackId : "",
          applyHeadroom: b.applyHeadroom === true,
        });
        // Deliberately NOT a field-by-field projection like the editor's save above: RenderMixResult IS this
        // route's wire shape (ok, error and the measurements, all top-level, which is why bridge.ts runs
        // isRenderMixReport on the body itself), and `error: undefined` drops on serialization. Re-listing
        // the fields here would put the same invariant in two places, and only the seam's copy is testable:
        // dev.ts cannot be imported headless, so a key dropped from a re-listing would reach the pane as "a
        // report this build cannot read" on every clean render with every test still green. One copy, owned
        // by desktop/creator_mixer.test.ts. The GET above keeps its projection because there the result is
        // NOT the wire shape: it nests under `data`.
        return json(r);
      }
      // real omp ACP backend (genuine model replies + live session config)
      if (p === "/api/sessions") return json({ ok: true, data: listSessions() });
      if (p === "/api/sessions/ingest/clear" && req.method === "POST") return json({ ok: true, data: clearIngestSessions() }); // P-KG-INGEST.2
      if (p === "/api/session" && url.searchParams.get("id")) { // P-PERF.4: tail-first page (limit=0 = all)
        const lim = Math.max(0, Math.trunc(Number(url.searchParams.get("limit")) || 0));
        const sid = url.searchParams.get("id")!;
        const page = sessionMessages(sid, lim);
        // P-RESUME.1 (ADR-0171): re-anchor the step recorder to the transcript's REAL user count
        // (turns run outside this GUI can't shift later anchors), then merge the restored activity.
        syncStepTurns(sid, page.userTotal);
        return json({ ok: true, data: { ...page, steps: readTurnSteps(sid) } });
      }
      if (p === "/api/session/load" && req.method === "POST") { const { id } = await readBody<{ id?: unknown }>(req); await backend.loadSession(String(id)); return json({ ok: true }); }
      if (p === "/api/session/delete" && req.method === "POST") {
        const { id } = await readBody<{ id?: unknown }>(req);
        const sid = String(id);
        // If it's the live session, close it first so omp releases the file handle (Windows
        // locks open files), then start fresh. newSession() does session/close + ensureSession.
        if (backend.currentSessionId() === sid) await backend.newSession().catch(() => {});
        const res = deleteSession(sid);
        if (res.ok) deleteSteps(sid); // P-RESUME.1: the activity sidecar goes with its session
        return json({ ok: true, data: res });
      }

      // workspace (the folder the agent works in; local or cloned remote)
      if (p === "/api/workspace") {
        if (req.method === "POST") { const b = await readBody<{ path?: unknown }>(req); setWorkspace(String(b.path ?? "")); backend.restart(); if (collabManager.active) collabManager.refreshOptions(); /* P-COLLAB.14: mirror the folder switch to edit guests */ }
        return json({ ok: true, data: workspaceInfo() });
      }
      // Drop a folder from the recents pills. Local list change only - the active workspace is untouched, so
      // NO backend restart (unlike setWorkspace/clone). Returns the refreshed workspace info.
      if (p === "/api/workspace/recent-remove" && req.method === "POST") {
        const b = await readBody<{ path?: unknown }>(req);
        return json({ ok: true, data: removeRecentWorkspace(typeof b.path === "string" ? b.path : "") });
      }
      if (p === "/api/workspace/clone" && req.method === "POST") {
        // `pat` (ADR-0216): an OPTIONAL, freshly-entered git token passed inline so a private clone works THIS
        // session before the vault-injected env var lands on the next launch. It is used only to spawn git
        // (redacted from any error) and is never logged, persisted here, or forwarded to the agent.
        const { url, pat } = await readBody<{ url?: unknown; pat?: unknown }>(req);
        const r = await cloneRepo(String(url ?? ""), typeof pat === "string" ? pat : undefined);
        if (r.ok && r.path) { setWorkspace(r.path); backend.restart(); }
        return json({ ok: r.ok, data: { ...workspaceInfo(), cloned: r.ok, error: r.error } });
      }
      // P-WSSETUP: the workspace-initialization offer. Profile the current folder (is it empty?
      // a code repo? already framework-equipped?), scaffold the .agents framework on accept, or
      // record a dismissal so the popup never re-asks for this folder.
      if (p === "/api/workspace/setup-profile") {
        const ws = currentWorkspace();
        return json({ ok: true, data: { ...profileWorkspace(ws), asked: !!loadSettings().workspaceSetupAsked?.[ws] } });
      }
      if (p === "/api/workspace/agents-init" && req.method === "POST") {
        const b = await readBody<{ purpose?: unknown; scan?: unknown }>(req);
        const purpose = b.purpose;
        if (purpose !== "app" && purpose !== "docs" && purpose !== "analysis" && purpose !== "other") return json({ ok: false, error: "invalid purpose" });
        const ws = currentWorkspace();
        const r = scaffoldAgentsFramework(ws, { purpose, scan: !!b.scan });
        markWorkspaceSetupAsked(ws);
        return json({ ok: r.ok, data: r, error: r.error });
      }
      if (p === "/api/workspace/setup-dismiss" && req.method === "POST") {
        markWorkspaceSetupAsked(currentWorkspace());
        return json({ ok: true, data: { asked: true } });
      }

      // settings + provider auth
      if (p === "/api/settings") {
        if (req.method === "POST") {
          const b = await readBody<{ skip?: unknown; email?: unknown; username?: unknown; role?: unknown; tourSeen?: unknown; govconCui?: unknown; theme?: unknown }>(req);
          // ADR-0088/0089 + P-GOVCUI.1: role + first-run-tour + gov/CUI answer are cosmetic onboarding state,
          // policy-free — set them up front, independent of the email-attribution policy gate below.
          if (b.role != null && (USER_ROLES as string[]).includes(String(b.role))) setUserRole(String(b.role) as UserRole);
          if (b.tourSeen != null) setTourSeen(!!b.tourSeen);
          if (typeof b.govconCui === "boolean") setGovconCui(b.govconCui);
          // P-THEME.1: stored as an opaque string and NOT validated against a theme list here. The
          // renderer's THEMES registry is the single source of truth for which ids exist, and resolveTheme
          // already treats an unknown id as "not chosen", so validating here would only duplicate that
          // list server-side and break every time a theme ships. A junk value is inert, not dangerous:
          // it is only ever written into a [data-theme] attribute, escaped by the DOM API.
          if (typeof b.theme === "string") setThemeId(b.theme);
          // Enforce enterprise-managed attribution policy server-side (the UI also reflects it).
          if (b.skip && !skipAllowed()) return json({ ok: false, error: "Your organization requires a corporate email.", data: settingsData() });
          if (b.email != null && String(b.email).trim() && !emailDomainAllowed(String(b.email))) {
            const ds = managedConfig().config?.attribution?.allowedEmailDomains ?? [];
            return json({ ok: false, error: `Use your corporate email${ds.length ? " (" + ds.map((d) => "@" + d).join(", ") + ")" : ""}.`, data: settingsData() });
          }
          if (b.skip) setAttributionSkip(); // user skipped the email prompt → workstation attribution
          else if (b.email != null || b.username != null) setProfile({ username: b.username != null ? String(b.username) : undefined, email: b.email != null ? String(b.email) : undefined });
        }
        return json({ ok: true, data: settingsData() });
      }
      // Enterprise-managed policy (read-only; placed by admins via GPO/MDM). Sanitized — policy only.
      if (p === "/api/managed") {
        const mc = managedConfig();
        return json({ ok: true, data: {
          managed: !!mc.config,
          orgName: typeof mc.config?.orgName === "string" ? mc.config.orgName : "",
          attribution: mc.config?.attribution ?? null,
          asksageOnly: managedAsksageOnly(mc.config),
          locks: managedLocks(mc.config),
        } });
      }
      // P-IDE.1c (ADR-0029): the China-origin data-sovereignty acknowledgement gate. GET returns the
      // flag; POST {acknowledge:true} after the user types ACKNOWLEDGE unlocks those models in the picker.
      if (p === "/api/china-ack") {
        if (req.method === "POST") { const b = await readBody<{ acknowledge?: unknown }>(req); return json({ ok: true, data: { acknowledged: !!setChinaModelsAcknowledged(!!b.acknowledge).chinaModelsAcknowledged } }); }
        return json({ ok: true, data: { acknowledged: chinaModelsAcknowledged() } });
      }
      // The third-party / non-U.S. / custom "More providers" acknowledgement gate (mirrors china-ack).
      if (p === "/api/thirdparty-ack") {
        if (req.method === "POST") { const b = await readBody<{ acknowledge?: unknown }>(req); return json({ ok: true, data: { acknowledged: !!setThirdPartyProvidersAcknowledged(!!b.acknowledge).thirdPartyProvidersAcknowledged } }); }
        return json({ ok: true, data: { acknowledged: thirdPartyProvidersAcknowledged() } });
      }
      // ADR-0219: per chat-session CUI vs Search mode. Defaults to the ACTIVE omp session so the renderer can
      // just ask "the current session's mode" without tracking ids. GET (?id= optional) → mode (default
      // "cui"); POST {mode, id?} → persist. Under lockdown the backend egress gate reads this to decide
      // whether to block public egress for the active session (CUI blocks; Search allows).
      if (p === "/api/session-mode") {
        if (req.method === "POST") {
          const b = await readBody<{ id?: unknown; mode?: unknown }>(req);
          const id = (typeof b.id === "string" && b.id) ? b.id : (backend.currentSessionId() ?? "");
          const mode = b.mode === "search" ? "search" : "cui";
          if (id) setSessionMode(id, mode);
          return json({ ok: true, data: { id, mode: id ? sessionMode(id) : "cui" } });
        }
        const id = url.searchParams.get("id") || (backend.currentSessionId() ?? "");
        return json({ ok: true, data: { id, mode: id ? sessionMode(id) : "cui" } });
      }
      // ADR-0221: the "Semantic search" (BYO-embeddings) config. Non-secret (baseUrl/model/dim/auth); the token
      // is stored separately in the OS vault (credStore) and referenced by vaultRef. `active` reflects whether a
      // usable embedder resolves right now (config complete + any needed secret present in the child env).
      if (p === "/api/embeddings-config") {
        if (req.method === "POST") {
          const b = await readBody<{ config?: unknown }>(req);
          const c = b.config as Record<string, unknown> | null;
          if (c === null) { setEmbeddingsConfig(null); return json({ ok: true, data: { config: null, active: false } }); }
          if (!c || typeof c.baseUrl !== "string" || typeof c.model !== "string" || !c.baseUrl.trim() || !c.model.trim())
            return json({ ok: true, data: { config: embeddingsConfig(), active: !!desktopEmbedder(), error: "Base URL and model are required." } });
          const authKind = c.authKind === "bearer" || c.authKind === "apikey" ? c.authKind : "none";
          setEmbeddingsConfig({
            enabled: c.enabled !== false,
            baseUrl: c.baseUrl.trim(), model: c.model.trim(),
            dim: Math.max(1, Math.floor(Number(c.dim) || 0)),
            authKind, headerName: typeof c.headerName === "string" ? c.headerName : undefined,
            vaultRef: typeof c.vaultRef === "string" ? c.vaultRef : undefined,
          });
          return json({ ok: true, data: { config: embeddingsConfig(), active: !!desktopEmbedder() } });
        }
        return json({ ok: true, data: { config: embeddingsConfig(), active: !!desktopEmbedder() } });
      }
      // ADR-0221: "Test endpoint" - a one-vector connectivity probe against the ENTERED values (incl. an inline
      // key, so it works before saving/relaunch), reporting the dimension the model returns so the UI auto-fills it.
      if (p === "/api/embeddings/test" && req.method === "POST") {
        const b = await readBody<{ baseUrl?: unknown; model?: unknown; authKind?: unknown; headerName?: unknown; secret?: unknown }>(req);
        const baseUrl = String(b.baseUrl ?? "").trim(), model = String(b.model ?? "").trim();
        if (!baseUrl || !model) return json({ ok: true, data: { ok: false, error: "Base URL and model are required." } });
        const authKind = b.authKind === "bearer" || b.authKind === "apikey" ? b.authKind : "none";
        const secret = typeof b.secret === "string" && b.secret ? b.secret : (authKind !== "none" ? process.env.LUCID_EMBEDDINGS_KEY : undefined);
        try {
          const { dim } = await probeEmbeddings({ baseUrl, model, authKind, secret, headerName: typeof b.headerName === "string" ? b.headerName : undefined });
          return json({ ok: true, data: { ok: true, dim } });
        } catch (e) { return json({ ok: true, data: { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) } }); }
      }
      // ADR-0221: "Re-index" - rebuild every KG's semantic index from its compiled pages (idempotent). Only
      // meaningful once semantic search is active. Synchronous (KGs are few; embeddings are cheap next to compile).
      if (p === "/api/embeddings/reindex" && req.method === "POST") {
        const embedder = desktopEmbedder();
        if (!embedder) return json({ ok: true, data: { ok: false, error: "Semantic search isn't active. Enable it (and relaunch if it uses a cloud key) first." } });
        let kgs = 0, pages = 0, stored = 0;
        for (const kg of listKgs()) {
          try { const r = await syncVectorIndex(kg.kg_id, kg.name, embedder); kgs++; pages += r.pages; stored += r.stored; }
          catch (e) { console.error(`[REINDEX] ${kg.name} skipped:`, (e as Error)?.message); }
        }
        return json({ ok: true, data: { ok: true, kgs, pages, stored } });
      }
      if (p === "/api/auth") return json({ ok: true, data: providerAuth() });
      if (p === "/api/auth/key" && req.method === "POST") {
        const { env, key } = await readBody<{ env?: unknown; key?: unknown }>(req);
        setKey(String(env), String(key ?? ""));
        backend.restart(); // pick up the new env on next turn
        return json({ ok: true, data: providerAuth() });
      }
      if (p === "/api/auth/oauth" && req.method === "POST") {
        const { oauthId, promptAnswer } = await readBody<{ oauthId?: unknown; promptAnswer?: unknown }>(req);
        // GitHub Copilot's broker opens with an enterprise-domain prompt on stdin (blank = github.com); feed
        // it so the device URL surfaces. Other providers don't read a leading prompt, so leave it undefined.
        const id = String(oauthId);
        const answer = id === "github-copilot"
          ? (typeof promptAnswer === "string" ? promptAnswer : "")
          : (typeof promptAnswer === "string" ? promptAnswer : undefined);
        // omp owns the secure OAuth flow; the broker stays alive + drained until the callback lands.
        return json({ ok: true, data: await startOauthBroker(id, answer) });
      }
      // Device-authorization flow: xAI "Grok Build", GitHub device flow, etc. The user copies a code
      // from the provider's browser page and pastes it here; we forward it to the broker's stdin.
      if (p === "/api/auth/oauth-code" && req.method === "POST") {
        const { oauthId, code } = await readBody<{ oauthId?: unknown; code?: unknown }>(req);
        const r = sendOauthCode(String(oauthId), String(code ?? ""));
        return json({ ok: true, data: r });
      }
      if (p === "/api/auth/logout" && req.method === "POST") {
        const { oauthId } = await readBody<{ oauthId?: unknown }>(req);
        const id = String(oauthId);
        // Best-effort omp bookkeeping (keychain/in-memory), THEN the authoritative clear: omp's logout only
        // soft-disables and can time out on a cold/reinstalled box, leaving the row "connected". Deleting the
        // credential row is what actually clears the login (the token lives in that row's `data`), so the
        // Settings status reflects it regardless of whether the omp spawn succeeded.
        Bun.spawnSync([ompBin(), "auth-broker", "logout", id], { timeout: 4000 });
        disconnectCredential(id);
        return json({ ok: true, data: providerAuth() });
      }
      // "Sign out of all providers" — clears EVERY OAuth login, including orphans the per-provider Disconnect
      // can't reach (a broker id with no Settings descriptor, or a key-only provider that still has an oauth
      // row). The reliable post-reinstall reset. API keys are untouched.
      if (p === "/api/auth/logout-all" && req.method === "POST") {
        const r = clearAllOauthCredentials();
        return json({ ok: true, data: providerAuth(), removed: r.removed });
      }
      // P-IMG.1 (ADR-0208): "Send to preview" for a chat image. Validate the image through the strict gate,
      // write a self-contained wrapper HTML (image embedded as a data: URI — allowed by the preview frame CSP)
      // into the workspace, and hand back its path. The existing local-file preview pipeline then renders it
      // in the iframe with the markup canvas overlaid, so the user can annotate + screenshot → chat to iterate.
      if (p === "/api/preview/image" && req.method === "POST") {
        const { dataUrl } = await readBody<{ dataUrl?: unknown }>(req);
        const parsed = parseImageDataUrl(typeof dataUrl === "string" ? dataUrl : "");
        if (!parsed) return json({ ok: false, error: "not a valid PNG, JPEG, WebP or GIF image" });
        const html = previewImageHtml(`data:${parsed.mimeType};base64,${parsed.base64}`);
        if (!html) return json({ ok: false, error: "could not render the image for preview" });
        const dir = join(currentWorkspace(), ".omp", "images");
        mkdirSync(dir, { recursive: true });
        const outPath = join(dir, `img_${randomBytes(6).toString("hex")}.html`);
        writeFileSync(outPath, html, "utf8");
        return json({ ok: true, data: { path: outPath } });
      }
      // AskSage gov gateway (ADR-0007)
      if (p === "/api/asksage") {
        if (req.method === "POST") {
          const b = await readBody<{ baseUrl?: unknown; only?: unknown; limit?: unknown; datasets?: unknown; queryModel?: unknown; persona?: unknown }>(req);
          const prev = asksageConfig();
          setAsksage({
            baseUrl: typeof b.baseUrl === "string" ? b.baseUrl : undefined,
            only: typeof b.only === "boolean" ? b.only : undefined,
            limit: typeof b.limit === "number" ? b.limit : undefined,
            datasets: Array.isArray(b.datasets) ? b.datasets.map(String) : undefined,
            queryModel: typeof b.queryModel === "string" ? b.queryModel : undefined,
            persona: typeof b.persona === "string" ? b.persona : undefined,
          });
          const next = asksageConfig();
          // The omp child reads datasets/model/persona/base from env at spawn - restart to apply.
          if ((typeof b.baseUrl === "string" && next.base !== prev.base) || (b.datasets !== undefined && next.datasets.join(",") !== prev.datasets.join(",")) || (b.queryModel !== undefined && next.queryModel !== prev.queryModel) || (b.persona !== undefined && next.persona !== prev.persona)) backend.restart();
        }
        const c = asksageConfig();
        return json({ ok: true, data: { configured: c.configured, base: c.base, only: c.only, limit: c.limit, datasets: c.datasets, queryModel: c.queryModel, persona: c.persona } });
      }
      if (p === "/api/asksage/tokens") return json({ ok: true, data: await monthlyTokens() });
      if (p === "/api/asksage/datasets") return json({ ok: true, data: await listDatasets() });
      if (p === "/api/asksage/personas") return json({ ok: true, data: await listPersonas() });
      if (p === "/api/asksage/persona" && req.method === "POST") {
        const { id, clear } = await readBody<{ id?: unknown; clear?: unknown }>(req);
        if (clear) { backend.setPersona(null); return json({ ok: true, data: { cleared: true } }); }
        const personas = (await listPersonas()) ?? [];
        const persona = personas.find((x) => x.id === String(id));
        if (!persona) return json({ ok: false, error: "persona not found" });
        const scan = await scanPersona(persona.text); // SAME scanner as tool calls - fail-closed
        if (!scan.ok) { backend.setPersona(null); return json({ ok: true, data: { applied: false, scan } }); }
        backend.setPersona(wrapPersona(persona.id, persona.text)); // delimited, delivered in the user turn
        return json({ ok: true, data: { applied: true, scan } });
      }
      // P-TRAINER.7 (ADR-0255): the in-app Trainer, driven by the real harness core over trainer.duckdb.
      // State (coverage/domains/gap/question) + games are pure over confirmed units; the answer -> unit
      // distiller is fail-closed on a model + the scanner sidecar (submitAnswer returns distilled:false when
      // absent, never storing unscanned text).
      if (p === "/api/trainer") return json({ ok: true, data: await trainerState() });
      if (p === "/api/trainer/answer" && req.method === "POST") { const b = await readBody<{ text?: unknown }>(req); return json({ ok: true, data: await trainerAnswer(typeof b.text === "string" ? b.text : "") }); }
      if (p === "/api/trainer/games") return json({ ok: true, data: await trainerGames() });
      // P-TRAINER.8: build + activate a coverage pack for ANY role from a name + tasks and/or a pasted
      // Position Description (the PD is the user's own text, parsed as data, never executed).
      if (p === "/api/trainer/role" && req.method === "POST") {
        const b = await readBody<{ role?: unknown; tasks?: unknown; pdText?: unknown; demo?: unknown }>(req);
        // demo:true = the user explicitly picked the labeled WMO sample; seed + activate it (idempotent).
        if (b.demo === true) return json({ ok: true, data: { ok: true, state: await trainerUseDemoPack() } });
        const role = typeof b.role === "string" ? b.role : "";
        const tasks = Array.isArray(b.tasks) ? b.tasks.filter((t): t is string => typeof t === "string") : [];
        const pdText = typeof b.pdText === "string" ? b.pdText : undefined;
        return json({ ok: true, data: await trainerSetRole({ role, tasks, pdText }) });
      }
      if (p === "/api/config") return json({ ok: true, data: await backend.getConfig() });
      // P-MODELDEF: the user's explicitly-chosen model (sticky default across launches). GET reads it;
      // POST {value} persists it ("" clears). The renderer sets it only on a genuine user pick.
      if (p === "/api/model/chosen") {
        if (req.method === "POST") { const b = await readBody<{ value?: unknown }>(req); setChosenModel(typeof b.value === "string" ? b.value : ""); }
        return json({ ok: true, data: chosenModel() });
      }
      // P-MODEL.2: the LAST model the composer actually ran on, as persisted by the backend's syncModelEnv.
      // Read-only: it is written from omp's reported active model, never from the UI. The renderer needs it
      // because "what was I last using?" and "what did I once click in the picker?" (chosenModel, above)
      // are different questions, and the renderer's boot-time default used to consult only the latter. A
      // user who switched models via the composer and never opened the picker therefore had an empty
      // chosenModel and got re-defaulted to a heuristic pick on every launch, which is the "it keeps
      // going back to Opus 4.8" the user reported.
      if (p === "/api/model/last") return json({ ok: true, data: loadSettings().lastModel ?? "" });
      // Manual "Refresh models": respawn omp so it re-reads the credential vault, then return the
      // fresh model list. Used after connecting a provider (OAuth or key) without relaunching.
      if (p === "/api/config/refresh" && req.method === "POST") { backend.restart(); return json({ ok: true, data: await backend.getConfig() }); }
      if (p === "/api/commands") return json({ ok: true, data: await backend.getCommands() });
      // P-TRIV.3 (ADR-0176): executive Trivia Wire intel news - first-party curated feeds, fetched
      // server-side, scan-gated fail-closed, fail-quiet to [] offline. Audited per fetch (egress events).
      if (p === "/api/intel-news") return json({ ok: true, data: await intelNews() });
      // P-TRIV.4 (ADR-0191): AI re-seed the Trivia Wire. The renderer POSTs the role + opt-in sources; we
      // gather that on-device context, hand it to seedTrivia which SCANS it fail-closed (a finding or a dead
      // scanner drops the whole re-seed - the model is never called), delimits it late, and generates a pack
      // on the user's SELECTED model (throwaway util session, tool-free). Fail-quiet: the caller keeps the seed.
      if (p === "/api/trivia/reseed" && req.method === "POST") {
        const b = await readBody<{ model?: unknown; role?: unknown; sources?: { sessions?: unknown; kg?: unknown; codegraph?: unknown } }>(req);
        const sources = { sessions: !!b.sources?.sessions, kg: !!b.sources?.kg, codegraph: !!b.sources?.codegraph };
        const data = await seedTrivia(
          { role: typeof b.role === "string" ? b.role : "developer", sources, model: typeof b.model === "string" ? b.model : "" },
          {
            providers: {
              sessions: () => listSessions().sessions.map((s) => s.title),
              kg: () => { const g = personalGraph(); return g ? [...g.facts.map((f) => f.statement), ...g.nodes.map((n) => n.name)] : []; },
              code: () => (loadCodeGraph(currentWorkspace())?.nodes ?? []).map((n) => n.name),
            },
            complete: (system, user, m) => backend.complete(system, user, m ? { model: m } : {}),
          },
        );
        return json({ ok: true, data });
      }
      if (p === "/api/skills") return json({ ok: true, data: await listSkills() });
      // P-SKILL.1 (ADR-0045): gated drop-import. Each dropped .md is scanned fail-closed; clean ones
      // are written under .omp/skills/<slug>/SKILL.md, flagged ones are held for Security-panel review.
      if (p === "/api/skills/import" && req.method === "POST") {
        const b = await readBody<{ files?: { name?: unknown; content?: unknown }[] }>(req);
        const files = Array.isArray(b.files) ? b.files.slice(0, 20) : []; // cap one drop at 20 files
        const results = [];
        for (const f of files) {
          const content = String(f?.content ?? "");
          if (!content.trim()) { results.push({ ok: false, name: String(f?.name ?? "skill"), reason: "empty file" }); continue; }
          results.push(await importSkill(String(f?.name ?? "skill.md"), content));
        }
        return json({ ok: true, data: { results } });
      }
      // P-SKILL.4 (ADR-0097): the directory's per-skill management menu. All three resolve the skill by
      // NAME through omp's own discovery (never a client-supplied path) and are pathWithin-confined:
      //   inspect — read the SKILL.md body + resource tree as DATA (the renderer delimits it);
      //   rescan  — run the fail-closed gate + record the verdict (dead scanner ⇒ quarantined);
      //   remove  — delete a project/user skill dir; bundled/agents/plugin are refused (immutable).
      if (p === "/api/skills/inspect" && req.method === "POST") {
        const b = await readBody<{ name?: unknown }>(req);
        return json({ ok: true, data: await inspectSkill(String(b.name ?? "")) });
      }
      if (p === "/api/skills/rescan" && req.method === "POST") {
        const b = await readBody<{ name?: unknown }>(req);
        return json({ ok: true, data: await rescanSkill(String(b.name ?? "")) });
      }
      if (p === "/api/skills/remove" && req.method === "POST") {
        const b = await readBody<{ name?: unknown }>(req);
        return json({ ok: true, data: await removeSkill(String(b.name ?? "")) });
      }
      // P-SKILLREG.1 (ADR-0098): the enterprise-registry READER seam. A connector (private add-on) POSTs a
      // fetched, signed skill artifact; the reader verifies its signature, runs it through the fail-closed
      // scan gate, and installs it locally ONLY if both pass \u2014 then it appears as a `registry` directory row.
      // Fail-closed: unsigned / bad-signature / scan-flagged / dead-scanner \u2192 blocked, nothing written.
      if (p === "/api/skills/registry/install" && req.method === "POST") {
        const b = await readBody<{ artifact?: RegistrySkillArtifact }>(req);
        if (!b.artifact) return json({ ok: true, data: { ok: false, name: "", installed: false, stage: "validate", reason: "missing artifact" } });
        return json({ ok: true, data: await installRegistrySkill(b.artifact) });
      }
      // P-SKILL.5 (ADR-0101): Skill Studio. `analyze` gathers the user's recent work into a delimited DATA
      // digest and asks the most-used model for candidate skills; `draft` codifies ONE reviewed candidate
      // through the SAME fail-closed import gate (clean writes to .omp/skills, flagged blocks). Analysis
      // uses backend.complete (the model call) with the digest's model; nothing is written at analyze time.
      if (p === "/api/skill-studio/analyze" && req.method === "POST") {
        const b = await readBody<{ window?: unknown }>(req);
        const window: StudioWindow = b.window === "today" ? "today" : "week";
        const data = await analyzeWork(window, {
          gather: gatherWorkDigest,
          complete: (system, user, model) => backend.complete(system, user, model ? { model } : {}),
        });
        return json({ ok: true, data });
      }
      if (p === "/api/skill-studio/draft" && req.method === "POST") {
        const b = await readBody<{ candidate?: SkillCandidate }>(req);
        const c = b.candidate;
        if (!c || typeof c.name !== "string" || typeof c.description !== "string" || typeof c.body !== "string") {
          return json({ ok: true, data: { ok: false, name: "", reason: "invalid candidate" } });
        }
        return json({ ok: true, data: await codifyCandidate({ name: c.name, description: c.description, body: c.body }) });
      }
      // P-KB.2b (ADR-0099/0100 desktop plumbing): the compiled knowledge base surface. ingest = scan the
      // source + compile (backend.complete, most-used model) + re-scan each derived page, all fail-closed;
      // retrieve = the router (the vector store is not desktop-wired yet, so vector/hybrid return the
      // compiled hits) delimited + cited; graph = pages + links for the force-graph view.
      if (p === "/api/kb/ingest" && req.method === "POST") {
        const b = await readBody<{ sourcePath?: unknown; title?: unknown; text?: unknown }>(req);
        const text = String(b.text ?? "");
        if (!text.trim()) return json({ ok: true, data: { documentId: "", status: "quarantined", pagesCompiled: 0, pagesQuarantined: 0, links: 0, pageIds: [], blocked: [{ stage: "source", reason: "empty document", trustLabel: "quarantined", findings: 0 }] } });
        const model = usageLedger().models[0]?.model;
        const result = await ingestDocument({
          store: await kbStore(),
          scanner: kbScanner(),
          complete: (system, user) => backend.complete(system, user, model ? { model } : {}),
          sourcePath: String(b.sourcePath ?? "document"),
          title: String(b.title ?? "Untitled"),
          text,
          onBlock: (blk) => recordBlock({ tool: "kb_ingest", severity: "high", findings: String(blk.findings), reason: `KB ${blk.stage} blocked${blk.slug ? ` (${blk.slug})` : ""}: ${blk.reason}` }),
        });
        return json({ ok: true, data: result });
      }
      if (p === "/api/kb/retrieve" && req.method === "POST") {
        const b = await readBody<{ query?: unknown; mode?: unknown }>(req);
        const requested: RetrieveMode = b.mode === "vector" || b.mode === "hybrid" ? b.mode : "compiled";
        const store = await kbStore();
        // ADR-0221: auto-upgrade to HYBRID (semantic vectors + lexical compiled) when an embeddings endpoint is
        // configured AND the active KG has embedded chunks; else stay lexical. The knowledge_search tool always
        // asks for "compiled" — this transparently upgrades it when vectors exist, and degrades safely if not.
        const embedder = desktopEmbedder();
        let vector: RetrieveArgs["vector"];
        if (embedder) {
          try {
            const vstore = await knowledgeVectorStore();
            const ds = (await vstore.listDatasets()).find((d) => d.embedding_model === embedder.id && d.dim === embedder.dim);
            if (ds && (await vstore.chunkCount(ds.dataset_id)) > 0) vector = { store: vstore, datasetId: ds.dataset_id, embedder };
          } catch { /* no vector store yet → lexical */ }
        }
        const mode: RetrieveMode = vector ? "hybrid" : (requested === "vector" ? "compiled" : requested);
        return json({ ok: true, data: await retrieveKnowledge({ query: String(b.query ?? ""), mode, compiled: { store }, vector }) });
      }
      // ── P-KG.3: the agent's read/write path into the UNLOCKED personal knowledge graph ──────────────
      // Backs the omp-native `memory_recall` / `memory_retain` tools (harness/omp/knowledge_extension.ts),
      // which POST here through the token'd LUCID_KG_RECALL_URL / LUCID_KG_RETAIN_URL they inherit.
      //
      // Before this, the agent could only SEE the graph as a server-injected <user-profile> preamble and
      // could not write to it at all, so "remember that I prefer X" was a promise the product could not
      // keep. All gating (locked / trust / compartment / shape) lives in the pure agent_kg.ts and is
      // applied by desktop/personal.ts; these routes are transport only and add no policy of their own.
      //
      // FAIL-CLOSED on both sides, and the two failure modes are deliberately DISTINGUISHABLE to the
      // model: a locked vault reports `locked` with a reason, never an empty success on a read (which
      // would read as "the user has told me nothing") and never a silent success on a write (which would
      // teach the model it has memory it does not have).
      if (p === "/api/kg/recall" && req.method === "POST") {
        const b = await readBody<{ query?: unknown; kinds?: unknown; limit?: unknown }>(req);
        return json({ ok: true, data: agentRecall({
          query: String(b.query ?? ""),
          ...(Array.isArray(b.kinds) ? { kinds: b.kinds.filter((k): k is string => typeof k === "string") } : {}),
          ...(typeof b.limit === "number" ? { limit: b.limit } : {}),
        }) });
      }
      // The body is passed through UNVALIDATED on purpose: vetAgentWrite is the single validator, and
      // re-deriving the shape here would create a second, drifting copy of that contract. It receives
      // `unknown` and returns either a normalized write or a refusal reason.
      if (p === "/api/kg/retain" && req.method === "POST") {
        return json({ ok: true, data: agentRetain(await readBody<unknown>(req)) });
      }
      if (p === "/api/kb/graph") {
        const s = await kbStore();
        return json({ ok: true, data: { pages: await s.listPages(), links: await s.listLinks() } });
      }
      // P-KGPACK.2 (ADR-0205): the named-KG picker. list/create/rename/activate over the KG registry
      // (file-per-KG, ADR-0205). Mutations return the refreshed list; a validation error rides on `error`
      // rather than nulling the list, so the picker can toast and still redraw. No trust path here - the
      // registry only maps ids↔files; ingest gating (fail-closed) is unchanged and lives in the pipeline.
      if (p === "/api/kb/list") {
        return json({ ok: true, data: kgListView() });
      }
      if (p === "/api/kb/create" && req.method === "POST") {
        const b = await readBody<{ name?: unknown }>(req);
        try { createKg({ name: String(b.name ?? "") }); }
        catch (e) { return json({ ok: true, data: kgListView(clientError(e, "could not load knowledge graphs")) }); }
        return json({ ok: true, data: kgListView() });
      }
      if (p === "/api/kb/rename" && req.method === "POST") {
        const b = await readBody<{ kgId?: unknown; name?: unknown }>(req);
        try { renameKg(String(b.kgId ?? ""), String(b.name ?? "")); }
        catch (e) { return json({ ok: true, data: kgListView(clientError(e, "could not load knowledge graphs")) }); }
        return json({ ok: true, data: kgListView() });
      }
      if (p === "/api/kb/activate" && req.method === "POST") {
        const b = await readBody<{ kgId?: unknown }>(req);
        try { setActiveKg(String(b.kgId ?? "")); }
        catch (e) { return json({ ok: true, data: kgListView(clientError(e, "could not load knowledge graphs")) }); }
        return json({ ok: true, data: kgListView() });
      }
      // P-KGPACK.3 (ADR-0205): seed a named KG from a folder of AI-vendor conversations or Obsidian markdown.
      // `name` creates + names the KG at ingest ("rename at ingest"); otherwise an explicit `kgId`, else the
      // active KG. Each source is compiled through the SAME fail-closed pipeline (scan source + re-scan every
      // page); blocks are audited via recordBlock. Capped (KB_BATCH_CAP) with the remainder reported skipped.
      if (p === "/api/kb/ingest-batch" && req.method === "POST") {
        // P-KGPACK.6 (ADR-0205): start the seed as a BACKGROUND job and return a jobId immediately (the old
        // synchronous path capped at 50 to avoid hanging the request on hundreds of model calls). No cap now
        // — authoring compiles the WHOLE dataset; the UI polls /status + can /cancel.
        const b = await readBody<{ path?: unknown; name?: unknown; kgId?: unknown }>(req);
        const src = readKbSources(String(b.path ?? ""));
        if (!src.ok) return json({ ok: true, data: { ok: false, error: src.error } });
        let targetId: string, kgName: string;
        try {
          const name = typeof b.name === "string" ? b.name.trim() : "";
          if (name) { const e = createKg({ name, sourceKind: src.scan.kind, provenance: src.scan.vendor ? `import:${src.scan.vendor}` : "import:obsidian" }); targetId = e.kg_id; kgName = e.name; }
          else { targetId = (typeof b.kgId === "string" && b.kgId) ? b.kgId : (activeKgId() ?? ""); kgName = listKgs().find((k) => k.kg_id === targetId)?.name ?? ""; }
        } catch (e) { return json({ ok: true, data: { ok: false, error: clientError(e, "could not create or resolve the knowledge graph") } }); }
        if (!targetId) return json({ ok: true, data: { ok: false, error: "No target knowledge graph." } });
        const model = usageLedger().models[0]?.model;
        const started = startKbIngest({
          kgId: targetId, kgName,
          run: async (onTick, signal) => {
            const result = await ingestSourcesIntoKg({
              store: await kbStore(targetId),
              scanner: kbScanner(),
              // The job's abort signal rides along, so Stop interrupts the in-flight compile call instead
              // of waiting it out (same fix as the chat-history import, ADR-0264).
              complete: (system: string, user: string) => backend.complete(system, user, { ...(model ? { model } : {}), signal }),
              docs: src.scan.docs,
              onProgress: onTick,
              signal,
              onBlock: (blk) => recordBlock({ tool: "kb_ingest", severity: "high", findings: String(blk.findings), reason: `KB ${blk.stage} blocked${blk.slug ? ` (${blk.slug})` : ""}: ${blk.reason}` }),
            });
            // ADR-0221: rebuild the KG's SEMANTIC index from its compiled pages, when an embeddings endpoint is
            // configured. Best-effort: a failure here (or no embedder) leaves the KG lexical-only; never fails
            // the compile job. Same routine as the explicit "re-index" action, so both stay consistent.
            try {
              const embedder = desktopEmbedder();
              if (embedder && !signal?.aborted) await syncVectorIndex(targetId, kgName, embedder);
            } catch (e) { console.error("[EMBED] semantic index skipped:", (e as Error)?.message); }
            return { ...result, kgId: targetId, kgName, kind: src.scan.kind, vendor: src.scan.vendor ?? null };
          },
        });
        return json({ ok: true, data: { ok: started.ok, jobId: started.ok ? started.jobId : undefined, kgId: targetId, kgName, error: started.ok ? undefined : started.error } });
      }
      if (p === "/api/kb/ingest-batch/status" && req.method === "GET")
        return json({ ok: true, data: kbIngestJobStatus(url.searchParams.get("jobId") ?? undefined) });
      if (p === "/api/kb/ingest-batch/cancel" && req.method === "POST") {
        const b = await readBody<{ jobId?: unknown }>(req);
        return json({ ok: true, data: cancelKbIngest(b.jobId == null ? undefined : String(b.jobId)) });
      }
      // P-KGPACK.4 (ADR-0205): author (export) + gated import of .lkgpack KG Packs. Export writes a
      // <slug>.lkgpack dir (db + signed-or-unsigned manifest); import verifies integrity + origin, re-scans
      // every page fail-closed, and installs a read-only, untrusted KG (keystone #2). See desktop/kb_pack.ts.
      if (p === "/api/kb/pack/export" && req.method === "POST") {
        const b = await readBody<{ kgId?: unknown; dest?: unknown; author?: unknown; version?: unknown; role?: unknown; description?: unknown }>(req);
        const kgId = String(b.kgId ?? ""), dest = String(b.dest ?? "");
        if (!kgId || !dest) return json({ ok: true, data: { ok: false, error: "kgId and dest are required" } });
        const r = await exportKgPack(kgId, dest, {
          author: typeof b.author === "string" ? b.author : undefined,
          version: typeof b.version === "string" ? b.version : undefined,
          role: typeof b.role === "string" ? b.role : undefined,
          description: typeof b.description === "string" ? b.description : undefined,
          createdAt: new Date().toISOString(),
        });
        return json({ ok: true, data: r });
      }
      if (p === "/api/kb/pack/import" && req.method === "POST") {
        const b = await readBody<{ path?: unknown }>(req);
        const path = String(b.path ?? "");
        if (!path) return json({ ok: true, data: { ok: false, error: "path is required" } });
        return json({ ok: true, data: await importKgPack(path) });
      }
      // P-KGMARKET.4 (ADR-0206): download a signed `.lkgpack.zip` (the entitlement backend's getPackDownload
      // URL) and install it through the SAME gate as a local import (verify + re-scan fail-closed, read-only).
      if (p === "/api/kb/pack/install-from-url" && req.method === "POST") {
        const b = await readBody<{ url?: unknown }>(req);
        const url = String(b.url ?? "");
        if (!url) return json({ ok: true, data: { ok: false, error: "url is required" } });
        return json({ ok: true, data: await installPackFromUrl(url) });
      }
      // P-SKILLREG.2 (ADR-0102): the PUBLISH seam. Reads a codified skill's SKILL.md and publishes it as a
      // versioned artifact to the configured targets (fail-safe fan-out). Public ships the LOCAL publisher;
      // a declared remote with no registered publisher is a clean no-op. Publishing establishes NO trust:
      // the signature + scan gate still run on the READ side (P-SKILLREG.1) before anything installs.
      if (p === "/api/skills/publish" && req.method === "POST") {
        const b = await readBody<{ name?: unknown; version?: unknown; targets?: unknown }>(req);
        const insp = await inspectSkill(String(b.name ?? ""));
        if (!insp.ok || !insp.body) return json({ ok: true, data: { ok: false, receipts: [], reason: insp.reason ?? "skill not found or empty" } });
        const version = typeof b.version === "string" && b.version ? b.version : "1.0.0";
        const targets = Array.isArray(b.targets) ? b.targets.filter((t): t is string => typeof t === "string") : undefined;
        const dispatcher = new PublishDispatcher();
        dispatcher.setPublishers(publishersFor());
        const receipts = await dispatcher.publish(buildSkillArtifact({ name: insp.name, version, content: insp.body }), targets);
        return json({ ok: true, data: { ok: receipts.some((r) => r.ok), receipts } });
      }
      // P-CMD.1 (ADR-0146): user-authored "/" slash commands. GET = list stored commands; POST = create one
      // (validate → secret-scan → Unicode-scan, all fail-closed → persist). The delete route removes one.
      if (p === "/api/usercommand" && req.method === "GET") return json({ ok: true, data: listUserCommands() });
      if (p === "/api/usercommand" && req.method === "POST") {
        const b = await readBody<{ command?: unknown }>(req);
        return json({ ok: true, data: await createUserCommand(b.command) });
      }
      if (p === "/api/usercommand/delete" && req.method === "POST") {
        const b = await readBody<{ name?: unknown }>(req);
        return json({ ok: true, data: { deleted: deleteUserCommand(String(b.name ?? "")) } });
      }
      if (p === "/api/headroom") {
        if (req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); return json({ ok: true, data: setHeadroomEnabled(!!b.enabled) }); }
        return json({ ok: true, data: headroomStatus() });
      }
      // Personalization knowledge graph (ADR-0010 P9.1 / ADR-0012). Passphrase custody;
      // the passphrase never leaves this handler and is never persisted.
      if (p === "/api/personal") return json({ ok: true, data: personalStatus() });
      if (p === "/api/personal/enable" && req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); return json({ ok: true, data: enablePersonal(!!b.enabled) }); }
      if (p === "/api/personal/ai-extract" && req.method === "POST") { const b = await readBody<{ enabled?: unknown }>(req); setPersonalAiExtract(!!b.enabled); return json({ ok: true, data: personalStatus() }); }
      if (p === "/api/personal/setup" && req.method === "POST") { const b = await readBody<{ passphrase?: unknown }>(req); return json({ ok: true, data: setupPersonal(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/unlock" && req.method === "POST") { const b = await readBody<{ passphrase?: unknown }>(req); return json({ ok: true, data: unlockPersonal(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/lock" && req.method === "POST") return json({ ok: true, data: lockPersonal() });
      if (p === "/api/personal/scope" && req.method === "POST") { const b = await readBody<{ scope?: unknown }>(req); return json({ ok: true, data: setScope(String(b.scope ?? "personal") as any) }); }
      // P9.5a: the isolated CUI store has its OWN setup/unlock/lock (separate file + passphrase).
      if (p === "/api/personal/cui/setup" && req.method === "POST") { const b = await readBody<{ passphrase?: unknown }>(req); return json({ ok: true, data: setupCui(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/cui/unlock" && req.method === "POST") { const b = await readBody<{ passphrase?: unknown }>(req); return json({ ok: true, data: unlockCui(String(b.passphrase ?? "")) }); }
      if (p === "/api/personal/cui/lock" && req.method === "POST") return json({ ok: true, data: lockCui() });
      // P9.5b: audited migration (move legacy cui out of the main store) + records destruction.
      if (p === "/api/personal/cui/migrate" && req.method === "POST") return json({ ok: true, data: migrateCuiIntoStore() });
      if (p === "/api/personal/cui/destroy" && req.method === "POST") return json({ ok: true, data: destroyCui() });
      if (p === "/api/personal/graph") return json({ ok: true, data: personalGraph((url.searchParams.get("scope") ?? undefined) as any) });
      if (p === "/api/personal/forget" && req.method === "POST") { const b = await readBody<{ factId?: unknown }>(req); return json({ ok: true, data: forgetFact(String(b.factId ?? "")) }); }
      // P-KG-REL.1 (ADR-0075): user-authored relationship between two existing, visible nodes. First-party
      // (not external content) → no scanner; relateEntities validates both nodes + sanitizes the label.
      if (p === "/api/personal/relate" && req.method === "POST") { const b = await readBody<{ from?: unknown; to?: unknown; relation?: unknown }>(req); return json({ ok: true, data: relateEntities(String(b.from ?? ""), String(b.to ?? ""), b.relation == null ? undefined : String(b.relation)) }); }
      if (p === "/api/personal/unrelate" && req.method === "POST") { const b = await readBody<{ from?: unknown; to?: unknown; relation?: unknown }>(req); return json({ ok: true, data: unrelateEntities(String(b.from ?? ""), String(b.to ?? ""), b.relation == null ? undefined : String(b.relation)) }); } // P-KG-REL.3
      // P9.7: import a ChatGPT / Claude / Gemini export (folder, .json, or .zip). Every imported
      // user message is scanned by the fail-closed gate first. `model:true` runs the richer LLM
      // extractor via a throwaway omp completion (capped); otherwise the offline heuristic.
      if (p === "/api/personal/import" && req.method === "POST") {
        // P-KG-INGEST.1 (ADR-0076): start the import as a BACKGROUND job and return a jobId immediately,
        // so the request never blocks the app for ~25 minutes. The renderer polls /status + can /cancel.
        const b = await readBody<{ model?: unknown; path?: unknown; vendor?: ImportVendor }>(req);
        const path = String(b.path ?? ""), vendor = b.vendor;
        // The extractor's signal is the JOB's abort signal, so Stop interrupts the in-flight model call
        // instead of waiting for it (P-KG-INGEST.5, ADR-0264).
        const complete: CompleteFn | undefined = b.model
          ? (system, user, o) => backend.complete(system, user, { signal: o?.signal })
          : undefined;
        const started = startImport({
          vendor: typeof vendor === "string" ? vendor : undefined,
          run: (onProgress, signal) => importChatExport(path, { vendorHint: vendor, complete, onProgress, signal }),
        });
        return json({ ok: true, data: started });
      }
      if (p === "/api/personal/import/status" && req.method === "GET")
        return json({ ok: true, data: importJobStatus(url.searchParams.get("jobId") ?? undefined) });
      if (p === "/api/personal/import/cancel" && req.method === "POST") {
        const b = await readBody<{ jobId?: unknown }>(req);
        return json({ ok: true, data: cancelImport(b.jobId == null ? undefined : String(b.jobId)) });
      }
      // P-IMP.2 (ADR-0035): read-only pre-import estimate (message + char counts) so the renderer can
      // warn about AI-mode token cost + runtime before the capped, paid model extraction runs.
      if (p === "/api/personal/import/estimate" && req.method === "POST") {
        const b = await readBody<{ path?: unknown }>(req);
        return json({ ok: true, data: await estimateChatExport(String(b.path ?? "")) });
      }
      // P-IDE.5 (ADR-0036): gated read/write for the in-app code editor. Reads + writes are confined to
      // the workspace; saves pass through the fail-closed scanner gate before anything touches disk.
      if (p === "/api/editor/file" && req.method === "POST") {
        const b = await readBody<{ path?: unknown }>(req);
        return json({ ok: true, data: readEditorFile(String(b.path ?? "")) });
      }
      if (p === "/api/editor/save" && req.method === "POST") {
        const b = await readBody<{ path?: unknown; content?: unknown; baseSha?: unknown; overwrite?: unknown }>(req);
        return json({ ok: true, data: await saveEditorFile({ path: String(b.path ?? ""), content: String(b.content ?? ""), baseSha: b.baseSha != null ? String(b.baseSha) : undefined, overwrite: !!b.overwrite }) });
      }
      // P9.4: audited decrypt→export. Vault excludes CUI unless explicitly listed; the
      // CUI archive is a separate, loud, NARA-aligned records-management path.
      if (p === "/api/personal/vault" && req.method === "POST") {
        const b = await readBody<{ scopes?: unknown; dest?: unknown; reviewer?: unknown }>(req);
        const scopes = Array.isArray(b.scopes) ? b.scopes.map(String).filter((x: string) => x === "personal" || x === "work" || x === "cui") : undefined;
        return json({ ok: true, data: exportVault({ scopes, dest: typeof b.dest === "string" ? b.dest : undefined, reviewer: typeof b.reviewer === "string" ? b.reviewer : undefined }) });
      }
      if (p === "/api/personal/cui-archive" && req.method === "POST") {
        const b = await readBody<{ dest?: unknown; reviewer?: unknown; designation?: CuiDesignation }>(req);
        return json({ ok: true, data: exportCuiArchive({ dest: typeof b.dest === "string" ? b.dest : undefined, reviewer: typeof b.reviewer === "string" ? b.reviewer : undefined, designation: typeof b.designation === "object" && b.designation ? b.designation : undefined }) });
      }
      if (p === "/api/personal/exports") return json({ ok: true, data: exportHistory() });
      if (p === "/api/setConfig" && req.method === "POST") { const { configId, value } = await readBody<{ configId: string; value: string }>(req); const data = await backend.setConfig(configId, value); if (configId === "model" && collabManager.active) collabManager.refreshOptions(); /* P-COLLAB.14: mirror the model switch to edit guests */ return json({ ok: true, data }); }
      // P-ACP.2 (ADR-0027): ACP session modes (Plan / Agent). GET lists them + the active one;
      // POST {modeId} switches via session/set_mode.
      if (p === "/api/modes") {
        if (req.method === "POST") { const b = await readBody<{ modeId?: unknown }>(req); return json({ ok: true, data: await backend.setMode(String(b.modeId ?? "default")) }); }
        return json({ ok: true, data: await backend.getModes() });
      }
      // P-ACP.3: the composer's 3-way Plan/Ask/Agent. Ask = omp `default` + per-tool approval prompts.
      if (p === "/api/uimode" && req.method === "POST") {
        const b = await readBody<{ uiMode?: unknown }>(req);
        // CREATOR-0 (ADR-0279): `creator` is accepted only in a Creator build; anywhere else it folds to
        // `agent`, so a forged POST cannot light up a surface this build does not ship.
        const m: UiMode = normalizeUiMode(b.uiMode, BUILD.creatorBuild);
        return json({ ok: true, data: await backend.setUiMode(m) });
      }
      // P-ACP.3: the renderer's answer to a forwarded tool-permission request (Ask mode). optionId
      // empty/absent ⇒ deny (fail-closed).
      if (p === "/api/chat/permission" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; optionId?: unknown }>(req);
        return json({ ok: true, data: { resolved: backend.resolvePermission(String(b.id ?? ""), b.optionId != null ? String(b.optionId) : null) } });
      }
      // P-ACP.4: Stop — interrupt the in-flight turn (reply + tool calls) via ACP session/cancel.
      if (p === "/api/chat/cancel" && req.method === "POST") { backend.cancel(); return json({ ok: true, data: { cancelled: true } }); }
      if (p === "/api/goal/cancel" && req.method === "POST") { backend.cancelGoal(); return json({ ok: true, data: { cancelled: true } }); } // P-GOAL.2: stop the loop
      // P-IDE.2 (ADR-0029): set/clear the active BUNDLED skill. Its prompt is TRUSTED (app corpus), so
      // it's wrapped in `<active-skill>` and delivered as a user-turn preamble (persona/recall path) —
      // never the frozen prefix. Clearing passes {clear:true}.
      if (p === "/api/skill" && req.method === "POST") {
        const b = await readBody<{ name?: unknown; prompt?: unknown; clear?: unknown }>(req);
        if (b.clear) { backend.setSkill(null); return json({ ok: true, data: { active: "" } }); }
        const name = String(b.name ?? "").slice(0, 80);
        const prompt = String(b.prompt ?? "").slice(0, 8000);
        if (!name || !prompt) return json({ ok: false, error: "name + prompt required" });
        backend.setSkill(`<active-skill name="${name.replace(/"/g, "&quot;")}">\n${prompt}\n</active-skill>`, name);
        return json({ ok: true, data: { active: backend.activeSkillName() } });
      }
      // P-IDE.3 (ADR-0029): record a skill activation as telemetry (metadata only — command/name/source).
      if (p === "/api/skill/activated" && req.method === "POST") {
        const b = await readBody<{ command?: unknown; name?: unknown; source?: unknown }>(req);
        const source = b.source === "project" || b.source === "task" ? b.source : "bundled";
        recordSkillActivated({ command: String(b.command ?? "").slice(0, 80), name: String(b.name ?? "").slice(0, 80), source });
        return json({ ok: true, data: { recorded: true } });
      }
      // ADR-0009 Phase A: re-load the cross-session recall block for the fresh session (read-only).
      if (p === "/api/newSession" && req.method === "POST") { await backend.newSession(); await refreshRecall(); return json({ ok: true }); }
      // P-FLEET.L5 (ADR-0274): the reviewable timeline - every session on this machine (master chats,
      // lane sessions labeled through the durable ledger, ingest throwaways), across ALL workspaces,
      // newest first. Reading a point reuses the same transcript reader the sidebar resume uses; the
      // injected user-turn preamble is already stripped for display there (issue #52).
      // `?selfTest=1` opts the repo's own echo/demo throwaways back IN (held back by default).
      if (p === "/api/timeline") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const includeSelfTest = url.searchParams.get("selfTest") === "1";
        return json({ ok: true, data: listTimeline({ limit: Number.isFinite(limit) ? limit : 100, offset: Number.isFinite(offset) ? offset : 0, includeSelfTest }) });
      }
      if (p === "/api/timeline/session" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; limit?: unknown }>(req);
        const lim = Number(b.limit ?? 40);
        return json({ ok: true, data: sessionMessages(String(b.id ?? ""), Number.isFinite(lim) && lim > 0 ? lim : 40) });
      }
      // P-FLEET.L1/L2: the local lane fleet. Status is metadata (lanes + pressure evidence); prompt streams
      // the lane's turn as NDJSON exactly like /api/chat; answer resolves a pending approval (fail-closed on
      // silence).
      if (p === "/api/fleet/status") return json({ ok: true, data: await fleet.status() });
      if (p === "/api/fleet/spawn" && req.method === "POST") {
        const b = await readBody<{ cwd?: unknown; model?: unknown; name?: unknown; repoUrl?: unknown; pat?: unknown }>(req);
        // P-FLEET.L2: a lane can be spawned straight from a GitHub / GitLab / Azure DevOps remote. The clone
        // lands INSIDE the folder the user picked in the OS dialog (or under ~/.omp/lucid-workspaces when
        // they picked none) and an existing clone is reused, so re-spawning the same repo is idempotent.
        // `pat` is the freshly-typed token: used only to spawn git, redacted out of any error, never logged,
        // never persisted here (the vault copy is written by the renderer through main's safeStorage) and
        // never forwarded to the agent.
        const repoUrl = typeof b.repoUrl === "string" ? b.repoUrl.trim() : "";
        let cwd = String(b.cwd ?? "");
        if (repoUrl) {
          const c = await cloneRepo(repoUrl, typeof b.pat === "string" && b.pat ? b.pat : undefined, cwd || undefined);
          if (!c.ok || !c.path) return json({ ok: true, data: { ok: false, reason: c.error || "git clone failed" } });
          cwd = c.path;
        }
        const r = await fleet.spawn({ cwd, model: typeof b.model === "string" && b.model ? b.model : undefined, name: typeof b.name === "string" && b.name ? b.name : undefined });
        return json({ ok: true, data: r });
      }
      // P-FLEET.L3: lane prompts carry P-VISION.1 image blocks like /api/chat (defensively filtered,
      // capped at 6). The same filter guards the queue and its drain below.
      if (p === "/api/fleet/prompt" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown; text?: unknown; images?: unknown }>(req);
        const laneId = String(b.laneId ?? "");
        const text = String(b.text ?? "");
        return ndjsonStream("fleet", (emit) => fleet.prompt(laneId, text, emit, laneImages(b.images)));
      }
      // P-FLEET.L3: the staged-prompt queue - manager-owned (survives dock close), drained FIFO by the
      // renderer when the lane goes idle, so every drained turn streams into a visible card.
      if (p === "/api/fleet/queue" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown; text?: unknown; images?: unknown }>(req);
        return json({ ok: true, data: fleet.enqueue(String(b.laneId ?? ""), String(b.text ?? ""), laneImages(b.images)) });
      }
      if (p === "/api/fleet/queue/remove" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown; index?: unknown }>(req);
        return json({ ok: true, data: fleet.queueRemove(String(b.laneId ?? ""), Number(b.index)) });
      }
      if (p === "/api/fleet/queue/move" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown; index?: unknown; dir?: unknown }>(req);
        return json({ ok: true, data: fleet.queueMove(String(b.laneId ?? ""), Number(b.index), Number(b.dir) < 0 ? -1 : 1) });
      }
      if (p === "/api/fleet/drain" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown }>(req);
        const laneId = String(b.laneId ?? "");
        return ndjsonStream("fleet", (emit) => fleet.drain(laneId, emit));
      }
      // P-FLEET.L4 (ADR-0274): retry streams the re-sent last turn exactly like /api/fleet/prompt;
      // respawn revives an error/stopped lane IN PLACE (same id, memory carried) and returns its view.
      if (p === "/api/fleet/retry" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown }>(req);
        const laneId = String(b.laneId ?? "");
        return ndjsonStream("fleet", (emit) => fleet.retry(laneId, emit));
      }
      if (p === "/api/fleet/respawn" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown }>(req);
        return json({ ok: true, data: await fleet.respawn(String(b.laneId ?? "")) });
      }
      // P-FLEET.L6: answer carries an optional approval SCOPE - "session" remembers the pending ask's
      // kind for the lane's lifetime (only on an allow; the manager ignores scope on a deny, fail-closed).
      if (p === "/api/fleet/answer" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown; allow?: unknown; scope?: unknown }>(req);
        if (b.scope !== undefined && b.scope !== "once" && b.scope !== "session") return json({ ok: false, error: `invalid scope "${String(b.scope)}"` });
        return json({ ok: true, data: fleet.answer(String(b.laneId ?? ""), b.allow === true, b.scope as "once" | "session" | undefined) });
      }
      // P-FLEET.L6: full auto-mode. laneId targets ONE lane; omitted applies to ALL lanes and persists
      // fleetAutoApprove as the default for new lanes. Turning auto ON anywhere is refused until the user
      // has explicitly accepted the risk once (fleetAutoRiskAcceptedAt; acceptRisk === true records it).
      // The in-omp security gate still scans every tool call in auto mode - only the human ask goes away.
      if (p === "/api/fleet/auto" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown; on?: unknown; acceptRisk?: unknown }>(req);
        const on = b.on === true;
        if (on && !loadSettings().fleetAutoRiskAcceptedAt) {
          if (b.acceptRisk !== true) return json({ ok: false, error: "full auto-mode needs an explicit risk acceptance first" });
          saveSettings({ ...loadSettings(), fleetAutoRiskAcceptedAt: Date.now() });
        }
        const laneId = typeof b.laneId === "string" && b.laneId ? b.laneId : "";
        if (laneId) return json({ ok: true, data: fleet.setAuto(laneId, on) });
        fleet.setAutoAll(on);
        saveSettings({ ...loadSettings(), fleetAutoApprove: on });
        return json({ ok: true, data: { ok: true } });
      }
      if (p === "/api/fleet/cancel" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown }>(req);
        return json({ ok: true, data: fleet.cancel(String(b.laneId ?? "")) });
      }
      if (p === "/api/fleet/stop" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown }>(req);
        return json({ ok: true, data: fleet.stop(String(b.laneId ?? "")) });
      }
      // P-FLEET.L10: DISMISS a lane (stop parks it, this forgets it). Fail-closed on a live turn unless
      // the caller passes `force`, so one click can never destroy work in flight; the UI makes it a
      // two-step gesture instead. The lane's on-disk session log and its ledger line both survive, so a
      // dismissed lane is still reviewable on the timeline.
      if (p === "/api/fleet/remove" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown; force?: unknown }>(req);
        return json({ ok: true, data: fleet.remove(String(b.laneId ?? ""), b.force === true) });
      }
      if (p === "/api/fleet/model" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown; model?: unknown }>(req);
        return json({ ok: true, data: await fleet.setModel(String(b.laneId ?? ""), String(b.model ?? "")) });
      }
      // P-FLEET.L8: the composer ATTACHES to a lane. Promotion does not move the ACP session - the
      // lane's omp child, cwd, and model are untouched - so it works MID-TURN and demotion is instant.
      // The response carries the lane's bounded transcript so the composer can render history without a
      // second round trip, and the manager writes the promote/demote provenance line itself.
      if (p === "/api/fleet/promote" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown }>(req);
        return json({ ok: true, data: fleet.promote(String(b.laneId ?? "")) });
      }
      if (p === "/api/fleet/demote" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown }>(req);
        const laneId = typeof b.laneId === "string" && b.laneId ? b.laneId : undefined;
        return json({ ok: true, data: fleet.demote(laneId) });
      }
      if (p === "/api/fleet/promoted") return json({ ok: true, data: { lane: fleet.promotedLane() } });
      // P-FLEET.L8: FOLLOW a lane's live events without owning its turn. This is what lets the composer
      // join a turn that is ALREADY RUNNING: fleet.observe() is a persistent sink that survives turn
      // boundaries and respawns, so a promote mid-turn starts streaming from the next chunk instead of
      // waiting for the turn to end. Distinct from /api/fleet/prompt, which OWNS a turn; a watcher must
      // never be able to start one.
      if (p === "/api/fleet/watch" && req.method === "POST") {
        const b = await readBody<{ laneId?: unknown }>(req);
        const laneId = String(b.laneId ?? "");
        if (!laneId) return json({ ok: false, error: "laneId is required" });
        return ndjsonStream("fleet-watch", async (emit) => {
          const gate = Promise.withResolvers<void>();
          const dispose = fleet.observe((id, e) => { if (id === laneId) emit(e); });
          // The stream lives until the CLIENT leaves. Without this it would resolve immediately and the
          // renderer would reconnect in a tight loop.
          const stop = () => { dispose(); gate.resolve(); };
          if (req.signal.aborted) stop();
          else req.signal.addEventListener("abort", stop, { once: true });
          const seed = fleet.laneTranscript(laneId);
          if (seed.length) emit({ type: "watch-seed", turns: seed });
          await gate.promise;
        });
      }
      if (p === "/api/fleet/transcript") {
        const laneId = url.searchParams.get("laneId") ?? "";
        return json({ ok: true, data: { turns: fleet.laneTranscript(laneId) } });
      }
      // P-HEALTH.1: what the self-watch currently thinks, and a manual kick. The GET is read-only (it
      // takes no action), so the renderer can poll it beside the status poll; the POST forces one ladder
      // step, which is the "I do not want to wait for the next tick" button.
      //
      // NAMED `/api/session-health`, NOT `/api/health`: that path is already the ADR-0305 port-guard
      // nonce endpoint, and it is the ONE route deliberately exempt from the token gate above, because a
      // foreign process squatting the engine port has to be detectable before anything is authenticated.
      // Reusing it would have both shadowed this route (the guard is registered first and wins) and hung
      // session telemetry off an unauthenticated path.
      if (p === "/api/session-health") return json({ ok: true, data: { master: backend.healthStatus(), lanes: fleet.healthReport() } });
      if (p === "/api/session-health/tick" && req.method === "POST") {
        const [master, lanes] = await Promise.all([backend.healthTick(), fleet.healthTick()]);
        return json({ ok: true, data: { master, lanes } });
      }
      // P-INTERJECT.1: mid-turn operator interjections. POST queues a note for "master" or a laneId
      // (store enforces trim/4000-char/8-note discipline; validation here mirrors it for a crisp error).
      // GET /pending returns AND clears atomically - the single consumer is the target's omp child
      // (interject_extension.ts polls it once per tool result via the token'd LUCID_INTERJECT_URL).
      if (p === "/api/interject" && req.method === "POST") {
        const b = await readBody<{ target?: unknown; text?: unknown }>(req);
        const target = String(b.target ?? "").trim();
        const text = String(b.text ?? "").trim();
        if (!target) return json({ ok: false, error: "target required" });
        if (!text) return json({ ok: false, error: "text required" });
        if (text.length > 4000) return json({ ok: false, error: "note too long (max 4000 chars)" });
        const r = addInterject(target, text);
        return r.ok ? json({ ok: true, data: { pending: pendingInterjectCount(target) } }) : json({ ok: false, error: r.reason });
      }
      if (p === "/api/interject/pending" && req.method === "GET") {
        const target = String(url.searchParams.get("target") ?? "").trim();
        return json({ ok: true, data: { notes: target ? drainInterjects(target) : [] } });
      }
      // P-INTERJECT.1: the unified Processes list (master turn, live lanes, import job, wave-2 browsers).
      if (p === "/api/processes") return json({ ok: true, data: { processes: await buildProcessViews() } });
      if (p === "/api/chat" && req.method === "POST") {
        const { text, images, from, share } = await readBody<{ text?: unknown; images?: unknown; from?: unknown; share?: unknown }>(req);
        // P-VISION.1 (ADR-0136): pasted-image content blocks ride alongside the text (defensively filtered).
        const imgs = Array.isArray(images)
          ? images.filter((im): im is { data: string; mimeType: string } => !!im && typeof (im as { data?: unknown }).data === "string" && typeof (im as { mimeType?: unknown }).mimeType === "string").slice(0, 6)
          : undefined;
        const prompt = String(text ?? "");
        // P-COLLAB.3 (ADR-0192): when a share is live, mirror this turn to view-only guests. The tap is a
        // best-effort passthrough — a collab failure must never break the local chat stream.
        // P-COLLAB.15: `from` (present for a guest-driven turn) attributes the broadcast; else the host authors it.
        const turnFrom = typeof from === "string" && from.trim() ? String(from).slice(0, 48) : undefined;
        if (collabManager.active) { try { collabManager.tapUserTurn(prompt, turnFrom); } catch { /* non-fatal */ } }
        // P-PREVIEW-PWA.3 (ADR-0240): while guests watch, the MODEL sees a trusted awareness preamble (counts
        // only - guest names are untrusted and withheld); the CLEAN prompt above is what guests get mirrored
        // (P-COLLAB.15) and what the user typed. Relay roster is read here; a renderer-hosted direct-P2P share
        // sends its counts in the body (validated). Rebuilt per turn -> appears/vanishes with the roster.
        let bodyShare: ShareCounts | null = null;
        if (share && typeof share === "object" && "view" in share && "edit" in share) {
          const v = Number(share.view);
          const e = Number(share.edit);
          if (Number.isFinite(v) && Number.isFinite(e)) bodyShare = { view: v, edit: e };
        }
        const counts = collabManager.active ? accessCounts(collabManager.status().participants) : bodyShare;
        const awareness = buildShareAwareness(counts);
        const modelPrompt = awareness ? `${awareness}\n\n${prompt}` : prompt;
        return ndjsonStream("chat", (emit) => backend.prompt(modelPrompt, (e) => {
          // acp_backend's ChatEvent and bridge's are structurally identical (kept in parity); bridge over the
          // separate declarations at this one boundary.
          if (collabManager.active) { try { collabManager.tapEvent(e as unknown as Parameters<typeof collabManager.tapEvent>[0]); } catch { /* non-fatal */ } }
          emit(e);
        }, imgs));
      }
      // P-COLLAB.3 (ADR-0192): live session sharing. `status` is the Share panel's poll; `start` mints a
      // room + view/full links + stands up the host (fail-closed if no relay is authorized); `stop` ends it.
      // `relay` GET/POST reads + configures the authorized relay (self-hosted default, public opt-in).
      if (p === "/api/collab/status") return json({ ok: true, data: { ...collabManager.status(), relay: effectiveRelay() } });
      // P-REMOTE.2c: the renderer pushes a fresh Firebase ID token for the GATED hosted relay. Token-gated like
      // every /api call; the token itself is never logged or echoed back (only whether one is now cached).
      if (p === "/api/collab/token" && req.method === "POST") {
        const b = await readBody<{ idToken?: unknown; expiresAt?: unknown }>(req);
        const idToken = typeof b.idToken === "string" ? b.idToken : "";
        const expiresAt = Number(b.expiresAt);
        if (!idToken) { relayTokenCache.clear(); return json({ ok: true, data: { present: false } }); }
        relayTokenCache.set(idToken, expiresAt);
        return json({ ok: true, data: { present: relayTokenCache.present } });
      }
      if (p === "/api/collab/start" && req.method === "POST") {
        const b = await readBody<{ allowEdit?: unknown; favModels?: unknown }>(req);
        // P-REMOTE.11b: snapshot the renderer's favorite models for the guest picker (validated, capped).
        collabFavModels = Array.isArray(b.favModels) ? b.favModels.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, MAX_FAVS) : [];
        pendingGuestPrompt = null; guestAbortRequested = false; pendingGuestModel = null; pendingGuestWorkspace = null; // fresh inbox per share
        try {
          const status = await collabManager.start({ allowEdit: b.allowEdit === true });
          // P-COLLAB.18: audit the RELAY share start (metadata only).
          recordCollabShareStarted({ transport: "relay", access: status.allowEdit ? "edit" : "view", roomId: status.roomId, relaySource: status.relaySource });
          return json({ ok: true, data: status });
        }
        catch (e) { return json({ ok: false, error: clientError(e, "could not start the share") }); }
      }
      if (p === "/api/collab/stop" && req.method === "POST") {
        const prev = collabManager.status(); // capture the roomId/access before the share is torn down
        pendingGuestPrompt = null; guestAbortRequested = false; pendingGuestModel = null; pendingGuestWorkspace = null;
        const data = collabManager.stop("host ended the session");
        if (prev.active) recordCollabShareStopped({ transport: "relay", access: prev.allowEdit ? "edit" : "view", roomId: prev.roomId, relaySource: prev.relaySource });
        return json({ ok: true, data });
      }
      // P-PREVIEW-PWA.1 (ADR-0237): broadcast a Preview-panel snapshot to RELAY guests. The renderer captured +
      // downscaled it; we just tap it into the live CollabHost (E2E-sealed, relay sees only ciphertext). Fail-
      // closed: no active relay share OR a non-image payload -> sent:false, nothing broadcast.
      if (p === "/api/collab/preview" && req.method === "POST") {
        const b = await readBody<{ image?: unknown; label?: unknown }>(req);
        const image = typeof b.image === "string" ? b.image : "";
        const label = typeof b.label === "string" ? b.label.slice(0, 120) : undefined;
        if (!collabManager.active || !image.startsWith("data:image/")) return json({ ok: true, data: { sent: false } });
        try { collabManager.tapEvent({ type: "preview-snapshot", image, ...(label ? { label } : {}) }); } catch { /* non-fatal */ }
        return json({ ok: true, data: { sent: true } });
      }
      // P-COLLAB.13 (ADR-0198): the HOST renderer polls this while sharing with edit; it runs any pending
      // guest prompt through its own composer (gate + approvals) + aborts on request. Consume-on-read.
      if (p === "/api/collab/guest-inbox") {
        // P-COLLAB.14: also carry a guest's model / already-used-folder pick (workspace as a host-LOCAL path -
        // resolved from the opaque id here, never sent to the guest). Consume-on-read like prompt/abort.
        const out = { prompt: pendingGuestPrompt, abort: guestAbortRequested, model: pendingGuestModel, workspace: pendingGuestWorkspace };
        pendingGuestPrompt = null; guestAbortRequested = false; pendingGuestModel = null; pendingGuestWorkspace = null;
        return json({ ok: true, data: out });
      }
      // The connected GUEST drives the host (EDIT access only - CollabGuest.sendPrompt no-ops when read-only).
      if (p === "/api/collab/guest-prompt" && req.method === "POST") {
        const b = await readBody<{ text?: unknown; images?: unknown }>(req);
        const g = collabGuest?.guest;
        if (!g) return json({ ok: false, error: "you are not connected to a shared session" });
        // P-REMOTE.8: a desktop watch-guest may attach images too (validated image data URLs).
        const images = Array.isArray(b.images) ? b.images.filter((s): s is string => typeof s === "string") : undefined;
        const sent = g.sendPrompt(String(b.text ?? ""), images);
        return sent ? json({ ok: true, data: { sent: true } }) : json({ ok: false, error: "you are watching read-only - ask the host for an edit link" });
      }
      if (p === "/api/collab/guest-abort" && req.method === "POST") { collabGuest?.guest.abort(); return json({ ok: true, data: { aborted: true } }); }
      // P-COLLAB.14: the connected GUEST switches the host's active model / already-used folder (EDIT access
      // only - CollabGuest.setModel/setWorkspace no-op when read-only or the pick isn't in the offered list).
      if (p === "/api/collab/guest-model" && req.method === "POST") {
        const b = await readBody<{ value?: unknown }>(req);
        const g = collabGuest?.guest;
        if (!g) return json({ ok: false, error: "you are not connected to a shared session" });
        return g.setModel(String(b.value ?? "")) ? json({ ok: true, data: { sent: true } }) : json({ ok: false, error: "you can't switch the model here - ask the host for an edit link" });
      }
      if (p === "/api/collab/guest-workspace" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        const g = collabGuest?.guest;
        if (!g) return json({ ok: false, error: "you are not connected to a shared session" });
        return g.setWorkspace(String(b.id ?? "")) ? json({ ok: true, data: { sent: true } }) : json({ ok: false, error: "you can't switch the folder here - ask the host for an edit link" });
      }
      if (p === "/api/collab/relay" && req.method === "GET") return json({ ok: true, data: { relay: collabRelayConfig() } });
      if (p === "/api/collab/relay" && req.method === "POST") {
        const b = await readBody<{ url?: unknown; publicOptIn?: unknown }>(req);
        setCollabRelay({
          ...(typeof b.url === "string" ? { url: b.url } : {}),
          ...(typeof b.publicOptIn === "boolean" ? { publicOptIn: b.publicOptIn } : {}),
        });
        return json({ ok: true, data: { relay: collabRelayConfig() } });
      }
      // P-COLLAB.17 (ADR-0202): the "prefer direct P2P (WebRTC)" preference + STUN/TURN config. The renderer
      // owns the P2P host/guest (RTCPeerConnection is renderer-only); this just persists the choice + servers,
      // and reports the org lock so the toggle disables under managed policy. `guestName` labels a P2P watcher.
      if (p === "/api/collab/p2p" && req.method === "GET") {
        return json({ ok: true, data: { config: collabP2PConfig(), guestName: collabDisplayName(), managed: { locked: managedLocks(managedConfig().config).collab } } });
      }
      if (p === "/api/collab/p2p" && req.method === "POST") {
        if (managedLocks(managedConfig().config).collab) return json({ ok: false, error: "collaboration settings are locked by your organization" });
        const b = await readBody<{ preferDirect?: unknown; iceUrls?: unknown; turnUsername?: unknown; turnCredential?: unknown }>(req);
        setCollabP2P({
          ...(typeof b.preferDirect === "boolean" ? { preferDirect: b.preferDirect } : {}),
          ...(Array.isArray(b.iceUrls) ? { iceUrls: b.iceUrls.map((u) => String(u)) } : {}),
          ...(typeof b.turnUsername === "string" ? { turnUsername: b.turnUsername } : {}),
          ...(typeof b.turnCredential === "string" ? { turnCredential: b.turnCredential } : {}),
        });
        return json({ ok: true, data: { config: collabP2PConfig() } });
      }
      // P-COLLAB.17: authorize a relay endpoint for a DIRECT P2P join BEFORE the renderer connects to it - the
      // same fail-closed managed `allowedRelays` gate the backend join path applies (so P2P can't bypass policy).
      if (p === "/api/collab/authorize-connect" && req.method === "POST") {
        const b = await readBody<{ endpoint?: unknown }>(req);
        const endpoint = String(b.endpoint ?? "").trim();
        if (!endpoint) return json({ ok: false, error: "no relay endpoint" });
        const authz = authorizeRelayConnect(endpoint, managedConfig().config);
        return json({ ok: authz.ok, ...(authz.ok ? {} : { error: authz.reason }) });
      }
      // P-COLLAB.18 (ADR-0204): the RENDERER hosts a direct-P2P share itself (RTCPeerConnection is renderer-only)
      // and can't write the audit log, so it reports its share/join lifecycle here. Fail-closed: the action is a
      // CLOSED set (recordCollabAudit refuses anything else) and the metadata is whitelisted - the renderer can
      // never name an off-enum event or smuggle a key/link/content field into the trail.
      if (p === "/api/collab/audit" && req.method === "POST") {
        const b = await readBody<{ action?: unknown; meta?: unknown }>(req);
        const ok = recordCollabAudit(b.action, b.meta);
        return json({ ok });
      }
      // P-COLLAB.7 (ADR-0193): the "be the relay" toggle - host the embedded relay on this device.
      // `serve` is governance-gated + fail-closed; `status` drives the toggle (running + bind + managed lock).
      if (p === "/api/collab/relay/status") return json({ ok: true, data: relayServeStatus() });
      if (p === "/api/collab/relay/serve" && req.method === "POST") {
        const b = await readBody<{ enabled?: unknown; host?: unknown; port?: unknown }>(req);
        if (b.enabled === false) { stopRelay(); return json({ ok: true, data: relayServeStatus() }); }
        const host = typeof b.host === "string" && b.host.trim() ? b.host.trim() : "127.0.0.1";
        const port = Number.isFinite(Number(b.port)) && Number(b.port) > 0 ? Number(b.port) : DEFAULT_RELAY_PORT;
        const r = serveRelay(host, port);
        return r.ok ? json({ ok: true, data: relayServeStatus() }) : json({ ok: false, error: r.error });
      }
      // P-COLLAB.10 (ADR-0196): JOIN a shared session as a read-only guest. Parse the pasted invite, resolve +
      // authorize the relay endpoint (fail-closed via managed allowedRelays), connect a CollabGuest, and stream
      // its view (welcome / event / state / error / end) to the renderer as NDJSON until it ends. `leave` stops.
      if (p === "/api/collab/leave" && req.method === "POST") { leaveCollabGuest(); return json({ ok: true, data: { left: true } }); }
      if (p === "/api/collab/join" && req.method === "POST") {
        const b = await readBody<{ link?: unknown }>(req);
        let parsed;
        try { parsed = parseShareLink(String(b.link ?? "")); } catch { return json({ ok: false, error: "that invite link is malformed" }); }
        const relayBase = parsed.relay || effectiveRelay()?.wsBase || null;
        if (!relayBase) return json({ ok: false, error: "this link carries no relay, and no relay is configured to fall back to" });
        const authz = authorizeRelayConnect(relayBase, managedConfig().config);
        if (!authz.ok) return json({ ok: false, error: authz.reason });
        leaveCollabGuest(); // Phase 1: one watched session at a time
        return ndjsonStream("collab-join", (emit) => new Promise<void>((resolve) => {
          void (async () => {
            let key: CryptoKey;
            try { key = await importRoomKey(parsed.key); } catch { emit({ kind: "error", message: "the invite link's key is invalid" }); resolve(); return; }
            const wsUrl = `${relayBase.replace(/\/+$/, "")}/r/${parsed.roomId}`;
            // NOTE (P-REMOTE.2c): the desktop watching ANOTHER host stays anonymous here - gated-relay watch
            // (presenting this device's token as a guest) is out of scope; the phone is the guest that matters.
            const sock = new CollabSocket({ wsUrl, role: "guest", key });
            const guest = new CollabGuest(sock, { name: collabDisplayName(), writeToken: parsed.writeToken }, {
              onWelcome: (w) => emit({ kind: "welcome", header: w.header, transcript: w.transcript, participants: w.participants, readOnly: w.readOnly }),
              onEvent: (e) => emit({ kind: "event", event: e }),
              onState: (participants, model, contextPct) => emit({ kind: "state", participants, model, contextPct }),
              onError: (m) => emit({ kind: "error", message: m }),
              onEnd: (reason) => { emit({ kind: "end", reason }); if (collabGuest?.guest === guest) collabGuest = null; resolve(); },
            });
            collabGuest = { guest, sock };
            guest.start();
          })();
        }));
      }
      // P-GOAL.1 (ADR-0046): run a /goal loop — maker iterations + a separate verifiable checker, capped
      // and gated. Streams the same NDJSON chat events plus goal-iter / goal-check / goal-done / goal-stop.
      // P-GOAL.4: loops that stopped without meeting their condition (resumable from their memory file).
      // P-GOAL.6 (ADR-0048): the /goal checker MODEL — a distinct, cheaper judge. GET returns the saved
      // choice + the auto recommendation + the accessible list; POST persists the choice ("" = auto).
      if (p === "/api/checker-model" && req.method === "GET") return json({ ok: true, data: backend.checkerModelInfo() });
      if (p === "/api/checker-model" && req.method === "POST") {
        const b = await readBody<{ value?: unknown }>(req);
        return json({ ok: true, data: backend.setCheckerModelChoice(String(b.value ?? "")) });
      }
      if (p === "/api/goal/resumable") return json({ ok: true, data: listResumableLoops(currentWorkspace()) });
      // P-GOAL.14 (ADR-0112): browse PAST After-Action Reports for this workspace. GET lists them
      // (most-recent first); GET with ?rel= returns one report's markdown (confined to .omp/loops/).
      if (p === "/api/goal/reports") {
        const rel = url.searchParams.get("rel");
        if (rel) { const md = readGoalReport(currentWorkspace(), rel); return md != null ? json({ ok: true, data: { rel, markdown: md } }) : json({ ok: false, error: "report not found" }); }
        return json({ ok: true, data: listGoalReports(currentWorkspace()) });
      }
      // P-GOAL.10 (ADR-0055): cross-run evaluation — success rate / avg iters / failure breakdown + recent runs.
      if (p === "/api/goal/stats") return json({ ok: true, data: backend.loopRunStats() });
      // P-GOAL.12 (ADR-0057): Pre-Flight Audit — git scopes for the picker, and the readiness/design pass.
      if (p === "/api/goal/scopes") return json({ ok: true, data: backend.loopScopes() });
      if (p === "/api/goal/preflight" && req.method === "POST") {
        const b = await readBody<Record<string, unknown>>(req);
        const spec = {
          goal: String(b.goal ?? ""), command: b.command ? String(b.command) : undefined, scope: b.scope ? String(b.scope) : undefined,
          budgetUsd: Number(b.budgetUsd) || 0, maxIters: Number(b.maxIters) || undefined, checkerIsCheap: b.checkerIsCheap === true,
          doneDefinition: b.doneDefinition ? String(b.doneDefinition) : undefined, nonGoals: b.nonGoals ? String(b.nonGoals) : undefined,
          risks: b.risks ? String(b.risks) : undefined, feedback: b.feedback ? String(b.feedback) : undefined,
        };
        return json({ ok: true, data: await backend.preflightAudit(spec) });
      }
      if (p === "/api/goal" && req.method === "POST") {
        const b = await readBody<{ goal?: unknown; condition?: unknown; command?: unknown; maxIters?: unknown; resume?: unknown; budgetUsd?: unknown; criteria?: unknown; dial?: unknown }>(req);
        return ndjsonStream("goal", (emit) => backend.runGoal(
          { goal: String(b.goal ?? ""), condition: String(b.condition ?? ""), command: b.command ? String(b.command) : undefined, maxIters: Number(b.maxIters) || 6, resume: b.resume ? String(b.resume) : undefined, budgetUsd: Number(b.budgetUsd) || 0, criteria: b.criteria ? String(b.criteria) : undefined, dial: parseLoopDial(b.dial) },
          emit,
        ));
      }

      // P-GOAL.5 (ADR-0047): scheduled AUTOMATIONS — saved /goal specs the in-process scheduler runs on a
      // cadence (interval or daily) while the app is open. Created DISABLED; the user arms each explicitly.
      if (p === "/api/automations" && req.method === "GET") return json({ ok: true, data: listAutomations(currentWorkspace()) });
      if (p === "/api/automations" && req.method === "POST") {
        const b = await readBody<{ goal?: unknown; condition?: unknown; command?: unknown; maxIters?: unknown; cadence?: unknown; kind?: unknown; agentSpecId?: unknown; agentPrompt?: unknown; agentModel?: unknown }>(req);
        const cadence = normalizeCadence(b.cadence);
        if (!cadence) return json({ ok: false, error: "invalid cadence" });
        const a = createAutomation(currentWorkspace(),
          {
            goal: String(b.goal ?? ""), condition: b.condition ? String(b.condition) : undefined, command: b.command ? String(b.command) : undefined, maxIters: Number(b.maxIters) || 6, cadence,
            // P-AGENT.14: scheduled built-agent runs (created DISARMED like every automation)
            kind: b.kind === "agent" ? "agent" : undefined,
            agentSpecId: b.agentSpecId ? String(b.agentSpecId) : undefined,
            agentPrompt: b.agentPrompt ? String(b.agentPrompt) : undefined,
            agentModel: b.agentModel ? String(b.agentModel) : undefined,
          },
          Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), Date.now());
        return a ? json({ ok: true, data: a }) : json({ ok: false, error: "could not create (check the goal/agent fields)" });
      }
      if (p === "/api/automations/enable" && req.method === "POST") {
        const b = await readBody<{ id?: unknown; enabled?: unknown }>(req);
        const a = updateAutomation(currentWorkspace(), String(b.id ?? ""), { enabled: !!b.enabled });
        return a ? json({ ok: true, data: a }) : json({ ok: false, error: "not found" });
      }
      if (p === "/api/automations/delete" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        return json({ ok: deleteAutomation(currentWorkspace(), String(b.id ?? "")), data: { deleted: true } });
      }
      if (p === "/api/automations/run" && req.method === "POST") {
        const b = await readBody<{ id?: unknown }>(req);
        return ndjsonStream("automation", async (emit) => { await backend.runAutomation(String(b.id ?? ""), emit); });
      }

      const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      // ADR-0024: serve the HTML with the per-launch token injected as a meta tag. Same-origin
      // policy keeps a cross-origin page from reading this response body, so the token stays secret
      // to the real renderer; no-store so it's never cached across launches.
      // P-TRAINER.7: trainer.html is a same-origin iframe that calls the token-gated /api/trainer routes, so
      // it needs the per-launch token meta injected exactly like index.html.
      if (rel === "index.html" || rel === "trainer.html") {
        const html = (await Bun.file(join(ROOT, rel)).text())
          .replace("</head>", `  <meta name="lucid-token" content="${TOKEN}">\n</head>`);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      const file = Bun.file(join(ROOT, rel));
      if (await file.exists()) {
        const ext = rel.slice(rel.lastIndexOf("."));
        const ct = CT[ext] ?? "application/octet-stream";
        // Text assets (css/js/svg) must stay fresh so edits show on reload; cache only binary assets
        // (images/fonts), which are large and rarely change.
        return new Response(file, { headers: { "content-type": ct + (isTextCT(ct) ? "; charset=utf-8" : ""), "cache-control": isTextCT(ct) ? "no-store" : "max-age=86400" } });
      }
    } catch (err) {
      // js/stack-trace-exposure: log the detail server-side, return a generic message to the client
      // so an internal error/stack never reaches the renderer (or a forged caller).
      console.error(`[dev] ${p}:`, err);
      return json({ ok: false, error: "internal error" });
    }
    return new Response("not found", { status: 404 });
  },
});

// P-PREVIEW.3a-shot (ADR-0096): hand the omp subprocess a ready-to-use URL (real bound port + token) for the
// agent's preview_screenshot tool to fetch the cached shot. omp is spawned later (lazily, by acp_backend in
// THIS process) and inherits process.env, so setting it here — after the server binds — is enough; no
// ACPClient env plumbing needed. 127.0.0.1 (not localhost) matches the loopback bind.
process.env.LUCID_PREVIEW_SHOT_URL = `http://127.0.0.1:${server.port}/api/preview/shot?t=${TOKEN}`;
// P-PREVIEW.6b (ADR-0153): the agent's preview_inspect tool GETs this (with ?selector=&what=) to read the DOM.
process.env.LUCID_PREVIEW_INSPECT_URL = `http://127.0.0.1:${server.port}/api/preview/inspect?t=${TOKEN}`;
// P-PREVIEW.6c (ADR-0153): preview_click / preview_type GET this (with ?action=&selector=&value=) to act.
process.env.LUCID_PREVIEW_ACT_URL = `http://127.0.0.1:${server.port}/api/preview/act?t=${TOKEN}`;
// P-PREVIEW.11 (ADR-0308): preview_open POSTs {path} here so the panel opens from the TOOL's own call.
// The old path (acp_backend matching "preview_open: <path>" in the ACP title) is dead under intent
// tracing, which rewrites that title to the model's intent prose; it stays only as a fallback.
process.env.LUCID_PREVIEW_OPEN_URL = `http://127.0.0.1:${server.port}/api/preview/open?t=${TOKEN}`;
// ADR-0220: the `knowledge_search` tool (omp subprocess) POSTs the user's query here to ground on the local
// compiled knowledge base. Token'd URL, same pattern as the preview tools; retrieval returns delimited untrusted DATA.
process.env.LUCID_KB_RETRIEVE_URL = `http://127.0.0.1:${server.port}/api/kb/retrieve?t=${TOKEN}`;
// P-FLEET.L1: the master agent's fleet_status tool (omp subprocess) GETs this to see local lane status -
// metadata only (lane replies render in the fleet dashboard, never through this URL).
process.env.LUCID_FLEET_STATUS_URL = `http://127.0.0.1:${server.port}/api/fleet/status?t=${TOKEN}`;
// P-EVAL.4 (ADR-0318): the tool_meta extension POSTs {id,name,ok?} here for every tool call, because the
// real tool name exists ONLY inside omp's hook API - the ACP update carries a coarse `kind` and an
// intent-shadowed title. Unset means the extension self-skips, and reports fall back to the coarse kind.
process.env.LUCID_TOOL_META_URL = `http://127.0.0.1:${server.port}/api/tool/meta?t=${TOKEN}`;
// P-KG.3: the agent's memory_recall / memory_retain tools reach the UNLOCKED personal knowledge graph
// through these. Both fail closed when the vault is locked: recall returns no hits and retain refuses,
// so a locked vault can never be mistaken for an empty one (which would teach the model it has no memory)
// nor silently swallow a write (which would teach it that it does).
process.env.LUCID_KG_RECALL_URL = `http://127.0.0.1:${server.port}/api/kg/recall?t=${TOKEN}`;
process.env.LUCID_KG_RETAIN_URL = `http://127.0.0.1:${server.port}/api/kg/retain?t=${TOKEN}`;
// P-INTERJECT.1: the omp children (master + lanes) reach this server for mid-turn operator notes.
// LUCID_DEV_URL is the bare base URL from the shared contract; LUCID_INTERJECT_URL is the ready-to-use
// token'd drain endpoint (same pattern as LUCID_FLEET_STATUS_URL - /api requires the per-launch token,
// which a child can only carry as ?t=). Per-child LUCID_INTERJECT_TARGET rides the spawn env overlay
// (interjectChildEnv in acp_backend.ts for the master, the fleet env dep above for lanes).
process.env.LUCID_DEV_URL = `http://127.0.0.1:${server.port}`;
process.env.LUCID_INTERJECT_URL = `http://127.0.0.1:${server.port}/api/interject/pending?t=${TOKEN}`;
// P-BROWSER.1 (wave 2): the omp child's browser_* tools reach the agent-browser routes through this
// token'd BASE (the extension appends /open, /capture, /scroll, /close, /shot and keeps the ?t=).
// Gated on LUCID_MAIN_TOKEN: without the Electron main there is no window executor, so the env stays
// unset and browser_extension.ts skips registration entirely (bun-only / plain-browser dev runs).
if (process.env.LUCID_MAIN_TOKEN) process.env.LUCID_BROWSER_URL = `http://127.0.0.1:${server.port}/api/browser?t=${TOKEN}`;

// Build recall once at startup — the FIRST session is created lazily on the first /api/chat (never
// via /api/newSession), so this is what carries prior-session facts into it. Best-effort; the omp
// child isn't spawned yet here, so the read-only open is uncontended.
await refreshRecall();

// P-GOAL.5 (ADR-0047): arm the in-process automation scheduler. It only ticks while this dev server
// (and thus the app) is running; nothing is registered with the OS, so closing the app stops it.
backend.startAutomationScheduler();

console.log(`\n  ◆ LucidAgentIDE desktop renderer (dev)\n  → http://localhost:${server.port}\n`);
