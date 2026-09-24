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
  /** P-SANDBOX.14 (ADR-0394): managed policy stops users adding folders; the panel shows a note instead. */
  foldersLocked: boolean;
}

/** `policyRequiresIsolation` is "policy keeps the switch on" (managedSandboxLocksOn: exec.requireIsolation
 *  OR sandbox.allowUserOff === false). */
export function sandboxControlView(i: { platform: string; helperBundled: boolean; mode?: SandboxWindowsMode; policyRequiresIsolation: boolean; registered: boolean; foldersLocked?: boolean }): SandboxControlView {
  const available = i.platform === "win32" && i.helperBundled;
  return { available, userOff: available && i.mode === "off" && !i.policyRequiresIsolation, policyLocked: i.policyRequiresIsolation, registered: available && i.registered, foldersLocked: !!i.foldersLocked };
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

// ── P-SANDBOX.13 (ADR-0391): folders the user adds from the panel, and the ones LUCID always allows ─────

/** PURE: may the user grant the sandbox this picked folder? The path comes from the native Explorer
 *  dialog the ENGINE opened (never from the caller), so this only rejects picks that are too broad or
 *  pointless: a drive root, the whole user profile, the OS dirs (already readable by every AppContainer,
 *  and not a standard user's to re-ACL), and a relative / UNC path. Returns null when allowed, else the
 *  sentence the panel shows. Windows paths compared case-insensitively. */
export function refuseGrantPath(path: string, home: string): string | null {
  const n = path.replace(/\//g, "\\").replace(/\\+$/, "");
  const lower = n.toLowerCase();
  if (!/^[a-z]:\\/i.test(n + "\\")) return "pick a folder on a local drive (a network path cannot be granted)";
  if (/^[a-z]:$/i.test(n)) return "a whole drive is too broad - pick a folder inside it";
  if (lower === home.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()) return "your whole user folder is too broad - pick a folder inside it";
  if (/^[a-z]:\\windows(\\|$)/.test(lower) || /^[a-z]:\\program files( \(x86\))?(\\|$)/.test(lower)) return "Windows and Program Files are already readable by the sandbox and cannot be changed here";
  return null;
}

/** P-SANDBOX.14 (ADR-0394): may a user-initiated folder grant (panel or agent tool) proceed? Null when
 *  allowed, else the sentence shown. Revoking is never refused: it only narrows access. */
export function refuseUserFolderAdd(v: SandboxControlView): string | null {
  if (!v.available) return "the Windows sandbox helper is not available on this host";
  if (v.foldersLocked) return "your organization manages which folders the sandbox can reach; ask your administrator to add one";
  return null;
}

/** PURE: expand a policy folder for this user. `%NAME%` reads `env` (case-insensitive, as Windows does) and
 *  a leading `~` is `home`. An unknown variable yields null: never guess at a path an admin did not mean. */
export function expandPolicyPath(raw: string, env: Record<string, string | undefined>, home: string): string | null {
  const lookup = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  let missing = false;
  let out = raw.trim().replace(/%([^%]+)%/g, (_m, name: string) => {
    const v = lookup.get(name.toLowerCase());
    if (!v) { missing = true; return ""; }
    return v;
  });
  if (missing || !out) return null;
  if (out === "~" || out.startsWith("~\\") || out.startsWith("~/")) out = home + out.slice(1);
  return out.replace(/\//g, "\\").replace(/\\+$/, "");
}

export interface PolicyFolderPlan {
  grantRx: string[];
  grantRw: string[];
  /** Each skipped entry and why, for the engine log (an admin typo must be visible, never silent). */
  skipped: { entry: string; why: string }[];
}

/** PURE: turn the managed folder lists into the grants a contained spawn carries. Each entry is expanded,
 *  bounded by refuseGrantPath (policy may widen access, but never to a drive root, the whole profile or
 *  the OS dirs), and kept only when `isDir` says it exists (the helper fails the spawn on a missing path).
 *  A folder in both lists is granted read-write once. */
export function policyFolderPlan(i: { read: string[]; readWrite: string[]; env: Record<string, string | undefined>; home: string; isDir: (p: string) => boolean }): PolicyFolderPlan {
  const plan: PolicyFolderPlan = { grantRx: [], grantRw: [], skipped: [] };
  const seen = new Set<string>();
  const take = (entry: string, into: string[]) => {
    const path = expandPolicyPath(entry, i.env, i.home);
    if (!path) { plan.skipped.push({ entry, why: "an environment variable in it is not set" }); return; }
    const refused = refuseGrantPath(path, i.home);
    if (refused) { plan.skipped.push({ entry, why: refused }); return; }
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    if (!i.isDir(path)) { plan.skipped.push({ entry, why: "no such folder on this machine" }); return; }
    seen.add(key);
    into.push(path);
  };
  for (const e of i.readWrite) take(e, plan.grantRw);
  for (const e of i.read) take(e, plan.grantRx);
  return plan;
}

export interface RuntimeFolderView {
  path: string;
  mode: "rx" | "rw";
  why: string;
}

/** PURE: the folders LUCID itself gives the contained agent so it can run (see appContainerRuntimeGrants),
 *  labelled for the panel, so the list the user sees is the COMPLETE answer to "what can it reach". */
export function runtimeFolderView(i: { workspace: string; grantRx: string[]; grantRw: string[]; tmpDir: string; policy?: PolicyFolderPlan }): RuntimeFolderView[] {
  const out: RuntimeFolderView[] = [{ path: i.workspace, mode: "rw", why: "the current workspace" }];
  // P-SANDBOX.14 (ADR-0394): the admin-approved folders come first after the workspace, labelled as policy.
  for (const p of i.policy?.grantRw ?? []) out.push({ path: p, mode: "rw", why: "allowed by your organization's policy" });
  for (const p of i.policy?.grantRx ?? []) out.push({ path: p, mode: "rx", why: "allowed by your organization's policy" });
  for (const p of i.grantRw) out.push({ path: p, mode: "rw", why: "the agent's own state (sessions, settings, audit)" });
  for (const p of i.grantRx) out.push({ path: p, mode: "rx", why: "LUCID's runtime (app files, bun, your shell)" });
  return out.filter((f) => f.path !== i.tmpDir);
}
