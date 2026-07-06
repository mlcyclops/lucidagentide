// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/steps_restore.ts — P-RESUME.1 (ADR-0171): render a resumed session's RESTORED
// agent activity (thinking / tool steps / tool failures from the lucid-steps sidecar).
//
// Pure HTML builders (marketplace.ts / toolfail_group.ts convention) so the markup is
// unit-testable; app.ts owns insertion + the click-to-toggle wiring. Reuses the LIVE surfaces'
// classes (.reasoning / .thoughts / .tf-row) so restored turns look like the real thing, just
// settled: collapsed by default, "restored" in the summary label. Everything step-derived is
// escaped — sidecar text originated from model output and tool errors, both untrusted for HTML.

import { esc } from "./format.ts";
import { icon } from "./icons.ts";
import { toolfailRowHtml } from "./toolfail_group.ts";
import type { RestoredTurn } from "../session_steps.ts";

/** The collapsed one-line label for a restored turn's tool window. */
export function stepsSummary(g: RestoredTurn): string {
  const bits: string[] = [];
  if (g.tools.length) bits.push(`${g.tools.length} step${g.tools.length === 1 ? "" : "s"}`);
  if (g.fails.length) bits.push(`${g.fails.length} failed`);
  return bits.join(" · ") || "No tools used";
}

/** One restored turn: an optional collapsed thinking block, an optional collapsed tool window,
 *  and the failed-call rows. Buttons carry data-rs-toggle; app.ts wires the expand/collapse. */
export function restoredTurnHtml(g: RestoredTurn): string {
  let h = `<div class="restored-steps">`;
  if (g.thinking) {
    h += `<div class="reasoning done restored">
      <button class="reasoning-head" type="button" data-rs-toggle aria-expanded="false">
        <span class="reasoning-spin">${icon("bulb", 13)}</span>
        <span class="reasoning-cur">Thinking · restored${g.thinkingTruncated ? " · truncated" : ""}</span>
        <span class="reasoning-chev">${icon("chevron", 14)}</span>
      </button>
      <div class="reasoning-body">${esc(g.thinking)}</div>
    </div>`;
  }
  if (g.tools.length || g.fails.length) {
    const rows = g.tools.map((t) => `<div class="thoughts-step">${icon("spark", 13)}<span class="ts-k">${esc(t.name)}</span><span class="ts-d">${esc(t.detail)}</span></div>`).join("");
    const fails = g.fails.length
      ? `<div class="tf-body restored"><div class="tf-title">Tool Call Actions · failed</div>${g.fails.map(toolfailRowHtml).join("")}</div>`
      : "";
    h += `<div class="thoughts done restored">
      <button class="thoughts-head" type="button" data-rs-toggle aria-expanded="false">
        <span class="thoughts-spin">${icon("spark", 13)}</span>
        <span class="thoughts-cur">${esc(stepsSummary(g))} · restored</span>
        <span class="thoughts-chev">${icon("chevron", 14)}</span>
      </button>
      <div class="thoughts-body">${rows}${fails}</div>
    </div>`;
  }
  return h + `</div>`;
}
