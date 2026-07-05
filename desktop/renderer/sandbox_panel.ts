// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/sandbox_panel.ts — P-SANDBOX.5 (ADR-0169): the "Runtime sandbox" Security-panel section.
//
// PURE (the format.ts / model_favorites.ts builder convention): a SandboxStatus in → the accordion HTML
// out. Surfaces what P-SANDBOX.1-.4 built but hid: is THIS session's exec runtime-isolated (bwrap /
// Seatbelt), the disclosed passthrough, or fail-closed BLOCKED — plus whether subprocess egress is
// mediated, and the recent reach-outs the proxy REFUSED (the DNS-TXT exfils it caught). Metadata only.

import { accordion } from "./dom.ts";
import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import type { SandboxStateView, SandboxStatusView } from "./bridge.ts";

const BACKEND_LABEL: Record<string, string> = {
  bwrap: "Linux bubblewrap",
  seatbelt: "macOS Seatbelt",
  noop: "disclosed passthrough",
};

/** The one-line posture: BLOCKED (red) ⇒ isolated (green) ⇒ disclosed passthrough (amber). Pure. */
function postureLine(s: SandboxStateView): string {
  if (s.execBlocked) {
    return `<div class="sbx-row bad"><span class="pill quarantined">exec blocked</span>
      <span>Exec is <b>fail-closed BLOCKED</b> — managed policy requires runtime isolation and none is available. ${esc(s.execBlocked)}</span></div>`;
  }
  if (s.isolated) {
    return `<div class="sbx-row good"><span class="pill">${icon("shield", 12)} isolated</span>
      <span>Exec runs runtime-isolated via <b>${esc(BACKEND_LABEL[s.backend ?? "noop"] ?? s.backend ?? "?")}</b> — declared network/exec caps enforced.</span></div>`;
  }
  return `<div class="sbx-row warn"><span class="pill dismissed">not isolated</span>
    <span>Exec is <b>not runtime-isolated</b> on ${esc(s.platform)} (disclosed passthrough). The argv gate + in-process scanner still apply; a native backend is a follow-up.</span></div>`;
}

/** The mediated-egress line (only meaningful when isolated). Pure. */
function egressLine(s: SandboxStateView): string {
  if (!s.isolated) return "";
  return s.proxied
    ? `<div class="sbx-row good"><span class="pill">${icon("shield", 12)} mediated</span><span>Subprocess egress is routed through the loopback proxy — every DNS/CONNECT is decided by your egress policy.</span></div>`
    : `<div class="sbx-row warn"><span class="pill dismissed">network-off</span><span>No egress proxy this session — subprocess network is denied (fail-closed).</span></div>`;
}

/**
 * Render the "Runtime sandbox" accordion. Empty string until the first omp spawn resolves a state
 * (nothing to show yet). `open` controls the initial expanded state.
 */
export function renderSandboxSection(status: SandboxStatusView | null | undefined, open = false): string {
  const s = status?.state;
  if (!s) return "";
  const blocks = status?.egressBlocks ?? [];
  let inner = postureLine(s) + egressLine(s);

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
