// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/renderer/plugin_catalog.ts - P-PLUGINS.1 (ADR-0461): the one catalog behind the Plugins drawer.
//
// PREMIUM: the LUCID apps sold at $29.99 one-time (ADR-0463) plus the link-outs that are never sold here (LEAPS
// keeps its own subscription; MDMP Engine and Joint Planning Engine are Black Arrow Systems partner apps,
// ADR-0465). FREE: the ADR-0158/0181 integrations registry, moved here from the retired `#scrim` marketplace
// with its featured / built-in / planned semantics intact, plus the capabilities LUCID already ships.
//
// Pure data and pure decisions (no DOM, no fetch): plugins_flyout.ts renders and wires; this module decides.
// Ids are stable forever (AGENTS.md invariant 9) and double as the entitlement id (PLUGINS-CONTRACT).

import { decidePackAction, type Entitlement, type GovAccessStatus } from "../../harness/market/entitlement.ts";

export type PluginTier = "premium" | "free";
export type PluginSection = "civilian" | "government";
/** Palette token a generated poster is tinted with (styles.css `--<tone>-rgb`), so posters follow the theme. */
export type PosterTone = "accent" | "cyan" | "green" | "amber" | "blue" | "violet";

/** How a card's picture is made. `loop`: a bundled `<id>-loop.mp4` plays over the poster while visible.
 *  `poster: "webp"`: a bundled `<id>-poster.webp`; `"generated"`: an SVG drawn from `glyph` + `tone`. */
export interface PluginMedia { loop: boolean; poster: "webp" | "generated"; glyph: string; tone: PosterTone }

interface PremiumBase {
  id: string;
  name: string;
  kicker: string;
  pitch: string;
  /** The "With LUCID Agent" line: what the plugin does once it lives inside LUCID. */
  lucid: string;
  section: PluginSection;
  media: PluginMedia;
}
/** Sold through LUCID: one-time $29.99, Stripe price looked up by `lookupKey` server-side. `available` is true
 *  only once the package is built, signed and verified; until then the card says Coming soon and sells nothing. */
export interface SoldPlugin extends PremiumBase { sale: "buy"; lookupKey: string; available: boolean }
/** Never sold through LUCID: the card opens `href` in the system browser. */
export interface LinkOutPlugin extends PremiumBase { sale: "link"; href: string; linkLabel: string; partner?: string }
export type PremiumPlugin = SoldPlugin | LinkOutPlugin;

export const PLUGIN_PRICE_LABEL = "$29.99";
export const PLUGIN_LICENSE_NAME = "LUCID Premium Plugin License";
export const PLUGIN_LICENSE_URL = "https://lucid-agent.web.app/legal/plugins";
export const BLACK_ARROW = "Black Arrow Systems";

export const PREMIUM_PLUGINS: PremiumPlugin[] = [
  {
    id: "pathfinder", name: "Pathfinder", section: "civilian", sale: "buy", lookupKey: "PLG-PATHFINDER-OTF", available: true,
    kicker: "Career and relocation",
    pitch: "Evidence-first career and relocation planner for the whole household: resume parsing, jobs near the target region for you and your partner, a fact-checked resume tailored to each opening, commute baselines, FEMA flood zones, and verified housing and volunteer research.",
    lucid: "Runs on your machine and thinks with your LUCID model, no separate AI key. The agent can search jobs, tailor a resume, and build a relocation brief through Pathfinder's tools.",
    media: { loop: true, poster: "webp", glyph: "search", tone: "cyan" },
  },
  {
    id: "myhome", name: "MyHome", section: "civilian", sale: "buy", lookupKey: "PLG-MYHOME-OTF", available: true,
    kicker: "Local-first household AI",
    pitch: "One app for a household's health, insurance, and property tax on a local knowledge graph that stays on your computer. Care Finder searches plan doctor directories by voice, and Home Tax scores each taxing authority on your bill.",
    lucid: "Bills, EOBs and policy documents are read by your LUCID model instead of a separate key. The agent can summarize the household, list upcoming renewals and claims, and score tax authorities through MyHome's tools.",
    media: { loop: true, poster: "webp", glyph: "folder", tone: "green" },
  },
  {
    id: "agentictrade187", name: "AgenticTrade187", section: "civilian", sale: "buy", lookupKey: "PLG-AT187-OTF", available: true,
    kicker: "Agent-ready trading desk",
    pitch: "A trading desk AI agents can run: paper trading by default, a server-side risk gate, Strategy Studio backtests with overfitting receipts, the Market Map screener, Smart Alerts that say why they fired, and 3D charts.",
    lucid: "Its 47 MCP tools register with the agent, so LUCID can research tickers, run backtests, and journal lessons, while every order stays behind the risk gate.",
    media: { loop: true, poster: "webp", glyph: "gauge", tone: "amber" },
  },
  {
    id: "homeschooltutor", name: "HomeschoolTutor", section: "civilian", sale: "buy", lookupKey: "PLG-HST-OTF", available: false,
    kicker: "Local-first learning companion",
    pitch: "A private learning companion for homeschooled kids on Miacademy: a Chrome extension with hint ladders that guide without giving the answer away, and a Learning Hub with daily quests, a Mastery Path, narrated story series, and 3D explainers.",
    lucid: "Will install the Learning Hub on the family computer and run its hints and Studio prompts on your LUCID model, with the Chrome extension as one Add to Chrome step.",
    media: { loop: true, poster: "webp", glyph: "bulb", tone: "violet" },
  },
  {
    id: "tactical-genai-trainer", name: "Tactical GenAI Trainer", section: "civilian", sale: "buy", lookupKey: "PLG-TGT-OTF", available: false,
    kicker: "Certification training platform",
    pitch: "Self-paced certification training: 11 curricula and 202 modules across generative AI, cloud architecture, cloud security, and CMMC CUI awareness, with printable contact-hour certificates.",
    lucid: "Will run its scenarios and grading on your LUCID model instead of a Gemini key, so training keeps working on local GPUs with no internet.",
    media: { loop: true, poster: "webp", glyph: "shield", tone: "cyan" },
  },
  {
    id: "lucid-meeting-hub", name: "LUCID Meeting Hub", section: "civilian", sale: "buy", lookupKey: "PLG-MEETHUB-OTF", available: false,
    kicker: "Private meeting capture",
    pitch: "Meeting capture without a bot in the room: it detects Teams, Zoom, Webex, and Meet calls, transcribes with Whisper, labels speakers, and writes the summary, decisions, and action items into an encrypted local vault.",
    lucid: "Will install the Hub from here. Today it already pairs with LUCID's Meetings panel, where you search past meetings and send notes and screenshots into your knowledge graph.",
    media: { loop: true, poster: "webp", glyph: "calendar", tone: "violet" },
  },
  {
    id: "leaps", name: "LEAPS", section: "civilian", sale: "link",
    href: "https://l-e-a-p-s-947863229376.us-west1.run.app", linkLabel: "Subscription on leaps",
    kicker: "Spaced repetition studio",
    pitch: "LEAP Study Studio: a cloud-synced flashcard studio on the SM-2 spaced repetition engine, with starter decks for Cisco CCNA, AWS, military planning (MDMP), and more.",
    lucid: "LEAPS is sold as its own subscription. Your decks and progress live on the LEAPS site, which opens in your browser.",
    media: { loop: true, poster: "webp", glyph: "loop", tone: "green" },
  },
  {
    id: "rapid-survey", name: "RAPID-SURVEY", section: "government", sale: "buy", lookupKey: "PLG-RAPID-OTF", available: false,
    kicker: "Offline site intelligence",
    pitch: "Facility survey for security integrators, facilities and AEC teams, insurers, and public safety: on-site AI behind a CUI lockdown switch, native DWG drawings, IFC for Revit, and a one-click Autodesk package.",
    lucid: "Will run its site analysis through your LUCID model, including gov-lockdown routing, so survey data only travels the paths your organization approved.",
    media: { loop: true, poster: "webp", glyph: "scan", tone: "blue" },
  },
  {
    id: "quantum-cloak", name: "Quantum Cloak", section: "government", sale: "buy", lookupKey: "PLG-QCLOAK-OTF", available: true,
    kicker: "Quantum comms and computing trainer",
    pitch: "38 narrated 3-D modules on real simulators, starting with a math and physics primer: qubits and Bell tests, QKD over fiber and satellites and the attacks on it, Shor and Grover, error correction, the NIST post-quantum standards and migration deadlines, and capstone missions, with practice, track certificates and instructor reports.",
    lucid: "Runs in a Preview tab; only the narration audio streams from Google Cloud Storage. Its tools let the agent simulate circuits, run QKD links and lattice scenarios, quiz you with practice items, and explain any term.",
    media: { loop: true, poster: "webp", glyph: "spark", tone: "violet" },
  },
  {
    id: "mdmp-engine", name: "MDMP Engine", section: "government", sale: "link", partner: BLACK_ARROW,
    href: "https://tacticalmdmp.com/", linkLabel: "Visit partner",
    kicker: "Army MDMP trainer",
    pitch: "Turns the seven-step Military Decision-Making Process into a guided digital workflow: real-time doctrinal coaching, automated IPB, MIL-STD-2525D mapping, COA war-gaming, and one-click WARNORD and OPORD production.",
    lucid: "A Black Arrow Systems app built in partnership with TECHLEAD 187 LLC. It runs on tacticalmdmp.com and is not sold through LUCID.",
    media: { loop: true, poster: "webp", glyph: "layout", tone: "amber" },
  },
  {
    id: "joint-planning-engine", name: "Joint Planning Engine", section: "government", sale: "link", partner: BLACK_ARROW,
    href: "https://www.blackarrowsystems.net", linkLabel: "Visit partner",
    kicker: "Joint planning C2",
    pitch: "A secure, collaborative C2 application that guides military staffs through the Joint Planning Process and automates the heavy lifting of JIPOE, COA development, and wargaming.",
    lucid: "A Black Arrow Systems app built in partnership with TECHLEAD 187 LLC. It runs on the partner's site and is not sold through LUCID.",
    media: { loop: true, poster: "webp", glyph: "share", tone: "blue" },
  },
];

/** Closed set. featured = pinned to the top; built-in = LUCID already ships the capability;
 *  planned = on the integration roadmap (ADR-0158). */
export type FreeStatus = "featured" | "built-in" | "planned";

export interface FreePlugin {
  id: string;            // stable id: never regenerated (AGENTS.md invariant 9)
  name: string;
  desc: string;          // one line: what it does
  /** The upstream project (https GitHub). Absent for a LUCID capability with no separate upstream. */
  repo?: string;
  category: string;
  /** Obsidian community downloads where verified; null = unverified (never fabricated). */
  downloads: number | null;
  /** Canonical order: 1 = Excalidraw (pinned), then the Obsidian integrations rank, then LUCID-fit additions. */
  rank: number;
  status: FreeStatus;
  /** The "With LUCID Agent" line. For a planned row it is the integration plan. */
  lucid: string;
  glyph: string;
  tone: PosterTone;
}

/** The FREE registry (ADR-0158/0181 rows, retired ids never reused: copilot, brat, url-into-selection, readwise). */
export const FREE_PLUGINS: FreePlugin[] = [
  {
    id: "excalidraw", name: "Excalidraw", rank: 1, status: "featured",
    desc: "Virtual whiteboard for sketching hand-drawn-like diagrams.",
    repo: "https://github.com/excalidraw/excalidraw",
    category: "Whiteboard", downloads: 6_487_654, glyph: "pen", tone: "violet",
    lucid: "Embed the whiteboard in the sandboxed Preview panel; sketches feed the agent as design context.",
  },
  {
    id: "git", name: "Git", rank: 2, status: "built-in",
    desc: "Version your workspace with git, run safely on the host.",
    category: "Version control", downloads: null, glyph: "git", tone: "amber",
    lucid: "The agent's git runs through a host broker with an allowlist of subcommands and options, and the commit gate stops one agent from sweeping another agent's uncommitted files into its commit.",
  },
  {
    id: "remotely-save", name: "Remotely Save", rank: 3, status: "planned",
    desc: "Sync notes and settings to S3, WebDAV, Dropbox or OneDrive.",
    repo: "https://github.com/remotely-save/remotely-save",
    category: "Sync", downloads: 2_008_001, glyph: "refresh", tone: "blue",
    lucid: "Encrypted sync of sessions and semantic memory to storage you own (S3, WebDAV), with keys held in the vault.",
  },
  {
    id: "importer", name: "Importer", rank: 4, status: "planned",
    desc: "Import notes from Notion, Evernote, Roam, Apple Notes and more.",
    repo: "https://github.com/obsidianmd/obsidian-importer",
    category: "Import", downloads: null, glyph: "download", tone: "cyan",
    lucid: "Import external notes and docs into the knowledge graph through the scanner gate, labeled untrusted.",
  },
  {
    id: "advanced-uri", name: "Advanced URI", rank: 5, status: "planned",
    desc: "Deep links to control the app from outside (open, search, write).",
    repo: "https://github.com/Vinzent03/obsidian-advanced-uri",
    category: "Automation", downloads: null, glyph: "link", tone: "accent",
    lucid: "lucid:// deep links to open a session, run a slash command, or launch a saved agent.",
  },
  {
    id: "zotero", name: "Zotero Integration", rank: 6, status: "planned",
    desc: "Insert citations, notes and annotations from Zotero.",
    repo: "https://github.com/mgmeyers/obsidian-zotero-integration",
    category: "Research", downloads: null, glyph: "report", tone: "amber",
    lucid: "Pull citations and annotations into chat and the knowledge graph for research-heavy work.",
  },
  {
    id: "languagetool", name: "LanguageTool", rank: 7, status: "planned",
    desc: "Grammar and style checking for your prose.",
    repo: "https://github.com/Clemens-E/obsidian-languagetool-plugin",
    category: "Writing", downloads: null, glyph: "textT", tone: "green",
    lucid: "A grammar pass over drafted docs and briefs through a self-hosted LanguageTool endpoint, no cloud by default.",
  },
  {
    id: "mermaid", name: "Mermaid", rank: 8, status: "planned",
    desc: "Diagrams as code: flowcharts, sequence and architecture diagrams from plain text.",
    repo: "https://github.com/mermaid-js/mermaid",
    category: "Diagrams", downloads: null, glyph: "graph", tone: "cyan",
    lucid: "Render the agent's mermaid blocks inline in chat and the sandboxed Preview panel, offline, with no execution.",
  },
  {
    id: "gitleaks", name: "Gitleaks", rank: 9, status: "planned",
    desc: "Scan repos and commits for hardcoded secrets and credentials.",
    repo: "https://github.com/gitleaks/gitleaks",
    category: "Security", downloads: null, glyph: "shield", tone: "accent",
    lucid: "A pre-commit secret sweep wired into the exec gate; findings land as security events beside the vault.",
  },
  {
    id: "semgrep", name: "Semgrep", rank: 10, status: "planned",
    desc: "Fast static analysis with community security rules.",
    repo: "https://github.com/semgrep/semgrep",
    category: "Security", downloads: null, glyph: "scan", tone: "blue",
    lucid: "A static-analysis pass over agent-written code; findings surface in the security feed before anything ships.",
  },
  {
    id: "trivy", name: "Trivy", rank: 11, status: "planned",
    desc: "Vulnerability and misconfiguration scanner for dependencies, containers and IaC.",
    repo: "https://github.com/aquasecurity/trivy",
    category: "Security", downloads: null, glyph: "search", tone: "green",
    lucid: "On-demand dependency and SBOM scans; evidence exports beside the OCSF audit trail for CMMC and RMF packages.",
  },
  {
    id: "pandoc", name: "Pandoc", rank: 12, status: "planned",
    desc: "Universal document converter: markdown to DOCX, PDF, HTML and more.",
    repo: "https://github.com/jgm/pandoc",
    category: "Documents", downloads: null, glyph: "print", tone: "violet",
    lucid: "Export briefs, ADRs and reports to DOCX and PDF fully offline, for air-gapped deliverables.",
  },
  {
    id: "obsidian", name: "Obsidian", rank: 13, status: "built-in",
    desc: "Bring an Obsidian-style markdown vault into LUCID.",
    category: "Knowledge", downloads: null, glyph: "brain", tone: "violet",
    lucid: "Point the Knowledge panel at a vault folder; its notes compile into a named knowledge graph the agent answers from.",
  },
  {
    id: "browser", name: "Browser", rank: 14, status: "built-in",
    desc: "A real Chromium window the agent drives where you can watch it.",
    category: "Web", downloads: null, glyph: "eye", tone: "cyan",
    lucid: "The agent opens pages, clicks, types, and reads snapshots in a visible window. Closing the window is a kill switch for every pending command.",
  },
  {
    id: "codegraph", name: "Codegraph", rank: 15, status: "built-in",
    desc: "Turn the current workspace into an explorable code graph.",
    category: "Code intelligence", downloads: null, glyph: "runs", tone: "amber",
    lucid: "Ingest the workspace at the depth you pick, then explore symbols and their links yourself or let the agent use the graph.",
  },
  {
    id: "openfilm", name: "OpenFilm", rank: 16, status: "built-in",
    desc: "An HTML film format and CLI: pages that draw each frame, rendered to video.",
    repo: "https://github.com/openfilm/openfilm",
    category: "Video", downloads: null, glyph: "layout", tone: "accent",
    lucid: "Creator Studio checks a film for frames that do not repeat, page errors, and cut-off text, then renders it with headless Chromium and FFmpeg.",
  },
  {
    id: "whisper", name: "Whisper", rank: 17, status: "built-in",
    desc: "Speech-to-text on your own machine with whisper.cpp.",
    repo: "https://github.com/ggml-org/whisper.cpp",
    category: "Speech", downloads: null, glyph: "mic", tone: "green",
    lucid: "Dictate to the agent from the composer mic. With Local Whisper started in Settings, Voice, the bundled whisper.cpp server transcribes on this machine.",
  },
  {
    id: "knowledge-graph", name: "Knowledge Graph", rank: 18, status: "built-in",
    desc: "Named knowledge graphs from your chats, documents, and vaults.",
    category: "Knowledge", downloads: null, glyph: "graph", tone: "blue",
    lucid: "Seed graphs from ChatGPT, Claude, or Gemini exports or markdown, import signed Role KG Packs, and ground the agent's answers in them.",
  },
];

/** Featured pinned first, then rank asc, name as tiebreak. Pure; the input is not mutated. */
export function sortFree(list: FreePlugin[]): FreePlugin[] {
  return [...list].sort((a, b) =>
    Number(b.status === "featured") - Number(a.status === "featured") || a.rank - b.rank || a.name.localeCompare(b.name));
}

/** Case-insensitive substring filter over every line a card shows. Blank query keeps everything. Pure. */
export function matchesQuery(fields: readonly string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => f.toLowerCase().includes(q));
}

/** 6_487_654 -> "6.5M", 412_000 -> "412K", null -> "". Pure. */
export function fmtDownloads(n: number | null): string {
  if (n == null || n <= 0) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}

/** The drawer opens on PREMIUM unless the user last chose FREE (ADR-0461). Anything else stored reads as PREMIUM. */
export function parseTierPref(raw: string | null | undefined): PluginTier {
  return raw === "free" ? "free" : "premium";
}

/** Is `candidate` a strictly newer release than `installed`? Numeric `major.minor.patch`, where a prerelease
 *  (`1.2.0-beta.1`) sorts below its release. An unparseable side is never "newer": a garbled version must not
 *  nag the user into an update that may not exist. */
export function isNewerVersion(candidate: string | null | undefined, installed: string | null | undefined): boolean {
  const parse = (v: string | null | undefined) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec((v ?? "").trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" } : null;
  };
  const a = parse(candidate), b = parse(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i]! > b.n[i]!;
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;  // 1.2.0 > 1.2.0-beta
  if (!b.pre) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

/** What a premium card's one button does right now. */
export type CardAction =
  | { kind: "visit"; url: string; label: string }
  | { kind: "coming-soon" }
  | { kind: "signin" }
  | { kind: "request-access"; declined: boolean }
  | { kind: "access-pending" }
  | { kind: "buy" }
  | { kind: "install" }
  | { kind: "installing" }
  | { kind: "open" }
  | { kind: "update"; to: string };

export interface CardFacts {
  signedIn: boolean;
  /** The backend's (user, plugin) entitlement; `premium-all` is resolved server-side into this record. */
  entitlement: Entitlement | null;
  gov: GovAccessStatus;
  /** Version of the locally installed package, or null when it is not installed. */
  installedVersion: string | null;
  /** A download or install for this card is in flight. */
  busy: boolean;
  nowIso: string;
}

/** The card state machine (ADR-0461/0463/0465). Order matters:
 *  1. A link-out only ever visits: it is never sold, so no fact can turn it into Buy.
 *     A sold plugin whose package is not available yet is Coming soon: nothing to buy, request, or install.
 *  2. In-flight work shows Installing.
 *  3. An installed plugin opens (it runs offline and never phones home), or offers Update when the user is
 *     still entitled and the backend has published a newer version.
 *  4. Otherwise the fail-closed pack decision: signed out -> signin; entitled -> install; else checkout,
 *     where a Government plugin buys ONLY with approved access and otherwise asks for it. */
export function decideCardAction(p: PremiumPlugin, f: CardFacts): CardAction {
  if (p.sale === "link") return { kind: "visit", url: p.href, label: p.linkLabel };
  if (!p.available) return { kind: "coming-soon" };
  if (f.busy) return { kind: "installing" };
  const decision = decidePackAction({ signedIn: f.signedIn }, f.entitlement, f.nowIso);
  if (f.installedVersion) {
    const latest = f.entitlement?.latestVersion;
    return decision === "pull" && latest && isNewerVersion(latest, f.installedVersion) ? { kind: "update", to: latest } : { kind: "open" };
  }
  if (decision === "signin") return { kind: "signin" };
  if (decision === "pull") return { kind: "install" };
  if (p.section === "government" && f.gov !== "approved") {
    return f.gov === "pending" ? { kind: "access-pending" } : { kind: "request-access", declined: f.gov === "declined" };
  }
  return { kind: "buy" };
}

/** The button text for each state. One short line (invariant 11). */
export function cardActionLabel(a: CardAction): string {
  switch (a.kind) {
    case "visit": return a.label;
    case "coming-soon": return "Coming soon";
    case "signin": return "Sign in to buy";
    case "request-access": return a.declined ? "Request again" : "Request access";
    case "access-pending": return "Access pending";
    case "buy": return `Buy ${PLUGIN_PRICE_LABEL}`;
    case "install": return "Install";
    case "installing": return "Installing";
    case "open": return "Open";
    case "update": return `Update to ${a.to}`;
  }
}

/** Split the single "CAGE or UEI" field. A CAGE code is 5 alphanumerics, a UEI is 12; blank is allowed (a
 *  verified .gov/.mil email needs neither). Anything else is an error the form shows inline. */
export function parseCageOrUei(raw: string): { cage?: string; uei?: string } | { error: string } {
  const v = raw.trim().toUpperCase();
  if (!v) return {};
  if (/^[A-Z0-9]{5}$/.test(v)) return { cage: v };
  if (/^[A-Z0-9]{12}$/.test(v)) return { uei: v };
  return { error: "Enter a 5-character CAGE code or a 12-character UEI." };
}
