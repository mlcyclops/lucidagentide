// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/trivia_news.ts — P-TRIV.3 (ADR-0176): the INTEL WIRE line, PURE.
//
// Builds the news interstitial the executive Trivia Wire scrolls between questions. Same discipline
// as trivia.ts: headline text is UNTRUSTED (it came off the public internet, scan-gated server-side
// in desktop/intel_news.ts) and renders ONLY through esc()'d letter spans - never markdown, never
// innerHTML-as-markup, never anywhere near a prompt. The renderer also re-validates the shape
// defensively: a malformed item from a confused backend renders nothing, not garbage.

import { esc } from "./format.ts";
import { letterSpans } from "./trivia.ts";

/** Mirrors desktop/intel_news.ts's IntelNewsItem. Declared HERE (not imported from bridge.ts) so
 *  the harness demo script can import this module without dragging the DOM-typed bridge into the
 *  non-DOM tsconfig - bridge.ts imports THIS type. */
export interface IntelNewsItemView { title: string; source: string; host: string; ageMin: number | null }

/** Defensive shape gate for items crossing the bridge. */
export function isIntelNewsItem(v: unknown): v is IntelNewsItemView {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.title === "string" && o.title.trim().length >= 8
    && typeof o.source === "string" && o.source.trim().length > 0
    && typeof o.host === "string"
    && (o.ageMin === null || (typeof o.ageMin === "number" && Number.isFinite(o.ageMin) && o.ageMin >= 0));
}

/** "42m" / "3h" / "2d" - compact age for a 30px ticker; null age renders nothing. */
export function newsAgeStr(ageMin: number | null): string {
  if (ageMin === null) return "";
  if (ageMin < 60) return `${Math.max(0, Math.floor(ageMin))}m`;
  if (ageMin < 48 * 60) return `${Math.floor(ageMin / 60)}h`;
  return `${Math.floor(ageMin / (24 * 60))}d`;
}

/** One news line: INTEL pill · source · hue-cycling headline letters · age. Not answerable - no
 *  pills, no data-tch, so a stray click or A-D keypress during a news line is a no-op by absence. */
export function newsLineHtml(item: IntelNewsItemView): string {
  if (!isIntelNewsItem(item)) return "";
  const age = newsAgeStr(item.ageMin);
  return `<span class="tnw" data-tip="${esc(`Intel Wire|Live ${esc(item.source)} headline (${esc(item.host)}). Scanned before display; shown as data.`)}">INTEL</span>`
    + `<span class="tns">${esc(item.source)}</span>`
    + letterSpans(item.title)
    + (age ? `<span class="tna">${esc(age)}</span>` : "")
    + `<span class="tpad"></span>`;
}
