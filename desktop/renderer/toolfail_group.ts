// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/toolfail_group.ts — P-TOOLFAIL.2 (ADR-0163): the collapsed toolbox badge for
// failed tool-call actions.
//
// P-TOOLFAIL.1 gave each failed/didn't-run tool call an honest one-line chip — but a burst of
// probes (a grep that found nothing, a `make` on a box without make) still stacked full-width
// rows that read like alarms. Now a run of consecutive failures collapses into ONE small red
// toolbox icon with a count; clicking it expands the "Tool Call Actions" list — per action: the
// tool, the one-line reason, the COMMAND ATTEMPTED, and the full error text.
//
// Pure builders (no DOM) so the HTML is unit-testable — same convention as marketplace.ts
// (ADR-0158). app.ts owns grouping + the click-to-toggle wiring. Everything user-controlled is
// escaped; this surface is NEVER a security event (the gate's quarantine keeps its own loud
// .evt.block chip — ADR-0093 distinction preserved).

import { esc } from "./format.ts";
import { icon } from "./icons.ts";

/** One failed tool-call action, as carried by the (quarantined:false) block ChatEvent. */
export interface ToolFailEntry {
  tool: string;
  /** The one-line chip reason from tool_failure.ts ("tool failed: …" / "tool did not run: …"). */
  reason: string;
  /** The command/code the call attempted, when the update carried one (bare, no `$ ` prefix). */
  command?: string;
  /** The full multi-line error text, when longer than what `reason` already shows. */
  detail?: string;
}

/** One expanded row of the "Tool Call Actions" list. */
export function toolfailRowHtml(e: ToolFailEntry): string {
  const cmd = e.command ? `<code class="tf-cmd">$ ${esc(e.command)}</code>` : "";
  // Skip the detail block when it adds nothing over the one-line reason (short errors) —
  // compare whitespace-flattened, since `reason` is flattened and `detail` keeps newlines.
  const flat = (e.detail ?? "").replace(/\s+/g, " ").trim();
  const detail = flat && !e.reason.includes(flat) ? `<pre class="tf-detail">${esc(e.detail)}</pre>` : "";
  return `<div class="tf-row"><div class="tf-row-head">${icon("close", 12)}<b>${esc(e.tool)}</b><span class="tf-reason">${esc(e.reason)}</span></div>${cmd}${detail}</div>`;
}

/** The whole group: the collapsed toolbox badge, plus the expanded list when `open`. */
export function toolfailGroupHtml(entries: ToolFailEntry[], open: boolean): string {
  const n = entries.length;
  const head =
    `<button class="tf-head" type="button" aria-expanded="${open}" ` +
    `data-tip="Tool Call Actions|${n} tool call${n === 1 ? "" : "s"} failed or did not run — click to ${open ? "collapse" : "expand"} · not a security block">` +
    `${icon("toolbox", 15)}<span class="tf-count">${n}</span></button>`;
  if (!open) return head;
  return `${head}<div class="tf-body"><div class="tf-title">Tool Call Actions</div>${entries.map(toolfailRowHtml).join("")}</div>`;
}
