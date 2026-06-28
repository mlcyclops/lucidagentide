// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/tour.ts - the first-run guided walkthrough (ADR-0089, P-ROLE.1b).
//
// PURE string builders + data (no DOM nodes), so the demo + test can assert on the step catalog,
// the per-role selection, and the coach-card markup without a browser. The only host read is a
// GUARDED OS check (platform.ts) for shortcut labels, which is deterministic off-browser ("Ctrl").
// app.ts owns the engine (spotlight backdrop, anchoring, Back/Next/Skip); styles.css owns `.coach*`.
//
// A "coachmark" is the premium per-model hover card's twin: same visual language (see `.modeltip`),
// but interactive and with a dimmed spotlight on the live target. Each step points at a REAL,
// stable selector; a step whose target is absent for the active role is skipped by the engine.
//
//  - ROLE_META          per-role label / glyph / blurb / landing surface (drives the role picker).
//  - roleDefaultTab()   the inspector tab a role lands on (Security for the analyst, else Memory).
//  - TOUR_STEPS         the master step catalog, keyed by id, with stable target selectors.
//  - stepsForRole()     the ordered subset of steps that matter to a role (mirrors ADR-0088).
//  - coachHtml()        the inner HTML of one coach card (header · body · tip · dots · controls).

import { icon } from "./icons.ts";
import { modCombo } from "./platform.ts";
import type { UserRole } from "./bridge.ts";

const e = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const USER_ROLE_LIST: UserRole[] = ["developer", "security", "manager", "executive"];

export interface RoleMeta {
  id: UserRole;
  label: string;
  icon: string;   // glyph name from icons.ts
  lands: string;  // the surface this role lands on (one phrase)
  blurb: string;  // one-line "what you'll see"
}

/** Display metadata for the four onboarding roles (ADR-0088). Cosmetic - never gates anything. */
export const ROLE_META: Record<UserRole, RoleMeta> = {
  developer: {
    id: "developer", label: "Developer", icon: "command", lands: "Chat + Memory",
    blurb: "Flow-state telemetry. Security stays out of the way until something blocks.",
  },
  security: {
    id: "security", label: "Security engineer", icon: "shield", lands: "Security queue",
    blurb: "Quarantine, findings, approvals, and the audit sink - always up front.",
  },
  manager: {
    id: "manager", label: "Manager", icon: "graph", lands: "Cost + delivery",
    blurb: "Spend, savings, and loop throughput. Security as a rollup, not raw noise.",
  },
  executive: {
    id: "executive", label: "Executive", icon: "eye", lands: "Posture + spend",
    blurb: "A few reassurance signals and the engineering brief. Nothing operational.",
  },
};

/** The inspector tab a role foregrounds on launch. Security analysts land on the Security queue;
 *  every other role lands on Memory (context / cache / cost). ADR-0021's active-block override
 *  still wins at runtime - this only sets the calm default. */
export function roleDefaultTab(role: UserRole): "security" | "memory" {
  return role === "security" ? "security" : "memory";
}

export interface TourStep {
  id: string;
  /** CSS selector for the element to spotlight + anchor to. "" = a centered, target-less card. */
  target: string;
  side?: "right" | "left" | "auto";
  icon: string;
  title: string;
  body: string;
  /** Optional emphasised one-liner (rendered as the "tip" chip). */
  tip?: string;
}

// Master catalog. Every target is a STABLE selector that exists in the assembled shell (rails,
// the composer, the model badge) so a step never dangles. Panel-internal targets are deliberately
// avoided - they may be collapsed; the engine skips any step whose target is absent.
export const TOUR_STEPS: Record<string, TourStep> = {
  composer: {
    id: "composer", target: "#input", side: "auto", icon: "chat",
    title: "The agent lives here",
    body: "Type or dictate a task. Everything you send is scanned before it can reach a tool - fail-closed, every turn.",
  },
  model: {
    id: "model", target: "#modelBadge", side: "auto", icon: "spark",
    title: "Pick your model",
    body: "Click to choose the model, mode, and thinking depth for the next turn.",
    tip: "Hover any model in the list for the full cost + intelligence card.",
  },
  security: {
    id: "security", target: '.rail-btn[data-rail="security"]', side: "right", icon: "shield",
    title: "Your security queue",
    body: "Quarantined content, approvals, and findings land here. The badge lights up the moment something is blocked - even on another tab.",
    tip: "A real block always surfaces this, whatever your role.",
  },
  memory: {
    id: "memory", target: '.rail-btn[data-rail="memory"]', side: "right", icon: "brain",
    title: "Context, cache, and cost",
    body: "Live context-window fill, prompt-cache savings, and per-model spend for this session.",
  },
  cost: {
    id: "cost", target: '.rail-btn[data-rail="memory"]', side: "right", icon: "brain",
    title: "Spend and delivery",
    body: "Cross-model token spend, estimated cache savings, and AI-authored lines by repo - your chargeback view.",
  },
  knowledge: {
    id: "knowledge", target: '.rail-btn[data-rail="knowledge"]', side: "right", icon: "graph",
    title: "Your private graph",
    body: "An encrypted, on-device memory of durable facts about you. It never leaves this machine.",
  },
  devlogs: {
    id: "devlogs", target: "#railLogs", side: "right", icon: "logs",
    title: "Transcripts and audit",
    body: "Turn transcripts, the gate-block audit, and the OCSF/SIEM export feed live under developer mode.",
  },
  commands: {
    id: "commands", target: "#railCmd", side: "left", icon: "command",
    title: "Everything is a keystroke away",
    body: `Press ${modCombo("K")} for the command palette - every panel and action, searchable. Nothing your role hides is ever truly gone.`,
  },
  about: {
    id: "about", target: "#railAbout", side: "left", icon: "info",
    title: "About - and replay",
    body: "Version, license, and a “Take the tour” button so you can replay this walkthrough any time.",
  },
  closer: {
    id: "closer", target: "", icon: "check",
    title: "You're all set",
    body: `Your view just leads with what your role needs - the rest is one ${modCombo("K")} away. Change role in Settings, or replay this tour from About whenever you like.`,
  },
};

// Ordered step ids per role. Mirrors ADR-0088's foregrounding: each role tours the surface it lives in.
const ROLE_STEP_IDS: Record<UserRole, string[]> = {
  developer: ["composer", "model", "memory", "knowledge", "commands", "about", "closer"],
  security: ["composer", "security", "devlogs", "memory", "commands", "about", "closer"],
  manager: ["composer", "model", "cost", "commands", "about", "closer"],
  executive: ["composer", "cost", "commands", "about", "closer"],
};

/** The ordered tour steps for a role (full catalog entries). The engine then drops any whose
 *  target selector is non-empty but absent from the DOM - so a hidden surface never dangles. */
export function stepsForRole(role: UserRole): TourStep[] {
  const ids = ROLE_STEP_IDS[role] ?? ROLE_STEP_IDS.developer;
  return ids.map((id) => TOUR_STEPS[id]).filter((s): s is TourStep => !!s);
}

/** Inner HTML for one coach card. Pure - app.ts positions the container + wires the data-coach-* hooks. */
export function coachHtml(step: TourStep, idx: number, total: number): string {
  const last = idx >= total - 1;
  const dots = Array.from({ length: total }, (_, i) =>
    `<span class="coach-dot${i === idx ? " on" : ""}"></span>`).join("");
  const tip = step.tip
    ? `<div class="coach-tip">${icon("info", 13)}<span>${e(step.tip)}</span></div>`
    : "";
  const back = idx > 0
    ? `<button class="coach-btn" type="button" data-coach-back>Back</button>`
    : "";
  return `<div class="coach-h">
      <span class="coach-ic">${icon(step.icon, 15)}</span>
      <span class="coach-title">${e(step.title)}</span>
      <span class="coach-count">${idx + 1} / ${total}</span>
    </div>
    <p class="coach-body">${e(step.body)}</p>
    ${tip}
    <div class="coach-nav">
      <div class="coach-dots" aria-hidden="true">${dots}</div>
      ${back}
      <button class="coach-btn primary" type="button" data-coach-next>${last ? "Done" : "Next"}</button>
    </div>
    <div class="coach-foot">
      <span>Esc to skip · replay later from About</span>
      <button class="coach-skip" type="button" data-coach-skip>Skip tour</button>
    </div>`;
}
