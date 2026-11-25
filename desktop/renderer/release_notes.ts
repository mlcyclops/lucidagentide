// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/release_notes.ts - P-WHATSNEW.1 (ADR-0686): the bundled What's new manifest.
//
// One entry per released APP_VERSION, newest first, shipped inside the renderer so it works offline and
// air-gapped (no fetch). Each highlight carries a bundled image (a path under desktop/renderer/, served as
// is) and an optional Learn more link to lucid-agents.com or docs.lucid-agents.com, the same pages and
// pictures the website and the docs show. A release with nothing to show the user (a hotfix, a rebuild)
// carries `quiet: true` and no highlights: the popup is skipped and the seen version simply moves on.
// release_notes.test.ts fails a version bump that adds neither an entry nor a quiet marker, and any
// highlight whose image is not in the bundle.

import { DOCS_BASE_URL } from "./docs_links.ts";
import { isNewerVersion } from "./plugin_catalog.ts";

/** The public docs site (ADR-0660), from the one place its URL lives (docs_links.ts, P-DOCS.2), without the trailing
 *  slash so page paths read `${DOCS_BASE}/agents/`. */
export const DOCS_BASE = DOCS_BASE_URL.replace(/\/$/, "");
/** The product website, the same link About shows. */
export const SITE_URL = "https://lucid-agents.com/";

export type HighlightKind = "feature" | "world";

export interface Highlight {
  /** Stable id, unique within its release (DOM hooks, tests). */
  id: string;
  title: string;
  body: string;
  /** Bundled image, relative to desktop/renderer/ (for example `assets/whatsnew/agents-rail.webp`). */
  image: string;
  /** Alt text for the image: what the picture shows. */
  alt: string;
  /** Optional page on lucid-agents.com or docs.lucid-agents.com. */
  learnMore?: string;
  kind: HighlightKind;
}

export interface ReleaseNotes {
  version: string;
  /** Release date, YYYY-MM-DD. */
  date: string;
  title: string;
  highlights: Highlight[];
  /** Nothing to show for this release: the popup is skipped and the version is recorded as seen. */
  quiet?: true;
}

/** Newest first. Add the new APP_VERSION's entry (or a quiet marker) in the same change as the bump. */
export const RELEASE_NOTES: readonly ReleaseNotes[] = [
  {
    version: "2.7.1",
    date: "2026-11-24",
    title: "Agents you can see, schedule and keep light",
    highlights: [
      {
        id: "agents-rail",
        kind: "feature",
        title: "Your Agents on the right rail",
        body: "Each folder you work in is a small Lucid in a glass brick. It lights up while an agent works there, so you see who is busy without opening anything.",
        image: "assets/whatsnew/agents-rail.webp",
        alt: "The right rail on its Agents view: a column of glass bricks, one per folder, with the working one lit.",
        learnMore: `${DOCS_BASE}/agents/`,
      },
      {
        id: "activate-agent",
        kind: "feature",
        title: "Activate an Agent",
        body: "Click an Agent to put it to work: take over the main composer, start a Fleet session, or open an Agent World session in its folder.",
        image: "assets/whatsnew/agents-activate-menu.webp",
        alt: "An Agent's module with the Activate choices open.",
        learnMore: `${DOCS_BASE}/agents/activate-an-agent/`,
      },
      {
        id: "schedule-agent",
        kind: "feature",
        title: "Schedule this Agent",
        body: "Run an Agent once, daily, on weekdays, on chosen days or monthly, at a time you pick, with a goal in plain words.",
        image: "assets/whatsnew/agents-schedule-form.webp",
        alt: "The Schedule this Agent form: how often, the time of day and the goal.",
        learnMore: `${DOCS_BASE}/agents/schedule-an-agent/`,
      },
      {
        id: "floating-agents",
        kind: "feature",
        title: "Floating Agents with ideas",
        body: "A small Agent floats over each message box and suggests next steps after a turn, ready to run in parallel or to ask Lucid about. A red x hides it for the session.",
        image: "assets/whatsnew/agents-buddy-ideas.webp",
        alt: "A floating Agent's ideas: suggested next steps with Run in parallel and Ask Lucid buttons.",
        learnMore: `${DOCS_BASE}/agents/floating-agents/`,
      },
      {
        id: "world-packs-first",
        kind: "world",
        title: "World Packs lead the store",
        body: "World Packs now come first in the Premium store, and worlds you bought restore themselves after an upgrade.",
        image: "assets/plugins/world-christmas-poster.webp",
        alt: "The Christmas Agent World poster.",
        learnMore: `${DOCS_BASE}/worlds/get-worlds/`,
      },
      {
        id: "worlds-every-lane",
        kind: "world",
        title: "Agent Worlds keep up with your Fleet",
        body: "Visualize and the rail stay accurate when four or more agents run at once, and an Agent can open straight into an Agent World session.",
        image: "assets/plugins/world-football-poster.webp",
        alt: "The Football Agent World poster.",
        learnMore: `${DOCS_BASE}/worlds/open-agent-worlds/`,
      },
    ],
  },
];

/** What About > What's new shows: the newest release up to `current` that has highlights (a quiet hotfix
 *  replays the release it fixed). Empty only when the manifest has nothing to show. Pure. */
export function latestNotes(current: string, manifest: readonly ReleaseNotes[] = RELEASE_NOTES): ReleaseNotes[] {
  const shown = manifest.filter((n) => !n.quiet && n.highlights.length > 0 && !isNewerVersion(n.version, current));
  const newest = shown.reduce<ReleaseNotes | undefined>((best, n) => (!best || isNewerVersion(n.version, best.version) ? n : best), undefined);
  return newest ? [newest] : [];
}

/** The releases to show a user who last saw `seen` and now runs `current`: every non-quiet entry newer than
 *  `seen` and not newer than `current`, newest first. With no `seen` (an install from before this feature)
 *  only the current release is shown, never the whole history. Pure. */
export function notesSince(seen: string | null, current: string, manifest: readonly ReleaseNotes[] = RELEASE_NOTES): ReleaseNotes[] {
  return manifest
    .filter((n) => !n.quiet && n.highlights.length > 0 && !isNewerVersion(n.version, current)
      && (seen ? isNewerVersion(n.version, seen) : n.version === current))
    .sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0));
}
