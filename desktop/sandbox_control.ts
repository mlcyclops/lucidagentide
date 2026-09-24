// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/sandbox_control.ts - P-SANDBOX.12 (ADR-0390): the user's On/Off control for the Windows
// AppContainer sandbox, and the policy that bounds it.
//
// Three facts decide what the Security panel may offer:
//   - available: this is Windows and the bundled lucid-appcontainer helper is on disk;
//   - userOff:   the per-user LUCID setting (settings_store.sandboxWindowsMode === "off");
//   - policyLocked: managed policy requires runtime isolation (ADR-0068 tighten-only). A user can never
//     turn the sandbox off against it; the panel says so instead of offering the switch.
// And one host fact: registered = the one-time elevated loopback exemption exists (ADR-0174). Turning
// OFF never needs admin (it is a LUCID setting, honored at the next agent spawn). Turning ON needs the
// exemption, so when it is missing the engine registers it once behind a UAC prompt. "Remove from
// Windows" is the elevated --unregister-loopback, for users who want the host change gone entirely.
// PURE: the engine and the renderer both decide from these functions; the impure edges live in dev.ts.

export type SandboxWindowsMode = "auto" | "off";

export interface SandboxControlView {
  available: boolean;
  userOff: boolean;
  policyLocked: boolean;
  registered: boolean;
}

export function sandboxControlView(i: { platform: string; helperBundled: boolean; mode?: SandboxWindowsMode; policyRequiresIsolation: boolean; registered: boolean }): SandboxControlView {
  const available = i.platform === "win32" && i.helperBundled;
  return { available, userOff: available && i.mode === "off" && !i.policyRequiresIsolation, policyLocked: i.policyRequiresIsolation, registered: available && i.registered };
}

/** Does this spawn honor the user's Off? Only when policy does not require isolation (policy wins). */
export function userTurnedSandboxOff(mode: SandboxWindowsMode | undefined, policyRequiresIsolation: boolean): boolean {
  return mode === "off" && !policyRequiresIsolation;
}

export type ModeRequest = { mode: "off" } | { mode: "auto" } | { mode: "unregister" };
export type ModeAction =
  | { action: "set-off" }
  | { action: "set-on"; registerFirst: boolean }
  | { action: "unregister" }
  | { action: "refuse"; reason: string };

/** PURE: what a panel request turns into, given the current view. Refusals carry the sentence the panel shows. */
export function planModeChange(req: ModeRequest, v: SandboxControlView): ModeAction {
  if (!v.available) return { action: "refuse", reason: "the Windows sandbox helper is not available on this host" };
  if (req.mode === "off") {
    if (v.policyLocked) return { action: "refuse", reason: "your organization's policy requires the sandbox; it cannot be turned off here" };
    return { action: "set-off" };
  }
  if (req.mode === "unregister") {
    if (v.policyLocked) return { action: "refuse", reason: "your organization's policy requires the sandbox; its Windows registration stays" };
    if (!v.userOff) return { action: "refuse", reason: "turn the sandbox off first, then remove its Windows registration" };
    return { action: "unregister" };
  }
  return { action: "set-on", registerFirst: !v.registered };
}
