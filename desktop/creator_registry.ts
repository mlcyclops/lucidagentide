// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/creator_registry.ts - CREATOR-0 (ADR-0282): the Creator integration registry.
//
// One honest, source-grounded catalog of every generative-media surface Creator Mode can reach, plus
// the validation for the endpoint DECLARATIONS a user adds. Two rules make this module trustworthy:
//
//   1. A capability is only "available" when an OFFICIAL, documented API/CLI/runtime surface exists.
//      Anything a vendor only exposes inside its own web product is `product-ui-only`; anything whose
//      endpoint the user must supply because no public API is published is `unverified-endpoint`;
//      anything on the roadmap is `planned`. The agent reads these labels and refuses to invent APIs.
//   2. A declaration NEVER holds a secret. It carries a vault credential NAME (`vaultRef`) or an env
//      var name; the value lives only in the OS-encrypted vault (ADR-0135 / ADR-0107 pattern).
//
// Pure module: no fetch, no fs, no child_process. The transports it describes are executed elsewhere
// through the existing gated paths (egress whitelist, exec approval, scan gate).

import { cuiProviderVerdict, type CuiVerdict } from "./cui_policy.ts";

/** Closed set of provider ids. A new provider is a deliberate registry change. */
export type CreatorProviderId =
  | "elevenlabs" | "dots-tts" | "suno" | "comfyui" | "threejs" | "blender" | "unreal"
  | "hyperframes" | "dgx-avatar" | "heygen" | "dgx-vision" | "design" | "drift"
  | "dgx-cad" | "pdf-markup" | "autodesk-aps" | "bluebeam-studio" | "classcad" | "oda-drawings";
export const CREATOR_PROVIDER_IDS: readonly CreatorProviderId[] = [
  "elevenlabs", "dots-tts", "suno", "comfyui", "threejs", "blender", "unreal",
  "hyperframes", "dgx-avatar", "heygen", "dgx-vision", "design", "drift",
  "dgx-cad", "pdf-markup", "autodesk-aps", "bluebeam-studio", "classcad", "oda-drawings",
] as const;

/** Where a provider sits in the Studio. Drives grouping only. The Design suite (dgx-vision, design) sits in
 *  "video", which the Studio already titles "Image and video": a separate "image" group would split one
 *  surface across two headings for no gain. */
export type CreatorGroup = "audio" | "video" | "3d" | "game" | "testing" | "cad";
export const CREATOR_GROUPS: readonly CreatorGroup[] = ["audio", "video", "3d", "game", "testing", "cad"] as const;

/** Closed capability vocabulary. The agent matches intent against THESE, never free text. */
export type CreatorCapabilityId =
  | "tts" | "stt" | "voice-clone" | "voice-design" | "dubbing" | "sfx" | "music" | "audio-isolation"
  | "alignment" | "streaming-audio" | "audio-mix" | "library-manage" | "remix"
  | "image" | "video" | "model-3d" | "scene-preview" | "render-still" | "render-animation"
  | "workflow-run" | "asset-import" | "engine-build" | "engine-test" | "runtime-feedback"
  | "avatar-video" | "video-compose" | "cad-model" | "cad-drawing" | "cad-convert" | "bim-inspect" | "pdf-markup"
  // Design suite: the DGX vision service (dgx-vision) and the in-renderer editor (design).
  | "segment" | "layer-decompose" | "matte" | "inpaint" | "upscale" | "depth" | "vision-label" | "vectorize"
  | "layers" | "mask-trace" | "vector-draw" | "motion" | "gif-export" | "svg-export" | "psd-export"
  // CutWire Drift (drift): a GPLv3 video editor reached through its own localhost agent protocol.
  | "video-edit" | "transcript-edit" | "stock-media";

/** Where a provider's data goes, for the CUI lockdown (contract section 1). `on-device` = this workstation
 *  (renderer, local child process, a loopback service the user runs); `enclave` = a DGX enclave host;
 *  `cloud` = a third-party service. `authorization` names the CUI authorization when one exists: none of the
 *  Creator providers carries one today, so every cloud entry is refused while the lockdown is on. */
export interface CreatorCuiPosture {
  readonly posture: "on-device" | "enclave" | "cloud";
  readonly authorization?: string;
}

/** How LUCID reaches the provider. `child-process` runs a declared executable through the existing
 *  exec-approval path; `in-renderer` never leaves the sandboxed renderer. */
export type CreatorTransport = "https" | "websocket" | "local-http" | "child-process" | "in-renderer";

export type CreatorAuthKind = "none" | "apikey" | "bearer" | "local";

/** Honesty labels. `available` means an official surface is documented TODAY. */
export type CreatorCapabilityStatus = "available" | "planned" | "product-ui-only" | "unverified-endpoint";

/** Which kind of official surface backs the capability. */
export type CreatorCapabilitySurface = "api" | "websocket" | "cli" | "runtime" | "product-ui" | "local";

export interface CreatorCapabilitySpec {
  readonly id: CreatorCapabilityId;
  readonly status: CreatorCapabilityStatus;
  readonly surface: CreatorCapabilitySurface;
  /** One line the UI shows verbatim and the agent may quote. No promises beyond the cited docs. */
  readonly detail: string;
}

export interface CreatorIntegrationSpec {
  readonly id: CreatorProviderId;
  readonly name: string;
  readonly group: CreatorGroup;
  readonly kind: "cloud" | "local-service" | "local-app" | "renderer";
  readonly transports: readonly CreatorTransport[];
  readonly authKind: CreatorAuthKind;
  /** Env var name the engine reads the secret from (never the secret). */
  readonly secretEnv?: string;
  /** Suggested vault credential NAME for the Settings flow. */
  readonly vaultRefHint?: string;
  /** True when using the provider for identity-preserving voice work needs recorded consent. */
  readonly consentRequired: boolean;
  /** Official documentation entry point. */
  readonly docsUrl: string;
  readonly capabilities: readonly CreatorCapabilitySpec[];
  /** Why the statuses above read the way they do. Rendered in the Studio row's detail line. */
  readonly note: string;
  /** CUI lockdown posture (contract section 4). Folded into every status row through cui_policy. */
  readonly cui: CreatorCuiPosture;
}

// ── the catalog ──────────────────────────────────────────────────────────────
// Grounded in official sources read during the CREATOR-0 research pass:
//   ElevenLabs API docs (elevenlabs.io/docs), studio-dots-ai/dots.tts (Apache-2.0, HF model cards),
//   comfyanonymous/ComfyUI server.py routes, mrdoob/three.js r0.185, Blender manual + bpy docs,
//   Unreal Engine remote-control / automation docs, and the Suno finding recorded in ADR-0281.

const ELEVENLABS: CreatorIntegrationSpec = {
  id: "elevenlabs",
  name: "ElevenLabs",
  group: "audio",
  kind: "cloud",
  transports: ["https", "websocket"],
  authKind: "apikey",
  secretEnv: "ELEVENLABS_API_KEY",
  vaultRefHint: "elevenlabs_api_key",
  consentRequired: true,
  docsUrl: "https://elevenlabs.io/docs",
  capabilities: [
    { id: "tts", status: "available", surface: "api", detail: "Text to speech with per-voice settings and multiple output formats." },
    { id: "streaming-audio", status: "available", surface: "websocket", detail: "Streaming synthesis for low-latency playback." },
    { id: "alignment", status: "available", surface: "api", detail: "Character and word timestamps - the spine of the follow-along editor." },
    { id: "stt", status: "available", surface: "api", detail: "Speech to text (Scribe), already wired into LUCID dictation." },
    { id: "voice-clone", status: "available", surface: "api", detail: "Instant and professional voice cloning; requires verified consent for the speaker." },
    { id: "voice-design", status: "available", surface: "api", detail: "Generate a synthetic voice from a description instead of a recording." },
    { id: "dubbing", status: "available", surface: "api", detail: "Dub a source track into another language, optionally identity preserving." },
    { id: "sfx", status: "available", surface: "api", detail: "Sound-effect generation from a prompt." },
    { id: "music", status: "available", surface: "api", detail: "Music generation where the account plan exposes it." },
    { id: "audio-isolation", status: "available", surface: "api", detail: "Strip background noise from a recording." },
    { id: "audio-mix", status: "planned", surface: "local", detail: "Multi-track mixing happens locally in LUCID; ElevenLabs returns single renders." },
    { id: "library-manage", status: "product-ui-only", surface: "product-ui", detail: "Studio project timeline editing, chapter layout, and shared workspace management live in the ElevenLabs web product." },
  ],
  note: "Cloud egress: audio and text leave the device. Air-gapped installs use the local engines instead.",
  cui: { posture: "cloud" },
};

const DOTS_TTS: CreatorIntegrationSpec = {
  id: "dots-tts",
  name: "dots.tts (local)",
  group: "audio",
  kind: "local-service",
  transports: ["local-http", "child-process"],
  authKind: "local",
  consentRequired: true,
  docsUrl: "https://github.com/studio-dots-ai/dots.tts",
  capabilities: [
    { id: "tts", status: "available", surface: "local", detail: "2B continuous autoregressive TTS at 48 kHz, Apache-2.0, served on your own GPU." },
    { id: "voice-clone", status: "available", surface: "local", detail: "Zero-shot cloning from a reference clip plus its transcript; nothing leaves your hardware." },
    { id: "streaming-audio", status: "available", surface: "local", detail: "Streaming generation through the runtime's stream API or an SGLang Omni server." },
    { id: "alignment", status: "planned", surface: "local", detail: "No official timestamp output; LUCID derives alignment locally for the follow-along editor." },
    { id: "music", status: "planned", surface: "local", detail: "Out of scope for dots.tts; use a music model or provider instead." },
  ],
  note: "Linux and macOS Python runtime, CUDA or MPS. LUCID talks to a server YOU run and ships no Python for it (invariant 2).",
  cui: { posture: "on-device" },
};

const SUNO: CreatorIntegrationSpec = {
  id: "suno",
  name: "Suno",
  group: "audio",
  kind: "cloud",
  transports: ["https"],
  authKind: "bearer",
  secretEnv: "LUCID_SUNO_TOKEN",
  vaultRefHint: "suno_partner_token",
  consentRequired: false,
  docsUrl: "https://suno.com",
  capabilities: [
    { id: "library-manage", status: "available", surface: "local", detail: "Import, store, tag, review, rate, and re-listen to songs in the local Creator library - works with zero API access." },
    { id: "remix", status: "available", surface: "local", detail: "Record remix and re-prompt lineage locally so every revision keeps its parent and its prompt." },
    { id: "music", status: "unverified-endpoint", surface: "api", detail: "Suno published no public self-serve API as of 2026 (curated partner program only), so generation needs YOUR partner base URL and token and is capability-probed before any call." },
    { id: "audio-mix", status: "planned", surface: "local", detail: "Stem-level mixing of Suno renders lands with the Creator mixer increment." },
  ],
  note: "No endpoint is hardcoded. LUCID never scrapes or automates the Suno web product; unofficial resellers are not registered.",
  cui: { posture: "cloud" },
};

const COMFYUI: CreatorIntegrationSpec = {
  id: "comfyui",
  name: "ComfyUI",
  group: "video",
  kind: "local-service",
  transports: ["local-http", "https", "websocket"],
  authKind: "bearer",
  secretEnv: "LUCID_COMFY_TOKEN",
  vaultRefHint: "comfyui_token",
  consentRequired: false,
  docsUrl: "https://docs.comfy.org",
  capabilities: [
    { id: "workflow-run", status: "available", surface: "api", detail: "POST /prompt queues a workflow graph and returns its prompt id." },
    { id: "runtime-feedback", status: "available", surface: "websocket", detail: "The /ws socket streams execution progress, node status, and preview frames." },
    { id: "image", status: "available", surface: "api", detail: "Image generation through whatever image nodes the server has installed." },
    { id: "video", status: "available", surface: "api", detail: "Video generation when video nodes and models are installed on that server." },
    { id: "model-3d", status: "available", surface: "api", detail: "3D asset nodes when installed; capability comes from /object_info, never assumption." },
    { id: "asset-import", status: "available", surface: "api", detail: "Upload inputs and fetch /history outputs as artifacts." },
    { id: "audio-mix", status: "planned", surface: "local", detail: "Audio nodes vary per install; LUCID mixes locally instead of assuming a graph." },
  ],
  note: "Capability comes from a live /object_info probe of THAT server. Remote servers ride the egress whitelist; a VPN endpoint is an internal-zone entry.",
  cui: { posture: "on-device" },
};

const THREEJS: CreatorIntegrationSpec = {
  id: "threejs",
  name: "three.js",
  group: "3d",
  kind: "renderer",
  transports: ["in-renderer"],
  authKind: "none",
  consentRequired: false,
  docsUrl: "https://threejs.org/docs",
  capabilities: [
    { id: "scene-preview", status: "available", surface: "runtime", detail: "Scenes run in the sandboxed Preview panel with WebGL2 or WebGPU." },
    { id: "render-still", status: "available", surface: "runtime", detail: "Screenshot the canvas back into chat for visual review." },
    { id: "runtime-feedback", status: "available", surface: "runtime", detail: "renderer.info reports draw calls, triangles, geometries, and textures for a perf budget." },
    { id: "asset-import", status: "available", surface: "runtime", detail: "glTF and the other loader formats the library ships." },
    { id: "render-animation", status: "planned", surface: "runtime", detail: "Deterministic frame-sequence capture lands with the video increment." },
  ],
  note: "No install, no egress, no key: the scene is ordinary code the agent writes and then looks at.",
  cui: { posture: "on-device" },
};

const BLENDER: CreatorIntegrationSpec = {
  id: "blender",
  name: "Blender",
  group: "3d",
  kind: "local-app",
  transports: ["child-process"],
  authKind: "local",
  consentRequired: false,
  docsUrl: "https://docs.blender.org/manual/en/latest/advanced/command_line/index.html",
  capabilities: [
    { id: "render-still", status: "available", surface: "cli", detail: "Background render of one frame: blender -b file.blend -o path -f N." },
    { id: "render-animation", status: "available", surface: "cli", detail: "Background render of a frame range with -s, -e, and -a." },
    { id: "runtime-feedback", status: "available", surface: "cli", detail: "Exit code plus captured stdout and stderr are the build signal." },
    { id: "asset-import", status: "available", surface: "cli", detail: "Exchange assets through .blend, glTF, OBJ, and image outputs." },
    { id: "model-3d", status: "planned", surface: "cli", detail: "Scripted scene AUTHORING runs user or project Python through the exec-approval path, per increment CREATOR-3." },
  ],
  note: "Fixed-argv child process only; the .blend and the output directory are path-confined. LUCID adds no Python of its own (invariant 2).",
  cui: { posture: "on-device" },
};

const UNREAL: CreatorIntegrationSpec = {
  id: "unreal",
  name: "Unreal Engine",
  group: "game",
  kind: "local-app",
  transports: ["child-process", "local-http"],
  authKind: "local",
  consentRequired: false,
  docsUrl: "https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-python-api",
  capabilities: [
    { id: "engine-build", status: "available", surface: "cli", detail: "UnrealBuildTool and commandlets drive builds and cooks headlessly." },
    { id: "engine-test", status: "available", surface: "cli", detail: "The Automation Test framework runs suites from the command line and reports results." },
    { id: "runtime-feedback", status: "available", surface: "cli", detail: "Log files plus exit status are the pass or fail evidence." },
    { id: "render-still", status: "planned", surface: "cli", detail: "Movie Render Queue stills land with the video increment." },
    { id: "workflow-run", status: "planned", surface: "api", detail: "The editor Remote Control API needs an explicitly opted-in, loopback-bound editor session (increment CREATOR-4)." },
  ],
  note: "Editor automation is opt-in and never enabled silently: the Remote Control listener is an open local control plane.",
  cui: { posture: "on-device" },
};

// ── video composition + avatars (free / self-hosted first, paid catalogued) ──
// HyperFrames (Apache-2.0, hyperframes.heygen.com) renders HTML compositions to video with headless Chrome
// plus FFmpeg. The DGX avatar service is the Loader's MuseTalk / EchoMimic pipeline behind a loopback HTTP
// API on the box (contract section 2a). HeyGen is the paid cloud counterpart, catalogued only.

const HYPERFRAMES: CreatorIntegrationSpec = {
  id: "hyperframes",
  name: "HyperFrames (local)",
  group: "video",
  kind: "local-app",
  transports: ["child-process"],
  authKind: "local",
  consentRequired: false,
  docsUrl: "https://hyperframes.heygen.com",
  capabilities: [
    { id: "video-compose", status: "available", surface: "cli", detail: "hyperframes render turns an HTML composition (data-start, data-duration, data-track-index) into MP4, WebM, or MOV with headless Chrome and FFmpeg." },
    { id: "render-animation", status: "available", surface: "cli", detail: "Seekable, deterministic frame capture: the same composition renders the same frames." },
    { id: "runtime-feedback", status: "available", surface: "cli", detail: "hyperframes lint runs before every render; exit code plus captured output are the build signal." },
  ],
  note: "Apache-2.0 CLI run as a fixed-argv child process with telemetry off (HYPERFRAMES_NO_TELEMETRY=1) and one worker. The cloud, publish, auth, and lambda subcommands are refused. Declare the native binary, or node.exe plus the package's CLI entry as its first arg.",
  cui: { posture: "on-device" },
};

const DGX_AVATAR: CreatorIntegrationSpec = {
  id: "dgx-avatar",
  name: "DGX avatar render",
  group: "video",
  kind: "local-service",
  transports: ["local-http"],
  authKind: "local",
  consentRequired: true,
  docsUrl: "https://github.com/TMElyralab/MuseTalk",
  capabilities: [
    { id: "avatar-video", status: "available", surface: "api", detail: "Lip-synced talking-head video from a WAV plus a template clip (MuseTalk or EchoMimic) on your own DGX GPU." },
    { id: "video-compose", status: "available", surface: "api", detail: "Optional HyperFrames title, subtitle, and caption compose on the box; caption timing is an estimate from character counts." },
  ],
  note: "The DGX Loader's avatar service (port 8088, loopback on the box) reached through an SSH forward. Import it from the Loader mailbox so it arrives attested as an enclave host. A real person's likeness needs their consent.",
  cui: { posture: "enclave" },
};

const HEYGEN: CreatorIntegrationSpec = {
  id: "heygen",
  name: "HeyGen",
  group: "video",
  kind: "cloud",
  transports: ["https"],
  authKind: "apikey",
  secretEnv: "HEYGEN_API_KEY",
  vaultRefHint: "heygen_api_key",
  consentRequired: true,
  docsUrl: "https://docs.heygen.com",
  capabilities: [
    { id: "avatar-video", status: "available", surface: "api", detail: "Avatar video generation through the documented HeyGen API (catalogued only in this phase: LUCID makes no HeyGen calls yet)." },
  ],
  note: "Paid cloud service, metered per plan: scripts, audio, and likeness leave the device, so it is refused under CUI lockdown. Catalog and declaration only this phase; use the DGX avatar render for local work.",
  cui: { posture: "cloud" },
};

// ── Design suite (image, vector, motion) ─────────────────────────────────────
// The DGX vision service is the Loader's `vision` kind (port 8090, loopback on the box): SAM 2.1, Florence-2
// (the native florence-community port), Depth Anything V2 Small, Swin2SR and VTracer, all permissively
// licensed, loaded from SHA-256-verified local snapshots with trust_remote_code off. The editor itself is
// in the renderer and needs nothing but this machine.

const DGX_VISION: CreatorIntegrationSpec = {
  id: "dgx-vision",
  name: "DGX vision service",
  group: "video",
  kind: "local-service",
  transports: ["local-http"],
  authKind: "local",
  consentRequired: false,
  docsUrl: "https://github.com/facebookresearch/sam2",
  capabilities: [
    { id: "segment", status: "available", surface: "api", detail: "SAM 2.1 masks from your traced brush strokes, points, or a box, returned as a PNG mask the size of the image." },
    { id: "layer-decompose", status: "available", surface: "api", detail: "Split an image into labeled RGBA layers (Florence-2 regions, SAM 2.1 masks, depth order, filled background); generative decomposition only when Qwen-Image-Layered is installed on the box." },
    { id: "matte", status: "available", surface: "api", detail: "Main-subject mask for background removal (SAM 2.1, optionally grounded by Florence-2)." },
    { id: "inpaint", status: "available", surface: "api", detail: "Fill a masked region: FLUX.2 klein 4B when installed, else a classic OpenCV Telea fill." },
    { id: "upscale", status: "available", surface: "api", detail: "Tiled 2x, 4x, or 8x super-resolution with Swin2SR; very large results come back as a stored artifact." },
    { id: "depth", status: "available", surface: "api", detail: "Relative depth map (Depth Anything V2 Small) used to order layers near to far." },
    { id: "vision-label", status: "available", surface: "api", detail: "Short region labels from Florence-2. Labels are model output: untrusted data, never instructions." },
    { id: "vectorize", status: "available", surface: "api", detail: "Raster to SVG with VTracer; the SVG is allowlist-checked on the box and again before LUCID stores it." },
  ],
  note: "The DGX Loader's vision service (port 8090, loopback on the box) reached through an SSH forward. Capability comes from its /health probe: a model the box has not fetched and verified is reported absent, never assumed. Import it from the Loader mailbox so it arrives attested as an enclave host.",
  cui: { posture: "enclave" },
};

const DESIGN: CreatorIntegrationSpec = {
  id: "design",
  name: "Design (local)",
  group: "video",
  kind: "renderer",
  transports: ["in-renderer"],
  authKind: "none",
  consentRequired: false,
  docsUrl: "https://www.w3.org/TR/compositing-1/",
  capabilities: [
    { id: "layers", status: "available", surface: "runtime", detail: "Layered raster editing with 16 W3C blend modes, opacity, groups, crop, and Lanczos resize, on tiled canvases." },
    { id: "mask-trace", status: "available", surface: "runtime", detail: "Brush mask tracer with true-size cursor; each trace becomes a labeled hint (isolate, remove, keep, refine) the agent reads." },
    { id: "vector-draw", status: "available", surface: "runtime", detail: "Pen, shapes, freehand, text, node edit, sanitized SVG import, and local raster-to-vector tracing." },
    { id: "motion", status: "available", surface: "runtime", detail: "Keyframe timeline for position, scale, rotation, and opacity with easing curves." },
    { id: "gif-export", status: "available", surface: "runtime", detail: "Animated GIF and APNG export encoded on this machine." },
    { id: "svg-export", status: "available", surface: "runtime", detail: "Static and CSS-animated SVG export; every SVG is safety-checked before it is stored." },
    { id: "psd-export", status: "available", surface: "runtime", detail: "Layered PSD and PSB export written natively (no Adobe code); metadata is never copied." },
  ],
  note: "Runs in the sandboxed renderer: no install, no egress, no key. Agents read the layer manifest and your traced hints and may queue structural edits; pixel work and every DGX request need your click.",
  cui: { posture: "on-device" },
};

// ── CutWire Drift (CREATOR-DRIFT) ────────────────────────────────────────────
// Drift (github.com/CutWire-Studios/Drift, GPL-3.0) is a Qt 6 + FFmpeg desktop video editor. When the user
// turns on Settings -> Agent access it serves a localhost MCP endpoint (JSON-RPC 2.0 over HTTP, bearer token)
// and writes mcp-session.json; LUCID talks to that endpoint and never links, vendors, or bundles Drift.

const DRIFT: CreatorIntegrationSpec = {
  id: "drift",
  name: "Drift (CutWire)",
  group: "video",
  kind: "local-app",
  transports: ["local-http"],
  authKind: "bearer",
  secretEnv: "DRIFT_MCP_TOKEN",
  vaultRefHint: "drift_mcp_token",
  consentRequired: false,
  docsUrl: "https://github.com/CutWire-Studios/Drift/blob/main/docs/MCP.md",
  capabilities: [
    { id: "video-edit", status: "available", surface: "api", detail: "Timeline, clip, canvas, text, shape, effect, speed, and audio edits through Drift's agent protocol; apply() batches are one undo step." },
    { id: "motion", status: "available", surface: "api", detail: "Keyframes, motion presets, and 3D model placement on the Drift timeline." },
    { id: "transcript-edit", status: "available", surface: "api", detail: "Local transcription and diarization, transcript-driven cuts, and subtitle generation on this machine; the ElevenLabs engine is cloud and billable." },
    { id: "stock-media", status: "available", surface: "api", detail: "Drift Market and Stock browsing when the user has granted consent in the Drift GUI. Drift Assets are CC BY-NC-SA 4.0: credit, non-commercial, share-alike." },
  ],
  note: "GPLv3 editor on this machine reached through its own localhost agent protocol; the session is discovered from Drift's own mcp-session.json when Agent access is on, or declared as a headless endpoint; cloud voices, marketplace and ElevenLabs transcription are refused under CUI lockdown; Drift Assets are CC BY-NC-SA 4.0.",
  cui: { posture: "on-device" },
};

// ── CAD, drawings, BIM, and PDF markup ───────────────────────────────────────

const DGX_CAD: CreatorIntegrationSpec = {
  id: "dgx-cad",
  name: "DGX CAD service",
  group: "cad",
  kind: "local-service",
  transports: ["local-http"],
  authKind: "local",
  consentRequired: false,
  docsUrl: "https://cadquery.readthedocs.io",
  capabilities: [
    { id: "cad-model", status: "available", surface: "api", detail: "Run a CadQuery or build123d script in a sandboxed subprocess on the box and export STEP, STL, SVG, or DXF. Needs exec approval every run." },
    { id: "cad-drawing", status: "available", surface: "api", detail: "Inspect DXF drawings with ezdxf: layers, entity counts, extents, and an SVG preview." },
    { id: "cad-convert", status: "available", surface: "api", detail: "DWG to DXF through the LibreDWG dwg2dxf CLI, run out of process on the box." },
    { id: "bim-inspect", status: "available", surface: "api", detail: "Read IFC models with IfcOpenShell: schema, project name, element counts, and storeys." },
  ],
  note: "The DGX Loader's CAD service (port 8089, loopback on the box). Capability comes from its /health probe: a library the box lacks is reported absent, never assumed.",
  cui: { posture: "enclave" },
};

const PDF_MARKUP: CreatorIntegrationSpec = {
  id: "pdf-markup",
  name: "PDF markup (local)",
  group: "cad",
  kind: "renderer",
  transports: ["in-renderer"],
  authKind: "none",
  consentRequired: false,
  docsUrl: "https://mozilla.github.io/pdf.js/",
  capabilities: [
    { id: "pdf-markup", status: "available", surface: "runtime", detail: "Open a PDF on this machine, mark it up (rectangle, cloud, ellipse, arrow, freehand, text, highlight), and save standard PDF annotations that Bluebeam Revu and other viewers read natively, plus XFDF export and import." },
  ],
  note: "pdf.js (Apache-2.0) renders and pdf-lib (MIT) writes the annotations, both bundled into the renderer: no install, no egress, no key. Bluebeam BAX is not supported.",
  cui: { posture: "on-device" },
};

const AUTODESK_APS: CreatorIntegrationSpec = {
  id: "autodesk-aps",
  name: "Autodesk Platform Services",
  group: "cad",
  kind: "cloud",
  transports: ["https"],
  authKind: "bearer",
  secretEnv: "LUCID_APS_TOKEN",
  vaultRefHint: "autodesk_aps_token",
  consentRequired: false,
  docsUrl: "https://aps.autodesk.com",
  capabilities: [
    { id: "cad-convert", status: "available", surface: "api", detail: "Model Derivative API translates DWG, RVT, IFC, and other formats (catalogued only in this phase)." },
    { id: "cad-drawing", status: "available", surface: "api", detail: "Automation API (Design Automation) runs AutoCAD and other engines headlessly in the cloud (catalogued only in this phase)." },
  ],
  note: "Paid cloud service metered in Flex tokens, with no self-hosted option: drawings leave the device, so it is refused under CUI lockdown. Catalog and declaration only this phase.",
  cui: { posture: "cloud" },
};

const BLUEBEAM_STUDIO: CreatorIntegrationSpec = {
  id: "bluebeam-studio",
  name: "Bluebeam Studio",
  group: "cad",
  kind: "cloud",
  transports: ["https"],
  authKind: "bearer",
  secretEnv: "LUCID_BLUEBEAM_TOKEN",
  vaultRefHint: "bluebeam_oauth_token",
  consentRequired: false,
  docsUrl: "https://developers.bluebeam.com",
  capabilities: [
    { id: "pdf-markup", status: "available", surface: "api", detail: "Studio Sessions Markups API reads and writes session markups over OAuth (catalogued only in this phase)." },
  ],
  note: "Paid cloud service: needs a Bluebeam Core (or higher) subscription and production app approval from Bluebeam. Documents leave the device, so it is refused under CUI lockdown. Catalog and declaration only this phase.",
  cui: { posture: "cloud" },
};

const CLASSCAD: CreatorIntegrationSpec = {
  id: "classcad",
  name: "ClassCAD",
  group: "cad",
  kind: "local-service",
  transports: ["websocket"],
  authKind: "apikey",
  secretEnv: "LUCID_CLASSCAD_KEY",
  vaultRefHint: "classcad_key",
  consentRequired: false,
  docsUrl: "https://classcad.ch",
  capabilities: [
    { id: "cad-model", status: "available", surface: "websocket", detail: "Parametric solid modeling through a ClassCAD worker over a websocket (catalogued only in this phase)." },
  ],
  note: "Paid, CHF pricing tiers. The worker signs in with a ClassCAD key and shares through a Cloudflare relay by default: set CLASSCAD_SHARE=off. Allowed under CUI lockdown only when its worker runs on a DGX endpoint attested as an enclave.",
  cui: { posture: "enclave" },
};

const ODA_DRAWINGS: CreatorIntegrationSpec = {
  id: "oda-drawings",
  name: "ODA Drawings SDK",
  group: "cad",
  kind: "local-app",
  transports: ["child-process"],
  authKind: "local",
  consentRequired: false,
  docsUrl: "https://www.opendesign.com",
  capabilities: [
    { id: "cad-convert", status: "planned", surface: "cli", detail: "Native DWG read and write through an Open Design Alliance member build; not wired in this build." },
  ],
  note: "Paid SDK that needs an ODA membership. Runs on this machine with no egress once wired; use the DGX CAD service's dwg2dxf conversion today.",
  cui: { posture: "on-device" },
};

export const CREATOR_INTEGRATIONS: readonly CreatorIntegrationSpec[] = [
  ELEVENLABS, DOTS_TTS, SUNO, COMFYUI, THREEJS, BLENDER, UNREAL,
  HYPERFRAMES, DGX_AVATAR, HEYGEN, DGX_VISION, DESIGN, DRIFT,
  DGX_CAD, PDF_MARKUP, AUTODESK_APS, BLUEBEAM_STUDIO, CLASSCAD, ODA_DRAWINGS,
] as const;

/** The catalog entry for one provider id. Every id in the closed set has exactly one (pinned by a test). */
export function creatorSpec(id: CreatorProviderId): CreatorIntegrationSpec {
  const spec = CREATOR_INTEGRATIONS.find((s) => s.id === id);
  if (!spec) throw new Error(`no catalog entry for ${id}`);
  return spec;
}

// ── user declarations ────────────────────────────────────────────────────────

/** One endpoint/executable the user registered. Declarations only: no secret value, ever. */
export interface CreatorEndpointDef {
  id: string;
  providerId: CreatorProviderId;
  label: string;
  /** For https / local-http / websocket transports. */
  baseUrl?: string;
  /** For child-process transports: the executable. Never a shell string. */
  command?: string;
  args?: string[];
  zone: "local" | "internal" | "external";
  /** Vault credential NAME. */
  vaultRef?: string;
  /** CREATOR-IMG (ADR-0291): the user's OWN exported workflow graph (ComfyUI "Save (API Format)"), with
   *  `{{prompt}}` / `{{model}}` / `{{seed}}` / `{{image:role}}` where LUCID should substitute. Not a secret,
   *  and never invented by LUCID: without it, generation refuses instead of guessing a graph. */
  workflow?: string;
  /** CUI lockdown: this endpoint is a DGX enclave host, either user-attested in Creator Studio or imported
   *  from the DGX Loader mailbox (lucid-creator-endpoint v1). Absent means not attested. */
  enclave?: boolean;
  enabled: boolean;
}

const SHELL_META = /[;&|`$><\n\r"']/;
/** What a pasted SECRET looks like. Shared with creator_monitor so both declaration surfaces refuse a
 *  value where a credential NAME belongs (the ADR-0134 / ADR-0135 guardrail). */
export const SECRET_SHAPE = /(sk-[A-Za-z0-9-]{12,}|xi-api-key|Bearer\s+[A-Za-z0-9._-]{12,}|[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{12,})/;

/** Fail-closed shape validation. Mirrors local_providers.validateLocalProvider's posture. */
export function validateCreatorEndpoint(def: CreatorEndpointDef): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const spec = CREATOR_INTEGRATIONS.find((s) => s.id === def.providerId);
  if (!spec) errors.push("unknown provider id");
  if (!def.id || !/^[a-z0-9][a-z0-9_-]{1,48}$/.test(def.id)) errors.push("id must be lowercase letters, digits, dash or underscore (2-49 chars)");
  if (!def.label || !def.label.trim()) errors.push("label is required");
  if (def.label && def.label.length > 80) errors.push("label must be 80 characters or fewer");

  const wantsUrl = !!spec?.transports.some((t) => t === "https" || t === "local-http" || t === "websocket");
  const wantsCommand = !!spec?.transports.includes("child-process");
  if (def.baseUrl) {
    let u: URL | null = null;
    try { u = new URL(def.baseUrl); } catch { u = null; }
    if (!u) errors.push("baseUrl must be a valid URL");
    else {
      if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) errors.push("baseUrl must be http, https, ws, or wss");
      if (u.username || u.password) errors.push("credentials must never be embedded in a URL - store a vault credential instead");
    }
  }
  if (def.command) {
    if (SHELL_META.test(def.command)) errors.push("command must be an executable path, never a shell string");
    for (const a of def.args ?? []) {
      if (typeof a !== "string") errors.push("every arg must be a string");
      else if (SHELL_META.test(a)) errors.push("args must not contain shell metacharacters");
    }
  }
  if (!def.baseUrl && !def.command) errors.push(wantsCommand && !wantsUrl ? "command is required for this provider" : "baseUrl is required for this provider");
  if (def.command && !wantsCommand) errors.push("this provider is not launched as a local executable");
  if (def.baseUrl && !wantsUrl) errors.push("this provider has no network endpoint");
  if (!["local", "internal", "external"].includes(def.zone)) errors.push("zone must be local, internal, or external");
  if (def.vaultRef && !/^[a-z0-9][a-z0-9_-]{1,64}$/.test(def.vaultRef)) errors.push("vaultRef must be a credential NAME, not a value");
  if (def.enclave !== undefined && typeof def.enclave !== "boolean") errors.push("enclave must be true or false");
  if (def.workflow !== undefined) {
    if (typeof def.workflow !== "string" || def.workflow.length > 512_000) errors.push("the workflow template must be JSON text under 512 KB");
    else if (def.workflow.trim()) {
      try { JSON.parse(def.workflow); } catch { errors.push("the workflow template is not valid JSON"); }
    }
  }
  const leak = scanForInlineSecret(def);
  if (leak) errors.push(`a secret looks pasted into ${leak} - store it in the vault and reference it by name`);
  return { ok: errors.length === 0, errors };
}

/** Which field a pasted secret landed in, or null. Same guardrail as the Agent Builder / Local Providers. */
export function scanForInlineSecret(def: CreatorEndpointDef): string | null {
  const fields: [string, string | undefined][] = [["label", def.label], ["baseUrl", def.baseUrl], ["command", def.command], ["id", def.id]];
  for (const [name, value] of fields) if (value && SECRET_SHAPE.test(value)) return name;
  for (const a of def.args ?? []) if (SECRET_SHAPE.test(a)) return "args";
  return null;
}

// ── availability folding ─────────────────────────────────────────────────────

/** What the Studio row shows. `configured` = a declaration exists; `ready` additionally means the
 *  credential the provider needs is present. Discovery is a LIVE probe result, never an assumption. */
export type CreatorProviderState = "ready" | "configured" | "needs-credential" | "needs-endpoint" | "built-in";

export interface CreatorProviderContext {
  /** Declarations the user saved for this provider. */
  readonly endpoints: readonly CreatorEndpointDef[];
  /** True when the provider's secret is present in the vault or the engine env. */
  readonly secretPresent: boolean;
  /** Last live capability probe, when one has run. */
  readonly discovered?: readonly CreatorCapabilityId[];
  /** The CUI lockdown (asksageLocked semantics) at fold time. Absent means unlocked. */
  readonly locked?: boolean;
}

/** One declaration as the Studio row lists it: enough to pick it by id and see its verdict, never its
 *  vault reference, args, or workflow template. */
export interface CreatorEndpointView {
  readonly id: string;
  readonly label: string;
  readonly baseUrl?: string;
  readonly command?: string;
  readonly zone: CreatorEndpointDef["zone"];
  readonly enclave?: boolean;
  readonly enabled: boolean;
  readonly cui: CuiVerdict;
}

export interface CreatorProviderStatus {
  readonly id: CreatorProviderId;
  readonly name: string;
  readonly group: CreatorGroup;
  readonly state: CreatorProviderState;
  readonly transports: readonly CreatorTransport[];
  readonly consentRequired: boolean;
  readonly docsUrl: string;
  readonly note: string;
  readonly endpointCount: number;
  /** Capabilities usable RIGHT NOW: available, plus a live probe when one exists. */
  readonly usable: readonly CreatorCapabilityId[];
  /** Everything the catalog knows, with its honesty label - the UI shows all of it. */
  readonly capabilities: readonly CreatorCapabilitySpec[];
  /** The CUI lockdown verdict for this provider: the first enabled declaration it would use that is
   *  allowed, else the first enabled one, else the provider with no endpoint at all. */
  readonly cui: CuiVerdict;
  /** Every declaration for this provider with its own verdict, in settings order. */
  readonly endpoints: readonly CreatorEndpointView[];
}

/** The verdict a provider row shows. Mirrors which endpoint a route would pick: an allowed enabled one wins
 *  over a refused one, so the row never reads "refused" while a usable declaration exists. */
export function providerCuiVerdict(spec: CreatorIntegrationSpec, endpoints: readonly CreatorEndpointDef[], locked: boolean): CuiVerdict {
  const enabled = endpoints.filter((e) => e.enabled && e.providerId === spec.id);
  if (!enabled.length) return cuiProviderVerdict(locked, spec);
  const verdicts = enabled.map((e) => cuiProviderVerdict(locked, spec, e));
  return verdicts.find((v) => v.allowed) ?? verdicts[0]!;
}

export function foldProviderStatus(spec: CreatorIntegrationSpec, ctx: CreatorProviderContext): CreatorProviderStatus {
  const enabled = ctx.endpoints.filter((e) => e.enabled && e.providerId === spec.id);
  const locked = ctx.locked === true;
  const needsEndpoint = spec.transports.some((t) => t !== "in-renderer");
  const needsSecret = spec.authKind === "apikey" || spec.authKind === "bearer";
  const state: CreatorProviderState = !needsEndpoint ? "built-in"
    : enabled.length === 0 ? "needs-endpoint"
    : needsSecret && !ctx.secretPresent ? "needs-credential"
    : ctx.discovered && ctx.discovered.length ? "ready"
    : "configured";
  // A local capability (the Creator library, remix lineage, local mixing) never depends on a probe.
  const localReady = spec.capabilities.filter((c) => c.status === "available" && (c.surface === "local" || c.surface === "runtime")).map((c) => c.id);
  // CREATOR-1 (ADR-0292): once a PROBE has spoken, only what it attested is usable - the catalog lists what
  // the vendor documents, the probe reports what THIS install actually has. A built-in (three.js) needs no
  // probe because it ships in the renderer.
  const remoteReady = state === "built-in" ? spec.capabilities.filter((c) => c.status === "available").map((c) => c.id) : [];
  const probed = (ctx.discovered ?? []).filter((id) => spec.capabilities.some((c) => c.id === id));
  return {
    id: spec.id,
    name: spec.name,
    group: spec.group,
    state,
    transports: spec.transports,
    consentRequired: spec.consentRequired,
    docsUrl: spec.docsUrl,
    note: spec.note,
    endpointCount: enabled.length,
    usable: [...new Set([...localReady, ...remoteReady, ...probed])],
    capabilities: spec.capabilities,
    cui: providerCuiVerdict(spec, ctx.endpoints, locked),
    endpoints: ctx.endpoints.filter((e) => e.providerId === spec.id).map((e) => ({
      id: e.id,
      label: e.label,
      ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}),
      ...(e.command ? { command: e.command } : {}),
      zone: e.zone,
      ...(e.enclave === true ? { enclave: true } : {}),
      enabled: e.enabled,
      cui: cuiProviderVerdict(locked, spec, e),
    })),
  };
}

/** Every provider's status, in Studio order. `locked` is the CUI lockdown (asksageLocked semantics). */
export function creatorRegistryStatus(byProvider: Partial<Record<CreatorProviderId, CreatorProviderContext>>, locked = false): CreatorProviderStatus[] {
  return CREATOR_INTEGRATIONS.map((spec) => foldProviderStatus(spec, { ...(byProvider[spec.id] ?? { endpoints: [], secretPresent: false }), locked }));
}
