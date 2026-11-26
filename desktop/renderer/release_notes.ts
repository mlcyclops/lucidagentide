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
    version: "2.7.2-beta.1",
    date: "2026-11-25",
    title: "Eleven new worlds, and Agent Worlds that keep up with your whole fleet",
    highlights: [
      {
        id: "every-lane",
        kind: "feature",
        title: "Your whole fleet, drawn",
        body: "Every running Fleet lane is drawn and counted again, even after a New session or a restart, and 3D no longer flashes black while your agents work.",
        image: "assets/whatsnew/v272-every-lane.webp",
        alt: "Agent Worlds in 3D with eight agents in glass cubes and token streams flowing between them.",
        learnMore: `${DOCS_BASE}/worlds/open-agent-worlds/`,
      },
      {
        id: "lane-panel",
        kind: "feature",
        title: "Agent panels, Fleet style",
        body: "Click an agent in Agent Worlds to watch its thinking and tool calls stream in, paste images as chips, stage the next prompt while it works, and drag the panel bigger.",
        image: "assets/whatsnew/v272-lane-panel.webp",
        alt: "An agent's panel in Agent Worlds with its prompt, its controls, the Mini game rows and the prompt box.",
      },
      {
        id: "session-history",
        kind: "feature",
        title: "Take your history with you",
        body: "Export a project's sessions to one plain-text file and import it into another LUCID Agent IDE, offline. Every session is scanned on the way out and on the way in.",
        image: "assets/whatsnew/v272-session-history.webp",
        alt: "The Export session history dialog with the project's sessions selected and an optional marking field.",
      },
      {
        id: "worlds-service",
        kind: "world",
        title: "Eight new service worlds",
        body: "Field Exercise, Flight Deck, Flight Line, Boot Camp, Sea Rescue, Orbital Ops, Cyber Ops and Special Operations, each with its own throwables, storm and options.",
        image: "assets/whatsnew/v272-worlds-service.webp",
        alt: "Eight world previews: a field camp, a carrier deck, a flight line, a boot camp, a sea rescue, an orbit, a cyber room and a night operation.",
        learnMore: `${DOCS_BASE}/worlds/get-worlds/`,
      },
      {
        id: "worlds-states",
        kind: "world",
        title: "Florida, Texas and California",
        body: "Three state worlds join the store: Florida Man's Space Coast and Everglades, Texas ranch country with a Supercell, and California's Golden State set. Find all eleven in Plugins.",
        image: "assets/whatsnew/v272-worlds-states.webp",
        alt: "Previews of the Florida, Texas and California worlds side by side.",
        learnMore: `${DOCS_BASE}/worlds/get-worlds/`,
      },
      {
        id: "builtin-options",
        kind: "world",
        title: "Built-in worlds, your way",
        body: "The built-in worlds get options: Nebula, Night sky, Sunset, Aurora, Studio, Deep space or a solid backdrop, plus stars, accent colors, lighting, name tags and a floor grid.",
        image: "assets/whatsnew/v272-builtin-options.webp",
        alt: "The Anime world on a sunset backdrop with the View menu open on Anime options.",
      },
      {
        id: "tray-reactions",
        kind: "world",
        title: "Four new reactions on the tray",
        body: "The arrow at the left of the tray folds out Celebrate, Wave, Coffee break and Dance. Every agent joins in, then gets back to work.",
        image: "assets/whatsnew/v272-tray-reactions.webp",
        alt: "Agents in 3D mid-celebration, with the tray's reactions group folded out.",
      },
      {
        id: "mini-games",
        kind: "world",
        title: "Mini games, leveled up",
        body: "Target tap and Memory cards gain levels, power-ups and combos, and Agent runner is new: dodge bugs and firewalls down a build pipeline.",
        image: "assets/whatsnew/v272-mini-games.webp",
        alt: "Agent runner's robot on a three-lane pipeline next to Target tap and Memory cards.",
      },
      {
        id: "purchases",
        kind: "world",
        title: "Purchases stay unlocked",
        body: "Sign in once: your worlds stay unlocked through restarts and updates, even offline. When a world you own gets a new version, Update it right from the Worlds menu.",
        image: "assets/plugins/bundle-patron-poster.webp",
        alt: "The Patron bundle card art.",
      },
    ],
  },
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
