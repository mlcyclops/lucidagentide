// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/build_flavor.ts - CREATOR-0 (ADR-0279): the product-line contract.
//
// LUCID ships as two FLAVORS off ONE branch: the standard Agent build and the Creator build. A flavor is
// packaging identity, never a user preference and never a security posture: it decides the app id, the
// product name, the installer artifact names, the native default ports, the deep-link scheme, and which
// Creator surfaces exist at all. Everything security-relevant (the scan gate, permission forwarding,
// egress, trust labels) is IDENTICAL in both flavors.
//
// Pure module by design: no electron, no fs, no process access. main.ts, dev.ts, and the renderer all
// resolve their identity through these functions so the two flavors can never drift apart in three
// places at once.

/** Closed set. A third flavor is a deliberate contract change, not a new string. */
export type BuildFlavor = "agent" | "creator";
export const BUILD_FLAVORS: readonly BuildFlavor[] = ["agent", "creator"] as const;

/** The composer's execution mode. `creator` exists ONLY in a Creator build; its security posture is
 *  byte-identical to `agent` (see uiModePosture) - it changes which WORKSPACE surfaces are live, never
 *  what the gate does. */
export type UiMode = "agent" | "creator" | "ask" | "plan";
export const UI_MODES: readonly UiMode[] = ["agent", "creator", "ask", "plan"] as const;

/** Which Creator surfaces this build carries. Absent, not disabled: a standard build never renders them. */
export interface BuildFeatures {
  readonly creatorMode: boolean;
  readonly integrationRegistry: boolean;
  readonly localMonitoring: boolean;
  readonly cpuGpuOdometer: boolean;
  readonly creatorLibrary: boolean;
}

export interface BuildFlavorInfo {
  readonly flavor: BuildFlavor;
  readonly creatorBuild: boolean;
  /** electron-builder appId. Drives userData, the single-instance lock, and the NSIS install GUID. */
  readonly appId: string;
  /** Electron app name. Drives the userData directory name on every OS. */
  readonly productName: string;
  readonly displayName: string;
  /** Installer/artifact filename stem (LucidAgent-Setup.exe / LucidCreator-Setup.exe). */
  readonly artifactStem: string;
  /** Native control-plane port. Two flavors never share one, so they never fight over a lock. */
  readonly defaultPort: number;
  /** Embedded collab relay default bind port. */
  readonly defaultRelayPort: number;
  /** Managed whisper.cpp default port (whisper.cpp binds SO_REUSEPORT - a shared port silently splits
   *  requests across two model loads, so each flavor owns its own). */
  readonly defaultWhisperPort: number;
  /** Deep-link scheme. Creator must NOT claim `lucid` or it steals the standard build's OAuth callback. */
  readonly authProtocol: string;
  readonly features: BuildFeatures;
}

const AGENT_FEATURES: BuildFeatures = {
  creatorMode: false,
  integrationRegistry: false,
  localMonitoring: false,
  cpuGpuOdometer: false,
  creatorLibrary: false,
};
const CREATOR_FEATURES: BuildFeatures = {
  creatorMode: true,
  integrationRegistry: true,
  localMonitoring: true,
  cpuGpuOdometer: true,
  creatorLibrary: true,
};

export const AGENT_FLAVOR: BuildFlavorInfo = {
  flavor: "agent",
  creatorBuild: false,
  appId: "com.lucidagentide.desktop",
  productName: "LucidAgentIDE",
  displayName: "Lucid Agent",
  artifactStem: "LucidAgent",
  defaultPort: 5319,
  defaultRelayPort: 8790,
  defaultWhisperPort: 9111,
  authProtocol: "lucid",
  features: AGENT_FEATURES,
};

export const CREATOR_FLAVOR: BuildFlavorInfo = {
  flavor: "creator",
  creatorBuild: true,
  appId: "com.lucidcreator.desktop",
  productName: "LucidCreator",
  displayName: "Lucid Creator",
  artifactStem: "LucidCreator",
  defaultPort: 5320,
  defaultRelayPort: 8791,
  defaultWhisperPort: 9112,
  authProtocol: "lucid-creator",
  features: CREATOR_FEATURES,
};

/** Anything unrecognized is the STANDARD build. A typo can never silently unlock Creator surfaces. */
export function normalizeBuildFlavor(raw: unknown): BuildFlavor {
  return (typeof raw === "string" ? raw.trim().toLowerCase() : "") === "creator" ? "creator" : "agent";
}

export function flavorInfo(flavor: BuildFlavor): BuildFlavorInfo {
  return flavor === "creator" ? CREATOR_FLAVOR : AGENT_FLAVOR;
}

/** Resolution order: an explicit env var (launcher / dev run / CI), then the packaged package.json's
 *  `lucidBuildFlavor` (electron-builder extraMetadata), then the standard build. */
export function resolveBuildFlavor(env: Readonly<Record<string, string | undefined>> | null | undefined, packageFlavor?: unknown): BuildFlavor {
  const fromEnv = typeof env?.LUCID_BUILD_FLAVOR === "string" ? env.LUCID_BUILD_FLAVOR.trim() : "";
  if (fromEnv) return normalizeBuildFlavor(fromEnv);
  const fromPkg = typeof packageFlavor === "string" ? packageFlavor.trim() : "";
  if (fromPkg) return normalizeBuildFlavor(fromPkg);
  return "agent";
}

/** Normalize a wire value. `creator` is accepted ONLY in a Creator build; anywhere else it folds to
 *  `agent`, so a hand-rolled POST at a standard build can never activate a Creator surface. */
export function normalizeUiMode(raw: unknown, creatorBuild: boolean): UiMode {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "plan") return "plan";
  if (v === "ask") return "ask";
  if (v === "creator") return creatorBuild ? "creator" : "agent";
  return "agent";
}

/** The omp session mode + permission posture a UI mode maps to. Creator is deliberately IDENTICAL to
 *  Agent: autonomy with the in-process gate scanning every call. Ask is the only per-tool-approval
 *  posture; Plan is omp's read-only planner. */
export interface UiModePosture {
  readonly ompMode: "default" | "plan";
  readonly permissionMode: "auto" | "ask";
}
export function uiModePosture(mode: UiMode): UiModePosture {
  if (mode === "plan") return { ompMode: "plan", permissionMode: "auto" };
  if (mode === "ask") return { ompMode: "default", permissionMode: "ask" };
  return { ompMode: "default", permissionMode: "auto" };
}

/** What `GET /api/build-info` returns. Paths are local diagnostics (the route is token-gated like the
 *  rest of /api); it NEVER carries a credential, a vault ref, or a decrypted value. */
export interface BuildInfoView {
  readonly flavor: BuildFlavor;
  readonly creatorBuild: boolean;
  readonly appId: string;
  readonly productName: string;
  readonly displayName: string;
  readonly version: string;
  readonly defaultPort: number;
  readonly port: number;
  readonly authProtocol: string;
  readonly dataRoot: string;
  readonly settingsFile: string;
  readonly personalDir: string;
  readonly vaultScope: BuildFlavor;
  readonly features: BuildFeatures;
}

export interface BuildRuntimeInfo {
  readonly version: string;
  readonly port: number;
  readonly dataRoot: string;
  readonly settingsFile: string;
  readonly personalDir: string;
}

export function buildInfoView(info: BuildFlavorInfo, runtime: BuildRuntimeInfo): BuildInfoView {
  return {
    flavor: info.flavor,
    creatorBuild: info.creatorBuild,
    appId: info.appId,
    productName: info.productName,
    displayName: info.displayName,
    version: runtime.version,
    defaultPort: info.defaultPort,
    port: runtime.port,
    authProtocol: info.authProtocol,
    dataRoot: runtime.dataRoot,
    settingsFile: runtime.settingsFile,
    personalDir: runtime.personalDir,
    vaultScope: info.flavor,
    features: info.features,
  };
}
