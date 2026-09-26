// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/sandbox_panel.ts - P-SANDBOX.5 (ADR-0169): the "Runtime sandbox" Security-panel section.
//
// PURE (the format.ts / model_favorites.ts builder convention): a SandboxStatus in → the accordion HTML
// out. Surfaces what P-SANDBOX.1-.4 built but hid: is THIS session's exec runtime-isolated (bwrap /
// Seatbelt), the disclosed passthrough, or fail-closed BLOCKED - plus whether subprocess egress is
// mediated, and the recent reach-outs the proxy REFUSED (the DNS-TXT exfils it caught). Metadata only.

import { accordion } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import type { RuntimeFolderView, SandboxControlView, SandboxGrantView, SandboxStateView, SandboxStatusView } from "./bridge.ts";

const BACKEND_LABEL: Record<string, string> = {
  bwrap: "Linux bubblewrap",
  seatbelt: "macOS Seatbelt",
  appcontainer: "Windows AppContainer",
  noop: "disclosed passthrough",
};

/** P-SANDBOX.12 (ADR-0390): the user's Windows sandbox switch. Policy-locked ⇒ a note, never a button;
 *  off ⇒ "Turn on" (+ "Remove from Windows" while the loopback registration stands); on ⇒ "Turn off".
 *  Text sits in ONE block element beside the buttons (invariant 11: never raw text among flex items). Pure. */
export function controlSection(c: SandboxControlView | undefined): string {
  if (!c?.available) return "";
  if (c.policyLocked) {
    return `<div class="sbx-row muted"><span>Your organization's policy keeps the sandbox <b>on</b>. It cannot be turned off here.</span></div>`;
  }
  if (c.userOff) {
    const remove = c.registered
      ? `<button class="btn-mini dismiss" data-sbx-mode="unregister" data-tip="Remove from Windows|Removes the sandbox's one-time loopback registration (asks for administrator approval). Turning the sandbox on again re-registers it.">${icon("close", 13)} Remove from Windows</button>`
      : "";
    return `<div class="sbx-ctl"><div class="sbx-ctl-txt">You turned the sandbox <b>off</b>. The agent runs as the disclosed passthrough; the argv gate and the scanner still apply.</div>
      <div class="sbx-ctl-btns"><button class="btn-mini ok" data-sbx-mode="auto" data-tip="Turn on|Run the agent inside the Windows AppContainer again. The first time, Windows asks for administrator approval once.">${icon("shield", 13)} Turn on</button>${remove}</div></div>`;
  }
  return `<div class="sbx-ctl"><div class="sbx-ctl-txt">The Windows sandbox is <b>on</b> when this host can run the agent inside it.</div>
    <div class="sbx-ctl-btns"><button class="btn-mini dismiss" data-sbx-mode="off" data-tip="Turn off|Run the agent as the disclosed passthrough instead. No administrator approval needed; the agent restarts.">${icon("close", 13)} Turn off</button></div></div>`;
}

/** The one-line posture: BLOCKED (red) ⇒ isolated (green) ⇒ disclosed passthrough (amber). Pure. */
function postureLine(s: SandboxStateView, c?: SandboxControlView): string {
  if (!s.isolated && !s.execBlocked && c?.userOff) {
    return `<div class="sbx-row warn"><span class="pill dismissed">off</span>
    <span>Exec is <b>not runtime-isolated</b>: you turned the Windows sandbox off. The argv gate + in-process scanner still apply.</span></div>`;
  }
  if (s.execBlocked) {
    return `<div class="sbx-row bad"><span class="pill quarantined">exec blocked</span>
      <span>Exec is <b>fail-closed BLOCKED</b> - managed policy requires runtime isolation and none is available. ${esc(s.execBlocked)}</span></div>`;
  }
  if (s.isolated) {
    return `<div class="sbx-row good"><span class="pill">${icon("shield", 12)} isolated</span>
      <span>Exec runs runtime-isolated via <b>${esc(BACKEND_LABEL[s.backend ?? "noop"] ?? s.backend ?? "?")}</b> - declared network/exec caps enforced.</span></div>`;
  }
  return `<div class="sbx-row warn"><span class="pill dismissed">not isolated</span>
    <span>Exec is <b>not runtime-isolated</b> on ${esc(s.platform)} (disclosed passthrough). The argv gate + in-process scanner still apply; no capable sandbox backend on this host - on Windows the bundled lucid-appcontainer helper is missing or failed its containment probe.</span></div>`;
}

/** The mediated-egress line (only meaningful when isolated). Pure. */
function egressLine(s: SandboxStateView): string {
  if (!s.isolated) return "";
  return s.proxied
    ? `<div class="sbx-row good"><span class="pill">${icon("shield", 12)} mediated</span><span>Subprocess egress is routed through the loopback proxy - every DNS/CONNECT is decided by your egress policy.</span></div>`
    : `<div class="sbx-row warn"><span class="pill dismissed">network-off</span><span>No egress proxy this session - subprocess network is denied (fail-closed).</span></div>`;
}

const GRANT_MODE_LABEL: Record<string, string> = { rx: "read-only", rw: "read-write" };

/** P-SANDBOX.13 (ADR-0391): Add folder (read-only / read-write). The engine opens the Explorer picker
 *  itself; the panel never sends a path. Shown whenever the Windows sandbox can be used. Pure. */
export function addFolderRow(c: SandboxControlView | undefined): string {
  if (!c?.available) return "";
  // P-SANDBOX.14 (ADR-0394): managed policy owns the folder list; a note, never a button.
  if (c.foldersLocked) return `<div class="sbx-row muted"><span>Your organization manages which folders the sandbox can reach. Ask your administrator to add one.</span></div>`;
  return `<div class="sbx-ctl"><div class="sbx-ctl-txt">Give the sandbox access to another folder. Windows opens its folder picker; nothing is granted until you choose one.</div>
    <div class="sbx-ctl-btns"><button class="btn-mini ok" data-sbx-add="rx" data-tip="Add folder (read-only)|The agent can read this folder but not change it.">${icon("plus", 13)} Add folder (read-only)</button><button class="btn-mini" data-sbx-add="rw" data-tip="Add folder (read-write)|The agent can read, create and change files in this folder.">${icon("plus", 13)} Add folder (read-write)</button></div></div>`;
}

/** P-SANDBOX.13: the folders LUCID always allows so the agent can run, listed read-only. Pure. */
function runtimeFoldersSection(folders: RuntimeFolderView[]): string {
  if (!folders.length) return "";
  const rows = folders
    .map((f) => `<div class="sbx-grant"><div class="sbx-grant-head"><span class="pill${f.mode === "rw" ? " dismissed" : ""}">${GRANT_MODE_LABEL[f.mode] ?? f.mode}</span><b class="sbx-host" title="${esc(f.path)}">${esc(f.path)}</b></div>
      <div class="sbx-blk-reason">${esc(f.why)}</div></div>`)
    .join("");
  return `<div class="sbx-blocks"><div class="sbx-blocks-hd">${icon("shield", 13)} Always allowed (LUCID's runtime and your organization's policy)</div>${rows}</div>`;
}

/** P-SANDBOX.8: the user-approved standing directory grants (AppContainer ACEs), each with Revoke.
 *  Every row is a PERSISTENT host DACL change, so the list is always visible while any grant stands. Pure. */
function grantsSection(grants: SandboxGrantView[]): string {
  if (!grants.length) return "";
  const rows = grants
    .map(
      (g) => `<div class="sbx-grant">
        <div class="sbx-grant-head"><span class="pill${g.mode === "rw" ? " dismissed" : ""}">${GRANT_MODE_LABEL[g.mode] ?? g.mode}</span><b class="sbx-host">${esc(g.path)}</b>
          <button class="btn-mini dismiss" data-grant-revoke="${esc(g.path)}" data-tip="Revoke|Remove the sandbox's ACE on this directory (helper --revoke-acl) and drop it from this list. The agent loses access immediately.">${icon("close", 13)} Revoke</button></div>
        <div class="sbx-blk-reason">${esc(g.reason || "no reason given")} · ${esc(g.grantedAt.slice(0, 10))}</div></div>`,
    )
    .join("");
  return `<div class="sbx-blocks"><div class="sbx-blocks-hd">${icon("shield", 13)} Directory grants (standing, until revoked)</div>${rows}</div>`;
}

/**
 * Render the "Runtime sandbox" accordion. Empty string until the first omp spawn resolves a state
 * (nothing to show yet) - unless standing directory grants exist, which must stay visible/revocable
 * even before a spawn. `open` controls the initial expanded state.
 */
export function renderSandboxSection(status: SandboxStatusView | null | undefined, open = false): string {
  const s = status?.state;
  const grants = status?.grants ?? [];
  const ctl = controlSection(status?.control);
  const folders = addFolderRow(status?.control) + grantsSection(grants) + runtimeFoldersSection(status?.runtimeFolders ?? []);
  if (!s && !grants.length && !ctl) return "";
  if (!s) {
    // Grants-only view (no spawn yet this session): the persistent host mutations still need a surface.
    return accordion("sec.sandbox", "Runtime sandbox", grants.length ? `${grants.length} directory grant${grants.length === 1 ? "" : "s"}` : "not started", ctl + folders, open, grants.length ? String(grants.length) : undefined);
  }
  const blocks = status?.egressBlocks ?? [];
  let inner = postureLine(s, status?.control) + egressLine(s) + ctl + folders;

  if (blocks.length) {
    const rows = blocks
      .map(
        (b) => `<div class="sbx-blk">
          <div class="sbx-blk-head"><span class="pill quarantined">${esc(b.channel)}</span><b class="sbx-host">${esc(b.host)}</b></div>
          <div class="sbx-blk-reason">${esc(b.reason)}</div></div>`,
      )
      .join("");
    inner += `<div class="sbx-blocks"><div class="sbx-blocks-hd">${icon("shield", 13)} Subprocess reach-outs refused (this session)</div>${rows}</div>`;
  } else if (s.isolated) {
    inner += `<div class="sbx-row muted"><span>No subprocess reach-outs have been refused this session.</span></div>`;
  }

  // Sub-label + count draw the eye when exec is NOT isolated or is blocked (the states worth noticing).
  const sub = s.execBlocked ? "exec blocked · fail-closed" : s.isolated ? "runtime-isolated" : "not isolated · disclosed";
  const count = blocks.length ? String(blocks.length) : undefined;
  return accordion("sec.sandbox", "Runtime sandbox", sub, inner, open || !s.isolated || !!s.execBlocked, count);
}
