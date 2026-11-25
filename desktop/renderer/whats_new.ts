// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/whats_new.ts - P-WHATSNEW.1 (ADR-0686): the one-time What's new popup after an upgrade.
//
// Pure (no DOM): the launch decision and the modal markup, so the tests and the demo can assert on both.
// app.ts owns open/close, the engine-side seen version (GET/POST /api/settings `whatsNewSeen`) and the
// About > What's new replay. The seen version lives in the engine's settings, never only in localStorage:
// the renderer origin carries the port, and a port-rolled launch (ADR-0458) starts with an empty store.

import { notesSince, type Highlight, type ReleaseNotes } from "./release_notes.ts";
import { isNewerVersion } from "./plugin_catalog.ts";

export interface WhatsNewInput {
  /** The version the user last saw notes for (engine settings), or, when that is unset on an existing
   *  install, the engine's previous-run version (`upgradedFrom`). null when neither is known. */
  seen: string | null;
  /** APP_VERSION. */
  current: string;
  /** A fresh install: nothing was ever seen and no role was chosen yet. Records the version silently. */
  firstRun: boolean;
  /** First-run onboarding, the tour or another modal is on screen: wait, never cover it. */
  onboardingActive: boolean;
  /** Lucid's news or holiday toast already showed this launch: keep the notes for the next launch. */
  noticeShownThisLaunch?: boolean;
}

/** show: open the popup and record `current`; record: store `current` silently; wait: ask again shortly;
 *  none: nothing to do this launch. */
export type WhatsNewDecision = "show" | "record" | "wait" | "none";

/** The launch decision. Pure. */
export function shouldShowWhatsNew(i: WhatsNewInput, manifest?: readonly ReleaseNotes[]): WhatsNewDecision {
  if (i.firstRun) return "record";
  if (i.seen && !isNewerVersion(i.current, i.seen)) return "none"; // already seen, or a downgrade
  if (notesSince(i.seen, i.current, manifest).length === 0) return "record"; // a quiet release
  if (i.noticeShownThisLaunch) return "none";
  if (i.onboardingActive) return "wait";
  return "show";
}

/** The toast shown when the popup is dismissed: where to find it again. */
export const WHATS_NEW_HINT = {
  title: "What's new is saved in About",
  desc: "Review these notes any time from About > What's new.",
} as const;

const e = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only our two sites are linked; anything else in a manifest renders no link. */
const SAFE_LINK = /^https:\/\/(docs\.)?lucid-agents\.com\//;

function card(h: Highlight, version: string): string {
  const link = h.learnMore && SAFE_LINK.test(h.learnMore)
    ? `<a class="wn-more" href="${e(h.learnMore)}" target="_blank" rel="noopener noreferrer" data-tip="Open in your browser">Learn more ↗</a>`
    : "";
  return `<article class="wn-card" data-wn-id="${e(h.id)}">
      <div class="wn-shot"><img src="${e(h.image)}" alt="${e(h.alt)}" loading="eager" decoding="async"></div>
      <div class="wn-body">
        <span class="wn-tag">New in ${e(version)}</span>
        <h3 class="wn-h">${e(h.title)}</h3>
        <p class="wn-p">${e(h.body)}</p>
        ${link}
      </div>
    </article>`;
}

function group(label: string, kind: Highlight["kind"], notes: readonly ReleaseNotes[]): string {
  const cards = notes.flatMap((n) => n.highlights.filter((h) => h.kind === kind).map((h) => card(h, `v${n.version}`)));
  if (!cards.length) return "";
  return `<section class="wn-group" data-wn-group="${kind}">
      <h2 class="wn-gh">${e(label)}</h2>
      <div class="wn-grid">${cards.join("")}</div>
    </section>`;
}

/** Full inner HTML for the What's new modal. `notes` newest first (notesSince). */
export function whatsNewHtml(notes: readonly ReleaseNotes[]): string {
  const top = notes[0];
  const sub = top ? `v${e(top.version)} · ${e(top.title)}` : "";
  return `<div class="about-modal wn-modal" role="dialog" aria-modal="true" aria-labelledby="whatsNewTitle">
    <button class="about-x" data-wn-close aria-label="Close">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>
    </button>
    <div class="about-hero wn-hero">
      <div class="about-glow" aria-hidden="true"></div>
      <h1 class="wn-title" id="whatsNewTitle">What's new in LUCID</h1>
      <div class="about-ver wn-sub">${sub}</div>
    </div>
    ${group("New features", "feature", notes)}
    ${group("Agent Worlds", "world", notes)}
    <div class="about-actions wn-actions">
      <button class="btn-mini ok" data-wn-dismiss>Dismiss</button>
    </div>
  </div>`;
}
