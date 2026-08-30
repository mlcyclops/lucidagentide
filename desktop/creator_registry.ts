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

/** Closed set of provider ids. A new provider is a deliberate registry change. */
export type CreatorProviderId = "elevenlabs" | "dots-tts" | "suno" | "comfyui" | "threejs" | "blender" | "unreal";
export const CREATOR_PROVIDER_IDS: readonly CreatorProviderId[] = ["elevenlabs", "dots-tts", "suno", "comfyui", "threejs", "blender", "unreal"] as const;

/** Where a provider sits in the Studio. Drives grouping only. */
export type CreatorGroup = "audio" | "video" | "3d" | "game" | "testing";
export const CREATOR_GROUPS: readonly CreatorGroup[] = ["audio", "video", "3d", "game", "testing"] as const;

/** Closed capability vocabulary. The agent matches intent against THESE, never free text. */
export type CreatorCapabilityId =
  | "tts" | "stt" | "voice-clone" | "voice-design" | "dubbing" | "sfx" | "music" | "audio-isolation"
  | "alignment" | "streaming-audio" | "audio-mix" | "library-manage" | "remix"
  | "image" | "video" | "model-3d" | "scene-preview" | "render-still" | "render-animation"
  | "workflow-run" | "asset-import" | "engine-build" | "engine-test" | "runtime-feedback";

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
};

export const CREATOR_INTEGRATIONS: readonly CreatorIntegrationSpec[] = [
  ELEVENLABS, DOTS_TTS, SUNO, COMFYUI, THREEJS, BLENDER, UNREAL,
] as const;

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
}

export function foldProviderStatus(spec: CreatorIntegrationSpec, ctx: CreatorProviderContext): CreatorProviderStatus {
  const enabled = ctx.endpoints.filter((e) => e.enabled && e.providerId === spec.id);
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
  };
}

/** Every provider's status, in Studio order. */
export function creatorRegistryStatus(byProvider: Partial<Record<CreatorProviderId, CreatorProviderContext>>): CreatorProviderStatus[] {
  return CREATOR_INTEGRATIONS.map((spec) => foldProviderStatus(spec, byProvider[spec.id] ?? { endpoints: [], secretPresent: false }));
}
